/**
 * gnomon-core: the declared [chain], as the INTERACTIVE loop actually runs it.
 *
 * Why this file exists, precisely:
 *
 * prompt_loop.ts is 5,830 lines at 50.28% statement coverage, and lines
 * 4526-5812 -- runPromptLoop, the interactive REPL -- were measured at 0%. It
 * is the least-tested code in the project and, by the project's own
 * post-mortems, where most defects have been found. The [chain] wiring landed
 * inside exactly that range.
 *
 * That combination has already produced the bug once: an earlier version of
 * this same feature was wired into runTask ONLY, so a surface declaring
 * [chain] ran three stages from `gnomon task` and one role from
 * `gnomon prompt` -- same surface, same hash, different behaviour per entry
 * point, for several commits. Nothing caught it because nothing drove the
 * interactive path. The chain tests that did exist (prompt_loop.test.ts,
 * "a declared chain is the shape of the turn") assert on
 * `String(promptLoop.runTask)` containing substrings, which cannot observe the
 * loop at all: they would pass unchanged with the interactive wiring deleted.
 *
 * These tests drive the real runPromptLoop through the `io` seam and assert on
 * what reaches the (stubbed) endpoint -- which roles ran, in what order, and
 * what text each was handed. No network, no local model, no API key: fetch is
 * replaced for the duration of each call and restored in a finally.
 *
 * TTY-only paths are guarded by isTTY and do not run against a PassThrough, so
 * what is exercised here is the loop's decisions, not its terminal handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runPromptLoop } from "./prompt_loop.js";

// ---------------------------------------------------------------------------
// Apparatus
// ---------------------------------------------------------------------------

/** Temp surfaces to remove after each test. */
const built: string[] = [];

/** Everything the loop wrote to console.log, for the rare assertion on it. */
let printed: string[] = [];

let realLog: typeof console.log;
let realError: typeof console.error;
let realExit: typeof process.exit;

