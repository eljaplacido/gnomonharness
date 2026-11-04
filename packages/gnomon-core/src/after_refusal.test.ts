/**
 * `[approval] after_refusal = "ask"` (GV13): after a refusal, a gated call that
 * names what was refused goes to a person, even when the gate or a standing
 * approval would have let it run unasked.
 *
 * The loop tests drive a real turn against a scratch surface whose implement
 * role may write only `src/**`, with a scripted model: it writes CHANGELOG.md
 * (refused by write_allow), then reaches for CHANGELOG.md through bash -- the
 * shape G1c's agent used (GVC m-109 #7, m-147 #21).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig } from "./config.js";
import {
  AFTER_REFUSAL_DEFAULT_CALLS,
  AFTER_REFUSAL_REASON,
  AFTER_REFUSAL_VALUES,
  AfterRefusalWindow,
  escalatable,
  namedTarget,
  refusedTargets,
  resolveAfterRefusal,
} from "./after_refusal.js";
import { runAgenticTurn, runTask } from "./prompt_loop.js";
import { explain } from "./explain.js";
import type { ApprovalRequest } from "./tools.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../conformance/after_refusal.json", import.meta.url), "utf-8")
) as {
  values: string[];
  default: string;
  default_calls: number;
  escalatable: string[];
  escalatable_prefix: string;
  record: { kind: string; key: string; value: string };
  counter: string;
  cases: Array<{ refused: { tool: string; args: Record<string, unknown> }; targets: string[]; then: Array<{ tool: string; args: Record<string, unknown>; names: string | null }> }>;
};

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A scaffold-shaped surface: implement may write src/** only. */
function surface(approval: string): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-after-refusal-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[audit]\nenabled = true\n\n[endpoints.target]\nurl = "http://127.0.0.1:9/v1/chat/completions"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.implement]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0\ntop_p = 1\n` +
      `tools = ["read", "write", "bash"]\nwrite_allow = ["src/**"]\nmax_steps = 12\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    ["read", "write", "bash"].map((n) => `[[tools]]\nname = "${n}"\ndescription = "${n}"\nenabled = true\n`).join("\n")
  );
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[approval]\n${approval}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(root, "NOTES.md"), "notes\n");
  return root;
}

type Call = { name: string; args: Record<string, unknown> };
const REFUSED_WRITE: Call = { name: "write", args: { path: "CHANGELOG.md", content: "# Changelog\n- x\n" } };
const ROUTE_AROUND: Call = { name: "bash", args: { command: "cat CHANGELOG.md" } };

/** A model that makes these calls, one per reply, then answers. */
function scripted(calls: Call[]) {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    const call = calls[n++];
    const message = call
      ? {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `c${n}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
        }
      : { role: "assistant", content: "done" };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** One turn at the loop, the way the terminal and ACP drive it. */
async function turn(root: string, calls: Call[], opts: { standing?: boolean; answer?: boolean } = {}) {
  const config = loadConfig(root);
  // Every request the loop sent, and the ones a person would have seen. A
  // standing approval lives in the approver, not the loop: the terminal's and
  // ACP's both answer a request themselves unless it is escalated, and this
  // one does the same.
  const requests: ApprovalRequest[] = [];
  const asked: ApprovalRequest[] = [];
  const said: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const restore = scripted(calls);
  try {
    const state = { config, exchanges: [], currentRole: "implement" } as never;
    const route = {
      model: "m1",
      temperature: 0,
      top_p: 1,
      target: { model: "m1", temperature: 0, top_p: 1, url: "http://127.0.0.1:9/v1/chat/completions", kind: "openai" },
    } as never;
    const result = await runAgenticTurn(state, "implement", route, [{ role: "user", content: "go" }], {
      approve: async (req) => {
        requests.push(req);
        if (opts.standing && !req.escalated) return true;
        asked.push(req);
        return opts.answer ?? true;
      },
      standingApproval: () => opts.standing ?? false,
      progress: { start() {}, update() {}, stop() {} } as never,
      ui: { cot: "full", think: "hide", color: false, spinner: false } as never,
      say: (s: string) => said.push(s),
      audit: {
        write: (kind: string, f: Record<string, unknown>) => audit.push({ kind, ...f }),
        text: (t: string) => t,
        action: (t: string) => t,
      } as never,
    });
    return { result, requests, asked, said, audit };
  } finally {
    restore();
  }
}

/** The trail a `gnomon task` run left. */
function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("after_refusal: the published shape", () => {
  it("matches conformance/after_refusal.json", () => {
    expect([...AFTER_REFUSAL_VALUES]).toEqual(fixture.values);
    expect(fixture.default).toBe("off");
    expect(AFTER_REFUSAL_DEFAULT_CALLS).toBe(fixture.default_calls);
    expect(AFTER_REFUSAL_REASON).toBe(fixture.record.value);
    for (const t of fixture.escalatable) expect(escalatable(t)).toBe(true);
    for (const t of ["read", "glob", "grep", "compute", "todo", "note"]) expect(escalatable(t)).toBe(false);
    expect(escalatable(`${fixture.escalatable_prefix}srv__tool`)).toBe(true);
  });

  it("reads each fixture case the way the fixture says", () => {
    for (const c of fixture.cases) {
      const targets = refusedTargets(c.refused.tool, c.refused.args);
      expect(targets, JSON.stringify(c.refused)).toEqual(c.targets);
      for (const then of c.then) {
        expect(namedTarget(then.tool, then.args, new Set(targets)), JSON.stringify(then)).toBe(then.names);
      }
    }
  });

  it("CONTRACTS.md names the section, the record key and the counter", () => {
    const doc = readFileSync(new URL("../../../docs/CONTRACTS.md", import.meta.url), "utf-8");
    expect(doc).toContain("§NEW-after-refusal");
    expect(doc).toContain(`\`${fixture.record.key}\``);
    expect(doc).toContain(`\`${fixture.counter}\``);
    expect(doc).toContain("conformance/after_refusal.json");
  });
});

