/**
 * gnomon-core: session persistence and resume, driven through the interactive loop
 *
 * Why this file exists
 * -------------------
 * docs/EVIDENCE.md records session resume as verified by a single live pty run
 * against a real model. There was no automated test of it, because there was no
 * way in: `runPromptLoop` read `process.stdin` directly, and the 1,286-line
 * region it occupies (prompt_loop.ts 4526-5812) measured 0% statement coverage
 * inside a 5,800-line file at 50.28% overall — the least-tested code in the
 * project, and by the project's own post-mortems the place most defects have
 * been found.
 *
 * session_store.test.ts already pins the STORE: saveSession, loadSession,
 * pruning, format refusal. None of that is the loop. What was untested is the
 * wiring — whether a turn actually persists, whether `--resume` puts the
 * restored conversation back in front of the model, whether the drift warning
 * the module header promises is ever printed. Those decisions live in the 0%
 * region, and each one is asserted here on observable behaviour: the bytes on
 * disk, the request body the model would have received, the lines printed.
 *
 * How it is driven
 * ----------------
 * Through the `{ io }` seam with a `stream.PassThrough`, so every isTTY-guarded
 * path (paste markers, keypress cancel, the interactive session picker) is
 * inert and what runs is the loop's decisions rather than its terminal
 * handling. `fetch` is replaced for every test: nothing here reaches a network,
 * a local model, or a key. `process.exit` is replaced too — `/quit` and the
 * failed-resume path both call it, and an unstubbed exit would take the test
 * runner with it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, recomputeManifest } from "./config.js";
import { runPromptLoop } from "./prompt_loop.js";
import {
  resolveSessionStore,
  listSessions,
  loadSession,
} from "./session_store.js";

// Every test gets its own surface; they are torn down together.
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * A surface small enough to reason about and complete enough to start a
 * session: one role, one endpoint, colour and spinner off so printed output can
 * be asserted verbatim.
 *
 * `marker` goes into system.md, which is hashed with the rest of the surface —
 * changing it is how the drift test moves the surface hash between two runs.
 */
function makeSurface(
  opts: { session?: string; marker?: string } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-loopsess-"));
  roots.push(root);
  const g = join(root, ".gnomon");
  mkdirSync(g, { recursive: true });
  writeFileSync(
    join(g, "config.toml"),
    [
      "[defaults]",
      "max_context_tokens = 8192",
      "",
      "[endpoints.local]",
      // Never contacted: fetch is stubbed. Port 9 (discard) so an escaped
      // request fails immediately instead of hanging a test.
      'url = "http://127.0.0.1:9/api/chat"',
      'kind = "ollama"',
      "",
      "[ui]",
      "color = false",
      "spinner = false",
      "",
      opts.session ?? "[session]\npersist = true\n",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(g, "roles.toml"),
    '[roles.implement]\nmodel = "stub-model"\nendpoint = "local"\ntools = []\n'
  );
  writeFileSync(
    join(g, "system.md"),
    `You are a stub under test.${opts.marker ?? ""}\n`
  );
  return root;
}

interface Driven {
  /** Everything the loop printed, console.log and console.error alike. */
  log: string;
  /** Each request body the loop would have sent to the model, in order. */
  bodies: any[];
  /** Codes passed to process.exit while the loop ran. */
  exits: number[];
}

/**
 * Run one whole session in-process and return what it did.
 *
 * The input is pre-filled and closed: readline sees the lines, then EOF, so the
 * loop always terminates even when an assertion is wrong. Every test also
 * carries its own timeout — a hanging test is worse than a missing one.
 */
async function drive(
  root: string,
  lines: string[],
  opts: {
    resume?: string | true;
    role?: string;
    answer?: (body: any) => string;
  } = {}
): Promise<Driven> {
  const config = loadConfig(root);

  const input = new PassThrough();
  for (const l of lines) input.write(`${l}\n`);
  input.end();

  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });

  const printed: string[] = [];
  const bodies: any[] = [];
  const exits: number[] = [];

  const realLog = console.log;
  const realError = console.error;
  const realFetch = globalThis.fetch;
  const realExit = process.exit;

  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
  }) as unknown as typeof process.exit;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const content = opts.answer ? opts.answer(body) : "acknowledged";
    return { ok: true, json: async () => ({ message: { content } }) };
  }) as unknown as typeof fetch;

  try {
    await runPromptLoop(config, opts.role, {
      io: { input, output },
      resume: opts.resume,
    });
  } finally {
    console.log = realLog;
    console.error = realError;
    globalThis.fetch = realFetch;
    process.exit = realExit;
  }

  return { log: printed.concat(written).join("\n"), bodies, exits };
}

const storeOf = (root: string) => resolveSessionStore(loadConfig(root));
const snapshots = (root: string) => {
  const dir = join(root, ".gnomon-sessions");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};

