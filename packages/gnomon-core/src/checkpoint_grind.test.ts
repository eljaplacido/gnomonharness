/**
 * Checkpoint, then grind (`[turn] continue_after_answer`), docs/CONTRACTS.md
 * §41, conformance/checkpoint_grind.json.
 *
 * - The fixture, the code and §41 agree; the keys are known to the surface
 *   audit and a bad value is fatal.
 * - Off (absent, false, or no --deadline): the request bodies are the ones
 *   the same run sends with nothing declared, and no checkpoint is recorded.
 * - Less than the declared share of the budget left at the answer: no
 *   continuation.
 * - The snapshot writes nothing into the graded tree.
 * - At the end: restore on a worse check, keep on better or equal, keep
 *   unverified with no check.
 *
 * Every server here is a fake on 127.0.0.1; no model is called. The clock
 * the share is read from is driven by the script, never by the runner.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { platformBlock, runTask } from "./prompt_loop.js";
import { BLOCK_KEYS, auditSurface, loadConfig } from "./config.js";
import {
  CHECKPOINT_EVENTS,
  CHECKPOINT_EXCLUDED,
  CHECK_SOURCES,
  CONTINUE_MIN_REMAINING_DEFAULT,
  continuationText,
  currentTreeHash,
  decideCheckpoint,
  passCount,
  resolveCheckpointGrind,
  restoreCheckpoint,
  roundDecision,
  scoreWorse,
  takeCheckpoint,
} from "./checkpoint_grind.js";
import { withMasterRefusal } from "./test_support.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/checkpoint_grind.json"), "utf-8"));

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** Every path under `dir`, files and directories, sorted. */
function listing(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    out.push(r);
    try {
      if (readdirSync(join(dir, r))) out.push(...listing(dir, r));
    } catch {
      /* a file */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The fixture and the surface
// ---------------------------------------------------------------------------

describe("conformance/checkpoint_grind.json", () => {
  it("the code's constants, defaults and texts are the fixture's", () => {
    expect([...CHECKPOINT_EVENTS]).toEqual(FIXTURE.events);
    expect([...CHECK_SOURCES]).toEqual(FIXTURE.check_sources);
    expect([...CHECKPOINT_EXCLUDED]).toEqual(FIXTURE.excluded);
    expect(CONTINUE_MIN_REMAINING_DEFAULT).toBeCloseTo(FIXTURE.keys.continue_min_remaining.default, 10);
    expect(resolveCheckpointGrind({ config: {} } as never)).toEqual({ on: false, min_remaining: CONTINUE_MIN_REMAINING_DEFAULT });
    expect(continuationText(10 * 60_000, true)).toBe(FIXTURE.continuation.with_time.replace("{n}", "10"));
    expect(continuationText(10 * 60_000, false)).toBe(FIXTURE.continuation.without_time);
    expect(continuationText(20_000, true)).toContain("About 1 minute remains.");
    // `[turn] continue_message`: a custom text, `{minutes}` replaced; no declared text = the default above, byte for byte
    const custom = "Saved. About {minutes} minutes remain. Check every requirement. Restored if worse.";
    expect(continuationText(10 * 60_000, true, custom)).toBe("Saved. About 10 minutes remain. Check every requirement. Restored if worse.");
    expect(continuationText(10 * 60_000, false, custom)).toBe("Saved. Check every requirement. Restored if worse.");
    expect(continuationText(10 * 60_000, true, undefined)).toBe(continuationText(10 * 60_000, true));
    expect(resolveCheckpointGrind({ config: { turn: { continue_after_answer: true, continue_message: "  x {minutes} " } } } as never))
      .toEqual({ on: true, min_remaining: CONTINUE_MIN_REMAINING_DEFAULT, message: "x {minutes}" });
  });

  it("CONTRACTS §41 names the keys, events, counters and the fixture", () => {
    const contracts = readFileSync(join(REPO, "docs/CONTRACTS.md"), "utf-8");
    const s41 = contracts.split("\n## 41.")[1]!.split("\n## 42.")[0]!;
    for (const k of Object.keys(FIXTURE.keys)) expect(s41).toContain(k);
    for (const e of CHECKPOINT_EVENTS) expect(s41).toContain(e);
    for (const o of FIXTURE.counters.outcome) expect(s41).toContain(o);
    expect(s41).toContain("conformance/checkpoint_grind.json");
  });

  it("the keys are known to the surface audit; a bad value is fatal; a stray key is said", () => {
    const turn = BLOCK_KEYS.find(([f, b]) => f === "config.toml" && b === "turn")![2];
    for (const k of Object.keys(FIXTURE.keys)) expect(turn).toContain(k);
    const surface = (t: Record<string, unknown>) => ({ config: { turn: t }, roles: {}, tools: [], policy: {} }) as never;
    const of = (t: Record<string, unknown>) =>
      auditSurface(surface(t)).filter((p) => /continue_after_answer|continue_min_remaining|checkpoint_check|continue_message|continue_max_rounds|continue_until_s/.test(p.where));
    expect(of({ continue_after_answer: true, continue_min_remaining: 0.25, checkpoint_check: "pytest -q" })).toEqual([]);
    expect(of({ continue_after_answer: "yes" }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ continue_after_answer: true, continue_min_remaining: 1.5 }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ continue_after_answer: true, checkpoint_check: "" }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ checkpoint_check: "pytest" }).map((p) => p.fatal)).toEqual([false]);
    expect(of({ continue_after_answer: true, continue_message: "Saved. {minutes} min." })).toEqual([]);
    expect(of({ continue_after_answer: true, continue_message: "" }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ continue_after_answer: true, continue_message: 3 }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ continue_message: "x" }).map((p) => p.fatal)).toEqual([false]);
    expect(of({ continue_after_answer: true, continue_max_rounds: 5, continue_until_s: 180 })).toEqual([]);
    for (const bad of [0, 1.5, "3", 21, -1]) expect(of({ continue_after_answer: true, continue_max_rounds: bad }).map((p) => p.fatal)).toEqual([true]);
    for (const bad of [0, -5, "180"]) expect(of({ continue_after_answer: true, continue_until_s: bad }).map((p) => p.fatal)).toEqual([true]);
    expect(of({ continue_max_rounds: 3 }).map((p) => p.fatal)).toEqual([false]);
    expect(of({ continue_until_s: 30 }).map((p) => p.fatal)).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// Scoring and the decision
// ---------------------------------------------------------------------------

describe("scoring", () => {
  it("reads pass counts from the common runners", () => {
    expect(passCount("===== 12 passed, 1 failed in 0.3s =====")).toBe(12);
    expect(passCount("Tests:       3 failed, 40 passed, 43 total")).toBe(40);
    expect(passCount("test result: ok. 5 passed; 0 failed\ntest result: ok. 2 passed; 0 failed")).toBe(7);
    expect(passCount("Ran 10 tests in 0.1s\n\nFAILED (failures=2, errors=1)")).toBe(7);
    expect(passCount("Ran 4 tests in 0.1s\n\nOK")).toBe(4);
    expect(passCount("--- PASS: TestA\n--- FAIL: TestB\n--- PASS: TestC")).toBe(2);
    expect(passCount("all good")).toBeUndefined();
  });

  it("worse: fails where it passed, or fewer passes; equal or better is not", () => {
    expect(scoreWorse({ exit: 0 }, { exit: 1 })).toBe(true);
    expect(scoreWorse({ exit: 1, passed: 5 }, { exit: 1, passed: 4 })).toBe(true);
    expect(scoreWorse({ exit: 1, passed: 5 }, { exit: 1, passed: 5 })).toBe(false);
    expect(scoreWorse({ exit: 1, passed: 5 }, { exit: 0, passed: 9 })).toBe(false);
    expect(scoreWorse({ exit: 0 }, { exit: 0 })).toBe(false);
  });

  it("the decision: no check, an unrunnable check or no final score keeps the final, unverified", () => {
    expect(decideCheckpoint(undefined, undefined)).toBe("checkpoint_kept_unverified");
    expect(decideCheckpoint({ exit: 127 }, { exit: 127 })).toBe("checkpoint_kept_unverified");
    expect(decideCheckpoint({ exit: 0 }, undefined)).toBe("checkpoint_kept_unverified");
    expect(decideCheckpoint({ exit: 0 }, { exit: 1, timed_out: true })).toBe("checkpoint_kept_unverified");
    expect(decideCheckpoint({ exit: 0 }, { exit: 1 })).toBe("checkpoint_restored");
    expect(decideCheckpoint({ exit: 0, passed: 3 }, { exit: 0, passed: 3 })).toBe("checkpoint_kept");
  });
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

describe("the snapshot", () => {
  it("leaves no stray file in the graded tree; the store is outside the root", () => {
    const root = tmp("gnomon-ckpt-root-");
    const store = tmp("gnomon-ckpt-store-");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "a.py"), "print(1)\n");
    writeFileSync(join(root, "src", "deep", "b.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(root, "out.json"), "{}\n");
    symlinkSync("out.json", join(root, "link.json"));
    mkdirSync(join(root, ".gnomon-audit"));
    writeFileSync(join(root, ".gnomon-audit", "t.jsonl"), "x\n");
    const before = listing(root);
    const cp = takeCheckpoint(root, { storeParent: store });
    if ("skipped" in cp) throw new Error(cp.skipped);
    expect(listing(root)).toEqual(before);
    expect(cp.store.startsWith(store)).toBe(true);
    expect([...cp.files.keys()].sort()).toEqual(["link.json", "out.json", "src/a.py", "src/deep/b.bin"]);
    expect(cp.hash).toBe(currentTreeHash(root));
    // A store inside the root is refused rather than written into the graded tree.
    expect(takeCheckpoint(root, { storeParent: join(root, "src") })).toEqual({ skipped: "the temp directory is inside the root" });
    expect(listing(root)).toEqual(before);
    // Past the limits: no checkpoint.
    expect("skipped" in takeCheckpoint(root, { storeParent: store, limits: { max_files: 2, max_bytes: 1e9 } })).toBe(true);
  });

  it("restore puts back changed and removed files, removes new ones, leaves gnomon's own dirs", () => {
    const root = tmp("gnomon-ckpt-root-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.py"), "good\n");
    writeFileSync(join(root, "keep.txt"), "k\n");
    const cp = takeCheckpoint(root, { storeParent: tmp("gnomon-ckpt-store-") });
    if ("skipped" in cp) throw new Error(cp.skipped);
    writeFileSync(join(root, "src", "a.py"), "bad\n");
    rmSync(join(root, "keep.txt"));
    mkdirSync(join(root, "new", "dir"), { recursive: true });
    writeFileSync(join(root, "new", "dir", "junk.txt"), "j\n");
    mkdirSync(join(root, ".gnomon-audit"));
    writeFileSync(join(root, ".gnomon-audit", "t.jsonl"), "trail\n");
    const r = restoreCheckpoint(cp);
    expect(r).toMatchObject({ rewritten: 2, removed: 1, verified: true });
    expect(readFileSync(join(root, "src", "a.py"), "utf-8")).toBe("good\n");
    expect(readFileSync(join(root, "keep.txt"), "utf-8")).toBe("k\n");
    expect(existsSync(join(root, "new"))).toBe(false);
    expect(readFileSync(join(root, ".gnomon-audit", "t.jsonl"), "utf-8")).toBe("trail\n");
  });
});

// ---------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------

type Step = { bash: string } | { answer: string };

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

/** The check script: "1 passed" and exit 0 while out.txt says good, else "0 passed" and exit 1. */
const CHECK_SH = `if grep -q good out.txt 2>/dev/null; then echo "1 passed"; exit 0; else echo "0 passed"; exit 1; fi\n`;

/**
 * A scripted run. Each request moves the script clock on by `stepPct` of a
 * 100 s budget; the model follows `script`, then answers "done".
 */
async function run(turn: string, script: Step[], opts: { deadline?: boolean; stepPct?: number; realMs?: number } = {}) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const n = raws.length;
      const step = script[n - 1] ?? { answer: "done" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          "answer" in step
            ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
            : {
                choices: [
                  {
                    message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.bash }) } }] },
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
  const root = tmp("gnomon-ckpt-run-");
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[turn]\nnudge_after_idle = 0\n${turn.includes("deadline_margin_ms") ? "" : "deadline_margin_ms = 200\n"}${turn}\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["bash"]\nmax_steps = 40\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n`);
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n`);
  writeFileSync(join(root, "check.sh"), CHECK_SH);
  const BUDGET = 100_000;
  const base = Date.now();
  const pct = opts.stepPct ?? 0.05;
  const rec = await runTask(loadConfig(root), "make out.txt say good", {
    role: "smol",
    yes: true,
    stderr: { write() {} },
    ...(opts.deadline === false
      ? {}
      : opts.realMs
        ? { deadline: { at: base + opts.realMs, source: "flag" as const } }
        : { deadline: { at: base + BUDGET, source: "flag" as const }, clock: () => base + raws.length * pct * BUDGET }),
  });
  const events = trail(root).filter((a) => a.kind === "checkpoint");
  const continuations = raws.map((r) => (JSON.parse(r).messages as Array<{ role: string; content: string }>).filter((m) => /saved as a checkpoint/.test(m.content)).length);
  return { raws, rec, root, events, continuations, hashes: raws.map(hashOf) };
}

