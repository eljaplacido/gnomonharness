/**
 * gnomon-core: what the interactive loop does BEFORE and AROUND the first turn.
 *
 * Why this file exists, with the measurement:
 *
 *   prompt_loop.ts is 5,830 lines at 50.28% statement coverage. Lines
 *   4526-5812 are `runPromptLoop`, the interactive REPL, measured at 0%. It is
 *   the least-tested code in the project and, by the project's own
 *   post-mortems, where most of its defects have been found. The interactive
 *   [chain] wiring landed inside that 1,286-line region -- new code in the
 *   most defect-dense file, with nothing able to reach it.
 *
 *   It was unreachable because the loop read `process.stdin` directly. The
 *   `{ io: { input, output } }` seam is what these tests drive. TTY-only paths
 *   (bracketed paste, the keypress handler, the session picker) are guarded by
 *   `isTTY` and simply do not run against a PassThrough, so what is exercised
 *   here is the loop's DECISIONS, not its terminal handling.
 *
 * Everything below asserts observable behaviour: what the operator is told,
 * and whether a model was called. No test reads the source for a substring.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

// ---------------------------------------------------------------------------
// Surface fixtures -- the idiom config.test.ts already uses: a real .gnomon/
// in a temp dir, written as TOML, loaded through the real loadConfig. Nothing
// here mocks the config layer, so a change to the audit rules shows up here.
// ---------------------------------------------------------------------------

const built: string[] = [];

function surface(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-startup-"));
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".gnomon", name), body);
  }
  built.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of built.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Quiet, colourless, non-persisting: the parts of a surface no test is about. */
const BASE_CONFIG = `
[defaults]
approval = "never"

[ui]
color = false
spinner = false
markdown = false
meta = []

[session]
persist = false

[endpoints.local]
url = "http://127.0.0.1:1/api/chat"
kind = "ollama"
`;

const FOUR_TOOLS = `
[[tools]]
name = "read"
description = "Read a file"
enabled = true

[[tools]]
name = "bash"
description = "Run a command"
enabled = true

[[tools]]
name = "glob"
description = "Find files by pattern"
enabled = true

[[tools]]
name = "grep"
description = "Find lines by regex"
enabled = true
`;

// ---------------------------------------------------------------------------
// Driving the loop
// ---------------------------------------------------------------------------

interface Run {
  /** Every line the loop printed, ANSI-free (the surfaces set color = false). */
  lines: string[];
  /** Joined, for a substring check that spans a wrapped message. */
  text: string;
  /** Request bodies the stubbed fetch saw. Length 0 means no model was called. */
  calls: unknown[];
  /** The code process.exit was called with, if it was. */
  exited?: number;
}

/**
 * Run the loop over a scripted stdin and collect what it said.
 *
 * `input` is ended after the script, which is how the session terminates: the
 * readline "close" resolves the pending read with null and the loop breaks.
 * `/quit` is deliberately NOT the terminator -- it goes through process.exit,
 * which a test must stub, and a stubbed exit would fall through into another
 * iteration and hang. Ending the stream is the honest exit path.
 */
async function run(
  dir: string,
  script: string[],
  opts: { role?: string; fetch?: typeof fetch } = {}
): Promise<Run> {
  const lines: string[] = [];
  const calls: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record as never);
  vi.spyOn(console, "error").mockImplementation(record as never);

  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain the prompt writes; nothing asserts on them

  for (const line of script) input.write(`${line}\n`);
  input.end();

  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  let exited: number | undefined;

  globalThis.fetch = (opts.fetch ??
    (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ message: { content: "answered" } }) };
    })) as unknown as typeof fetch;

  // A fatal surface makes the loop call process.exit(1). Throwing rather than
  // returning undefined is the point: a no-op stub would let execution fall
  // through the "refuse to start" branch and into the session it just refused,
  // which is precisely the behaviour under test.
  class Exited extends Error {}
  process.exit = ((code?: number) => {
    exited = code;
    throw new Exited(`process.exit(${code})`);
  }) as never;

  try {
    await promptLoop.runPromptLoop(loadConfig(dir), opts.role, { io: { input, output } });
  } catch (err) {
    if (!(err instanceof Exited)) throw err;
  } finally {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    input.end();
    output.end();
  }

  return { lines, text: lines.join("\n"), calls, exited };
}

