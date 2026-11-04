/**
 * The stall detectors inside the loop (LP5). Three claims:
 *
 * 1. They reach the turn record (`counters.stall_signals`) and, with [audit]
 *    on, the trail (`stall_signal`, right after the `tool_call` it follows).
 * 2. Replayable by construction: the turn's own `tool_call` records, run
 *    through a fresh detector, give exactly the counters the turn recorded.
 * 3. Log-only, as a property: over seeded random tool-call scripts, the turn
 *    sends byte-identical requests to the model, and returns the same result,
 *    whether the detector is the real one, one that never fires, one that
 *    fires at random, or one that throws. If anything in the loop read a
 *    detector back, one of those would move a request.
 *
 * Tools are stubbed (no file is touched, no command runs) so a script is a
 * pure function of its seed; the model is a scripted fetch.
 */
import { describe, it, expect, vi } from "vitest";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";
import { StallSignals, type StallSignalCounters } from "./stall_signals.js";

type Mode = "real" | "none" | "chaos" | "throw";
const ctl = vi.hoisted(() => ({ mode: "real" as string, seed: 1 }));

vi.mock("./stall_signals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stall_signals.js")>();
  const zero = () => ({
    v: 1,
    observed: 0,
    limit_cycle: { count: 0 },
    no_progress: { count: 0 },
    novelty_cusum: { count: 0 },
  });
  class Swapped {
    constructor() {
      if (ctl.mode === "real") return new actual.StallSignals() as any;
      if (ctl.mode === "none") return { counters: zero(), observe: () => [] } as any;
      if (ctl.mode === "throw") {
        return {
          counters: zero(),
          observe: () => {
            throw new Error("detector blew up");
          },
        } as any;
      }
      // chaos: fires whatever, whenever, and sometimes throws.
      let s = ctl.seed * 7919 + 13;
      const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      const counters = zero();
      return {
        counters,
        observe: (_o: unknown, step: number) => {
          if (rnd() < 0.04) throw new Error("chaos");
          counters.observed++;
          return actual.STALL_SIGNAL_NAMES.filter(() => rnd() < 0.3).map((signal, i) => ({
            signal,
            step,
            episode: i + 1,
            period: 2,
          }));
        },
      } as any;
    }
  }
  return { ...actual, StallSignals: Swapped };
});

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>) => {
      const path = String(args.path ?? "");
      const command = String(args.command ?? "");
      if (name === "read") return { code: 0, content: `contents of ${path}`, summary: `read ${path} — 10 lines` };
      if (name === "write" || name === "edit") return { code: 0, content: "ok", summary: `${name} ${path} (+1 −0)` };
      if (name === "bash") {
        const exit = command.includes("fail") ? 1 : 0;
        const worktree_changed = command.includes("touch") ? true : command.includes("maybe") ? null : false;
        return {
          code: 0,
          content: `exit: ${exit}\nstdout: ${command}`,
          summary: `bash — exit ${exit}`,
          shell_exit: exit,
          worktree_changed,
        };
      }
      return { code: 0, content: "ok", summary: `${name} — ok` };
    },
  };
});

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

type Call = { name: string; arguments: Record<string, unknown> };

/** One turn: `script[i]` is the i-th reply's tool calls; after it, an answer. */
async function turn(script: Call[][], mode: Mode, seed = 1) {
  ctl.mode = mode;
  ctl.seed = seed;
  const config: any = loadConfig("../..");
  // No declared check: a stubbed tool changed nothing a check could judge.
  config.policy = { ...config.policy, verify: undefined };
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const bodies: string[] = [];
  const audit: any[] = [];
  let reply = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(String(init.body));
    const body = JSON.parse(init.body);
    // The wrap-up after a stall or the wall has no tools: answer it.
    const calls = body.tools?.length ? script[reply++] : undefined;
    const tool_calls = calls?.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return {
      ok: true,
      json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: "go" }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: () => {},
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
    });
    return { result, bodies, audit };
  } finally {
    globalThis.fetch = original;
  }
}

const sh = (command: string): Call => ({ name: "bash", arguments: { command } });
const rd = (path: string): Call => ({ name: "read", arguments: { path } });

describe("stall signals in a turn", () => {
  it("land on the turn record, and in the trail right after the call that fired them", async () => {
    // A period-2 poll: the cycle detector fires at the 6th call; the loop's
    // own A-B-A-B stop ends the turn at the 8th.
    const poll = [sh("sleep 5"), sh("ps aux | grep make")];
    const script = Array.from({ length: 12 }, (_, i) => [poll[i % 2]!]);
    const { result, audit } = await turn(script, "real");
    expect(result.stop_reason).toBe("stall");
    expect(result.counters.stall_signals?.limit_cycle).toEqual({ count: 1, first_step: 6, period: 2 });
    const kinds = audit.map((r) => r.kind);
    const at = kinds.indexOf("stall_signal");
    expect(kinds.slice(0, at).filter((k) => k === "tool_call")).toHaveLength(6);
    expect(audit[at]).toMatchObject({ kind: "stall_signal", role: "implement", signal: "limit_cycle", step: 6, episode: 1, period: 2 });
  });

  it("are recomputed exactly from the turn's own tool_call records", async () => {
    const script = [
      [rd("src/a.ts"), rd("src/b.ts")],
      [sh("cd /app && pytest -q fail")],
      ...Array.from({ length: 9 }, (_, i) => [sh(`python3 -c 'probe ${i % 3}'`)]),
      [sh("touch out.txt")],
      ...Array.from({ length: 8 }, () => [sh("jq --help | grep indent"), rd("src/a.ts")]),
    ];
    const { result, audit } = await turn(script, "real");
    const recorded = result.counters.stall_signals as StallSignalCounters;
    expect(recorded.observed).toBeGreaterThan(10);
    const replayed = new StallSignals();
    audit
      .filter((r) => r.kind === "tool_call")
      .forEach((r, i) =>
        replayed.observe(
          { tool: r.tool, target: r.target, code: r.code, summary: r.summary, worktree_changed: r.worktree_changed },
          i + 1
        )
      );
    expect(replayed.counters).toEqual(recorded);
  });

  it("a detector that throws stops observing, says so, and changes nothing else", async () => {
    const script = Array.from({ length: 6 }, (_, i) => [rd(`f${i}`)]);
    const real = await turn(script, "real");
    const broken = await turn(script, "throw");
    expect(broken.result.counters.stall_signals?.error).toBe("detector blew up");
    expect(broken.bodies).toEqual(real.bodies);
    expect(broken.result.content).toBe(real.result.content);
  });
});