const WRITE_GOOD: Step = { bash: "printf good > out.txt" };

describe("in a run under --deadline", () => {
  it("off: absent, false, or true without --deadline -- the same requests, no checkpoint", async () => {
    const script = [WRITE_GOOD, { answer: "done" }];
    const base = await run("", script);
    const off = await run("continue_after_answer = false\n", script);
    const noDeadline = await run("continue_after_answer = true\n", script, { deadline: false });
    const noDeadlineBase = await run("", script, { deadline: false });
    expect(off.hashes).toEqual(base.hashes);
    expect(noDeadline.hashes).toEqual(noDeadlineBase.hashes);
    for (const r of [base, off, noDeadline]) {
      expect(r.raws).toHaveLength(2);
      expect(r.events).toEqual([]);
      expect(r.rec.counters.checkpoint).toBeUndefined();
    }
  });

  it("less than the share left at the answer: no continuation", async () => {
    // Each request uses 40% of the budget: the answer (request 2) comes with 20% left.
    const r = await run("continue_after_answer = true\ncheckpoint_check = \"sh check.sh\"\n", [WRITE_GOOD, { answer: "done" }], { stepPct: 0.4 });
    expect(r.raws).toHaveLength(2);
    expect(r.events).toEqual([]);
    expect(r.rec.counters.checkpoint).toEqual({ v: 1, outcome: "not_reached" });
  });

  it("one continuation, then restore when the final scores worse", async () => {
    const r = await run('continue_after_answer = true\ncheckpoint_check = "sh check.sh"\ndeadline_note = "upfront"\n', [
      WRITE_GOOD,
      { answer: "first" },
      { bash: "printf bad > out.txt && mkdir -p junk && echo x > junk/stray.txt" },
      { answer: "second" },
      { answer: "never asked" },
    ]);
    expect(r.raws).toHaveLength(4);
    // Sent once, as a [gnomon] user message, with the minutes left.
    const msg = (JSON.parse(r.raws[2]!).messages as Array<{ role: string; content: string }>).at(-1)!;
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("[gnomon] " + continuationText(89_800, true));
    expect(r.continuations).toEqual([0, 0, 1, 1]);
    expect(r.raws.join("")).not.toContain("Time check");
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_restored"]);
    expect(r.events[0]).toMatchObject({ check_source: "configured", checkpoint_score: { exit: 0, passed: 1 } });
    expect(r.events[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.events[1]).toMatchObject({ how: "answer", final_score: { exit: 1, passed: 0 }, verified: true, checkpoint_hash: r.events[0]!.content_hash });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good");
    expect(existsSync(join(r.root, "junk"))).toBe(false);
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "restored", check_source: "configured" });
    expect(r.rec.stop_reason).toBe("answered");
  });

  it("continue_message: the declared text is the one continuation message, {minutes} replaced; absent = the default", async () => {
    const msg = "Saved. About {minutes} minutes remain. Write a check per requirement and run it.";
    const r = await run(`continue_after_answer = true\ncontinue_message = ${JSON.stringify(msg)}\ncheckpoint_check = "sh check.sh"\n`, [
      WRITE_GOOD,
      { answer: "first" },
      { answer: "second" },
    ]);
    const m = (JSON.parse(r.raws[2]!).messages as Array<{ role: string; content: string }>).at(-1)!;
    expect(m.content).toBe("[gnomon] " + continuationText(89_800, true, msg));
    expect(m.content).toContain("About 1 minutes remain.");
    expect(m.content).not.toContain("Run the task's checks or tests");
    expect(r.events[0]!.event).toBe("checkpoint");
  });

  it("keeps the final when it scores better or equal; the session's last passing test is the check", async () => {
    const r = await run("continue_after_answer = true\n", [
      WRITE_GOOD,
      { bash: "sh check.sh run_tests" },
      { answer: "first" },
      { bash: "printf 'good, better' > out.txt" },
      { answer: "second" },
    ]);
    // `sh check.sh run_tests` matches the test pattern (run_tests) and exited 0.
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_kept"]);
    expect(r.events[0]).toMatchObject({ check_source: "session", command: "sh check.sh run_tests" });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good, better");
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "kept", check_source: "session" });
  });

  it("no check: the final is kept, unverified; the snapshot never wrote into the tree", async () => {
    const r = await run("continue_after_answer = true\n", [
      WRITE_GOOD,
      { answer: "first" },
      { bash: "ls -a > listing.txt; printf bad > out.txt" },
      { answer: "second" },
    ]);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_kept_unverified"]);
    expect(r.events[0]).toMatchObject({ check_source: "none" });
    expect(r.events[1]).toMatchObject({ why: "no check" });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("bad");
    // What the model saw of the root right after the checkpoint: nothing of gnomon's snapshot.
    const seen = readFileSync(join(r.root, "listing.txt"), "utf-8").split("\n").filter(Boolean).sort();
    expect(seen.filter((x) => /ckpt|checkpoint/i.test(x))).toEqual([]);
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "kept_unverified", check_source: "none" });
  });

  it("the deadline's self-stop after the continuation is judged too: worse, so restored", async () => {
    // A real 6 s deadline, margin 600 ms: the model breaks the file and keeps
    // the shell busy until the stop.
    const r = await run(
      'continue_after_answer = true\ncheckpoint_check = "sh check.sh"\ndeadline_margin_ms = 600\n',
      [WRITE_GOOD, { answer: "first" }, { bash: "printf bad > out.txt; sleep 30" }, { bash: "sleep 30" }, { bash: "sleep 30" }, { bash: "sleep 30" }],
      { realMs: 6_000 }
    );
    expect(r.rec.stop_reason).toBe("deadline");
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_restored"]);
    expect(r.events[1]).toMatchObject({ how: "deadline", verified: true });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good");
  }, 20_000);
});


