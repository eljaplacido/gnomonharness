/**
 * The stall detectors as a pure module (stall_signals.ts). The loop side --
 * that they reach the turn record and the trail, and that they never change
 * what the model is sent -- is stall_signals_loop.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  StallSignals,
  STALL_SIGNALS_VERSION,
  STALL_SIGNAL_THRESHOLDS,
  STALL_SIGNAL_NAMES,
  normalizeCommand,
  stallKey,
  changedState,
  isReadCall,
  isTestCall,
  summaryExit,
  type StallObservation,
  type StallThresholds,
} from "./stall_signals.js";

const bash = (command: string, exit = 0, worktree_changed: boolean | null = false): StallObservation => ({
  tool: "bash",
  target: command,
  code: 0,
  summary: `bash — exit ${exit}`,
  worktree_changed,
});
const read = (path: string, lines = 10): StallObservation => ({
  tool: "read",
  target: path,
  code: 0,
  summary: `read ${path} — ${lines} lines`,
});
const write = (path: string, code = 0): StallObservation => ({
  tool: "write",
  target: path,
  code,
  summary: code === 0 ? `write ${path} (+1 −0)` : `write ${path} — refused (outside sandbox)`,
});
const todo = (n: number): StallObservation => ({ tool: "todo", target: "", code: 0, summary: `todo — ${n}/5 done` });

/** Feed a sequence; return the counters and every fire, with steps from 1. */
function run(seq: StallObservation[], t?: StallThresholds) {
  const d = new StallSignals(t);
  const fires = seq.flatMap((o, i) => d.observe(o, i + 1));
  return { counters: d.counters, fires };
}

const only = (over: Partial<StallThresholds>): StallThresholds => ({
  ...STALL_SIGNAL_THRESHOLDS,
  cycle_periods: [],
  no_progress_calls: Infinity,
  cusum_h: Infinity,
  ...over,
});
const CYCLE = only({ cycle_periods: [2, 3, 4], cycle_min_calls: 6, cycle_min_periods: 2 });

describe("normalizeCommand", () => {
  it("drops what does not change what a command asks for", () => {
    expect(normalizeCommand("cd /app && pytest -q 2>&1 | tail -20")).toBe("pytest -q");
    expect(normalizeCommand("cd /app; cd src && pytest -q | head -n 50")).toBe("pytest -q");
    expect(normalizeCommand("  pytest   -q  ")).toBe("pytest -q");
    expect(normalizeCommand("DEBIAN_FRONTEND=noninteractive apt-get install -y gcc")).toBe("apt-get install -y gcc");
    expect(normalizeCommand("timeout 60 sudo -E make test")).toBe("make test");
  });

  it("reads a command behind a comment line, which 846 recorded calls had", () => {
    expect(normalizeCommand("# Check the config sections\ngrep '^\\[' /etc/x.cfg")).toBe("grep '^\\[' /etc/x.cfg");
    expect(normalizeCommand("cd /app\n# then list\nls -la")).toBe("ls -la");
  });

  it("keeps a pipe that is not a trailing head or tail", () => {
    expect(normalizeCommand("ps aux | grep make")).toBe("ps aux | grep make");
    expect(normalizeCommand("tail -f log | grep err")).toBe("tail -f log | grep err");
  });
});

describe("the call key", () => {
  it("is the same for the same tests seen through a different window", () => {
    expect(stallKey(bash("pytest 2>&1 | tail -20"))).toBe(stallKey(bash("cd /app && pytest | tail -50")));
  });

  it("tells two greps of one file apart by the pattern the summary carries", () => {
    const g = (pattern: string): StallObservation => ({
      tool: "grep",
      target: "/app/x.py",
      code: 0,
      summary: `grep ${pattern} — 1 match(es) in 1 file(s)`,
    });
    expect(stallKey(g("def a"))).not.toBe(stallKey(g("def b")));
    // ...and ignores what came back, which is the outcome, not the request.
    expect(stallKey(g("def a"))).toBe(stallKey({ ...g("def a"), summary: "grep def a — 0 match(es)" }));
  });
});