beforeEach(() => {
  realLog = console.log;
  realError = console.error;
  realExit = process.exit;
  printed = [];
  console.log = (...args: unknown[]) => {
    printed.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    printed.push(args.map((a) => String(a)).join(" "));
  };
  // runPromptLoop calls process.exit(1) when the surface has a FATAL problem.
  // Left alone that kills the vitest worker and reports nothing; as a throw it
  // fails the test that built the bad surface, and says which one.
  process.exit = ((code?: number) => {
    throw new Error(
      `runPromptLoop called process.exit(${code}). Surface problems:\n${printed.join("\n")}`
    );
  }) as typeof process.exit;
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exit = realExit;
  for (const dir of built.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SurfaceSpec {
  /** [chain] stages, or undefined to declare no [chain] block at all. */
  stages?: string[];
  /** Per-role tool allow-list. Absent role => tools = [] (nothing offered). */
  tools?: Record<string, string[]>;
  /** Extra files to drop in the project root, e.g. a file for `read`. */
  files?: Record<string, string>;
  /** Turn the audit trail on, so the per-stage records can be read back. */
  audit?: boolean;
}

/**
 * A surface on disk, the way config.test.ts and prompt_loop.test.ts build one.
 *
 * Every role routes to a DIFFERENT model tag, because the model tag in the
 * request body is how a test tells which role actually ran. Endpoint kind is
 * ollama and the url is never reached: fetch is stubbed.
 */
function surface(spec: SurfaceSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-loop-chain-"));
  built.push(dir);
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  const put = (name: string, body: string) =>
    writeFileSync(join(dir, ".gnomon", name), body);

  const chainBlock =
    spec.stages === undefined
      ? ""
      : `\n[chain]\nstages = [${spec.stages.map((s) => `"${s}"`).join(", ")}]\n`;

  put(
    "config.toml",
    `[defaults]
approval = "never"
sandbox = "off"
compaction = "discard"

# manual, so the routing table cannot move the role out from under a test that
# is about the chain.
[routing]
mode = "manual"
default = "implement"

[endpoints.local]
url = "http://127.0.0.1:9/api/chat"
kind = "ollama"
${spec.audit ? '\n[audit]\nenabled = true\n' : ""}${chainBlock}`
  );

  const toolsFor = (role: string): string => {
    const t = spec.tools?.[role] ?? [];
    return `tools = [${t.map((x) => `"${x}"`).join(", ")}]`;
  };
  put(
    "roles.toml",
    `[roles.plan]
model = "MODEL-plan"
${toolsFor("plan")}

[roles.implement]
model = "MODEL-implement"
${toolsFor("implement")}

[roles.critique]
model = "MODEL-critique"
${toolsFor("critique")}
`
  );

  put(
    "tools.toml",
    `[[tools]]
name = "read"
description = "Read a file as numbered lines, or list a directory."
enabled = true
`
  );
  put("policy.toml", "");
  put("system.md", "You are under test.\n");

  for (const [name, body] of Object.entries(spec.files ?? {})) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

/** One request the loop made, decoded. */
interface Seen {
  model: string;
  messages: { role: string; content?: string }[];
  tools?: unknown[];
  /** The last user message: what this call was actually asked. */
  ask: string;
  /** The whole body, for "did anything at all leak in" assertions. */
  raw: string;
}

/**
 * Replace fetch for the duration of `run`, recording every request.
 *
 * Same shape as the withFetch helper prompt_loop.test.ts already uses, kept
 * local so the two files cannot interfere with each other's globals.
 */
async function withFetch(
  impl: (seen: Seen, callIndex: number) => Response,
  run: (seen: Seen[]) => Promise<void>
): Promise<Seen[]> {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    const record: Seen = {
      model: body.model,
      messages,
      tools: body.tools,
      ask: lastUser?.content ?? "",
      raw: init.body,
    };
    seen.push(record);
    return impl(record, seen.length - 1);
  }) as unknown as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

const answers = (content: string): Response =>
  ({ ok: true, json: async () => ({ message: { content } }) }) as unknown as Response;

/**
 * Drive the real loop over the io seam.
 *
 * The input stream is ENDED rather than closed with /quit: EOF is the path
 * that lets runPromptLoop's promise resolve normally (readline "close" ->
 * readLine() resolves null -> session_end -> the finally that closes MCP and
 * readline). /quit calls process.exit, which a test cannot let happen.
 * Everything typed is queued by the loop and drained in order either way.
 */
async function drive(
  dir: string,
  lines: string[],
  initialRole = "implement"
): Promise<void> {
  const config = loadConfig(dir);
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const done = runPromptLoop(config, initialRole, { io: { input, output } });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
}

/** The session snapshot the loop persisted: what the operator's record says. */
function snapshot(dir: string): {
  exchanges: { role: string; model: string; output: string; code: number; bucket: string }[];
} {
  const sessions = join(dir, ".gnomon-sessions");
  const files = readdirSync(sessions).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(sessions, files[0]), "utf-8"));
}

/** The audit trail the loop wrote, one parsed record per line. */
function trail(dir: string): Record<string, unknown>[] {
  const auditDir = join(dir, ".gnomon-audit");
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBe(1);
  return readFileSync(join(auditDir, files[0]), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------

describe("the declared [chain] in the interactive loop", () => {
  it(
    "runs every declared stage, in declared order, for ONE user turn",
    async () => {
      // The failure this pins: [chain] was wired into runTask only, so this
      // surface produced three stages from `gnomon task` and one role from
      // `gnomon prompt`. Both entry points, one surface, one hash. The model
      // tag is the evidence -- each role routes to a different one, so the
      // sequence of tags reaching the endpoint IS the sequence of stages.
      const dir = surface({ stages: ["plan", "implement", "critique"] });

      const seen = await withFetch(
        (req) => answers(`answered-by-${req.model}`),
        async () => {
          await drive(dir, ["ship the thing"]);
        }
      );

      expect(seen.map((s) => s.model)).toEqual([
        "MODEL-plan",
        "MODEL-implement",
        "MODEL-critique",
      ]);

      // And the answer the operator is handed is the LAST stage's, not the
      // first stage's or a composite of the three.
      const snap = snapshot(dir);
      expect(snap.exchanges).toHaveLength(1);
      expect(snap.exchanges[0].model).toBe("MODEL-critique");
      expect(snap.exchanges[0].output).toContain("answered-by-MODEL-critique");
    },
    20000
  );

  it(
    "runs exactly one role when the surface declares no [chain]",
    async () => {
      // The behaviour that shipped, and the one a chain must not break: a
      // surface with no [chain] block answers with the session role, once.
      // Absent this test, wiring that ran the chain unconditionally -- or ran
      // the session role twice -- would look identical from the outside.
      const dir = surface({});

      const seen = await withFetch(
        (req) => answers(`answered-by-${req.model}`),
        async () => {
          await drive(dir, ["ship the thing"]);
        }
      );

      expect(seen.map((s) => s.model)).toEqual(["MODEL-implement"]);
    },
    20000
  );

  it(
    "treats a chain of ONE stage as no chain, and keeps the session role",
    async () => {
      // config.ts states the rule twice: resolveChain's callers test
      // `length < 2`, and auditSurface reports 'a chain of one stage ("plan")
      // is the same as no chain' as a non-fatal problem. A `>= 1` test here
      // would still pass every other chain test in this file, and would
      // silently hijack every turn on such a surface to the single named
      // stage. The session role is `implement`; the lone stage is `plan`, so
      // the two answers differ and the test can tell them apart.
      const dir = surface({ stages: ["plan"] });

      const seen = await withFetch(
        (req) => answers(`answered-by-${req.model}`),
        async () => {
          await drive(dir, ["ship the thing"]);
        }
      );

      expect(seen.map((s) => s.model)).toEqual(["MODEL-implement"]);
      // Nothing was carried, because no chain ran: the model was asked the
      // user's words and nothing else.
      expect(seen[0].ask).toBe("ship the thing");
      expect(seen[0].ask).not.toMatch(/previous stage/);
    },
    20000
  );

  it(
    "lets an explicit /role prefix override the chain: one role runs, not three",
    async () => {
      // Asking for one role and silently getting three would be worse than
      // having no chain at all -- it spends three models' budget on a turn
      // someone scoped to one, and the extra stages can write. The prefix also
      // has to be stripped: the model must be asked "do the thing", not
      // "/plan do the thing".
      const dir = surface({ stages: ["plan", "implement", "critique"] });

      const seen = await withFetch(
        (req) => answers(`answered-by-${req.model}`),
        async () => {
          await drive(dir, ["/plan do the thing"]);
        }
      );

      expect(seen.map((s) => s.model)).toEqual(["MODEL-plan"]);
      expect(seen[0].ask).toBe("do the thing");
    },
    20000
  );

  it(
    "stops the chain when a stage comes back an apparatus failure",
    async () => {
      // A dead endpoint is not an answer to hand onward. Without the break,
      // stages 2 and 3 run against the same dead endpoint and produce two more
      // apparatus failures, or -- worse, if the endpoint recovers -- answer a
      // question built on the string "Model API error: 400 Bad Request".
      //
      // 400 is deliberate: classifyFailure maps it to code 10, and
      // callEndpointWithRetry retries only 11 and 12, so exactly one request
      // per stage is attempted and the call count is unambiguous.
      const dir = surface({ stages: ["plan", "implement", "critique"] });

      const seen = await withFetch(
        () =>
          ({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "no such model",
          }) as unknown as Response,
        async () => {
          await drive(dir, ["ship the thing"]);
        }
      );

      // Stage 1 asked. Stages 2 and 3 never reached the endpoint.
      expect(seen.map((s) => s.model)).toEqual(["MODEL-plan"]);

      // And the turn is recorded as the failure it was, not as an answer.
      const snap = snapshot(dir);
      expect(snap.exchanges[0].code).toBe(10);
      expect(snap.exchanges[0].bucket).toBe("apparatus_failure");
    },
    20000
  );

  it(
    "hands each stage the previous stage's reported ANSWER, not its transcript",
    async () => {
      // The contract the source states: "it does NOT see the previous stage's
      // tool calls, only what that stage reported". Worth an actual test
      // because the cheap implementation -- passing the stage's own message
      // array forward -- satisfies every other assertion in this file while
      // leaking tool output, and tool output is where file contents,
      // credentials in a config file, and command stderr live.
      //
      // Stage 1 (plan) reads a file whose contents are a marker no model would
      // invent, then reports prose that does not contain it. Stage 2's request
      // must carry the prose and not the marker.
      const dir = surface({
        stages: ["plan", "implement"],
        tools: { plan: ["read"] },
        files: { "secret.txt": "TOOL-OUTPUT-MARKER-9c3f\n" },
      });

      const seen = await withFetch((req, i) => {
        // Stage 1, first call: tools are offered, so ask for one.
        if (i === 0) {
          return {
            ok: true,
            json: async () => ({
              message: {
                content: "",
                tool_calls: [
                  { function: { name: "read", arguments: { path: "secret.txt" } } },
                ],
              },
            }),
          } as unknown as Response;
        }
        if (req.model === "MODEL-plan") return answers("PLAN-REPORTED-ALPHA");
        return answers(`answered-by-${req.model}`);
      }, async () => {
        await drive(dir, ["ship the thing"]);
      });

      // The tool call really did run: the marker reached the plan stage.
      const planCalls = seen.filter((s) => s.model === "MODEL-plan");
      expect(planCalls.length).toBeGreaterThanOrEqual(2);
      expect(planCalls[planCalls.length - 1].raw).toContain("TOOL-OUTPUT-MARKER-9c3f");

      const stage2 = seen.filter((s) => s.model === "MODEL-implement");
      expect(stage2).toHaveLength(1);
      // What plan REPORTED is carried, attributed to the stage that said it.
      expect(stage2[0].ask).toContain("PLAN-REPORTED-ALPHA");
      expect(stage2[0].ask).toContain("The previous stage (plan) reported:");
      // The user's own words survive: a stage is given the task, not only the
      // previous stage's opinion of it.
      expect(stage2[0].ask).toContain("ship the thing");
      // What plan SAW does not travel. Asserted over the whole request body,
      // not just the last message, so a leak into system prompt or history
      // fails too.
      expect(stage2[0].raw).not.toContain("TOOL-OUTPUT-MARKER-9c3f");
    },
    20000
  );
  it(
    "records each stage on its own, and never as one composite verdict",
    async () => {
      // Rule 4, which is the constraint the whole feature is shaped around:
      // "every stage keeps its OWN bucket and its own record. The chain never
      // collapses three outcomes into a composite verdict." The chain tests
      // that existed for this asserted `String(runTask)` contained the string
      // "chain_stage" -- which is true of a build whose interactive loop
      // writes no records at all, and stays true if the records are wrong.
      //
      // Here the last stage fails on the apparatus while the first two
      // succeed, so a trail that folded three outcomes into one would have to
      // pick, and any pick is a lie: "result" hides a dead endpoint,
      // "apparatus_failure" hides two completed stages.
      const dir = surface({
        stages: ["plan", "implement", "critique"],
        audit: true,
      });

      await withFetch(
        (req) =>
          req.model === "MODEL-critique"
            ? ({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: async () => "no such model",
              } as unknown as Response)
            : answers(`answered-by-${req.model}`),
        async () => {
          await drive(dir, ["ship the thing"]);
        }
      );

      const stages = trail(dir).filter((r) => r.kind === "chain_stage");
      expect(stages.map((r) => r.role)).toEqual(["plan", "implement", "critique"]);
      expect(stages.map((r) => r.stage)).toEqual([1, 2, 3]);
      expect(stages.map((r) => r.of)).toEqual([3, 3, 3]);
      // Three stages, three outcomes, kept apart.
      expect(stages.map((r) => r.bucket)).toEqual([
        "result",
        "result",
        "apparatus_failure",
      ]);

      // One turn record for the turn, describing the stage whose answer the
      // operator actually received -- not a majority vote over the three.
      const turns = trail(dir).filter((r) => r.kind === "turn");
      expect(turns).toHaveLength(1);
      expect(turns[0].bucket).toBe("apparatus_failure");
      expect(turns[0].model).toBe("MODEL-critique");
    },
    20000
  );
});
