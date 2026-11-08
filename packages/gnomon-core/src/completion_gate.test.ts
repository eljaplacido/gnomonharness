/**
 * The completion gate's pure half (completion_gate.ts): the checklist, the
 * findings parser, the decision, the budget, the resolver, the surface audit,
 * and the contract (conformance/completion_gate.json, CONTRACTS.md §30). The
 * loop half is completion_gate_loop.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildChecklist,
  renderChecklist,
  parseFindings,
  nextGateStep,
  budgetLeft,
  resolveCompletionGate,
  auditCompletionGate,
  reviewerToolNames,
  taskTextOf,
  changedPaths,
  chainStageInput,
  withoutChainCarry,
  CHAIN_CARRY,
  COMPLETION_GATE_MODES,
  COMPLETION_GATE_ACTIONS,
  COMPLETION_GATE_OUTCOMES,
  COMPLETION_GATE_DEFAULTS,
  REVIEWER_TOOLS,
  NO_FINDINGS,
  type ResolvedCompletionGate,
} from "./completion_gate.js";
import { auditSurface } from "./config.js";

const cfg = (verify: Record<string, unknown> | undefined, roles: Record<string, unknown> = {}) =>
  ({ policy: { verify }, roles, config: {} }) as any;

describe("the checklist is built from the task's own words", () => {
  const task = [
    "Implement a write-ahead log recovery tool in /app/wal_recover.py.",
    "",
    "Requirements:",
    "- Read every segment under `/app/wal/` and write the recovered records to /app/out/recovered.jsonl as JSON Lines, sorted ascending by `seq`.",
    "- It must handle a torn final record without crashing.",
    "- Recovery must be safe when 4 writers append concurrently.",
    "- Finish within 30 seconds on 100000 records.",
    "",
    "Run it as:",
    "```bash",
    "python3 /app/wal_recover.py --wal /app/wal --out /app/out",
    "```",
    "Do not modify the files in /app/wal. See https://example.com/spec/v2 for the format.",
  ].join("\n");
  const cl = buildChecklist(task);

  it("lifts every list item and every sentence that asks for something", () => {
    expect(cl.requirements).toContain("It must handle a torn final record without crashing.");
    expect(cl.requirements).toContain("Recovery must be safe when 4 writers append concurrently.");
    expect(cl.requirements).toContain("Implement a write-ahead log recovery tool in /app/wal_recover.py.");
    expect(cl.requirements.some((r) => r.startsWith("Do not modify the files in /app/wal."))).toBe(true);
  });

  it("names the paths, commands, names, values and formats, and not the URL", () => {
    expect(cl.paths).toEqual(
      expect.arrayContaining(["/app/wal_recover.py", "/app/wal/", "/app/out/recovered.jsonl", "/app/wal"])
    );
    expect(cl.paths.some((p) => p.includes("example.com"))).toBe(false);
    expect(cl.commands).toEqual(["python3 /app/wal_recover.py --wal /app/wal --out /app/out"]);
    expect(cl.names).toEqual(["seq"]);
    expect(cl.values).toEqual(expect.arrayContaining(["4", "30 seconds", "100000"]));
    expect(cl.formats).toEqual(expect.arrayContaining(["JSON", "sorted", "ascending"]));
  });

  it("is deterministic, so the request it goes into is reproducible", () => {
    expect(buildChecklist(task)).toEqual(cl);
    const opts = { round: 1, maxRounds: 3, canCheck: true, changed: ["wal_recover.py", "scratch.py"] };
    expect(renderChecklist(cl, opts)).toBe(renderChecklist(buildChecklist(task), opts));
  });

  it("renders the requirements, the stray-file list and the check requirement", () => {
    const text = renderChecklist(cl, { round: 1, maxRounds: 3, canCheck: true, changed: ["wal_recover.py", "scratch.py"] });
    expect(text).toContain("round 1 of 3");
    expect(text).toContain("  1. ");
    expect(text).toContain("`scratch.py`");
    expect(text).toContain("An answer with no command run after this message is not accepted");
    const noBash = renderChecklist(cl, { round: 1, maxRounds: 3, canCheck: false, changed: null });
    expect(noBash).not.toContain("not accepted. Fix");
    expect(noBash).toContain("Re-read the result against each item above");
  });

  it("a task with nothing to lift still gets the generic checks", () => {
    const empty = buildChecklist("hello");
    expect(empty).toEqual({ requirements: [], paths: [], commands: [], names: [], values: [], formats: [] });
    expect(renderChecklist(empty, { round: 1, maxRounds: 1, canCheck: true, changed: null })).toContain("edge cases");
  });
});

describe("findings", () => {
  it("reads a list, one finding per item", () => {
    expect(parseFindings("Checked.\n- out.txt lacks a newline\n* concurrent run loses a record\n2. stray scratch.py")).toEqual([
      "out.txt lacks a newline",
      "concurrent run loses a record",
      "stray scratch.py",
    ]);
  });
  it(`reads ${NO_FINDINGS} as none, and prose without a list as one finding`, () => {
    expect(parseFindings(NO_FINDINGS)).toEqual([]);
    expect(parseFindings("<think>hmm</think>\nNo findings.")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("The output file is missing.")).toEqual(["The output file is missing."]);
  });
  it("is bounded", () => {
    const many = Array.from({ length: 30 }, (_, i) => `- finding ${i} ${"x".repeat(600)}`).join("\n");
    const out = parseFindings(many);
    expect(out).toHaveLength(10);
    for (const f of out) expect(f.length).toBeLessThanOrEqual(400);
  });
});

describe("the decision", () => {
  const g = (mode: "checklist" | "review" | "review_only", max_rounds = 3, min_remaining = 0.2): ResolvedCompletionGate => ({
    mode, max_rounds, min_remaining, reviewer: "verifier",
  });
  const s0 = { rounds: 0, checkRequired: false, checksSince: 0, reviewed: false };
  const ok = { budgetLeft: 0.9, canCheck: true };

  it("rejects the first end with the checklist", () => {
    expect(nextGateStep(g("checklist"), s0, ok)).toEqual({ act: "checklist" });
  });
  it("requires a check after the checklist, and only when the role can run one", () => {
    const after = { ...s0, rounds: 1, checkRequired: true };
    expect(nextGateStep(g("checklist"), after, ok)).toEqual({ act: "no_check" });
    expect(nextGateStep(g("checklist"), after, { ...ok, canCheck: false })).toEqual({ act: "accept", outcome: "passed" });
    expect(nextGateStep(g("checklist"), { ...after, checksSince: 1 }, ok)).toEqual({ act: "accept", outcome: "passed" });
  });
  it("reviews once the check ran, and accepts after the review", () => {
    const checked = { ...s0, rounds: 1, checkRequired: true, checksSince: 1 };
    expect(nextGateStep(g("review"), checked, ok)).toEqual({ act: "review" });
    expect(nextGateStep(g("review"), { ...checked, rounds: 2, reviewed: true, checkRequired: false, checksSince: 0 }, ok))
      .toEqual({ act: "accept", outcome: "passed" });
  });
  it("is bounded by max_rounds, and says when a condition was left unmet", () => {
    expect(nextGateStep(g("checklist", 1), { ...s0, rounds: 1, checkRequired: true }, ok)).toEqual({ act: "accept", outcome: "exhausted" });
    expect(nextGateStep(g("checklist", 0), s0, ok)).toEqual({ act: "accept", outcome: "exhausted" });
    expect(nextGateStep(g("review", 1), { ...s0, rounds: 1, checkRequired: true, checksSince: 1 }, ok)).toEqual({ act: "accept", outcome: "exhausted" });
  });
  it("review_only goes straight to the reviewer: no checklist, no check demanded", () => {
    expect(nextGateStep(g("review_only"), s0, ok)).toEqual({ act: "review" });
    // canCheck does not matter: nothing asked for a check.
    expect(nextGateStep(g("review_only"), s0, { ...ok, canCheck: false })).toEqual({ act: "review" });
    // Findings handed back (rounds 1, reviewed): the next end is accepted.
    const reviewed = { ...s0, rounds: 1, reviewed: true };
    expect(nextGateStep(g("review_only"), reviewed, ok)).toEqual({ act: "accept", outcome: "passed" });
    // One round is enough for review_only, and it passes.
    expect(nextGateStep(g("review_only", 1), reviewed, ok)).toEqual({ act: "accept", outcome: "passed" });
    // No round left before the review ran: exhausted, as for review.
    expect(nextGateStep(g("review_only", 0), s0, ok)).toEqual({ act: "accept", outcome: "exhausted" });
    // Not enough budget left: skipped, never reviewed.
    expect(nextGateStep(g("review_only"), s0, { ...ok, budgetLeft: 0.1 })).toEqual({ act: "accept", outcome: "skipped_budget" });
  });
  it("adding review_only moved none of the other modes' decisions", () => {
    // Every state the three earlier modes can reach, decided by the rule as it
    // stood before review_only existed, written out here independently.
    const before = (mode: "checklist" | "review", max: number, s: typeof s0, o: typeof ok) => {
      const unmet = s.rounds === 0 || (s.checkRequired && o.canCheck && s.checksSince === 0) || (mode === "review" && !s.reviewed);
      if (s.rounds >= max) return { act: "accept", outcome: unmet ? "exhausted" : "passed" };
      if (unmet && o.budgetLeft < 0.2) return { act: "accept", outcome: "skipped_budget" };
      if (s.rounds === 0) return { act: "checklist" };
      if (s.checkRequired && o.canCheck && s.checksSince === 0) return { act: "no_check" };
      if (mode === "review" && !s.reviewed) return { act: "review" };
      return { act: "accept", outcome: "passed" };
    };
    let n = 0;
    for (const mode of ["checklist", "review"] as const)
      for (const max of [0, 1, 3])
        for (const rounds of [0, 1, 2, 3])
          for (const checkRequired of [false, true])
            for (const checksSince of [0, 1])
              for (const reviewed of [false, true])
                for (const budgetLeft of [0.1, 0.9])
                  for (const canCheck of [false, true]) {
                    const s = { rounds, checkRequired, checksSince, reviewed };
                    const o = { budgetLeft, canCheck };
                    expect(nextGateStep(g(mode, max), s, o)).toEqual(before(mode, max, s, o));
                    n++;
                  }
    expect(n).toBe(768);
  });
  it("skips when less than min_remaining of the budget is left", () => {
    expect(nextGateStep(g("checklist"), s0, { ...ok, budgetLeft: 0.19 })).toEqual({ act: "accept", outcome: "skipped_budget" });
    expect(nextGateStep(g("checklist"), s0, { ...ok, budgetLeft: 0.2 })).toEqual({ act: "checklist" });
    expect(nextGateStep(g("checklist", 3, 0), s0, { ...ok, budgetLeft: 0 })).toEqual({ act: "checklist" });
  });
});

describe("the budget", () => {
  it("is the smaller of steps and the deadline", () => {
    expect(budgetLeft({ steps: 2, maxTotal: 10, now: 0 })).toEqual({ fraction: 0.8, by: "steps" });
    expect(budgetLeft({ steps: 2, maxTotal: 10, now: 900, deadline: { total_ms: 1000, started_at: 0 } }))
      .toEqual({ fraction: expect.closeTo(0.1, 5), by: "deadline" });
    expect(budgetLeft({ steps: 9, maxTotal: 10, now: 100, deadline: { total_ms: 1000, started_at: 0 } }))
      .toEqual({ fraction: expect.closeTo(0.1, 5), by: "steps" });
    expect(budgetLeft({ steps: 5, maxTotal: 0, now: 0 })).toEqual({ fraction: 1, by: "steps" });
    expect(budgetLeft({ steps: 1, maxTotal: 10, now: 5000, deadline: { total_ms: 1000, started_at: 0 } }).fraction).toBe(0);
  });
});

describe("the surface", () => {
  it("is off unless declared, and reads only real values", () => {
    expect(resolveCompletionGate(cfg(undefined)).mode).toBe("off");
    expect(resolveCompletionGate(cfg({ completion_gate: "reveiw" })).mode).toBe("off");
    expect(resolveCompletionGate(cfg({ completion_gate: "checklist" }))).toEqual({
      mode: "checklist", max_rounds: 3, min_remaining: 0.2, reviewer: "verifier",
    });
    expect(resolveCompletionGate(cfg({ completion_gate: "review", completion_rounds: -2, completion_min_remaining: 7, completion_reviewer: " critique " })))
      .toEqual({ mode: "review", max_rounds: 0, min_remaining: 1, reviewer: "critique" });
  });

  it("a review naming no role is fatal; a reviewer declaring write tools is said", () => {
    const missing = auditCompletionGate(cfg({ completion_gate: "review" }, { implement: {} }));
    expect(missing).toEqual([expect.objectContaining({ fatal: true, where: ".gnomon/policy.toml [verify] completion_reviewer" })]);
    const wide = auditCompletionGate(cfg({ completion_gate: "review", completion_reviewer: "critique" }, {
      critique: { tools: ["read", "write", "bash"] },
    }));
    expect(wide).toHaveLength(1);
    expect(wide[0].fatal).toBe(false);
    expect(wide[0].problem).toContain("write, bash (no bash_allow)");
    const clean = auditCompletionGate(cfg({ completion_gate: "review" }, {
      verifier: { tools: ["read", "grep", "bash"], bash_allow: ["^pytest\\b"] },
    }));
    expect(clean).toEqual([]);
    expect(auditCompletionGate(cfg({ completion_gate: "checklist", completion_min_remaining: 2 }))[0].fatal).toBe(false);
  });

  it("review_only resolves, and its reviewer is audited as review's is", () => {
    expect(resolveCompletionGate(cfg({ completion_gate: "review_only", completion_reviewer: "advisor" })).mode).toBe("review_only");
    const missing = auditCompletionGate(cfg({ completion_gate: "review_only", completion_reviewer: "advisor" }, { implement: {} }));
    expect(missing).toEqual([expect.objectContaining({ fatal: true, where: ".gnomon/policy.toml [verify] completion_reviewer" })]);
    expect(missing[0].problem).toContain('completion_gate = "review_only"');
    expect(auditCompletionGate(cfg({ completion_gate: "review_only" }, {
      verifier: { tools: ["read", "grep", "bash"], bash_allow: ["^pytest\\b"] },
    }))).toEqual([]);
  });

  it("the surface audit names a misspelt mode", () => {
    const problems = auditSurface({ ...cfg({ completion_gate: "reveiw" }), gnomonDir: "/nonexistent/.gnomon" } as any);
    expect(problems.some((p) => /completion_gate/.test(p.where + p.problem))).toBe(true);
  });

  it("the reviewer is offered nothing that can write", () => {
    expect(reviewerToolNames(["read", "write", "edit", "bash", "note", "task", "skill", "grep"], undefined)).toEqual(["read", "grep"]);
    expect(reviewerToolNames(["read", "bash"], ["^cat\\s"])).toEqual(["read", "bash"]);
    expect(reviewerToolNames(["read", "bash"], [])).toEqual(["read"]);
  });
});

describe("helpers", () => {
  it("the task is the last user message", () => {
    expect(taskTextOf([{ role: "user", content: "old" }, { role: "assistant", content: "x" }, { role: "user", content: "new" }])).toBe("new");
    expect(taskTextOf([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }])).toBe("a\nb");
    expect(taskTextOf([{ role: "system", content: "s" }])).toBe("");
  });
  it("in a chain, the task is the request without the previous stage's report", () => {
    const staged = chainStageInput("Fix the parser.", "advisor_plan", "1. Read parse.py\n---\n2. Fix it");
    expect(staged.startsWith("Fix the parser." + CHAIN_CARRY)).toBe(true);
    expect(staged).toContain("The previous stage (advisor_plan) reported:\n1. Read parse.py");
    expect(taskTextOf([{ role: "user", content: staged }])).toBe("Fix the parser.");
    expect(taskTextOf([{ role: "user", content: [{ type: "text", text: staged }] }])).toBe("Fix the parser.");
    // A request that merely contains a horizontal rule is left whole.
    const plain = "Do A.\n\n---\nThen do B.";
    expect(withoutChainCarry(plain)).toBe(plain);
    expect(taskTextOf([{ role: "user", content: plain }])).toBe(plain);
  });
  it("changed paths come from two snapshots, or are unknown", () => {
    const before = { tracked: new Map([["a.ts", [1, 0]], ["gone.ts", [0, 1]]]), untracked: new Map([["keep.txt", 1]]) };
    const after = { tracked: new Map([["a.ts", [2, 0]]]), untracked: new Map([["keep.txt", 1], ["new.py", 3]]) };
    expect(changedPaths(before, after)).toEqual(["a.ts", "gone.ts", "new.py"]);
    expect(changedPaths(null, after)).toBeNull();
  });
});

describe("the contract (conformance/completion_gate.json)", () => {
  const root = join(process.cwd(), "..", "..");
  const fixture = JSON.parse(readFileSync(join(root, "conformance", "completion_gate.json"), "utf8"));
  const contracts = readFileSync(join(root, "docs", "CONTRACTS.md"), "utf8");

  it("has the module's modes, actions, outcomes, defaults and reviewer tools", () => {
    expect(fixture.modes).toEqual([...COMPLETION_GATE_MODES]);
    expect(fixture.actions).toEqual([...COMPLETION_GATE_ACTIONS]);
    expect(fixture.outcomes).toEqual([...COMPLETION_GATE_OUTCOMES]);
    expect(fixture.policy.defaults).toEqual(COMPLETION_GATE_DEFAULTS);
    expect(fixture.reviewer_tools).toEqual([...REVIEWER_TOOLS]);
  });

  it("is the section CONTRACTS.md publishes", () => {
    const at = contracts.indexOf("## 30. Completion gate");
    expect(at, "CONTRACTS.md has no completion-gate section").toBeGreaterThan(-1);
    const next = contracts.indexOf("\n## ", at + 1);
    const section = contracts.slice(at, next === -1 ? undefined : next);
    expect(section).toContain("conformance/completion_gate.json");
    expect(section).toContain(`\`${fixture.audit.kind}\``);
    for (const v of [...fixture.modes, ...fixture.actions, ...fixture.outcomes]) expect(section, v).toContain(`\`${v}\``);
    for (const k of Object.keys(fixture.policy.defaults)) expect(section, k).toContain(`\`${k}\``);
    for (const k of [...fixture.counters.required, ...fixture.counters.optional]) expect(section, k).toContain(`\`${k}\``);
    for (const k of [...fixture.audit.required, ...fixture.audit.optional]) expect(section, k).toContain(`\`${k}\``);
  });
});