describe("after_refusal: the surface", () => {
  it("is off unless declared, and anything but \"ask\" is off", () => {
    expect(resolveAfterRefusal(loadConfig(surface(`gate = "on_write"`)))).toEqual({ mode: "off", calls: 1 });
    expect(resolveAfterRefusal(loadConfig(surface(`after_refusal = "ask"`)))).toEqual({ mode: "ask", calls: 1 });
    expect(resolveAfterRefusal(loadConfig(surface(`after_refusal = "ASK"`))).mode).toBe("off");
    expect(resolveAfterRefusal(loadConfig(surface(`after_refusal = "ask"\nafter_refusal_calls = 3`))).calls).toBe(3);
  });

  it("names a typo and a window that is not a positive integer, rather than reverting in silence", () => {
    const typo = auditSurface(loadConfig(surface(`after_refusal = "yes"`)));
    expect(typo.some((p) => /after_refusal = "yes" is not one of off \| ask/.test(p.problem))).toBe(true);
    for (const bad of [`"2"`, "0", "1.5"]) {
      const found = auditSurface(loadConfig(surface(`after_refusal = "ask"\nafter_refusal_calls = ${bad}`)));
      expect(found.some((p) => /after_refusal_calls = .* is not a positive integer/.test(p.problem)), bad).toBe(true);
    }
    const clean = auditSurface(loadConfig(surface(`after_refusal = "ask"\nafter_refusal_calls = 2`)));
    expect(clean.some((p) => /after_refusal/.test(p.problem))).toBe(false);
  });

  it("/explain approval says so only when declared", () => {
    const on = explain(loadConfig(surface(`after_refusal = "ask"`)), "implement", "approval");
    expect(on!.here.join("\n")).toMatch(/after_refusal\s+ask — for 1 gated call after a refusal/);
    const off = explain(loadConfig(surface(`gate = "on_write"`)), "implement", "approval");
    expect(off!.here.join("\n")).not.toContain("after_refusal");
  });
});

describe("after_refusal: the window", () => {
  it("watches the next N gated calls after a refusal; reads neither ask nor use it up", () => {
    const w = new AfterRefusalWindow({ mode: "ask", calls: 2 });
    expect(w.check("bash", { command: "cat CHANGELOG.md" })).toBeNull(); // nothing refused yet
    w.observe("write", { path: "CHANGELOG.md" }, true);
    expect(w.check("read", { path: "CHANGELOG.md" })).toBeNull(); // a read is not escalated...
    expect(w.check("bash", { command: "ls src" })).toBeNull(); // ...a gated call naming something else uses a place...
    expect(w.check("bash", { command: "cat CHANGELOG.md" })).toMatch(/CHANGELOG\.md was refused earlier/);
    expect(w.check("bash", { command: "cat CHANGELOG.md" })).toBeNull(); // ...and the window is spent
    w.observe("bash", { command: "rm -rf build" }, true); // any refusal re-arms it
    expect(w.check("bash", { command: "head CHANGELOG.md" })).toMatch(/CHANGELOG\.md/);
  });

  it("does nothing at all when off", () => {
    const w = new AfterRefusalWindow({ mode: "off", calls: 5 });
    w.observe("write", { path: "CHANGELOG.md" }, true);
    expect(w.check("bash", { command: "cat CHANGELOG.md" })).toBeNull();
  });
});

