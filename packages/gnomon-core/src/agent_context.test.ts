/**
 * agent_context.ts: is this process an agent's? Unit tests over a fake /proc
 * tree. The end-to-end attacks, through the real bash tool and the real CLI,
 * are in packages/gnomon-cli/src/skill_self_approval.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAncestry, agentReason, isGnomonAncestor, setDecisionContextProbe } from "./agent_context.js";

let proc: string;
beforeEach(() => {
  proc = mkdtempSync(join(tmpdir(), "gnomon-proc-"));
});
afterEach(() => {
  rmSync(proc, { recursive: true, force: true });
  setDecisionContextProbe(null);
});

/** One fake /proc/<pid>: its parent, initial environment and command line. */
function pid(n: number, ppid: number, env: string[], argv: string[], comm = "x"): void {
  mkdirSync(join(proc, String(n)), { recursive: true });
  writeFileSync(join(proc, String(n), "stat"), `${n} (${comm}) S ${ppid} ${n} ${n} 0 -1 4194304`);
  writeFileSync(join(proc, String(n), "environ"), env.map((e) => `${e}\0`).join(""));
  writeFileSync(join(proc, String(n), "cmdline"), argv.map((a) => `${a}\0`).join(""));
}

describe("isGnomonAncestor", () => {
  it.each([
    [["node", "/usr/lib/node_modules/gnomon-harness/bin/gnomon.mjs"]],
    [["node", "/home/u/gnomon/packages/gnomon-cli/gnomon.js", "task", "fix it"]],
    [["/usr/bin/node", "--import", "file:///x/tsx/dist/loader.mjs", "/r/packages/gnomon-cli/src/index.ts", "acp"]],
    [["node", "/r/packages/gnomon-cli/dist/index.js", "skill", "trial", "x"]],
    [["/usr/local/bin/gnomon", "--yes"]],
    [["/bin/sh", "/usr/local/bin/gnomon", "task", "x"]],
  ])("%j is gnomon", (argv) => {
    expect(isGnomonAncestor(argv)).toBe(true);
  });

  it.each([
    // A launcher of the very decision: gnomon.js's tsx fallback, a sh wrapper.
    [["node", "/r/packages/gnomon-cli/gnomon.js", "skill", "accept", "x"]],
    [["/bin/sh", "/usr/local/bin/gnomon", "skill", "reject", "x", "--reason", "no"]],
    [["node", "/r/gnomon.js", "audit", "resolve", "a.jsonl:3", "--reason", "r"]],
    // Not gnomon at all, or an inline program whose text happens to end in it.
    [["bash", "-c", "cd ~/gnomon"]],
    [["/bin/bash", "-lc", "ls /x/gnomon"]],
    [["node", "-e", "require('/x/gnomon.js')"]],
    [["vim", "gnomon.js"]],
    [["/usr/bin/gnomon-exec", "run"]],
    [[]],
  ])("%j is not", (argv) => {
    expect(isGnomonAncestor(argv)).toBe(false);
  });
});

describe("agentAncestry", () => {
  it("finds the marker in an ancestor's initial environment, whatever this process's says", () => {
    // gnomon (100) → the bash tool's shell (200, marked) → `env -u` → gnomon skill accept (300)
    pid(100, 1, ["PATH=/bin"], ["/usr/bin/vitest-or-anything"]);
    pid(200, 100, ["PATH=/bin", "GNOMON_AGENT_SESSION=s-1"], ["/bin/sh", "-c", "env -u GNOMON_AGENT_SESSION gnomon skill accept n"]);
    pid(300, 200, ["PATH=/bin"], ["node", "/x/bin/gnomon.mjs", "skill", "accept", "n"]);
    expect(agentAncestry({ pid: 300, proc })).toMatch(/ancestor process 200 was started inside agent session s-1/);
  });

  it("an empty marker in an ancestor counts", () => {
    pid(200, 1, ["GNOMON_AGENT_SESSION="], ["/bin/sh"]);
    pid(300, 200, [], ["node", "/x/bin/gnomon.mjs", "skill", "accept", "n"]);
    expect(agentAncestry({ pid: 300, proc })).toMatch(/agent session \(empty\)/);
  });

  it("finds the harness itself when the shell exec'd the command and no marked process is left", () => {
    // `exec env -i gnomon skill accept n`: the shell's pid now runs gnomon
    // with a clean environment, and its parent is the harness.
    pid(100, 1, ["PATH=/bin"], ["node", "/x/bin/gnomon.mjs", "task", "do it"]);
    pid(300, 100, ["PATH=/bin"], ["node", "/x/bin/gnomon.mjs", "skill", "accept", "n"]);
    expect(agentAncestry({ pid: 300, proc })).toMatch(/ancestor process 100 is gnomon itself/);
  });

  it("a person's shell above is nothing; comm with spaces and parentheses parses", () => {
    pid(50, 1, ["HOME=/h"], ["/usr/bin/tmux", "new"], "tmux: server");
    pid(60, 50, ["HOME=/h"], ["-bash"], "a (b) c");
    pid(70, 60, ["HOME=/h"], ["/bin/sh", "/usr/local/bin/gnomon", "skill", "accept", "n"]);
    pid(80, 70, ["HOME=/h"], ["node", "/x/bin/gnomon.mjs", "skill", "accept", "n"]);
    expect(agentAncestry({ pid: 80, proc })).toBeNull();
  });

  it("no /proc: nothing is claimed", () => {
    expect(agentAncestry({ pid: 300, proc: join(proc, "absent") })).toBeNull();
  });
});

describe("agentReason", () => {
  beforeEach(() => setDecisionContextProbe(() => ({ agent: null, interactive: true })));

  it.each([
    ["set", { GNOMON_AGENT_SESSION: "s-1" }, /GNOMON_AGENT_SESSION=s-1/],
    ["empty", { GNOMON_AGENT_SESSION: "" }, /GNOMON_AGENT_SESSION=\(empty\)/],
    ["overwritten", { GNOMON_AGENT_SESSION: "operator" }, /GNOMON_AGENT_SESSION=operator/],
  ])("the marker in this environment, %s, refuses", (_name, env, why) => {
    expect(agentReason(env as NodeJS.ProcessEnv)).toMatch(why);
  });

  it("absent here, the probe decides", () => {
    expect(agentReason({})).toBeNull();
    setDecisionContextProbe(() => ({ agent: "ancestor process 7 was started inside agent session s", interactive: true }));
    expect(agentReason({})).toMatch(/ancestor process 7/);
  });
});
