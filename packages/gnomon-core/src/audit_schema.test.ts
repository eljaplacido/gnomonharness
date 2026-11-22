/**
 * The audit record schema (conformance/audit_record_schema.json,
 * docs/CONTRACTS.md section 55) and the enumerations the binary publishes
 * (section 3; issue #113).
 *
 * Three claims:
 *  1. Every enumeration `gnomon-enums` prints is the TypeScript constant that
 *     mirrors it, and the golden says the same.
 *  2. The schema lists exactly the audit kinds there are, and is well formed.
 *  3. Every record real sessions write validates against it: no field the
 *     schema does not list, every required field present, every type right.
 *     A field added to the loop without a line in the schema fails here.
 *
 * Every model here is a fake on 127.0.0.1; nothing reaches a network.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { enumerations } from "gnomon-natives";
import { AUDIT_KINDS } from "./audit.js";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";
import { fromClaudeCode, guardHarnessRequest, guardToolCall, GUARD_DECISIONS, GUARD_RULES, GUARD_TOOLS } from "./guard.js";
import { CANDIDATE_SIGNALS } from "./skill_mine.js";
import { TRIAL_STATUSES, TRIAL_VERDICTS } from "./skill_trial.js";

const REPO = join(__dirname, "../../..");
const read = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf-8"));

// ---------------------------------------------------------------------------
// 1. The binary, the golden and the constants
// ---------------------------------------------------------------------------

describe("gnomon enumerations publishes what the TypeScript constants say (#113)", () => {
  const published = enumerations() as unknown as Record<string, unknown[]>;
  const golden = read("conformance/enumerations_golden.json") as Record<string, unknown[]>;

  it("the binary's output is the golden", () => {
    expect(published).toEqual(golden);
  });

  it("AUDIT_KINDS, the guard tables and the skill enumerations are the binary's, in order", () => {
    expect(published.audit_kind).toEqual([...AUDIT_KINDS]);
    expect(published.guard_decision).toEqual([...GUARD_DECISIONS]);
    expect(published.guard_rule).toEqual([...GUARD_RULES]);
    expect(published.guard_tool).toEqual([...GUARD_TOOLS]);
    expect(published.candidate_signal).toEqual([...CANDIDATE_SIGNALS]);
    expect(published.trial_verdict).toEqual([...TRIAL_VERDICTS]);
    expect(published.trial_status).toEqual([...TRIAL_STATUSES]);
  });

  it("a trial verdict is true, false or \"undetermined\": booleans stay booleans", () => {
    expect(published.trial_verdict).toEqual([true, false, "undetermined"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The schema itself
// ---------------------------------------------------------------------------

interface FieldSpec {
  type: string[];
  class: "metadata" | "content" | "identifier";
  note?: string;
}
interface Schema {
  schema: string;
  v: number;
  classes: Record<string, string>;
  envelope: { required: Record<string, FieldSpec>; optional: Record<string, FieldSpec> };
  kinds: Record<string, { required: Record<string, FieldSpec>; optional: Record<string, FieldSpec> }>;
}
const SCHEMA = read("conformance/audit_record_schema.json") as Schema;
const JSON_TYPES = ["string", "integer", "number", "boolean", "null", "array", "object"];
const CLASSES = ["metadata", "content", "identifier"];

describe("conformance/audit_record_schema.json", () => {
  it("names exactly the audit kinds the loop can write, in the enumeration's order", () => {
    expect(Object.keys(SCHEMA.kinds)).toEqual([...AUDIT_KINDS]);
    expect(new Set(Object.keys(SCHEMA.kinds))).toEqual(new Set(read("conformance/enumerations_golden.json").audit_kind));
  });

  it("is versioned and defines the three classes", () => {
    expect(SCHEMA.schema).toBe("gnomon.audit_record/1");
    expect(SCHEMA.v).toBe(1);
    expect(Object.keys(SCHEMA.classes).sort()).toEqual([...CLASSES].sort());
  });

  it("gives every field a JSON type list and a class, and no field both required and optional", () => {
    const sections = [SCHEMA.envelope, ...Object.values(SCHEMA.kinds)];
    for (const s of sections) {
      for (const [name, spec] of [...Object.entries(s.required), ...Object.entries(s.optional)]) {
        expect(spec.type.length, name).toBeGreaterThan(0);
        for (const t of spec.type) expect(JSON_TYPES, `${name}: ${t}`).toContain(t);
        expect(CLASSES, name).toContain(spec.class);
      }
      for (const name of Object.keys(s.required)) expect(s.optional, name).not.toHaveProperty(name);
    }
    for (const [kind, s] of Object.entries(SCHEMA.kinds)) {
      for (const name of [...Object.keys(s.required), ...Object.keys(s.optional)]) {
        expect(SCHEMA.envelope.required, `${kind}.${name}`).not.toHaveProperty(name);
        expect(SCHEMA.envelope.optional, `${kind}.${name}`).not.toHaveProperty(name);
      }
    }
  });

  it("the chain fields are identifiers; the fields that carry command or model text are content", () => {
    for (const f of ["seq", "prev", "hash"]) {
      expect((SCHEMA.envelope.required[f] ?? SCHEMA.envelope.optional[f])!.class, f).toBe("identifier");
    }
    const cls = (kind: string, field: string) =>
      (SCHEMA.kinds[kind]!.required[field] ?? SCHEMA.kinds[kind]!.optional[field])!.class;
    for (const [kind, field] of [
      ["tool_call", "target"], ["tool_call", "args"], ["tool_call", "result"], ["tool_call", "summary"],
      ["turn", "input"], ["turn", "output"], ["turn", "tool_log"], ["approval", "summary"],
      ["verify", "command"], ["bootstrap", "command"], ["guard", "target"], ["escalation", "handover"],
      ["check", "checks"], ["record_tamper_resolved", "reason"],
    ] as const) {
      expect(cls(kind, field), `${kind}.${field}`).toBe("content");
    }
    expect(cls("model_call", "model")).toBe("metadata");
    expect(cls("tool_call", "code")).toBe("metadata");
  });
});

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** What is wrong with one record, against the schema. Empty: nothing. */
export function recordProblems(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  const kind = r.kind;
  const spec = typeof kind === "string" ? SCHEMA.kinds[kind] : undefined;
  if (!spec) return [`unknown kind ${JSON.stringify(kind)}`];
  const required = { ...SCHEMA.envelope.required, ...spec.required };
  const allowed: Record<string, FieldSpec> = { ...required, ...SCHEMA.envelope.optional, ...spec.optional };
  for (const name of Object.keys(required)) {
    if (!(name in r)) out.push(`${kind}: required field ${name} is missing`);
  }
  for (const [name, v] of Object.entries(r)) {
    const f = allowed[name];
    if (!f) {
      out.push(`${kind}: field ${name} is not in the schema`);
      continue;
    }
    const t = jsonType(v);
    if (!f.type.includes(t) && !(t === "integer" && f.type.includes("number"))) {
      out.push(`${kind}.${name}: ${t} where the schema says ${f.type.join("|")}`);
    }
  }
  return out;
}