describe("session persistence through the interactive loop", () => {
  it(
    "a completed turn leaves a snapshot in the resolved session directory",
    async () => {
      // The store's saveSession has tests. Whether the LOOP ever calls it did
      // not: persist() is invoked from inside the 0%-coverage region, and a
      // session that is never written is a session that cannot be resumed.
      const root = makeSurface();

      await drive(root, ["remember the codeword BANANA", "/quit"]);

      const files = snapshots(root);
      expect(files, "one turn should have produced one snapshot").toHaveLength(1);

      const snap = loadSession(storeOf(root));
      expect(snap.exchanges).toHaveLength(1);
      expect(snap.exchanges[0].input).toBe("remember the codeword BANANA");
      expect(snap.exchanges[0].output).toBe("acknowledged");
      expect(snap.exchanges[0].code).toBe(0);
      expect(snap.currentRole).toBe("implement");
      expect(snap.cwd).toBe(process.cwd());
    },
    20000
  );

  it(
    "writing a snapshot does not move the surface hash",
    async () => {
      // The store's module header gives this as the reason sessions live in
      // .gnomon-sessions/ rather than .gnomon/: "a session file written inside
      // it would change the surface hash on every turn and make drift
      // detection meaningless". resolveSessionStore's directory choice is
      // tested; the consequence — a real turn writing a real snapshot and the
      // hash holding still — is only observable by running one.
      const root = makeSurface();
      const before = recomputeManifest(join(root, ".gnomon")).surface_hash;

      await drive(root, ["do a thing", "/quit"]);

      expect(snapshots(root)).toHaveLength(1);
      const after = recomputeManifest(join(root, ".gnomon")).surface_hash;
      expect(after).toBe(before);
    },
    20000
  );

  it(
    "persist = false writes no snapshot, though the session directory still appears",
    async () => {
      // Two things at once, and the second is why this test is not just
      // `expect(existsSync(dir)).toBe(false)`: command history is written to
      // the SAME directory and is not gated by [session].persist, so the
      // directory exists either way. Asserting on its absence would pass today
      // for the wrong reason and fail the day history moved.
      const root = makeSurface({ session: "[session]\npersist = false\n" });

      await drive(root, ["do a thing", "/quit"]);

      expect(snapshots(root)).toEqual([]);
      expect(
        existsSync(join(root, ".gnomon-sessions", "history")),
        "history is written regardless, so the directory is not the signal"
      ).toBe(true);
      expect(listSessions(storeOf(root))).toEqual([]);
    },
    20000
  );
});