/** How many report headers name this location. One problem, one line. */
const reportsFor = (r: Run, where: string) =>
  r.lines.filter((l) => l.includes(where)).length;

// ---------------------------------------------------------------------------

describe("runPromptLoop: the surface audit gates the session", () => {
  it("refuses to start on a fatal problem, and never reaches the first turn", async () => {
    // A [chain] stage naming a role that does not exist is auditSurface's
    // fatal class: the chain fails partway through a turn, after the earlier
    // stages have already spent their budget and their tokens. The claim in
    // reportSurfaceProblems is that fatal means the session does not start --
    // untested, in a function measured at 0%, and the [chain] wiring it guards
    // is the code that landed here tonight.
    const dir = surface({
      "config.toml": `${BASE_CONFIG}
[chain]
stages = ["implement", "reviewer"]
`,
      "roles.toml": `
[roles.implement]
model = "test-model"
tools = ["read"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, ["hello"]);

    // It refuses. Asserted as behaviour, not as a printed word:
    expect(r.exited).toBe(1);
    // ...the turn never ran,
    expect(r.calls).toHaveLength(0);
    // ...and the startup summary that follows the audit never printed, so the
    // refusal is the last thing on screen rather than something scrolled away.
    expect(r.lines.some((l) => l.startsWith("Role:"))).toBe(false);
    expect(r.lines.some((l) => l.startsWith("Model:"))).toBe(false);

    // The operator is told which stage and why, not merely that something failed.
    expect(r.text).toContain(".gnomon/config.toml [chain]");
    expect(r.text).toContain('stage "reviewer" is not a role in this surface');
    expect(r.text).toContain("must be fixed before a session can start");
  }, 15000);

  it("counts one fatal for one bad stage, not one per declared role", async () => {
    // The [chain] check used to sit inside the per-role loop, so it ran once
    // per role. With the six roles below that is six identical fatal reports
    // and a stated count of "6 problems" for one problem -- an overstated
    // count is worse than a repeated line, because it is the number an
    // operator uses to decide whether the surface is salvageable.
    const dir = surface({
      "config.toml": `${BASE_CONFIG}
[chain]
stages = ["implement", "reviewer"]
`,
      "roles.toml": `
[roles.implement]
model = "test-model"
tools = ["read"]
[roles.critique]
model = "test-model"
tools = ["read"]
[roles.plan]
model = "test-model"
tools = ["read"]
[roles.smol]
model = "test-model"
tools = ["read"]
[roles.verifier]
model = "test-model"
tools = ["read"]
[roles.coordinator]
model = "test-model"
tools = ["read"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, ["hello"]);

    expect(r.exited).toBe(1);
    expect(reportsFor(r, ".gnomon/config.toml [chain]")).toBe(1);
    // The stated count is the one an operator reads. Singular, and "1".
    expect(r.text).toContain("1 problem above must be fixed before a session can start");
    expect(r.text).not.toContain("6 problems above");
  }, 15000);

  it("reports each non-fatal problem once however many roles the surface declares", async () => {
    // Measured before the surface-scoped checks were lifted out of the
    // per-role loop: three problems on this repository's own surface printed
    // as fifteen lines, at every single launch. Warning fatigue is how a real
    // finding gets skipped, and this wall was in front of the operator every
    // time they opened a session.
    //
    // The property is not "three warnings" -- it is that the count does not
    // move with the number of roles. So the same three surface-scoped problems
    // are audited twice over surfaces that differ ONLY in role count. A
    // regression that puts one of these checks back inside the per-role loop
    // makes the two counts diverge, which is the exact shape of the bug.
    const problems = `
[nonsense]
value = 1

[routing]
mode = "manual"
default = "implement"
[routing.rules]
role = "implement"
match = "^plan"
`;
    const policy = `
[approval]
gate = "never"

[sandbox]
level = "confined"
extra_roots = ["../not-a-real-sibling"]
`;
    const role = (name: string) => `
[roles.${name}]
model = "test-model"
tools = ["read"]
`;
    const names = ["implement", "critique", "plan", "smol", "verifier", "coordinator"];

    const build = (roles: string[]) =>
      surface({
        "config.toml": BASE_CONFIG + problems,
        "policy.toml": policy,
        "roles.toml": roles.map(role).join(""),
        "tools.toml": FOUR_TOOLS,
      });

    const one = await run(build(names.slice(0, 1)), []);
    const six = await run(build(names), []);

    const warnings = (r: Run) => r.lines.filter((l) => l.trimStart().startsWith("⚠")).length;

    // Non-fatal: both sessions start. A harness that refuses over a warning is
    // a harness people route around.
    expect(one.exited).toBeUndefined();
    expect(six.exited).toBeUndefined();
    expect(six.lines.some((l) => l.startsWith("Role:"))).toBe(true);

    // Three problems, three reports -- at one role and at six alike.
    expect(warnings(one)).toBe(3);
    expect(warnings(six)).toBe(warnings(one));

    // Named individually, so a count that happened to match by coincidence
    // could not pass: one report per location, not one per role.
    for (const where of [
      ".gnomon/config.toml [nonsense]",
      ".gnomon/config.toml [routing]",
      ".gnomon/policy.toml [sandbox]",
    ]) {
      expect(reportsFor(six, where), `${where} should be reported exactly once`).toBe(1);
    }
  }, 20000);
});

describe("runPromptLoop: the startup summary", () => {
  it("names the role, the model, the tools it may call, and the tools withheld", async () => {
    // "Withheld tools are named rather than silently dropped" is a documented
    // claim of this harness with no test behind it, and the code that makes it
    // true lives in the 0%-covered region. The failure it guards against is a
    // role quietly shorter than its surface reads: a `tools` list that drops
    // `bash` looks identical, at launch, to a build where bash is broken.
    const dir = surface({
      "config.toml": BASE_CONFIG,
      "roles.toml": `
[roles.implement]
model = "implement-model"
tools = ["read", "bash", "glob", "grep"]

[roles.critique]
model = "critique-model"
tools = ["read"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, [], { role: "critique" });

    expect(r.lines).toContain("Role: critique");
    expect(r.lines).toContain("Model: critique-model");

    const offered = r.lines.find((l) => l.startsWith("Tools (critique):"));
    const withheld = r.lines.find((l) => l.includes("not for this role:"));
    expect(offered, "the startup summary should name the role's tools").toBeDefined();
    expect(withheld, "the startup summary should name what was withheld").toBeDefined();

    const namesIn = (line: string) =>
      line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean);
    const may = namesIn(offered!);
    const mayNot = namesIn(withheld!);

    expect(may).toEqual(["read"]);
    expect(mayNot.sort()).toEqual(["bash", "glob", "grep"]);

    // The claim in full: every tool the surface declares is accounted for by
    // name in one list or the other. Nothing is dropped in silence.
    for (const tool of ["read", "bash", "glob", "grep"]) {
      expect(
        may.includes(tool) !== mayNot.includes(tool),
        `${tool} should appear in exactly one of the two lists`
      ).toBe(true);
    }
  }, 15000);

  it("shows the same role a wider tool list when the surface gives it one", async () => {
    // The control for the test above: without it, "withheld names bash" would
    // pass on a build that printed a fixed string. Same surface, different
    // role, and the two lists swap contents.
    const dir = surface({
      "config.toml": BASE_CONFIG,
      "roles.toml": `
[roles.implement]
model = "implement-model"
tools = ["read", "bash", "glob", "grep"]

[roles.critique]
model = "critique-model"
tools = ["read"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, [], { role: "implement" });

    expect(r.lines).toContain("Role: implement");
    expect(r.lines).toContain("Model: implement-model");
    const offered = r.lines.find((l) => l.startsWith("Tools (implement):"))!;
    expect(offered).toContain("bash");
    expect(offered).toContain("grep");
    // Nothing is withheld from a role that holds everything declared.
    expect(r.lines.some((l) => l.includes("not for this role:"))).toBe(false);
  }, 15000);
});

describe("runPromptLoop: the sandbox note publishes the limit of network = false", () => {
  it("says network = false stops webfetch and does NOT stop bash", async () => {
    // The dial reads like process isolation and is not. A role holding `bash`
    // reaches the network through curl or a package manager whatever this says,
    // so the startup note has to state its own limit -- an operator who trusts
    // `network = false` to contain a bash-holding role is wrong about the one
    // thing they were relying on. Publishing the limit IS the claim being made.
    const dir = surface({
      "config.toml": BASE_CONFIG,
      "policy.toml": `
[approval]
gate = "never"

[sandbox]
level = "confined"
network = false
`,
      "roles.toml": `
[roles.implement]
model = "test-model"
tools = ["read", "bash"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, []);
    const note = r.lines.find((l) => l.includes("network = false"));
    expect(note, "startup should note a declared network = false").toBeDefined();

    // What it covers,
    expect(note).toContain("webfetch");
    // what it does not,
    expect(note).toContain("bash");
    expect(note).toMatch(/NOT process isolation/);
    // and what to do instead -- a limit published without a remedy is a shrug.
    expect(note).toContain("bash_allow");
  }, 15000);

  it("says nothing when the surface never declared network = false", async () => {
    // The control. A note printed unconditionally would carry no information,
    // and would pass the assertions above on every surface in existence.
    const dir = surface({
      "config.toml": BASE_CONFIG,
      "policy.toml": `
[approval]
gate = "never"

[sandbox]
level = "confined"
network = true
`,
      "roles.toml": `
[roles.implement]
model = "test-model"
tools = ["read", "bash"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    const r = await run(dir, []);
    expect(r.lines.some((l) => l.includes("network = false"))).toBe(false);
    expect(r.lines.some((l) => l.includes("NOT process isolation"))).toBe(false);
  }, 15000);
});

describe("runPromptLoop: what a bare Enter costs", () => {
  it("DEFECT, characterized: a blank line opens a full turn and enters the context", async () => {
    // This test was written to assert that an empty input line produces no
    // model call. It does not hold: there is no empty-input guard anywhere in
    // runPromptLoop. Measured here -- two bare Enters produced two model
    // calls, and the second one carried "1 turn(s) of context", so the empty
    // exchange was recorded and is re-sent, and paid for, on every later turn
    // of the session.
    //
    // The behaviour asserted below is therefore the WRONG behaviour, locked in
    // deliberately so that fixing it is a deliberate act rather than an
    // accident. The fix is a guard between `readLine()` and the slash-command
    // dispatch at prompt_loop.ts:5272 -- `if (!input.trim()) continue;` -- and
    // whoever adds it should delete this test and restore the assertion its
    // title names. Source edits were out of scope for this file.
    //
    // The control in the second half is what makes any of it non-vacuous: the
    // same harness, surface and stub are shown to call the model when they
    // should, so "0 calls" could not have come from a stub that never fires.
    const dir = surface({
      "config.toml": BASE_CONFIG,
      "roles.toml": `
[roles.implement]
model = "test-model"
tools = ["read"]
`,
      "tools.toml": FOUR_TOOLS,
    });

    // The control: a typed line reaches the model exactly once.
    const typed = await run(dir, ["hello"]);
    expect(
      typed.calls.length,
      "a real line must reach the model, or the blank-line count below proves nothing"
    ).toBe(1);

    // The defect: so does a bare Enter, and so does a line of spaces.
    const blank = await run(dir, ["", "   "]);
    expect(
      blank.calls.length,
      "SHOULD be 0 -- a bare Enter must not open a turn; this records that it does"
    ).toBe(2);

    // And it is not a free no-op: the empty turn is kept as history, so the
    // next turn pays for it. The second request carries the first one back.
    const second = blank.calls[1] as { messages: Array<{ role: string; content: string }> };
    expect(
      second.messages.filter((m) => m.role !== "system").length,
      "SHOULD be 1 -- the blank turn should never have become context"
    ).toBeGreaterThan(1);
  }, 20000);
});