describe("classification", () => {
  it("counts a successful write, a moved worktree, an install and a delegation as a state change", () => {
    expect(changedState(write("a.ts"))).toBe(true);
    expect(changedState(write("a.ts", 3))).toBe(false);
    expect(changedState(bash("python gen.py", 0, true))).toBe(true);
    expect(changedState(bash("python gen.py", 0, false))).toBe(false);
    // Unknown is not a change.
    expect(changedState(bash("python gen.py", 0, null))).toBe(false);
    // Outside the worktree, where the stamp cannot see (POSTMORTEM F13)...
    expect(changedState(bash("apt-get install -y libssl-dev"))).toBe(true);
    expect(changedState(bash("cat > /etc/postfix/transport << 'EOF'\nx\nEOF"))).toBe(true);
    // ...but only when it worked.
    expect(changedState(bash("pip install nothere", 1))).toBe(false);
    expect(changedState({ tool: "task", target: "", code: 0, summary: "task — ok" })).toBe(true);
  });

  it("knows a test run and a read when it sees one", () => {
    expect(isTestCall(bash("cd /app && python -m pytest tests/ -x"))).toBe(true);
    expect(isTestCall(bash("npm test"))).toBe(true);
    expect(isTestCall(bash("# run them\ncargo test --all"))).toBe(true);
    expect(isTestCall(bash("ls"))).toBe(false);
    expect(isReadCall(read("/x"))).toBe(true);
    expect(isReadCall(bash("sed -n '1,40p' x.py"))).toBe(true);
    expect(isReadCall(bash("sed -i s/a/b/ x.py"))).toBe(false);
    expect(isReadCall(bash("# look first\ncat x.py"))).toBe(true);
    expect(isReadCall(bash("python3 -c 'print(1)'"))).toBe(false);
  });

  it("reads the exit status out of a bash summary, and nothing out of a kill", () => {
    expect(summaryExit("bash — exit 2")).toBe(2);
    expect(summaryExit("bash — exit 0 · surface changed")).toBe(0);
    expect(summaryExit("bash — killed by SIGKILL")).toBeUndefined();
  });
});

describe("limit_cycle", () => {
  it("fires on a period-2 poll loop at the sixth call, not the fifth", () => {
    const a = bash("sleep 5");
    const b = bash("ps aux | grep make");
    const { counters, fires } = run([a, b, a, b, a, b, a, b], CYCLE);
    expect(fires.map((f) => [f.signal, f.step, f.period])).toEqual([["limit_cycle", 6, 2]]);
    expect(counters.limit_cycle).toEqual({ count: 1, first_step: 6, period: 2 });
  });

  it("finds periods 3 and 4", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => bash(`curl localhost/${x}`));
    expect(run([a, b, c, a, b, c], CYCLE).counters.limit_cycle).toEqual({ count: 1, first_step: 6, period: 3 });
    expect(run([a, b, c, d, a, b, c, d], CYCLE).counters.limit_cycle).toEqual({ count: 1, first_step: 8, period: 4 });
  });

  it("leaves period 1 to stall_repeats", () => {
    const a = bash("make");
    expect(run(Array(12).fill(a), CYCLE).counters.limit_cycle.count).toBe(0);
  });

  it("does not call an edit-and-test rhythm that changes files a cycle", () => {
    const e: StallObservation = { tool: "edit", target: "/app/x.py", code: 0, summary: "edit /app/x.py (+1 −1)" };
    const t = bash("pytest", 1);
    expect(run([e, t, e, t, e, t, e, t], CYCLE).counters.limit_cycle.count).toBe(0);
  });

  it("counts a second cycle as a second episode and keeps the first step", () => {
    const a = bash("sleep 5");
    const b = bash("ps aux");
    const breaker = read("/app/new.py");
    const { counters } = run([a, b, a, b, a, b, a, b, breaker, a, b, a, b, a, b], CYCLE);
    expect(counters.limit_cycle).toEqual({ count: 2, first_step: 6, period: 2 });
  });
});