describe("after_refusal: in the loop", () => {
  it("off: a standing approval answers the follow-up exactly as before, and the transcript is the same", async () => {
    const absent = await turn(surface(`gate = "on_write"`), [REFUSED_WRITE, ROUTE_AROUND], { standing: true });
    const off = await turn(surface(`gate = "on_write"\nafter_refusal = "off"`), [REFUSED_WRITE, ROUTE_AROUND], {
      standing: true,
    });
    for (const r of [absent, off]) {
      expect(r.asked).toEqual([]);
      expect(r.requests).toHaveLength(1);
      expect(r.requests[0]).not.toHaveProperty("escalated");
      expect(r.result.counters.after_refusal_asks).toBeUndefined();
      expect(r.audit.filter((a) => a.kind === "tool_call").map((a) => a.code)).toEqual([2, 0]);
    }
    // The scratch directory's name is in no line; the transcripts are identical.
    expect(off.said).toEqual(absent.said);
  });

  it("on: the call that reaches for the refused file is asked, though a standing approval would have answered it", async () => {
    const r = await turn(surface(`after_refusal = "ask"`), [REFUSED_WRITE, ROUTE_AROUND], { standing: true });
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.tool).toBe("bash");
    expect(r.asked[0]!.escalated).toMatch(/CHANGELOG\.md was refused earlier in this turn/);
    expect(r.result.counters.after_refusal_asks).toBe(1);
    const calls = r.audit.filter((a) => a.kind === "tool_call");
    expect(calls.map((a) => [a.tool, a.code, a.gated])).toEqual([
      ["write", 2, true],
      ["bash", 0, true],
    ]);
  });

  it("on: a person's no refuses it, and that refusal opens the window again", async () => {
    const r = await turn(
      surface(`after_refusal = "ask"`),
      [REFUSED_WRITE, ROUTE_AROUND, { name: "bash", args: { command: "tail -1 CHANGELOG.md" } }],
      { standing: true, answer: false }
    );
    expect(r.asked.map((a) => a.summary)).toEqual(["bash: cat CHANGELOG.md", "bash: tail -1 CHANGELOG.md"]);
    expect(r.audit.filter((a) => a.kind === "tool_call").map((a) => a.code)).toEqual([2, 2, 2]);
  });

  it("on, under gate = \"never\": asked although nothing else in the session asks", async () => {
    const r = await turn(surface(`gate = "never"\nafter_refusal = "ask"`), [
      { name: "bash", args: { command: "ls" } },
      REFUSED_WRITE,
      ROUTE_AROUND,
    ]);
    expect(r.asked.map((a) => a.tool)).toEqual(["bash"]);
    expect(r.asked[0]!.summary).toBe("bash: cat CHANGELOG.md");
  });

  it("on: a follow-up that names something else, or comes after the window, runs as it would have", async () => {
    const other = await turn(surface(`after_refusal = "ask"`), [REFUSED_WRITE, { name: "bash", args: { command: "cat NOTES.md" } }], {
      standing: true,
    });
    expect(other.asked).toEqual([]);
    const late = await turn(
      surface(`after_refusal = "ask"`),
      [REFUSED_WRITE, { name: "bash", args: { command: "ls src" } }, ROUTE_AROUND],
      { standing: true }
    );
    expect(late.asked).toEqual([]);
    // A declared wider window reaches it.
    const wide = await turn(
      surface(`after_refusal = "ask"\nafter_refusal_calls = 2`),
      [REFUSED_WRITE, { name: "bash", args: { command: "ls src" } }, ROUTE_AROUND],
      { standing: true }
    );
    expect(wide.asked.map((a) => a.summary)).toEqual(["bash: cat CHANGELOG.md"]);
  });

  it("on: a follow-up the rules refuse is refused before anyone is asked", async () => {
    const r = await turn(surface(`after_refusal = "ask"`), [REFUSED_WRITE, { name: "write", args: { path: "CHANGELOG.md", content: "y" } }], {
      standing: true,
    });
    expect(r.asked).toEqual([]);
    expect(r.audit.filter((a) => a.kind === "tool_call").map((a) => a.code)).toEqual([2, 2]);
  });

  it("gnomon task: --yes answers the escalated call like any gated one, and the trail says it was escalated", async () => {
    const root = surface(`gate = "never"\nafter_refusal = "ask"`);
    const restore = scripted([REFUSED_WRITE, ROUTE_AROUND]);
    try {
      await runTask(loadConfig(root), "go", { role: "implement", yes: true });
    } finally {
      restore();
    }
    const approvals = trail(root).filter((r) => r.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      tool: "bash",
      decision: "approved",
      by: "flag:--yes",
      [fixture.record.key]: fixture.record.value,
    });
  });

  it("gnomon task without --yes: nobody to ask, so the escalated call is declined -- the existing rule", async () => {
    const root = surface(`gate = "never"\nafter_refusal = "ask"`);
    const restore = scripted([REFUSED_WRITE, ROUTE_AROUND]);
    let rec;
    try {
      rec = await runTask(loadConfig(root), "go", { role: "implement" });
    } finally {
      restore();
    }
    expect(rec.counters.after_refusal_asks).toBe(1);
    const t = trail(root);
    expect(t.find((r) => r.kind === "approval")).toMatchObject({
      decision: "declined",
      by: "default:no-operator",
      escalated: AFTER_REFUSAL_REASON,
    });
    expect(t.filter((r) => r.kind === "tool_call").map((r) => r.code)).toEqual([2, 2]);
    // Off, the same run under gate = "never" asks nobody and the bash call runs.
    const plain = surface(`gate = "never"`);
    const again = scripted([REFUSED_WRITE, ROUTE_AROUND]);
    try {
      await runTask(loadConfig(plain), "go", { role: "implement" });
    } finally {
      again();
    }
    expect(trail(plain).filter((r) => r.kind === "approval")).toEqual([]);
    expect(trail(plain).filter((r) => r.kind === "tool_call").map((r) => r.code)).toEqual([2, 0]);
  });
});