describe("resuming a session through the interactive loop", () => {
  it(
    "resume by id restores the conversation and puts it in front of the next turn",
    async () => {
      // The point of resume is not that a file is read — it is that the model
      // sees the earlier conversation on the next turn. Asserting on the
      // restored `state.exchanges` alone would pass even if buildMessages never
      // received them, so this asserts on the request body the loop built.
      const root = makeSurface();

      await drive(root, ["the codeword is BANANA", "/quit"], {
        answer: () => "noted: BANANA",
      });
      const id = loadSession(storeOf(root)).id;

      const second = await drive(root, ["what was the codeword?", "/quit"], {
        resume: id,
      });

      expect(second.log).toContain(`Resumed ${id} — 1 turn(s)`);

      // The surface did not move between the two runs, so the drift warning
      // must NOT fire. Without this, the drift test below could be passing on
      // a warning that is printed unconditionally.
      expect(second.log).not.toContain("the surface changed since this session ran");

      const sent = second.bodies.at(-1);
      expect(sent, "the resumed turn should have called the model").toBeDefined();
      const roles = sent.messages.map((m: any) => m.role);
      const texts = sent.messages.map((m: any) => m.content);
      expect(texts).toContain("the codeword is BANANA");
      expect(texts).toContain("noted: BANANA");
      // Replayed in order and in the right roles: the user's line as user, the
      // model's answer as assistant, the new question last.
      const askedAt = texts.indexOf("the codeword is BANANA");
      const answeredAt = texts.indexOf("noted: BANANA");
      expect(roles[askedAt]).toBe("user");
      expect(roles[answeredAt]).toBe("assistant");
      expect(answeredAt).toBeGreaterThan(askedAt);
      expect(texts.at(-1)).toBe("what was the codeword?");

      // The resumed turn continues the same session rather than forking one.
      expect(snapshots(root)).toHaveLength(1);
      const after = loadSession(storeOf(root));
      expect(after.id).toBe(id);
      expect(after.exchanges.map((e) => e.input)).toEqual([
        "the codeword is BANANA",
        "what was the codeword?",
      ]);
      expect(after.exchanges.map((e) => e.turn)).toEqual([1, 2]);
    },
    30000
  );

  it(
    "resume: true picks the most recent session, not the first one on disk",
    async () => {
      // `--resume` with no id is the common case. listSessions returns newest
      // last and loadSession takes entries[length - 1]; whether the LOOP asks
      // for that, rather than for entries[0], is what decides whether a user
      // reopening yesterday's work gets yesterday's work.
      const root = makeSurface();

      await drive(root, ["the FIRST session said ALPHA", "/quit"]);
      // Session ids are timestamp-derived (ISO to the millisecond, plus pid).
      // Guarantee two distinct ones rather than letting a fast machine collide
      // them into a single overwritten snapshot, which would leave the
      // assertion below passing for the wrong reason. The length check that
      // follows makes a collision fail loudly rather than silently.
      await new Promise((r) => setTimeout(r, 25));
      await drive(root, ["the SECOND session said OMEGA", "/quit"]);

      const entries = listSessions(storeOf(root));
      expect(entries, "the two runs must be two snapshots").toHaveLength(2);
      const newest = entries[entries.length - 1];
      expect(newest.opening).toBe("the SECOND session said OMEGA");

      const resumed = await drive(root, ["carry on", "/quit"], { resume: true });

      expect(resumed.log).toContain(`Resumed ${newest.id}`);
      const sent = resumed.bodies.at(-1);
      const texts = sent.messages.map((m: any) => m.content).join("\n");
      expect(texts).toContain("the SECOND session said OMEGA");
      expect(texts).not.toContain("the FIRST session said ALPHA");
    },
    40000
  );

  it(
    "a snapshot records the surface hash it ran under, and resuming across a changed surface states the difference",
    async () => {
      // session_store.ts's header: "Behaviour comes from the surface, never
      // from the snapshot ... If the surface changed in between, the snapshot
      // records the hash it ran under so the difference is stated rather than
      // silently carried forward." Only the loop can honour that promise — the
      // store just carries the field — and the comparison sits in the 0%
      // region. A resumed session whose rules quietly changed underneath it is
      // exactly the failure this harness exists to prevent.
      const root = makeSurface({ marker: " rev-one" });
      const hashAtSave = recomputeManifest(join(root, ".gnomon")).surface_hash;

      await drive(root, ["begin under the old rules", "/quit"]);
      const saved = loadSession(storeOf(root));
      expect(saved.surface_hash).toBe(hashAtSave);
      expect(saved.surface_hash).not.toBe("");

      // Move the surface. system.md is hashed with the rest of it.
      writeFileSync(
        join(root, ".gnomon", "system.md"),
        "You are a stub under test. rev-two, materially different.\n"
      );
      const hashNow = recomputeManifest(join(root, ".gnomon")).surface_hash;
      expect(hashNow, "editing system.md must move the surface hash").not.toBe(
        hashAtSave
      );

      const resumed = await drive(root, ["continue", "/quit"], {
        resume: saved.id,
      });

      expect(resumed.log).toContain("the surface changed since this session ran");
      // Both sides named, so the difference is actionable rather than a vague
      // "something changed".
      expect(resumed.log).toContain(
        `${hashAtSave.slice(0, 12)} → ${hashNow.slice(0, 12)}`
      );
      expect(resumed.log).toContain(
        "the replayed history was produced under the older one"
      );

      // Stated, not refused: the conversation is still restored and still
      // reaches the model. Silently dropping it would be a different bug.
      expect(resumed.log).toContain(`Resumed ${saved.id} — 1 turn(s)`);
      const texts = resumed.bodies.at(-1).messages.map((m: any) => m.content);
      expect(texts).toContain("begin under the old rules");

      // And the new snapshot records the hash it is running under NOW, so the
      // next resume compares against the surface that produced the last turn.
      expect(loadSession(storeOf(root)).surface_hash).toBe(hashNow);
    },
    30000
  );

  it(
    "resuming an id that does not exist is reported by name, lists what is available, and does not crash",
    async () => {
      // The failure path is `console.error(...)` then `process.exit(1)`. A
      // thrown stack trace here would be indistinguishable from a harness bug,
      // and a silent fallback to a fresh session would be worse: the operator
      // would keep working, believing the earlier conversation was underneath.
      //
      // Honest about the seam: process.exit is stubbed, so under test the loop
      // continues past it and goes on to open a fresh session. What is asserted
      // is therefore what the loop REPORTED and the exit code it asked for —
      // not that the process ended, which no in-process test can observe.
      const root = makeSurface();
      await drive(root, ["something worth resuming", "/quit"]);
      const real = loadSession(storeOf(root)).id;

      const bad = await drive(root, ["/quit"], { resume: "not-a-session" });

      expect(bad.log).toContain('No session "not-a-session"');
      expect(bad.log, "it should say which sessions do exist").toContain(real);
      expect(bad.exits).toContain(1);
      // Nothing was resumed, so no earlier conversation is claimed to be
      // underneath the new session.
      expect(bad.log).not.toContain("Resumed ");
    },
    30000
  );

  it(
    "resuming into an empty store reports that rather than starting silently",
    async () => {
      const root = makeSurface();

      const bad = await drive(root, ["/quit"], { resume: true });

      expect(bad.log).toMatch(/No sessions in .*\.gnomon-sessions/);
      expect(bad.exits).toContain(1);
    },
    20000
  );
});