describe("no_progress", () => {
  const NP = only({ no_progress_calls: 5 });

  it("fires after N calls with no change, no new test outcome and no new read", () => {
    const probes = Array.from({ length: 7 }, (_, i) => bash(`python3 -c 'import m${i}'`, 1));
    const { counters, fires } = run(probes, NP);
    expect(fires).toEqual([{ signal: "no_progress", step: 5, episode: 1, streak: 5 }]);
    expect(counters.no_progress).toEqual({ count: 1, first_step: 5 });
  });

  it("is reset by a new read, a write, and a test whose outcome changed", () => {
    const p = (i: number) => bash(`python3 -c 'probe${i}'`, 1);
    for (const reset of [read("/app/fresh.py"), write("/app/x.py"), bash("pytest", 0)]) {
      // Four idle calls, then pytest failing (a new outcome: progress), four
      // more, the reset under test, four more: never five in a row.
      const seq = [p(1), p(2), p(3), p(4), bash("pytest", 1), p(5), p(6), p(7), p(8), reset, p(9), p(10), p(11), p(12)];
      expect(run(seq, NP).counters.no_progress.count).toBe(0);
    }
  });

  it("does not count a re-read or a re-run with the same result as progress", () => {
    const seq = [read("/a"), bash("pytest", 1), read("/a"), bash("pytest", 1), read("/a"), bash("pytest", 1), read("/a")];
    // The first read and the first pytest are progress; the next five are not.
    expect(run(seq, NP).counters.no_progress).toEqual({ count: 1, first_step: 7 });
  });
});

describe("novelty_cusum", () => {
  const CU = only({ cusum_k: 0.6, cusum_h: 3 });

  it("alarms when novelty decays, and needs fresh evidence for a second alarm", () => {
    const a = bash("jq --help | grep -i indent");
    // One novel call, then repeats: +0.6 each, the alarm at 3.0, five later.
    const { counters, fires } = run(Array(11).fill(a), CU);
    expect(fires.map((f) => f.step)).toEqual([6, 11]);
    expect(counters.novelty_cusum).toEqual({ count: 2, first_step: 6 });
  });

  it("is held down while most calls are new, and drifts up once most are not", () => {
    // Two new reads to one repeated `ls`: novelty 2/3, above k = 0.6.
    const mostlyNew = Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? bash("ls") : read(`/f${i}`)));
    expect(run(mostlyNew, CU).counters.novelty_cusum.count).toBe(0);
    // One in two: novelty 1/2, below k. The first `ls` is new; from the
    // second one on the sum reads 0.6, 0.8, 1.0, ... after each repeat, and
    // reaches 3 at the thirteenth repeat: step 28.
    const half = Array.from({ length: 30 }, (_, i) => (i % 2 ? bash("ls") : read(`/f${i}`)));
    expect(run(half, CU).counters.novelty_cusum).toEqual({ count: 1, first_step: 28 });
  });
});