describe("the validator", () => {
  it("rejects what it should", () => {
    const ok = { seq: 0, ts: "2026-11-22T00:00:00.000Z", kind: "first_token_stall", prev: null, role: "r", step: 1, attempt: 1, waited_ms: 3, recovered: true };
    expect(recordProblems(ok)).toEqual([]);
    expect(recordProblems({ ...ok, extra: 1 })).toEqual(["first_token_stall: field extra is not in the schema"]);
    const { role: _r, ...noRole } = ok;
    expect(recordProblems(noRole)).toEqual(["first_token_stall: required field role is missing"]);
    expect(recordProblems({ ...ok, step: "1" })).toEqual(["first_token_stall.step: string where the schema says integer"]);
    expect(recordProblems({ ...ok, kind: "nope" })).toEqual(['unknown kind "nope"']);
  });
});

// ---------------------------------------------------------------------------
// 3. Real sessions
// ---------------------------------------------------------------------------

const roots: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
});
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Step =
  | { tool: string; args: Record<string, unknown> }
  | { text: string; reasoning?: string }
  | { runaway: true };

const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/** A scripted OpenAI-style endpoint. Streams when asked, so the think cap can cut a reply. */
async function serve(script: Step[], opts: { stream?: boolean } = {}): Promise<string> {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const step = script[Math.min(n++, script.length - 1)]!;
      if (opts.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if ("runaway" in step) {
          for (let i = 0; i < 60; i++) sse(res, { choices: [{ index: 0, delta: { reasoning_content: "y".repeat(400) }, finish_reason: null }] });
          sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        } else if ("tool" in step) {
          sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: "tool_calls" }] });
        } else {
          sse(res, { choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: "stop" }] });
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      const message =
        "tool" in step
          ? { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
          : "text" in step
            ? { role: "assistant", content: step.text, ...(step.reasoning ? { reasoning_content: step.reasoning } : {}) }
            : { role: "assistant", content: "done" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: "tool" in step ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 400, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } },
        })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
}

