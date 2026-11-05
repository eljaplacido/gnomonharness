/**
 * `gnomon chaos` as a command: its arguments, its exit contract
 * (docs/CONTRACTS.md §20), and the two renderings of the scorecard. The suite
 * itself is held to its figures in gnomon-core's chaos.test.ts.
 */
import { describe, it, expect } from "vitest";
import { cmdChaos, parseChaosArgs, renderCard, CHAOS_USAGE } from "./chaos.js";
import { CHAOS_FAULTS } from "gnomon-core";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (s: string) => void out.push(s), e: (s: string) => void err.push(s) };
};

describe("gnomon chaos — arguments", () => {
  it("reads its subcommands and flags", () => {
    expect(parseChaosArgs(["list", "--json"])).toEqual({ sub: "list", flags: { json: "true" }, positional: [] });
    expect(parseChaosArgs(["--faults", "error,empty", "--seed", "3"]).flags).toEqual({ faults: "error,empty", seed: "3" });
  });

  it("--help prints the usage and exits 0", async () => {
    const c = capture();
    expect(await cmdChaos(["--help"], c.o, c.e)).toBe(0);
    expect(c.out.join("\n")).toBe(CHAOS_USAGE);
  });

  it("refuses what it cannot run with exit 2, before starting anything", async () => {
    for (const argv of [["--faults", "nope"], ["--schedules", "sometimes"], ["--seed", "x"], ["stray"]]) {
      const c = capture();
      expect(await cmdChaos(argv, c.o, c.e), argv.join(" ")).toBe(2);
      expect(c.err.join("\n")).toMatch(/gnomon chaos/);
    }
  });

  it("list --json publishes the taxonomy, patterns as strings", async () => {
    const c = capture();
    expect(await cmdChaos(["list", "--json"], c.o, c.e)).toBe(0);
    const j = JSON.parse(c.out.join(""));
    expect(j.faults.map((f: { id: string }) => f.id)).toEqual(CHAOS_FAULTS.map((f) => f.id));
    expect(typeof j.faults[0].names).toBe("string");
    expect(j.schedules).toEqual(["single", "persistent", "intermittent", "burst"]);
  });

  it("list prints one line per fault and what it injects", async () => {
    const c = capture();
    expect(await cmdChaos(["list"], c.o, c.e)).toBe(0);
    const text = c.out.join("\n");
    for (const f of CHAOS_FAULTS) expect(text).toContain(f.id);
  });
});

describe("gnomon chaos — a real run", () => {
  it("one fault, --json: the card on stdout and the exit it states", async () => {
    const c = capture();
    const code = await cmdChaos(["--faults", "schema.content", "--json"], c.o, c.e);
    const card = JSON.parse(c.out.join(""));
    expect(card.schema).toBe("gnomon.chaos/1");
    expect(code).toBe(card.exit);
    expect(card.apparatus.problems).toEqual([]);
    expect(card.summary).toMatchObject({ faults: 1, faults_announced: 1, cases: 1 });
    expect(code).toBe(0);
    // And as a table.
    const table = renderCard(card);
    expect(table).toMatch(/ANNOUNCED 1\/1 faults/);
    expect(table).toMatch(/schema\.content/);
    expect(table).toMatch(/exit 0/);
  }, 120_000);

  it("a void card says so before any number", () => {
    const table = renderCard({
      schema: "gnomon.chaos/1",
      harness: "gnomon/test",
      mode: "gnomon task --json",
      seed: 1,
      plan_hash: "0".repeat(64),
      surface_template_hash: "0".repeat(64),
      controls: [],
      apparatus: {
        ok: false,
        problems: ["every role is routed elsewhere"],
        lane_check: { tasks: [], serial_equals_concurrent: false, garbling_caught: false },
        baselines: [],
      },
      faults: [],
      cases: [],
      summary: {
        faults: 0, faults_announced: 0, faults_silent: [], cases: 0, cases_fired: 0, cases_announced: 0,
        cases_named: 0, cases_recovered: 0, failed: 0, silent_failures: 0, silent_failure_share: 0, tokens_wasted: 0,
      },
      exit: 2,
      volatile: { duration_ms: 0, surface_hash: "", endpoint: "", case_ms: {}, trace: {} },
    });
    expect(table.indexOf("VOID")).toBeLessThan(table.indexOf("ANNOUNCED"));
    expect(table).toMatch(/routed elsewhere/);
  });
});