/** mulberry32: a small seeded PRNG, so every script is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random script made of the shapes stalls take, and the shapes work takes. */
function randomScript(seed: number): Call[][] {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  let unique = 0;
  const alphabet: Array<() => Call> = [
    () => sh("sleep 5"),
    () => sh("ps aux | grep make"),
    () => rd("src/a.ts"),
    () => rd("src/b.ts"),
    () => sh("pytest -q fail"),
    () => sh("pytest -q"),
    () => ({ name: "write", arguments: { path: "out.txt", content: "x" } }),
    () => sh("touch gen.txt"),
    () => sh("maybe build"),
    () => ({ name: "todo", arguments: { items: [] } }),
    () => sh(`echo ${seed}-${unique++}`),
    () => sh(`# look\ncat src/${unique++}.ts`),
  ];
  const calls: Call[] = [];
  const target = 8 + Math.floor(r() * 40);
  while (calls.length < target) {
    const shape = r();
    if (shape < 0.35) {
      const period = Array.from({ length: 2 + Math.floor(r() * 3) }, () => pick(alphabet)());
      for (let k = 0, n = 2 + Math.floor(r() * 3); k < n; k++) calls.push(...period);
    } else if (shape < 0.5) {
      const one = pick(alphabet)();
      for (let k = 0, n = 2 + Math.floor(r() * 3); k < n; k++) calls.push(one);
    } else {
      for (let k = 0, n = 1 + Math.floor(r() * 6); k < n; k++) calls.push(pick(alphabet)());
    }
  }
  const replies: Call[][] = [];
  for (let i = 0; i < calls.length; ) {
    const n = 1 + Math.floor(r() * 3);
    replies.push(calls.slice(i, i + n));
    i += n;
  }
  return replies;
}

/**
 * The clock, wherever a record carries it: per model request `ms` and
 * `first_byte_ms`, in the turn's `modelCalls` and on each `model_call` audit
 * record (the per-call mediator record, CONTRACTS.md §29). Two runs of one
 * script differ in it by a millisecond either way.
 */
const unclocked = (c: any) => {
  const { ms: _ms, first_byte_ms: _fb, ...rest } = c;
  return rest;
};

/** The result with the detector's own field and the clock taken out: everything else must match. */
function withoutSignals(result: any) {
  const { stall_signals: _drop, ...counters } = result.counters;
  return {
    ...result,
    counters,
    ...(result.modelCalls ? { modelCalls: { ...result.modelCalls, calls: result.modelCalls.calls.map(unclocked) } } : {}),
  };
}

describe("property: the stall detectors never change what the model is sent", () => {
  const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i);

  it.each(SEEDS)("seed %i: real, silent, chaotic and throwing detectors send identical requests", async (seed) => {
    const script = randomScript(seed);
    const real = await turn(script, "real", seed);
    for (const mode of ["none", "chaos", "throw"] as const) {
      const other = await turn(script, mode, seed);
      expect(other.bodies).toEqual(real.bodies);
      expect(withoutSignals(other.result)).toEqual(withoutSignals(real.result));
      // The trail differs only by stall_signal records.
      const strip = (a: any[]) =>
        a.filter((x) => x.kind !== "stall_signal").map((x) => (x.kind === "model_call" ? unclocked(x) : x));
      expect(strip(other.audit)).toEqual(strip(real.audit));
    }
    // And the scripts are not vacuous: across the seeds they exercise stops
    // and firings (asserted in aggregate below).
    seen.push({ stop: real.result.stop_reason, fired: STALL_FIRED(real.result.counters.stall_signals) });
  });

  const seen: Array<{ stop: string; fired: boolean }> = [];
  const STALL_FIRED = (c?: StallSignalCounters) =>
    !!c && (c.limit_cycle.count > 0 || c.no_progress.count > 0 || c.novelty_cusum.count > 0);

  it("covered turns where the detectors fired and turns the loop stopped as a stall", () => {
    expect(seen.length).toBe(SEEDS.length);
    expect(seen.filter((s) => s.fired).length).toBeGreaterThanOrEqual(5);
    expect(seen.filter((s) => s.stop === "stall").length).toBeGreaterThanOrEqual(3);
    expect(seen.filter((s) => s.stop !== "stall").length).toBeGreaterThanOrEqual(3);
  });
});
