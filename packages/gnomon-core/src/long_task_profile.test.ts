/**
 * Long-task tier (a), docs/CONTRACTS.md §39, conformance/long_task_profile.json.
 *
 * - The fixture and the code agree; the keys are known to the surface audit;
 *   CONTRACTS §39 names them.
 * - `[turn] deadline_note`: "plan" is §31's text byte for byte; "continue" is
 *   one note at 0.8 in the SW1 wording. Declared at its default, or with a
 *   far deadline, every request body is master's (ae17a1ae).
 * - `[turn] prompt_profile = "unattended"`: drops the scaffold's two stop
 *   sentences (read from init.ts, the scaffold itself), adds the unattended
 *   block, turns the idle nudge off unless declared, and says on the trail
 *   what it dropped. "default" declared is master's bytes.
 * - The network refusal states what was refused and why, with no stop cue.
 * - `session_start.resolved`: the one locality rule's verdict, the replay
 *   state and the steering channel, each with its reason. Local lanes keep
 *   today's defaults (replay off, system channel) until SW1/LG2 measure them.
 *
 * Every server here is a fake on 127.0.0.1; no model is called. The deadline
 * clock is driven by the script (requests received), never by the runner.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildSystemPrompt, formatSpan, platformBlock, runTask } from "./prompt_loop.js";
import { BLOCK_KEYS, auditSurface, endpointLocality, loadConfig, resolveDeadline, resolveLoop } from "./config.js";
import {
  CONTINUE_NOTE_AT,
  DEADLINE_NOTE_STYLES,
  PROMPT_PROFILES,
  UNATTENDED_BLOCK,
  applyPromptProfile,
  deadlineNoteText,
  promptProfileBlock,
  resolveDeadlineNoteStyle,
  resolvePromptProfile,
  upfrontBudgetText,
} from "./long_task_profile.js";
import { NETWORK_REFUSAL_TAIL, bashPrecheck } from "./tools.js";
import { hostedUrl, restoreFetch, withMasterRefusal } from "./test_support.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/long_task_profile.json"), "utf-8"));

/** The scaffold's system.md, read out of init.ts: the text the profile is written against. */
function scaffoldSystemMd(): string {
  // A Windows checkout may have CRLF line endings; the template is read as LF.
  const src = readFileSync(join(REPO, "packages/gnomon-cli/src/init.ts"), "utf-8").replace(/\r\n/g, "\n");
  const start = src.indexOf("const SYSTEM_MD = `") + "const SYSTEM_MD = `".length;
  const end = src.indexOf("`;\n", start);
  return src.slice(start, end).replace(/\\`/g, "`");
}

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  restoreFetch();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

describe("conformance/long_task_profile.json", () => {
  it("the code's values, defaults and texts are the fixture's", () => {
    expect([...DEADLINE_NOTE_STYLES]).toEqual(FIXTURE.deadline_note.values);
    expect([...PROMPT_PROFILES]).toEqual(FIXTURE.prompt_profile.values);
    expect([...CONTINUE_NOTE_AT]).toEqual(FIXTURE.deadline_note.continue_at);
    expect(resolveDeadlineNoteStyle({ config: {} } as never)).toBe(FIXTURE.deadline_note.default);
    expect(resolvePromptProfile({ config: {} } as never)).toBe(FIXTURE.prompt_profile.default);
    for (const style of DEADLINE_NOTE_STYLES) {
      expect(deadlineNoteText(style, "13m", "29m")).toBe(
        FIXTURE.deadline_note.text[style].replace("{left}", "13m").replace("{total}", "29m")
      );
    }
    expect(UNATTENDED_BLOCK.startsWith(FIXTURE.prompt_profile.unattended.block_heading)).toBe(true);
    for (const line of FIXTURE.prompt_profile.unattended.block_lines) expect(UNATTENDED_BLOCK).toContain(line);
    expect(resolveLoop({ config: { turn: { prompt_profile: "unattended" } } } as never).nudge_after_idle).toBe(
      FIXTURE.prompt_profile.unattended.nudge_after_idle
    );
    const known = BLOCK_KEYS.find(([, b]) => b === "turn")![2];
    expect(known).toContain("deadline_note");
    expect(known).toContain("prompt_profile");
    for (const t of FIXTURE.locality.tiers) expect(["loopback", "private", "remote"]).toContain(t);
    expect(endpointLocality("http://127.0.0.1:1/")).toBe("loopback");
    expect(NETWORK_REFUSAL_TAIL).not.toContain(FIXTURE.network_refusal.removed);
  });

  it("CONTRACTS §39 names the keys, values, record fields and the fixture", () => {
    const contracts = readFileSync(join(REPO, "docs/CONTRACTS.md"), "utf-8");
    const s38 = contracts.split("\n## 39.")[1]!.split("\n## 40.")[0]!;
    for (const w of [
      "deadline_note",
      "prompt_profile",
      ...FIXTURE.deadline_note.values,
      ...FIXTURE.prompt_profile.values,
      ...FIXTURE.locality.tiers,
      ...FIXTURE.replay.session_start_values,
      ...FIXTURE.replay.session_start_sources,
      ...FIXTURE.steering.sources,
      ...FIXTURE.steering.call_keys,
      "steer_messages",
      FIXTURE.session_start.key,
      ...FIXTURE.session_start.target_keys,
      "temporary",
      "conformance/long_task_profile.json",
    ]) {
      expect(s38, w).toContain(w);
    }
  });

  it("the plan text is §31's, byte for byte: the note master sent", () => {
    expect(deadlineNoteText("plan", "a", "b")).toBe(
      "Time check: about a of this task's b remain before it is stopped. Plan the rest of the work, and checking it, to finish inside that."
    );
  });
});

// ---------------------------------------------------------------------------
// Resolution and the surface audit
// ---------------------------------------------------------------------------

describe("resolution and the surface audit", () => {
  const surface = (turn: Record<string, unknown>, system = "be brief\n") =>
    ({
      gnomonDir: "/x/.gnomon",
      config: { turn, endpoints: { e: { url: "https://x.example/v1/chat/completions", kind: "openai" } } },
      roles: { r: { model: "m", endpoint: "e" } },
      system: { content: system },
    }) as never;
  const problems = (turn: Record<string, unknown>, system?: string) =>
    auditSurface(surface(turn, system)).filter((p) => /deadline_note|prompt_profile|system\.md/.test(p.where));

  it("continue fixes the notes at 0.8; plan keeps deadline_notes", () => {
    expect(resolveDeadline({ config: { turn: { deadline_note: "continue" } } } as never)).toMatchObject({ notes: [0.8], style: "continue" });
    expect(resolveDeadline({ config: { turn: { deadline_note: "plan", deadline_notes: [0.3] } } } as never)).toMatchObject({ notes: [0.3], style: "plan" });
    expect(resolveDeadline({ config: { turn: { deadline_note: "none", deadline_notes: [0.3] } } } as never)).toMatchObject({ notes: [], style: "none" });
  });

  it("the unattended profile turns the nudge off unless a number is declared", () => {
    expect(resolveLoop({ config: { turn: {} } } as never).nudge_after_idle).toBe(12);
    expect(resolveLoop({ config: { turn: { prompt_profile: "unattended" } } } as never).nudge_after_idle).toBe(0);
    expect(resolveLoop({ config: { turn: { prompt_profile: "unattended", nudge_after_idle: 7 } } } as never).nudge_after_idle).toBe(7);
    expect(resolveLoop({ config: { turn: { prompt_profile: "default" } } } as never).nudge_after_idle).toBe(12);
  });

  it("a value outside either enumeration is fatal; the declared defaults are clean", () => {
    expect(problems({ deadline_note: "plan", prompt_profile: "default" })).toEqual([]);
    expect(problems({ deadline_note: "keep going" })).toEqual([expect.objectContaining({ fatal: true })]);
    expect(problems({ prompt_profile: "benchmark" })).toEqual([expect.objectContaining({ fatal: true })]);
    expect(problems({ deadline_note: true })).toEqual([expect.objectContaining({ fatal: true })]);
  });

  it("deadline_notes beside continue, and an unattended profile with nothing to drop, are said, not fatal", () => {
    for (const note of ["continue", "none"]) {
      expect(problems({ deadline_note: note, deadline_notes: [0.5] })).toEqual([
        expect.objectContaining({ fatal: false, where: expect.stringContaining("deadline_notes") }),
      ]);
    }
    expect(problems({ prompt_profile: "unattended" }, "be brief\n")).toEqual([
      expect.objectContaining({ fatal: false, where: ".gnomon/system.md" }),
    ]);
    expect(problems({ prompt_profile: "unattended" }, scaffoldSystemMd())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The unattended prompt profile against the real scaffold
// ---------------------------------------------------------------------------

describe("prompt_profile = \"unattended\" on the scaffold's system.md", () => {
  it("drops exactly the two stop sentences and leaves every other line as it was", () => {
    const md = scaffoldSystemMd();
    expect(md).toContain("Verify in proportion to the task");
    const { text, dropped } = applyPromptProfile(md, "unattended");
    expect(dropped).toBe(2);
    expect(text).not.toMatch(/Verify\s+in\s+proportion/);
    expect(text).not.toMatch(/Once\s+it\s+works\s+and\s+the\s+task's\s+requirements\s+are\s+met,\s+stop\./);
    // The bullets they ended still end cleanly, and nothing else moved.
    expect(text).toContain("Check it once against what the task asked for, in one command\n  where you can.\n- Get to");
    expect(text).toContain("a thing that was never produced scores nothing.\n- Keep prose short.");
    const removed = md.length - text.length;
    const sentences = FIXTURE.prompt_profile.unattended.drops.join("").replace(/\s+/g, "").length;
    expect(md.replace(/\s+/g, "").length - text.replace(/\s+/g, "").length).toBe(sentences);
    expect(removed).toBeGreaterThan(sentences);
    // CRLF line endings are matched the same.
    expect(applyPromptProfile(md.replace(/\n/g, "\r\n"), "unattended").dropped).toBe(2);
    // "default" is the identity, the same string.
    expect(applyPromptProfile(md, "default")).toEqual({ text: md, dropped: 0 });
  });

  it("buildSystemPrompt: the block after the session block; default is master's prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-ltp-"));
    roots.push(root);
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "system.md"), scaffoldSystemMd());
    writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.r]\nmodel = "m"\n`);
    writeFileSync(join(root, ".gnomon", "config.toml"), `[turn]\nprompt_profile = "default"\n`);
    const plain = buildSystemPrompt({ config: loadConfig(root) } as never, "r", "x");
    writeFileSync(join(root, ".gnomon", "config.toml"), ``);
    expect(buildSystemPrompt({ config: loadConfig(root) } as never, "r", "x")).toBe(plain);
    writeFileSync(join(root, ".gnomon", "config.toml"), `[turn]\nprompt_profile = "unattended"\n`);
    const un = buildSystemPrompt({ config: loadConfig(root) } as never, "r", "x");
    expect(un).not.toContain("Verify in proportion");
    expect(un).toContain(UNATTENDED_BLOCK);
    expect(un.indexOf("## This session")).toBeLessThan(un.indexOf("## Unattended run"));
    expect(plain).not.toContain("## Unattended run");
  });
});

// ---------------------------------------------------------------------------
// The network refusal
// ---------------------------------------------------------------------------

describe("the network refusal (a5)", () => {
  it("says what was refused and why, and nothing about routes", () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-ltp-net-"));
    roots.push(root);
    const ctx = {
      config: { gnomonDir: join(root, ".gnomon"), policy: {}, roles: {} },
      root,
      sandbox: "confined",
      gate: "never",
      approve: async () => true,
      timeoutMs: 0,
      maxOutputBytes: 0,
      allow: "strict",
      network: false,
    } as never;
    const r = bashPrecheck({ command: "curl -sI https://pypi.org/simple/" }, ctx);
    expect(r?.rule).toBe("network");
    expect(r!.content).toContain(`Refused: "curl -sI https://pypi.org/simple/" reaches the network`);
    expect(r!.content).toContain("[sandbox] network = false");
    expect(r!.content).toContain(NETWORK_REFUSAL_TAIL);
    expect(r!.content).not.toMatch(/another route|do not look/i);
    expect(withMasterRefusal(r!.content)).toContain("Do not look for another route to the network");
  });
});

// ---------------------------------------------------------------------------
// Byte-identity with master, and the notes under a script-driven deadline
// ---------------------------------------------------------------------------

type Kind = "openai" | "ollama";
type Step = { answer: string } | [string, Record<string, unknown>];

/** sweep_knobs.test.ts's script: the six steps master was hashed on. */
const STEPS: Step[] = [
  ["todo", { todos: [{ content: "read the file", status: "completed" }, { content: "edit the file", status: "in_progress" }, { content: "report back", status: "pending" }] }],
  ["read", { path: "f1.txt" }],
  ["edit", { path: "f1.txt", old_text: "hello 1", new_text: "hello one" }],
  ["bash", { command: "echo hi" }],
  ["bash", { command: "curl -s https://pypi.org/simple/numpy/" }],
];

function reply(kind: Kind, n: number): unknown {
  const step = STEPS[n - 1] ?? { answer: "done" };
  if ("answer" in step) {
    return kind === "openai"
      ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
      : { message: { role: "assistant", content: step.answer }, done: true, done_reason: "stop" };
  }
  const [name, args] = step;
  return kind === "openai"
    ? { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] }
    : { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: "stop" };
}

function hashOf(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  const body = withMasterRefusal(raw);
  return createHash("sha256").update(note ? body.split(note).join("") : body).digest("hex").slice(0, 12);
}

function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

/** sweep_knobs.test.ts MASTER_AE17A1AE: taken before any of this existed. */
const MASTER_AE17A1AE = {
  openai: ["99fa84abca6c", "ed0f266ead9a", "da81bfcd7c48", "903bfa0d4076", "934714e4c9d5", "145ade5b8635"],
  ollama: ["2a0a56c23277", "dc51e4a3c514", "68087d37eaa5", "cfa3853a6119", "e7a9a7ad3902", "489462142adb"],
};

async function scripted(kind: Kind, turn = "", deadlineMs?: number) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(kind, raws.length)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = kind === "openai" ? `http://127.0.0.1:${port}/v1/chat/completions` : `http://127.0.0.1:${port}/api/chat`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-ltp-bytes-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 32768\n\n[turn]\nmax_steps = 40\n${turn}\n[context]\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["bash", "edit", "read", "todo"]\nmax_steps = 40\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n`);
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n\n` +
      `[[tools]]\nname = "edit"\ndescription = "Replace one exact string in a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "todo"\ndescription = "Keep a checklist."\nenabled = true\n`
  );
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  const rec = await runTask(loadConfig(root), "read f1.txt, fix its greeting and report", {
    role: "smol",
    yes: true,
    stderr: { write() {} },
    ...(deadlineMs ? { deadline: { at: Date.now() + deadlineMs, source: "flag" as const } } : {}),
  });
  return { raws, hashes: raws.map(hashOf), rec, audit: trail(root) };
}

describe("byte-identity with master (ae17a1ae)", () => {
  for (const kind of ["openai", "ollama"] as const) {
    it(`${kind}: deadline_note = "plan" and prompt_profile = "default" declared: master's bodies`, async () => {
      const r = await scripted(kind, 'deadline_note = "plan"\nprompt_profile = "default"\n');
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.rec.surface_problems ?? []).toEqual([]);
    });
    it(`${kind}: deadline_note = "continue" under a far --deadline: master's bodies (no note is due)`, async () => {
      const r = await scripted(kind, 'deadline_note = "continue"\n', 600_000);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      const start = r.audit.find((a) => a.kind === "session_start")!;
      expect(start.deadline).toMatchObject({ notes: [0.8], note: "continue" });
    });
    it(`${kind}: undeclared, session_start.deadline has no note field`, async () => {
      const r = await scripted(kind, "", 600_000);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.audit.find((a) => a.kind === "session_start")!.deadline).not.toHaveProperty("note");
    });
  }

  it("the unattended profile changes the system prompt from the first request, and only by the block", async () => {
    const r = await scripted("openai", 'prompt_profile = "unattended"\n');
    // "be brief" has no scaffold sentence, so only the block is added.
    expect(r.hashes[0]).not.toBe(MASTER_AE17A1AE.openai[0]);
    const sys = JSON.parse(r.raws[0]!).messages[0].content as string;
    expect(sys.endsWith(`\n\n${UNATTENDED_BLOCK}`)).toBe(true);
    const start = r.audit.find((a) => a.kind === "session_start")!;
    expect(start.resolved.prompt_profile).toEqual({ name: "unattended", dropped: 0 });
    expect(r.rec.surface_problems?.some((p) => p.where === ".gnomon/system.md")).toBe(true);
  });
});

/**
 * A model that reads files until the script clock has passed 90% of the
 * budget, then answers. Each request received moves the clock on by 5% of
 * the budget, so `used` before request n is (n - 1) x 5%: the 0.5 note goes
 * out on request 11 and the 0.8 note on request 17.
 */
async function deadlineRun(turn: string, endpoint = "", task = "read the files and report", files: Record<string, string> = {}) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const n = raws.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          n >= 19
            ? { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
            : {
                choices: [
                  {
                    message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${(n % 6) + 1}.txt` }) } }] },
                    finish_reason: "tool_calls",
                  },
                ],
              }
        )
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-ltp-run-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[turn]\nnudge_after_idle = 0\ndeadline_margin_ms = 200\n${turn}\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${hostedUrl(url)}"\nkind = "openai"\nstream = false\n${endpoint}`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 200\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "read"\nenabled = true\n`);
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  const BUDGET = 100_000;
  const base = Date.now();
  const rec = await runTask(loadConfig(root), task, {
    role: "smol",
    yes: true,
    stderr: { write() {} },
    deadline: { at: base + BUDGET, source: "flag" },
    clock: () => base + raws.length * 5_000,
  });
  const notes = raws.map((raw, i) => ({
    n: i + 1,
    notes: (JSON.parse(raw).messages as Array<{ role: string; content: string }>).filter((m) => /Time check:/.test(m.content)),
  }));
  const firstWith = (re: RegExp) => notes.find((x) => x.notes.some((m) => re.test(m.content)))?.n;
  return { raws, rec, notes, firstWith, audit: trail(root) };
}

describe("the time note under --deadline (script clock)", () => {
  it("continue with deliverable_first: the missing-output note keeps going too, never after a plan-to-finish sentence", async () => {
    const r = await deadlineRun(
      'deadline_note = "continue"\ndeliverable_first = true\n',
      "",
      "Write the summary to `result.txt`. Write any Python dependencies to `requirements.txt`. Save notes as `notes.md`.",
      { "notes.md": "already here\n" }
    );
    const all = r.raws.join("");
    expect(all).not.toContain("Plan the rest of the work");
    expect(all).not.toContain("then improve it.");
    // At 0.4 (request 9) only result.txt is owed: requirements.txt is a
    // dependency manifest and notes.md was there when the run started.
    const first = r.notes.find((x) => x.notes.length > 0)!;
    expect(first.n).toBe(9);
    expect(first.notes[0]!.content).toBe(
      deadlineNoteText("continue", formatSpan(60_000), formatSpan(100_000)) +
        " These required outputs do not exist yet: result.txt. Write a first complete version now, then keep improving it."
    );
    const named = r.audit.find((a) => a.kind === "deliverable_first" && a.event === "named")!;
    expect(named).toMatchObject({ named: ["result.txt"], present: ["notes.md"] });
  });

  it("none: no time note at all, the deadline still stops the run's clock as before", async () => {
    const r = await deadlineRun('deadline_note = "none"\n');
    expect(r.rec.stop_reason).toBe("answered");
    expect(r.rec.counters.deadline_notes).toBeUndefined();
    expect(r.raws.join("")).not.toContain("Time check");
    expect(r.notes.every((x) => x.notes.length === 0)).toBe(true);
    expect(r.audit.find((a) => a.kind === "session_start")!.deadline).toMatchObject({ notes: [], note: "none" });
  });

  it("none with deliverable_first: the missing-output note alone, no countdown, keep improving", async () => {
    const r = await deadlineRun('deadline_note = "none"\ndeliverable_first = true\n', "", "Write the summary to `result.txt`.");
    const all = r.raws.join("");
    expect(all).not.toContain("Time check");
    expect(all).not.toContain("remain");
    const first = r.raws.findIndex((raw) => raw.includes("do not exist yet")) + 1;
    expect(first).toBe(9);
    const msgs = (JSON.parse(r.raws[first - 1]!).messages as Array<{ role: string; content: string }>).filter((m) =>
      m.content.includes("do not exist yet")
    );
    expect(msgs).toEqual([
      { role: "system", content: FIXTURE.deadline_note.none.deliverable_note.replace("{paths}", "result.txt") },
    ]);
    expect(r.rec.counters.deadline_notes).toBeUndefined();
    expect(r.rec.counters.deliverable_first_notes).toBeGreaterThanOrEqual(1);
  });

  it("plan with deliverable_first: §35's bytes, the plan sentence and \"then improve it\"", async () => {
    const r = await deadlineRun("deliverable_first = true\n", "", "Write the summary to `result.txt`.");
    const first = r.notes.find((x) => x.notes.length > 0)!;
    expect(first.n).toBe(9);
    expect(first.notes[0]!.content).toBe(
      deadlineNoteText("plan", formatSpan(60_000), formatSpan(100_000)) +
        " These required outputs do not exist yet: result.txt. Write a first complete version now, then improve it."
    );
  });

  it("plan, the default: notes at 0.5 and 0.8, in §31's words", async () => {
    const r = await deadlineRun("");
    expect(r.rec.stop_reason).toBe("answered");
    expect(r.rec.counters.deadline_notes).toBe(2);
    expect(r.firstWith(/Plan the rest of the work/)).toBe(11);
    expect(r.notes.at(-1)!.notes).toHaveLength(2);
    expect(r.raws.join("")).not.toContain("keep going");
  });

  it("continue: one note, at 0.8, in the SW1 words, on the steering channel", async () => {
    const r = await deadlineRun('deadline_note = "continue"\n');
    expect(r.rec.stop_reason).toBe("answered");
    expect(r.rec.counters.deadline_notes).toBe(1);
    expect(r.firstWith(/keep going and make sure the required outputs exist/)).toBe(17);
    const last = r.notes.at(-1)!.notes;
    expect(last).toHaveLength(1);
    expect(last[0]!.role).toBe("system");
    // 17 requests received before the 17th call's clock reading: 80% used of 100 s.
    expect(last[0]!.content).toBe(deadlineNoteText("continue", formatSpan(20_000 - 0), formatSpan(100_000)));
    expect(r.raws.join("")).not.toContain("Plan the rest of the work");
    expect(r.audit.find((a) => a.kind === "session_start")!.deadline).toMatchObject({ notes: [0.8], note: "continue" });
  });
});

// ---------------------------------------------------------------------------
// session_start.resolved
// ---------------------------------------------------------------------------

describe("session_start.resolved: the locality, replay and steering each run resolved", () => {
  async function startOf(url: string, endpoint = "", kind: Kind = "openai") {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(kind, 99)));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const real = (kind === "openai" ? `http://127.0.0.1:${port}/v1/chat/completions` : `http://127.0.0.1:${port}/api/chat`);
    const root = mkdtempSync(join(tmpdir(), "gnomon-ltp-start-"));
    roots.push(root);
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      `[audit]\nenabled = true\n\n[endpoints.target]\nurl = "${url === "hosted" ? hostedUrl(real) : real}"\nkind = "${kind}"\nstream = false\n${endpoint}`
    );
    writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = []\n`);
    writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
    await runTask(loadConfig(root), "say done", { role: "smol", stderr: { write() {} } });
    return trail(root).find((a) => a.kind === "session_start")!.resolved;
  }

  it("a local lane: replay off and the system channel, today's defaults, each said", async () => {
    const r = await startOf("local");
    expect(r).toEqual({
      routes: {
        smol: {
          target: { endpoint: "target", model: "m1", local: true, replay: "off", replay_source: "local_lane", steer_role: "system", steer_role_source: "default" },
        },
      },
    });
    for (const k of Object.keys(r.routes.smol.target)) expect(FIXTURE.session_start.target_keys).toContain(k);
  });

  it("a remote host: the same replay rule, the system channel", async () => {
    const r = await startOf("hosted");
    expect(r.routes.smol.target).toMatchObject({ local: false, replay: "on_reasoning", replay_source: "default", steer_role: "system", steer_role_source: "default" });
  });

  it("declared values say so; Ollama's /api/chat is off by its route", async () => {
    const r = await startOf("local", 'replay_reasoning = true\nsteer_role = "user"\n');
    expect(r.routes.smol.target).toMatchObject({ replay: "on", replay_source: "declared", steer_role: "user", steer_role_source: "declared" });
    const off = await startOf("hosted", "replay_reasoning = false\n");
    expect(off.routes.smol.target).toMatchObject({ local: false, replay: "off", replay_source: "declared" });
    const o = await startOf("local", "", "ollama");
    expect(o.routes.smol.target).toMatchObject({ replay: "off", replay_source: "ollama_route", steer_role: "system", steer_role_source: "default" });
  });
});

// ---------------------------------------------------------------------------
// SW1 arms T and PF: deadline_note = "upfront", prompt_profile = "peer",
// provider sampling
// ---------------------------------------------------------------------------

describe('deadline_note = "upfront"', () => {
  it("the text: whole minutes of the real budget, at least one, overriding the task's", () => {
    expect(upfrontBudgetText(1_740_000)).toBe(
      FIXTURE.deadline_note.upfront.first_request.replace("{minutes}", "29")
    );
    expect(upfrontBudgetText(30_000)).toBe(
      "You have 1 minute of wall time for this run; this overrides any time stated in the task."
    );
    expect(deadlineNoteText("upfront", "13m", "29m")).toBe("");
  });

  it("resolves to no countdown fractions, and a declared deadline_notes beside it is said, not fatal", () => {
    const cfg = (turn: Record<string, unknown>) => ({ config: { turn } }) as never;
    expect(resolveDeadline(cfg({ deadline_note: "upfront" }))).toMatchObject({ notes: [], style: "upfront" });
    expect(resolveDeadline(cfg({ deadline_note: "upfront", deadline_notes: [0.5] })).notes).toEqual([]);
    const surface = {
      gnomonDir: "/x/.gnomon",
      config: { turn: { deadline_note: "upfront", deadline_notes: [0.5] }, endpoints: { e: { url: "https://x.example/v1/chat/completions", kind: "openai" } } },
      roles: { r: { model: "m", endpoint: "e" } },
      system: { content: "be brief\n" },
    } as never;
    const p = auditSurface(surface).filter((x) => /deadline_note/.test(x.where));
    expect(p.map((x) => x.fatal)).toEqual([false]);
  });

  it("states the budget once, in the first request, on the steering channel; no countdown after it", async () => {
    const r = await deadlineRun('deadline_note = "upfront"\n');
    expect(r.rec.stop_reason).toBe("answered");
    const text = upfrontBudgetText(100_000);
    expect(text).toBe("You have 2 minutes of wall time for this run; this overrides any time stated in the task.");
    const first = JSON.parse(r.raws[0]!).messages as Array<{ role: string; content: string }>;
    expect(first.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(first[2]!.content).toBe(text);
    // Said once: the last request carries it once, as history, and nothing else about time.
    const last = r.raws.at(-1)!;
    expect(last.split(text).length - 1).toBe(1);
    expect(r.raws.join("")).not.toContain("Time check");
    expect(r.rec.counters.deadline_notes).toBeUndefined();
    expect(r.rec.counters.deadline_upfront).toBe(1);
    expect(r.audit.find((a) => a.kind === "session_start")!.deadline).toMatchObject({ notes: [], note: "upfront" });
  });

  it("with deliverable_first: the missing-output note alone, no countdown, keep improving", async () => {
    const r = await deadlineRun('deadline_note = "upfront"\ndeliverable_first = true\n', "", "Write the summary to `result.txt`.");
    const all = r.raws.join("");
    expect(all).not.toContain("Time check");
    expect(all).toContain(FIXTURE.deadline_note.upfront.deliverable_note.replace("{paths}", "result.txt"));
  });
});

describe('prompt_profile = "peer"', () => {
  it("drops the two stop sentences of the scaffold, adds nothing, and turns the nudge off unless declared", () => {
    const scaffold = scaffoldSystemMd();
    const peer = applyPromptProfile(scaffold, "peer");
    expect(peer.dropped).toBe(2);
    expect(peer.text).toBe(applyPromptProfile(scaffold, "unattended").text);
    for (const d of FIXTURE.prompt_profile.peer.drops) expect(peer.text.replace(/\s+/g, " ")).not.toContain(d);
    expect(promptProfileBlock("peer")).toBe(FIXTURE.prompt_profile.peer.block);
    expect(resolvePromptProfile({ config: { turn: { prompt_profile: "peer" } } } as never)).toBe("peer");
    expect(resolveLoop({ config: { turn: { prompt_profile: "peer" } } } as never).nudge_after_idle).toBe(
      FIXTURE.prompt_profile.peer.nudge_after_idle
    );
    expect(resolveLoop({ config: { turn: { prompt_profile: "peer", nudge_after_idle: 7 } } } as never).nudge_after_idle).toBe(7);
  });

  it("in a run: the system prompt is system.md less the sentences, no block; the trail names the profile", async () => {
    const r = await scripted("openai", 'prompt_profile = "peer"\n');
    const d = await scripted("openai", "");
    const sys = JSON.parse(r.raws[0]!).messages[0].content as string;
    expect(sys).toBe(JSON.parse(d.raws[0]!).messages[0].content);
    expect(sys).not.toContain("## Unattended run");
    const start = r.audit.find((a) => a.kind === "session_start")!;
    expect(start.resolved.prompt_profile).toEqual({ name: "peer", dropped: 0 });
  });
});

describe("arm PF: upfront + peer + provider sampling in one run", () => {
  it("no temperature or top_p on the wire, the budget up front, no countdown, peer on the trail", async () => {
    const r = await deadlineRun('deadline_note = "upfront"\nprompt_profile = "peer"\n', 'sampling = "provider"\n');
    for (const raw of r.raws) {
      const body = JSON.parse(raw);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
    }
    expect(JSON.parse(r.raws[0]!).messages[2].content).toBe(upfrontBudgetText(100_000));
    expect(r.raws.join("")).not.toContain("Time check");
    const start = r.audit.find((a) => a.kind === "session_start")!;
    expect(start.resolved.prompt_profile).toEqual({ name: "peer", dropped: 0 });
    expect(start.deadline).toMatchObject({ note: "upfront" });
  });
});
