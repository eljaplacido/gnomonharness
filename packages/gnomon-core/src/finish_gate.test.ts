/**
 * The finish gate's pure half (finish_gate.ts): the caveat scanner, the
 * claim/evidence check, the hand-backs, the decision, the resolver, the
 * surface audit, and the contract (conformance/finish_gate.json, CONTRACTS.md
 * §33). The loop half is finish_gate_loop.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scanCaveats,
  caveatIds,
  evidenceGaps,
  auditFinish,
  renderFinishGate,
  renderFinishNoTool,
  nextFinishStep,
  resolveFinishGate,
  auditFinishGate,
  CAVEAT_PATTERNS,
  CAVEAT_IDS,
  EVIDENCE_IDS,
  FINISH_GATE_MODES,
  FINISH_GATE_ACTIONS,
  FINISH_GATE_OUTCOMES,
  FINISH_GATE_DEFAULTS,
  FINISH_GATE_ROUNDS,
  FINISH_GATE_MIN_REMAINING,
  FINISH_GATE_TASK_CHARS,
} from "./finish_gate.js";
import { auditSurface } from "./config.js";

const ids = (answer: string) => caveatIds(scanCaveats(answer));

describe("the caveat scanner: the near misses it was built from", () => {
  // Quoted from the final answers of the FLAG cells (research note 03, §1).
  it("atrx B41: a judgement call that kept an out-of-scope variant", () => {
    const a =
      "One judgement call worth flagging: `ENST00000373344.11:c.7275_7276insC` is annotated by VEP as " +
      "`3_prime_UTR_variant`, i.e. it is not a coding-sequence variant; I kept it in the catalogue.";
    const hits = scanCaveats(a);
    expect(hits).toHaveLength(2);
    expect(caveatIds(hits)).toEqual(["flagged", "interpretation", "judgement_call"]);
    expect(hits[0].quote).toContain("judgement call worth flagging");
  });
  it("cargo B41: over the limit, and a `false` the plan reports", () => {
    const a = [
      "## One thing to flag",
      "The SUV→TBU takeoff is 8,629.6 lb against an 8,600 lb limit (29.6 lb over).",
      "The plan reports `route_feasible: false`.",
    ].join("\n");
    expect(ids(a)).toEqual(["false_literal", "flagged", "over_limit"]);
  });
  it("cargo R2: over MTOW, and `route_feasible` is `false`", () => {
    expect(ids("the SUV→TBU leg is genuinely 30 lbs over MTOW and `route_feasible` is `false`.")).toEqual([
      "false_literal",
      "over_limit",
    ]);
  });
  it("production R1: necessarily carries lateness; ten orders cannot all finish", () => {
    const a = "Ten orders cannot all finish by their due date. So the plan necessarily carries lateness.";
    expect(ids(a)).toEqual(["carries", "could_not", "late"]);
  });
  it("production B41: the only reading under which it works", () => {
    expect(ids("Reservations cover the critical BOM components only — the only reading under which the plan is feasible.")).toEqual([
      "interpretation",
    ]);
  });
});

describe("the caveat scanner: one true and one false positive per pattern", () => {
  const cases: Record<string, [string, string]> = {
    judgement_call: ["That was a judgment call on my part.", "I called the judge function twice."],
    flagged: ["There is one thing to flag about the totals.", "The feature flag is now read from env."],
    infeasible: ["Meeting both limits is infeasible.", "Feasibility is checked first."],
    not_possible: ["An exact match is not possible here.", "Wherever possible, inputs are streamed."],
    could_not: ["I could not reproduce the upstream build.", "The parser rejects input that cannot be decoded."],
    skipped: ["I skipped the slow integration suite.", "The skip list is configurable."],
    approximate: ["The rate is approximately 4.2%.", "Proximity search uses the index."],
    only_the: ["It only handles the ASCII case.", "Only after a restart does the cache warm."],
    carries: ["The schedule carries some lateness on order 7.", "Each record carries a timestamp."],
    over_limit: ["Leg 2 is over the limit by 30 lb.", "I iterated over the list of legs."],
    late: ["Order 7 finishes late.", "The latest build is used."],
    false_literal: ["The result has `valid: false`.", "The check returns `false` for empty input."],
    todo: ["There is still a TODO in the parser.", "The todo list is complete."],
    workaround: ["I used a workaround for the lock.", "The work is around 200 lines."],
    assumed: ["I assumed the input is sorted.", "The sum is computed in one pass."],
    not_implemented: ["Streaming mode is not implemented.", "Streaming mode is implemented and tested."],
    partial: ["The migration is partial.", "Partition keys are hashed."],
    interpretation: ["I chose to keep the header row.", "The chosen header row is kept."],
    unverified: ["The Windows path is untested.", "Every path was tested on Linux and Windows."],
  };

  it("covers every pattern", () => {
    expect(Object.keys(cases).sort()).toEqual([...CAVEAT_IDS].sort());
  });

  for (const [id, [hit, miss]] of Object.entries(cases)) {
    it(`${id}: "${hit}" hits, "${miss}" does not`, () => {
      expect(ids(hit)).toContain(id);
      expect(ids(miss)).not.toContain(id);
    });
  }
});

describe("the caveat scanner: what it does not read", () => {
  it("a negated admission is not one", () => {
    expect(scanCaveats("No TODOs remain. Nothing was skipped. There are no workarounds and no assumptions.")).toEqual([]);
  });
  it("fenced code and reasoning are not claims", () => {
    const a = "<think>maybe I assumed too much</think>Done.\n```python\n# TODO: speed up\nok = False\n```\nAll requirements met.";
    expect(scanCaveats(a)).toEqual([]);
  });
  it("a clean answer has no hits", () => {
    expect(
      scanCaveats(
        "Wrote /app/out.json with 12 records sorted by `seq`. `pytest -q` passes 14 tests, including a blocked-writer ordering test."
      )
    ).toEqual([]);
  });
  it("is deterministic, quotes each sentence once, and stops at eight", () => {
    const a = Array.from({ length: 12 }, (_, i) => `Item ${i} is partial.`).join(" ");
    const one = scanCaveats(a);
    expect(one).toHaveLength(8);
    expect(scanCaveats(a)).toEqual(one);
    expect(scanCaveats("It is partial. It is partial.")).toHaveLength(1);
  });
  it("clips a long sentence", () => {
    const hit = scanCaveats("I assumed " + "x".repeat(500) + ".")[0];
    expect(hit.quote.length).toBeLessThanOrEqual(280);
    expect(hit.quote.endsWith("…")).toBe(true);
  });
  it("every pattern has a unique id", () => {
    expect(new Set(CAVEAT_PATTERNS.map((p) => p.id)).size).toBe(CAVEAT_PATTERNS.length);
  });
});

describe("claims against evidence (after clnkr)", () => {
  const w = { name: "write" };
  it("a written output nobody looked at after the last write is a gap", () => {
    expect(evidenceGaps("I wrote /app/out.json.", [w])).toEqual(["artifact_unchecked"]);
    expect(evidenceGaps("I wrote /app/out.json.", [w, { name: "bash", command: "cat /app/out.json" }])).toEqual([]);
    expect(evidenceGaps("I wrote /app/out.json.", [w, { name: "read" }])).toEqual([]);
  });
  it("a check before the last change does not count", () => {
    const calls = [{ name: "bash", command: "ls -l /app/out.json" }, w];
    expect(evidenceGaps("Created /app/out.json.", calls)).toEqual(["artifact_unchecked"]);
  });
  it("a service claim needs a probe", () => {
    expect(evidenceGaps("The server is listening on 8080.", [w, { name: "bash", command: "python3 -m app &" }])).toEqual([
      "service_unchecked",
    ]);
    expect(evidenceGaps("The server is listening on 8080.", [w, { name: "bash", command: "curl -s localhost:8080/health" }])).toEqual([]);
  });
  it("a works/fixed claim needs a run", () => {
    expect(evidenceGaps("Fixed the off-by-one; it works.", [w])).toEqual(["behavior_unchecked"]);
    expect(evidenceGaps("Fixed the off-by-one; it works.", [w, { name: "bash", command: "pytest -q tests/" }])).toEqual([]);
    expect(evidenceGaps("Fixed the off-by-one.", [w, { name: "bash", command: "cd /app && ./run.sh" }])).toEqual([]);
  });
  it("no claim, no gap; and claims inside code are not claims", () => {
    expect(evidenceGaps("Here is the summary.", [w])).toEqual([]);
    expect(evidenceGaps("Summary.\n```\nwrote 3 files\n```", [w])).toEqual([]);
  });
});

describe("the audit seam", () => {
  it("auditFinish is the caveat scan, the evidence gaps and the open todos, in one shape", () => {
    const found = auditFinish({
      answer: "I wrote /app/out.json; the totals are approximate.",
      calls: [{ name: "write" }],
      todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }],
    });
    expect(caveatIds(found.caveats)).toEqual(["approximate"]);
    expect(found.gaps).toEqual(["artifact_unchecked"]);
    expect(found.todos).toEqual([{ content: "b", status: "in_progress" }]);
  });
});

describe("the hand-backs", () => {
  const task = "Catalogue all coding variants in /app/out.json.\n\n- Exclude UTR variants.";
  it("quotes the task verbatim, the todos, every caveat, the gaps and the targeted checks", () => {
    const text = renderFinishGate({
      task,
      todos: [{ content: "check UTR rows", status: "pending" }],
      caveats: scanCaveats("One judgement call: I kept the UTR insertion."),
      changed: ["out.json", "scratch.py"],
      gaps: ["artifact_unchecked"],
      round: 1,
    });
    expect(text).toContain(`round 1 of ${FINISH_GATE_ROUNDS}`);
    expect(text).toContain(`<task>\n${task}\n</task>`);
    expect(text).toContain("- [ ] check UTR rows");
    expect(text).toContain('Your answer says: "One judgement call: I kept the UTR insertion."');
    expect(text).toContain("The task requires the strict reading; fix it or show concretely why the task text allows it.");
    expect(text).toContain("You say you created or wrote an output");
    expect(text).toContain("evidence only after you confirm they cover the requirement");
    expect(text).toContain("ordering, concurrency, edge inputs, changed values");
    expect(text).toContain("Do not substitute a narrower");
    expect(text).toContain("`scratch.py`");
    expect(text).toContain("Never delete an input");
    expect(text).toContain("at least one tool call");
  });
  it("with no caveat, says so and asks for any unstated deviation", () => {
    const text = renderFinishGate({ task, todos: [], caveats: [], changed: null, round: 1 });
    expect(text).toContain("states no deviation");
    expect(text).not.toContain("open items");
    expect(text).not.toContain("Claims without evidence");
  });
  it("clips a very long task and says how much is not repeated", () => {
    const text = renderFinishGate({ task: "a".repeat(FINISH_GATE_TASK_CHARS + 10), todos: [], caveats: [], changed: null, round: 1 });
    expect(text).toContain("[… 10 more characters of the task not repeated here]");
  });
  it("the no-tool hand-back repeats what the answer still admits", () => {
    const text = renderFinishNoTool({ round: 2, caveats: scanCaveats("It is partial.") });
    expect(text).toContain("round 2 of 2");
    expect(text).toContain('"It is partial."');
  });
});

describe("the decision", () => {
  it("fires first, wants a tool call after, and is bounded", () => {
    expect(nextFinishStep({ rounds: 0, toolsSince: 0 }, 1)).toEqual({ act: "fire" });
    expect(nextFinishStep({ rounds: 1, toolsSince: 0 }, 1)).toEqual({ act: "no_tool" });
    expect(nextFinishStep({ rounds: 1, toolsSince: 2 }, 1)).toEqual({ act: "accept", outcome: "passed" });
    expect(nextFinishStep({ rounds: 2, toolsSince: 0 }, 1)).toEqual({ act: "accept", outcome: "exhausted" });
    expect(nextFinishStep({ rounds: 2, toolsSince: 1 }, 1)).toEqual({ act: "accept", outcome: "passed" });
  });
  it("never hands back with less than the minimum budget left", () => {
    const below = FINISH_GATE_MIN_REMAINING - 0.001;
    expect(nextFinishStep({ rounds: 0, toolsSince: 0 }, below)).toEqual({ act: "accept", outcome: "skipped_budget" });
    expect(nextFinishStep({ rounds: 1, toolsSince: 0 }, below)).toEqual({ act: "accept", outcome: "skipped_budget" });
    expect(nextFinishStep({ rounds: 0, toolsSince: 0 }, FINISH_GATE_MIN_REMAINING)).toEqual({ act: "fire" });
    // A tool call since: accepted as passed whatever the budget.
    expect(nextFinishStep({ rounds: 1, toolsSince: 1 }, 0)).toEqual({ act: "accept", outcome: "passed" });
  });
});

describe("resolver and surface audit", () => {
  const cfg = (verify: Record<string, unknown> | undefined) => ({ policy: { verify }, roles: {}, config: {} }) as any;
  it('only "v2" turns it on', () => {
    expect(resolveFinishGate(cfg(undefined))).toBe("off");
    expect(resolveFinishGate(cfg({ finish_gate: "off" }))).toBe("off");
    expect(resolveFinishGate(cfg({ finish_gate: "V2" }))).toBe("off");
    expect(resolveFinishGate(cfg({ finish_gate: "v2" }))).toBe("v2");
  });
  it("says, not fatally, that the completion gate does not run beside it", () => {
    expect(auditFinishGate(cfg({ finish_gate: "v2" }))).toEqual([]);
    expect(auditFinishGate(cfg({ finish_gate: "v2", completion_gate: "off" }))).toEqual([]);
    expect(auditFinishGate(cfg({ finish_gate: "off", completion_gate: "review" }))).toEqual([]);
    const [p] = auditFinishGate(cfg({ finish_gate: "v2", completion_gate: "checklist" }));
    expect(p).toMatchObject({ fatal: false });
    expect(p.problem).toContain("completion_gate does not run");
  });
  it("says, not fatally, that the todo gate does not run beside it", () => {
    const withTodo = (verify: Record<string, unknown>) => ({ policy: { verify }, roles: {}, config: { turn: { todo_gate: true } } }) as any;
    expect(auditFinishGate(withTodo({ finish_gate: "off" }))).toEqual([]);
    const [p] = auditFinishGate(withTodo({ finish_gate: "v2" }));
    expect(p).toMatchObject({ fatal: false, where: ".gnomon/config.toml [turn] todo_gate" });
    expect(p.problem).toContain("todo_gate does not run");
    expect(auditFinishGate(withTodo({ finish_gate: "v2", completion_gate: "review" }))).toHaveLength(2);
  });
  it("a misspelt mode is reported by auditSurface", () => {
    const problems = auditSurface({ ...cfg({ finish_gate: "v3" }), gnomonDir: "/nonexistent/.gnomon" } as any);
    expect(problems.some((p) => /finish_gate/.test(p.where + p.problem))).toBe(true);
  });
  it("auditSurface carries the two-gates finding", () => {
    const problems = auditSurface({ ...cfg({ finish_gate: "v2", completion_gate: "review" }), gnomonDir: "/nonexistent/.gnomon" } as any);
    expect(problems.some((p) => p.problem.includes("completion_gate does not run"))).toBe(true);
  });
});

describe("the contract (conformance/finish_gate.json)", () => {
  const root = join(process.cwd(), "..", "..");
  const fixture = JSON.parse(readFileSync(join(root, "conformance", "finish_gate.json"), "utf8"));
  const contracts = readFileSync(join(root, "docs", "CONTRACTS.md"), "utf8");

  it("has the module's modes, actions, outcomes, defaults, bounds and ids", () => {
    expect(fixture.modes).toEqual([...FINISH_GATE_MODES]);
    expect(fixture.actions).toEqual([...FINISH_GATE_ACTIONS]);
    expect(fixture.outcomes).toEqual([...FINISH_GATE_OUTCOMES]);
    expect(fixture.policy.defaults).toEqual(FINISH_GATE_DEFAULTS);
    expect(fixture.max_rounds).toBe(FINISH_GATE_ROUNDS);
    expect(fixture.min_remaining).toBe(FINISH_GATE_MIN_REMAINING);
    expect(fixture.caveat_ids).toEqual([...CAVEAT_IDS]);
    expect(fixture.evidence_ids).toEqual([...EVIDENCE_IDS]);
  });

  it("is the section CONTRACTS.md publishes", () => {
    const at = contracts.indexOf("## 33. Finish gate");
    expect(at, "CONTRACTS.md has no finish-gate section").toBeGreaterThan(-1);
    const next = contracts.indexOf("\n## ", at + 1);
    const section = contracts.slice(at, next === -1 ? undefined : next);
    expect(section).toContain("conformance/finish_gate.json");
    expect(section).toContain(`\`${fixture.audit.kind}\``);
    for (const v of [...fixture.modes, ...fixture.actions, ...fixture.outcomes, ...fixture.caveat_ids, ...fixture.evidence_ids]) {
      expect(section, v).toContain(`\`${v}\``);
    }
    for (const k of Object.keys(fixture.policy.defaults)) expect(section, k).toContain(`\`${k}\``);
    for (const k of [...fixture.counters.required, ...fixture.counters.optional]) expect(section, k).toContain(`\`${k}\``);
    for (const k of [...fixture.audit.required, ...fixture.audit.optional]) expect(section, k).toContain(`\`${k}\``);
  });
});