describe("continue_max_rounds and continue_until_s: more than one continuation", () => {
  const ROUNDS = (n: number, extra = "") => `continue_after_answer = true\ncontinue_max_rounds = ${n}\ncheckpoint_check = "sh check.sh"\n${extra}`;
  const sendCount = (r: Awaited<ReturnType<typeof run>>) => r.continuations.at(-1);

  it("the keys resolve; absent they are not in the resolved object (one continuation, unchanged)", () => {
    expect(resolveCheckpointGrind({ config: { turn: { continue_after_answer: true } } } as never)).toEqual({ on: true, min_remaining: CONTINUE_MIN_REMAINING_DEFAULT });
    expect(resolveCheckpointGrind({ config: { turn: { continue_after_answer: true, continue_max_rounds: 5, continue_until_s: 180 } } } as never))
      .toEqual({ on: true, min_remaining: CONTINUE_MIN_REMAINING_DEFAULT, max_rounds: 5, until_s: 180 });
    expect(CHECKPOINT_EVENTS).toContain("checkpoint_round");
  });

  it("roundDecision: new best when not worse, kept best when worse or unscorable, unverified without a check", () => {
    expect(roundDecision({ exit: 0, passed: 3 }, { exit: 0, passed: 3 }, true)).toBe("new_best");
    expect(roundDecision({ exit: 0, passed: 3 }, { exit: 0, passed: 4 }, true)).toBe("new_best");
    expect(roundDecision({ exit: 0, passed: 3 }, { exit: 0, passed: 2 }, true)).toBe("kept_best");
    expect(roundDecision({ exit: 0 }, { exit: 1 }, true)).toBe("kept_best");
    expect(roundDecision({ exit: 0 }, { exit: 127 }, true)).toBe("kept_best");
    expect(roundDecision({ exit: 0 }, undefined, true)).toBe("kept_best");
    expect(roundDecision({ exit: 127 }, { exit: 0 }, true)).toBe("unverified_new");
    expect(roundDecision(undefined, undefined, false)).toBe("unverified_new");
  });

  it("rounds stop at the maximum: N continuations, then the end decision", async () => {
    const r = await run(ROUNDS(3), [
      WRITE_GOOD, { answer: "a1" },
      { bash: "printf 'good 2' > out.txt" }, { answer: "a2" },
      { bash: "printf 'good 3' > out.txt" }, { answer: "a3" },
      { bash: "printf 'good 4' > out.txt" }, { answer: "a4" },
      { answer: "never asked" },
    ]);
    expect(sendCount(r)).toBe(3);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_round", "checkpoint_round", "checkpoint_kept"]);
    expect(r.events[1]).toMatchObject({ round: 2, decision: "new_best" });
    expect(r.events[2]).toMatchObject({ round: 3, decision: "new_best" });
    expect(r.events[3]).toMatchObject({ how: "answer", rounds: 3 });
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "kept", rounds: 3 });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good 4");
    // each round's message is the same one-line [gnomon] continuation
    expect(r.raws.join("")).not.toContain("Time check");
  });

  it("stops when the time left is at or under continue_until_s", async () => {
    // 10 s per request on a 100 s budget; until 50 s: answers at 80 s (first checkpoint), 60 s (round 2), 40 s (end).
    const r = await run(ROUNDS(5, "continue_until_s = 50\n"), [
      WRITE_GOOD, { answer: "a1" },
      { bash: "printf 'good 2' > out.txt" }, { answer: "a2" },
      { bash: "printf 'good 3' > out.txt" }, { answer: "a3" },
      { answer: "never asked" },
    ], { stepPct: 0.1 });
    expect(sendCount(r)).toBe(2);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_round", "checkpoint_kept"]);
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "kept", rounds: 2 });
  });

  it("the first checkpoint also needs more than continue_until_s left", async () => {
    // the answer (request 5 at 10 s each) comes with 50 s left and until = 50: no checkpoint at all.
    const r = await run(ROUNDS(5, "continue_until_s = 50\ncontinue_min_remaining = 0.01\n"), [
      { bash: "printf x > a" }, { bash: "printf y > b" }, { bash: "printf z > c" }, WRITE_GOOD, { answer: "a1" },
    ], { stepPct: 0.1 });
    expect(r.events).toEqual([]);
    expect(r.rec.counters.checkpoint).toEqual({ v: 1, outcome: "not_reached" });
  });

  it("best-so-far survives a worse round and is restored at the end", async () => {
    const r = await run(ROUNDS(3), [
      WRITE_GOOD, { answer: "a1" },                       // checkpoint 1: out.txt = good (best)
      { bash: "printf bad > out.txt" }, { answer: "a2" },     // round 2: scores worse -> best kept
      { bash: "printf worse > out.txt && echo x > junk" }, { answer: "a3" }, // round 3: worse again
      { bash: "printf worst > out.txt" }, { answer: "a4" },   // rounds spent: final worse than the best
    ]);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_round", "checkpoint_round", "checkpoint_restored"]);
    expect(r.events[1]).toMatchObject({ round: 2, decision: "kept_best", round_score: { exit: 1 }, best_score: { exit: 0 } });
    expect(r.events[2]).toMatchObject({ round: 3, decision: "kept_best", content_hash: r.events[0]!.content_hash });
    expect(r.events[3]).toMatchObject({ how: "answer", rounds: 3, checkpoint_hash: r.events[0]!.content_hash, verified: true });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good");
    expect(existsSync(join(r.root, "junk"))).toBe(false);
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "restored", rounds: 3 });
  });

  it("a later round that scores as well replaces the best; the end compares with that one", async () => {
    const r = await run(ROUNDS(2), [
      WRITE_GOOD, { answer: "a1" },
      { bash: "printf 'good v2' > out.txt" }, { answer: "a2" },   // not worse -> new best (hash changes)
      { bash: "printf bad > out.txt" }, { answer: "a3" },        // worse than the new best -> restored to v2
    ]);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_round", "checkpoint_restored"]);
    expect(r.events[1]!.decision).toBe("new_best");
    expect(r.events[1]!.content_hash).not.toBe(r.events[0]!.content_hash);
    expect(r.events[2]).toMatchObject({ checkpoint_hash: r.events[1]!.content_hash });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good v2");
  });

  it("unverified path: no check anywhere, every round takes a new checkpoint, the final tree is kept", async () => {
    const r = await run("continue_after_answer = true\ncontinue_max_rounds = 3\n", [
      WRITE_GOOD, { answer: "a1" },
      { bash: "printf 'two' > out.txt" }, { answer: "a2" },
      { bash: "printf 'three' > out.txt" }, { answer: "a3" },
      { bash: "printf 'four' > out.txt" }, { answer: "a4" },
    ]);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_round", "checkpoint_round", "checkpoint_kept_unverified"]);
    expect(r.events[1]).toMatchObject({ decision: "unverified_new", check_source: "none" });
    expect(r.events[3]).toMatchObject({ why: "no check", rounds: 3 });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("four");
    expect(r.rec.counters.checkpoint).toMatchObject({ outcome: "kept_unverified", rounds: 3 });
  });

  it("the default is unchanged: no continue_max_rounds, one continuation, no rounds field", async () => {
    const r = await run('continue_after_answer = true\ncheckpoint_check = "sh check.sh"\n', [WRITE_GOOD, { answer: "a1" }, { answer: "a2" }, { answer: "never" }]);
    expect(r.events.map((e) => e.event)).toEqual(["checkpoint", "checkpoint_kept"]);
    expect(r.rec.counters.checkpoint).toEqual({ v: 1, outcome: "kept", check_source: "configured", left_s: expect.any(Number) });
  });
});