describe("the detectors together", () => {
  it("skip bookkeeping calls but report the caller's step", () => {
    const a = bash("sleep 5");
    const b = bash("ps aux");
    const seq = [a, todo(1), b, a, todo(2), b, a, b];
    const { counters, fires } = run(seq, CYCLE);
    expect(counters.observed).toBe(6);
    expect(fires.find((f) => f.signal === "limit_cycle")?.step).toBe(8);
  });

  it("start every turn with every detector present at zero", () => {
    const d = new StallSignals();
    expect(d.counters).toEqual({
      v: 1,
      observed: 0,
      limit_cycle: { count: 0 },
      no_progress: { count: 0 },
      novelty_cusum: { count: 0 },
    });
    expect(Object.keys(d.counters).filter((k) => (STALL_SIGNAL_NAMES as readonly string[]).includes(k))).toEqual([
      ...STALL_SIGNAL_NAMES,
    ]);
  });

  it("are pure: the same calls give the same counters, and the input is not touched", () => {
    const seq = Array.from({ length: 60 }, (_, i) => (i % 7 < 4 ? bash(`cmd ${i % 3}`, i % 2) : read(`/f${i % 5}`)));
    const frozen = seq.map((o) => Object.freeze({ ...o }));
    const one = run(frozen);
    const two = run(frozen);
    expect(one).toEqual(two);
  });

  it("declare every number in one frozen place", () => {
    expect(Object.isFrozen(STALL_SIGNAL_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(STALL_SIGNAL_THRESHOLDS.cycle_periods)).toBe(true);
    expect(STALL_SIGNAL_THRESHOLDS.cycle_periods).not.toContain(1);
  });
});

describe("the record contract (conformance/stall_signals.json)", () => {
  const root = join(process.cwd(), "..", "..");
  const fixture = JSON.parse(readFileSync(join(root, "conformance", "stall_signals.json"), "utf8"));
  const contracts = readFileSync(join(root, "docs", "CONTRACTS.md"), "utf8");

  /** A turn that makes every detector fire, so every key appears. */
  function everything() {
    const a = bash("sleep 5");
    const b = bash("ps aux");
    const d = new StallSignals();
    const seq = Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b));
    const fires = seq.flatMap((o, i) => d.observe(o, i + 1));
    return { counters: d.counters, fires };
  }

  it("has the module's version, signals and input fields", () => {
    expect(fixture.v).toBe(STALL_SIGNALS_VERSION);
    expect(fixture.signals).toEqual([...STALL_SIGNAL_NAMES]);
    const input: Required<StallObservation> = { tool: "", target: "", code: 0, summary: "", worktree_changed: null };
    expect(fixture.input).toEqual(Object.keys(input));
  });

  it("names every key the counters carry, and the counters carry every required one", () => {
    const { counters } = everything();
    const c = fixture.counters;
    const keys = Object.keys(counters);
    for (const k of c.required) expect(keys).toContain(k);
    for (const k of keys) expect([...c.required, ...c.optional]).toContain(k);
    for (const name of STALL_SIGNAL_NAMES) {
      const tally = counters[name] as unknown as Record<string, unknown>;
      expect(tally.count, name).toBeGreaterThan(0);
      const allowed = [
        ...c.per_signal.required,
        ...c.per_signal.optional,
        ...(name === "limit_cycle" ? c.per_signal.limit_cycle_optional : []),
      ];
      for (const k of c.per_signal.required) expect(Object.keys(tally)).toContain(k);
      for (const k of Object.keys(tally)) expect(allowed, `${name}.${k}`).toContain(k);
    }
  });

  it("names every key a stall_signal record carries", () => {
    const { fires } = everything();
    const a = fixture.audit;
    expect(new Set(fires.map((f) => f.signal))).toEqual(new Set(STALL_SIGNAL_NAMES));
    for (const f of fires) {
      // The loop adds `role` beside what the module returns.
      const record = { role: "implement", ...f };
      for (const k of a.required) expect(Object.keys(record)).toContain(k);
      for (const k of Object.keys(record)) expect([...a.required, ...a.optional]).toContain(k);
    }
  });

  it("is the section CONTRACTS.md publishes", () => {
    const at = contracts.indexOf("## 27. Stall signals");
    expect(at, "CONTRACTS.md has no stall-detectors section").toBeGreaterThan(-1);
    const next = contracts.indexOf("\n## ", at + 1);
    const section = contracts.slice(at, next === -1 ? undefined : next);
    expect(section).toContain(`\`${fixture.audit.kind}\``);
    expect(section).toContain("conformance/stall_signals.json");
    for (const name of STALL_SIGNAL_NAMES) expect(section).toContain(`\`${name}\``);
    for (const k of fixture.input) expect(section).toContain(`\`${k}\``);
  });
});
