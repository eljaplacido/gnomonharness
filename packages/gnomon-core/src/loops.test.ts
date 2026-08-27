/**
 * gnomon-core: Loop tests
 *
 * A loop runs unattended, so the paths that matter are the ones nobody will be
 * watching: the breaker that stops a broken remediation from retrying forever,
 * the rate ceiling, and the guarantee that loop state never perturbs the
 * surface hash. Those are pinned here rather than trusted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLoops,
  runTick,
  readState,
  guardTrips,
  cronExpr,
  LoopDef,
  LOOP_STATE_DIR,
} from "./loops.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-loops-"));
  mkdirSync(join(root, ".gnomon", "loops"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const loop = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: "t",
  every: "5m",
  act: { run: "true" },
  limits: {},
  ...over,
});

describe("guardTrips", () => {
  it("compares with each operator", () => {
    expect(guardTrips("gt 5", 6, 0)).toBe(true);
    expect(guardTrips("gt 5", 5, 0)).toBe(false);
    expect(guardTrips("ge 5", 5, 0)).toBe(true);
    expect(guardTrips("lt 5", 4, 0)).toBe(true);
    expect(guardTrips("le 5", 5, 0)).toBe(true);
    expect(guardTrips("eq 0", 0, 0)).toBe(true);
    expect(guardTrips("ne 0", 0, 0)).toBe(false);
  });

  it("reads exit status when asked to", () => {
    expect(guardTrips("exit_nonzero", null, 1)).toBe(true);
    expect(guardTrips("exit_nonzero", null, 0)).toBe(false);
  });

  it("does not trip on an unreadable value", () => {
    // A guard that printed nothing has not said "act". Treating an unparsable
    // reading as a trip would make every broken guard a trigger.
    expect(guardTrips("gt 5", null, 0)).toBe(false);
  });

  it("trips when no condition is given", () => {
    expect(guardTrips(undefined, null, 0)).toBe(true);
  });
});

describe("cronExpr", () => {
  it("renders minutes, hours, days", () => {
    expect(cronExpr("5m")).toBe("*/5 * * * *");
    expect(cronExpr("2h")).toBe("0 */2 * * *");
    expect(cronExpr("1d")).toBe("0 0 */1 * *");
  });

  it("rejects periods cron cannot express", () => {
    // */90 in the minute field does not mean "every 90 minutes" -- it means
    // "every 90th minute past the hour", which never fires. Silently accepting
    // it would install a loop that looks scheduled and never runs.
    expect(() => cronExpr("90m")).toThrow();
    expect(() => cronExpr("36h")).toThrow();
    expect(() => cronExpr("banana")).toThrow();
  });
});

describe("runTick", () => {
  it("skips without acting when the guard does not trip", () => {
    const marker = join(root, "acted");
    const r = runTick(root, loop({
      guard: { run: "echo 0", act_when: "gt 0" },
      act: { run: `touch ${JSON.stringify(marker)}` },
    }));
    expect(r.outcome).toBe("skipped");
    expect(r.guardValue).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("acts when the guard trips", () => {
    const marker = join(root, "acted");
    const r = runTick(root, loop({
      guard: { run: "echo 7", act_when: "gt 0" },
      act: { run: `touch ${JSON.stringify(marker)}` },
    }));
    expect(r.outcome).toBe("acted");
    expect(existsSync(marker)).toBe(true);
  });

  it("does not act on a dry run", () => {
    const marker = join(root, "acted");
    const r = runTick(root, loop({
      guard: { run: "echo 7", act_when: "gt 0" },
      act: { run: `touch ${JSON.stringify(marker)}` },
    }), { dryRun: true });
    expect(r.outcome).toBe("acted");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a guard timeout as apparatus failure, not as 'nothing wrong'", () => {
    const r = runTick(root, loop({
      guard: { run: "sleep 5", act_when: "gt 0", timeout_sec: 1 },
    }));
    expect(r.outcome).toBe("guard_failed");
  });

  it("opens the breaker after repeated action failures and then stops acting", () => {
    const l = loop({
      guard: { run: "echo 1", act_when: "gt 0" },
      act: { run: "false" },
      limits: { max_consecutive_failures: 2 },
    });
    expect(runTick(root, l).outcome).toBe("act_failed");
    expect(runTick(root, l).outcome).toBe("act_failed");
    expect(readState(root, "t").tripped).toBe(true);
    // The point of the breaker: the third tick must not run the action at all.
    expect(runTick(root, l).outcome).toBe("breaker_open");
  });

  it("clears the failure streak once a tick comes back clean", () => {
    const failing = loop({ guard: { run: "echo 1", act_when: "gt 0" }, act: { run: "false" }, limits: { max_consecutive_failures: 3 } });
    runTick(root, failing);
    expect(readState(root, "t").consecutive_failures).toBe(1);
    runTick(root, loop({ guard: { run: "echo 0", act_when: "gt 0" }, act: { run: "false" } }));
    expect(readState(root, "t").consecutive_failures).toBe(0);
  });

  it("stops acting once the hourly ceiling is reached", () => {
    const l = loop({
      guard: { run: "echo 1", act_when: "gt 0" },
      act: { run: "true" },
      limits: { max_runs_per_hour: 2 },
    });
    expect(runTick(root, l).outcome).toBe("acted");
    expect(runTick(root, l).outcome).toBe("acted");
    expect(runTick(root, l).outcome).toBe("rate_limited");
  });

  it("keeps state out of .gnomon/, so ticking cannot change the surface hash", () => {
    // The whole determinism story depends on this. State inside .gnomon/ would
    // make collectSurface() see a different tree after every tick.
    runTick(root, loop({ guard: { run: "echo 1", act_when: "gt 0" } }));
    expect(existsSync(join(root, LOOP_STATE_DIR, "t.json"))).toBe(true);
    expect(readdirSync(join(root, ".gnomon"))).toEqual(["loops"]);
  });
});

describe("loadLoops", () => {
  const write = (name: string, body: string) =>
    writeFileSync(join(root, ".gnomon", "loops", name), body);

  it("reads a declaration", () => {
    write("a.toml", `[loop]\nname = "a"\nevery = "10m"\n\n[guard]\nrun = "echo 0"\nact_when = "gt 0"\n\n[act]\nrun = "true"\n`);
    const [l] = loadLoops(join(root, ".gnomon"));
    expect(l.name).toBe("a");
    expect(l.every).toBe("10m");
    expect(l.guard?.act_when).toBe("gt 0");
  });

  it("rejects a loop with no action", () => {
    write("b.toml", `[loop]\nname = "b"\nevery = "5m"\n`);
    expect(() => loadLoops(join(root, ".gnomon"))).toThrow(/needs \[act\]/);
  });

  it("rejects a loop with no schedule", () => {
    write("c.toml", `[loop]\nname = "c"\n\n[act]\nrun = "true"\n`);
    expect(() => loadLoops(join(root, ".gnomon"))).toThrow(/needs "every"/);
  });

  it("is a no-op when nothing is declared", () => {
    rmSync(join(root, ".gnomon", "loops"), { recursive: true });
    expect(loadLoops(join(root, ".gnomon"))).toEqual([]);
  });
});