interface Scenario {
  url: string;
  config?: string;
  /** Extra keys for the [turn] block. */
  turn?: string;
  /** Replaces the role's max_steps line. */
  maxSteps?: string;
  role?: string;
  policy?: string;
  extraEndpoints?: string;
  files?: Record<string, string>;
  record?: "metadata" | "full";
  stream?: boolean;
  /** [defaults] max_context_tokens. */
  window?: number;
}

function surface(s: Scenario): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-audit-schema-")));
  roots.push(root);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put(
    ".gnomon/config.toml",
    `[defaults]\nmax_tokens = 4096\n${s.window ? `max_context_tokens = ${s.window}\n` : ""}\n[turn]\nnudge_after_idle = 0\n${s.turn ?? ""}\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\nrequest_timeout_ms = 30000\n\n` +
      `[audit]\nenabled = true\nrecord = "${s.record ?? "full"}"\n\n` +
      `[endpoints.target]\nurl = "${s.url}"\nkind = "openai"\nstream = ${s.stream === true}\n${s.extraEndpoints ?? ""}\n${s.config ?? ""}`
  );
  put(
    ".gnomon/roles.toml",
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read", "write", "bash"]\n${s.maxSteps ?? "max_steps = 12"}\n${s.role ?? ""}`
  );
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "off"\n\n${s.policy ?? ""}`);
  put(".gnomon/system.md", "be brief\n");
  put(".gnomon/tools.toml", ["read", "write", "bash"].map((n) => `[[tools]]\nname = "${n}"\ndescription = "${n}"\nenabled = true\n`).join("\n"));
  for (const [rel, text] of Object.entries(s.files ?? {})) put(rel, text);
  return root;
}

/** Every record every trail under the surface's audit directory holds. */
function records(root: string): Array<Record<string, unknown>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

const seen = new Set<string>();
function check(root: string): Array<Record<string, unknown>> {
  const recs = records(root);
  expect(recs.length).toBeGreaterThan(0);
  const bad = recs.flatMap((r) => recordProblems(r).map((p) => `seq ${r.seq}: ${p}`));
  expect(bad).toEqual([]);
  for (const r of recs) seen.add(String(r.kind));
  return recs;
}

const BOOT = `[bootstrap.env]\nlinux = ['echo hello-from-probe']\nmacos = ['echo hello-from-probe']\nwindows = ['echo hello-from-probe']\nmax_lines = 2\n`;

describe("every record a real session writes validates against the schema", () => {
  for (const record of ["full", "metadata"] as const) {
    it(`tool calls, approval, verify, bootstrap, context trims and model calls (record = ${record})`, async () => {
      const url = await serve([
        { tool: "write", args: { path: "a.txt", content: "a\n" } },
        { tool: "bash", args: { command: "echo hi && ls" } },
        { tool: "read", args: { path: "a.txt" } },
        { tool: "read", args: { path: "nope.txt" } },
        { tool: "bash", args: { command: "rm -rf /" } },
        { text: "Done." },
        { tool: "write", args: { path: "GNOMON_OK", content: "ok\n" } },
        { text: "Done, and the check passes." },
      ]);
      const root = surface({
        url,
        record,
        config:
          `[context]\nbootstrap = "env"\n\n[context.mask_observations]\nkeep_last = 1\nat_fill = 0.01\nbatch = 1\n`,
        policy: `[verify]\ncommand = "test -f GNOMON_OK"\nafter = "change"\nmax_rounds = 2\n\n${BOOT}`,
        role: "",
      });
      await runTask(loadConfig(root), "write a.txt, then list files", { role: "smol", yes: true });
      const recs = check(root);
      const kinds = new Set(recs.map((r) => r.kind));
      for (const k of ["session_start", "turn", "tool_call", "approval", "verify", "bootstrap", "model_call", "session_end"]) {
        expect(kinds.has(k as never), k).toBe(true);
      }
    });
  }

  it("context_mask and trims: a small window filled by tool results", async () => {
    const files: Record<string, string> = {};
    const script: Step[] = [];
    for (let i = 1; i <= 8; i++) {
      files[`big${i}.txt`] = `line ${i} `.repeat(500);
      script.push({ tool: "read", args: { path: `big${i}.txt` } });
    }
    script.push({ text: "done" });
    const url = await serve(script);
    const root = surface({
      url,
      window: 6000,
      config: `\n[context.mask_observations]\nkeep_last = 1\nat_fill = 0.3\nbatch = 2\n`,
      files,
    });
    await runTask(loadConfig(root), "read every big file", { role: "smol", yes: true });
    const recs = check(root);
    expect(recs.some((r) => r.kind === "context_mask")).toBe(true);
  });

  it("think_cap: a reply cut for reasoning without acting", async () => {
    const url = await serve([{ runaway: true }, { text: "done" }], { stream: true });
    const root = surface({ url, stream: true, turn: "max_reasoning_tokens_without_action = 1000\n" });
    const rec = await runTask(loadConfig(root), "think a lot", { role: "smol", yes: true });
    expect(rec.stop_reason).toBe("answered");
    const recs = check(root);
    expect(recs.some((r) => r.kind === "think_cap")).toBe(true);
  });

  it("skill_use: a skill the match rule loads", async () => {
    const url = await serve([{ text: "I follow release-checklist.", reasoning: "the release-checklist note applies" }]);
    const root = surface({
      url,
      files: { ".gnomon/skills/release-checklist.md": '+++\nname = "release-checklist"\nmatch = "release"\n+++\n\nTag, then publish.\n' },
    });
    await runTask(loadConfig(root), "prepare the release", { role: "smol", yes: true });
    const recs = check(root);
    expect(recs.some((r) => r.kind === "skill_use")).toBe(true);
  });

  it("escalation: local first, cloud rescue", async () => {
    const local = await serve([
      { tool: "read", args: { path: "a.txt" } },
      { tool: "read", args: { path: "b.txt" } },
      { tool: "read", args: { path: "c.txt" } },
      { text: "never reached" },
    ]);
    const cloud = await serve([{ text: "fixed it" }]);
    const root = surface({
      url: local,
      extraEndpoints: `\n[endpoints.cloud]\nurl = "${cloud}"\nkind = "openai"\nstream = false\n`,
      maxSteps: "max_steps = 2\nmax_steps_total = 2",
      role: `\n[roles.smol.escalate]\nmodel = "cloud-m"\nendpoint = "cloud"\non = ["step_wall"]\ncarry = "handover"\nmax_steps = 3\n`,
      files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" },
    });
    const rec = await runTask(loadConfig(root), "fix the bug", { role: "smol", yes: true });
    expect(rec.escalation, rec.output).toBeDefined();
    const recs = check(root);
    expect(recs.some((r) => r.kind === "escalation")).toBe(true);
  });

  it("the gates: completion, finish and todo", async () => {
    for (const gate of [`completion_gate = "checklist"`, `finish_gate = "v2"`]) {
      const url = await serve([
        { tool: "write", args: { path: "out.txt", content: "42\n" } },
        { text: "Done. I believe it should work, probably." },
        { tool: "bash", args: { command: "cat out.txt" } },
        { text: "Verified: out.txt says 42." },
      ]);
      const root = surface({ url, policy: `[verify]\n${gate}\n` });
      await runTask(loadConfig(root), "write out.txt with 42", { role: "smol", yes: true });
      const recs = check(root);
      expect(recs.some((r) => r.kind === (gate.startsWith("completion") ? "completion_gate" : "finish_gate")), gate).toBe(true);
    }
  });

  it("a deadline: the time note and the deliverable-first check", async () => {
    const url = await serve([
      { tool: "read", args: { path: "f1.txt" } },
      { tool: "read", args: { path: "f2.txt" } },
      { tool: "read", args: { path: "f3.txt" } },
      { tool: "read", args: { path: "f4.txt" } },
      { text: "done" },
    ]);
    const root = surface({
      url,
      turn: 'deadline_note = "continue"\ndeliverable_first = true\ndeadline_margin_ms = 200\n',
      files: { "f1.txt": "1\n", "f2.txt": "2\n", "f3.txt": "3\n", "f4.txt": "4\n" },
    });
    const base = Date.now();
    let tick = 0;
    await runTask(loadConfig(root), "Write the summary to `result.txt`.", {
      role: "smol",
      yes: true,
      stderr: { write() {} },
      deadline: { at: base + 100_000, source: "flag" },
      clock: () => base + 20_000 * tick++,
    } as never);
    const recs = check(root);
    expect(recs.some((r) => r.kind === "deliverable_first")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The guard's own trail
// ---------------------------------------------------------------------------

describe("the guard's trail validates", () => {
  it("allow, deny and ask decisions, with and without [governance]", async () => {
    const cases = read("conformance/guard_cases.json");
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-audit-schema-guard-")));
    roots.push(repo);
    const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@example.invalid"]);
    sh(["config", "user.name", "t"]);
    sh(["config", "commit.gpgsign", "false"]);
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    };
    for (const [file, text] of Object.entries(cases.surface as Record<string, string>)) {
      put(`.gnomon/${file}`, file === "policy.toml" ? (text as string).replace("{{gate}}", "on_write") : text);
    }
    put(".gnomon/config.toml", `${cases.surface["config.toml"]}\n[audit]\nenabled = true\n`);
    put("src/a.ts", "old\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "surface"]);

    await guardToolCall({ cwd: repo, call: { tool: "read", input: { path: "src/a.ts" } }, role: "implement" });
    await guardToolCall({ cwd: repo, call: { tool: "bash", input: { command: "git push --force origin main" } }, role: "implement" });
    await guardToolCall({ cwd: repo, call: { tool: "write", input: { path: "src/a.ts", content: "x" } }, role: "implement" });
    await guardToolCall({ cwd: repo, call: { tool: "read", input: { path: ".env" } }, role: "implement" });
    const hr = fromClaudeCode({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: repo,
      session_id: "s-1",
      tool_use_id: "toolu_01",
      permission_mode: "default",
    });
    await guardHarnessRequest(hr, { role: "implement", harness: "claude-code" });

    const recs = records(repo);
    expect(recs.filter((r) => r.kind === "guard").length).toBeGreaterThanOrEqual(5);
    const bad = recs.flatMap((r) => recordProblems(r).map((p) => `seq ${r.seq}: ${p}`));
    expect(bad).toEqual([]);
    for (const r of recs) seen.add(String(r.kind));

    // Under [governance] the record carries verdict, family and level too.
    put(".gnomon/policy.toml", `${readFileSync(join(repo, ".gnomon/policy.toml"), "utf-8")}\n[governance]\nlevel = "advise"\n`);
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "governed"]);
    await guardHarnessRequest(
      fromClaudeCode({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: repo, session_id: "s-2", tool_use_id: "toolu_02", permission_mode: "default" }),
      { role: "implement", harness: "claude-code" }
    );
    const governed = records(repo).filter((r) => r.kind === "guard" && "verdict" in r);
    expect(governed.length).toBeGreaterThan(0);
    expect(records(repo).flatMap((r) => recordProblems(r))).toEqual([]);
  });
});

describe("coverage", () => {
  it("the scripted sessions above wrote the kinds this file claims to cover", () => {
    // Not every kind: the ones the other suites write by hand (skill_accept,
    // eval_run, record_tamper, ...) were checked against the same schema when
    // it was written, with every record the whole suite produces.
    for (const k of [
      "session_start", "turn", "tool_call", "approval", "verify", "bootstrap", "model_call", "session_end",
      "think_cap", "skill_use", "escalation", "guard", "completion_gate", "finish_gate", "deliverable_first",
      "context_mask", "session_resume",
    ]) {
      expect(seen.has(k), `no ${k} record was written`).toBe(true);
    }
  });
});
