/**
 * `gnomon security test --sandbox` (sandbox_probes.ts) against
 * conformance/sandbox_probes.json (CONTRACTS.md §63) and the matrix in
 * docs/THREAT-MODEL.md.
 *
 * The probes that need a real sandbox skip with the reason where the machine
 * has none (no docker, no Landlock, Windows); none needs root, and every one
 * works in a temp directory this test owns.
 */

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CELL_STATUSES,
  CONFIGS,
  ESCAPE_CLASSES,
  PROBE_CONFIG_IDS,
  SANDBOX_PROBE_EXIT,
  SANDBOX_PROBE_LIMITS,
  SANDBOX_PROBE_SCHEMA,
  THREATS,
  THREAT_MATRIX,
  availability,
  formatSandboxProbes,
  probeCatalog,
  removeTree,
  runSandboxProbes,
  statusOf,
  type Cell,
  type ProbeConfigId,
} from "./sandbox_probes.js";
import { DEFAULT_SANDBOX_IMAGE } from "gnomon-core";

// Real docker and a real sandbox are spawned per probe.
vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "conformance/sandbox_probes.json"), "utf-8")) as {
  exit: Record<string, number>;
  configs: string[];
  threats: string[];
  escape_classes: string[];
  cell_statuses: string[];
  coverage: string[];
  report_keys: string[];
  cell_keys: string[];
  config_keys: string[];
  probes: Array<{ id: string; threat: string; escape_class: string; applies: string[]; claimed: string[] }>;
};

const TOOL_CONFIGS: ProbeConfigId[] = ["tools_off", "tools_confined", "tools_strict"];
const avail = availability(DEFAULT_SANDBOX_IMAGE);
const cellsOf = (cells: Cell[], config: string): Cell[] => cells.filter((c) => c.config === config);

describe("the contract", () => {
  it("configs, threats, escape classes, statuses, exits and every probe are the fixture's", () => {
    expect(SANDBOX_PROBE_SCHEMA).toBe("gnomon.sandbox_probes/1");
    expect([...PROBE_CONFIG_IDS]).toEqual(FIXTURE.configs);
    expect(CONFIGS.map((c) => c.id)).toEqual(FIXTURE.configs);
    expect([...THREATS]).toEqual(FIXTURE.threats);
    expect([...ESCAPE_CLASSES]).toEqual(FIXTURE.escape_classes);
    expect([...CELL_STATUSES]).toEqual(FIXTURE.cell_statuses);
    expect(SANDBOX_PROBE_EXIT).toEqual({ clean: FIXTURE.exit.clean, failed: FIXTURE.exit.failed, couldNotRun: FIXTURE.exit.could_not_run });
    expect(probeCatalog()).toEqual(FIXTURE.probes);
  });

  it("every claimed config is one the probe applies to, and every threat has a probe", () => {
    for (const p of probeCatalog()) for (const c of p.claimed) expect(p.applies, `${p.id} claims ${c}`).toContain(c);
    for (const t of THREATS) expect(probeCatalog().some((p) => p.threat === t), t).toBe(true);
  });

  it("a claim that holds passes, a claim that does not is a FAIL, and an unclaimed escape is only open", () => {
    expect(statusOf({ outcome: "contained", detail: "" }, true)).toBe("pass");
    expect(statusOf({ outcome: "escaped", detail: "" }, true)).toBe("FAIL");
    expect(statusOf({ outcome: "escaped", detail: "" }, false)).toBe("open");
    expect(statusOf({ outcome: "contained", detail: "" }, false)).toBe("contained_unclaimed");
    expect(statusOf({ outcome: "inconclusive", detail: "" }, true)).toBe("skipped");
    expect(statusOf({ outcome: "not_applicable", detail: "" }, true)).toBe("n/a");
  });
});

describe("docs/THREAT-MODEL.md carries the matrix the code holds", () => {
  const doc = readFileSync(join(ROOT, "docs/THREAT-MODEL.md"), "utf-8");
  const section = doc.slice(doc.indexOf("## Sandbox level x threat"), doc.indexOf("## Trajectory-level detection"));
  const rows = section.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| Threat"));
  const cols: ProbeConfigId[] = ["tools_off", "tools_confined", "exec_off", "exec_os", "exec_os_scoped", "exec_docker"];
  const label: Record<string, string> = {
    file_escape: "File escape",
    network: "Network",
    process: "Process",
    credential: "Credential",
    container_breakout: "Container breakout",
  };

  it("has one row per threat and one cell per sandbox level, each equal to THREAT_MATRIX", () => {
    expect(rows).toHaveLength(THREATS.length);
    for (const t of THREATS) {
      const row = rows.find((r) => r.startsWith(`| ${label[t]}`));
      expect(row, t).toBeDefined();
      const cells = row!.split("|").slice(2, -1).map((c) => c.trim());
      expect(cells, t).toHaveLength(cols.length);
      cols.forEach((c, i) => expect(cells[i], `${t} x ${c}`).toBe(THREAT_MATRIX[t][c]));
    }
  });

  it("confined and strict are one column because the matrix holds them equal", () => {
    for (const t of THREATS) expect(THREAT_MATRIX[t].tools_confined).toBe(THREAT_MATRIX[t].tools_strict);
  });

  it("only uses the three words the contract allows, and states what it does not cover", () => {
    for (const t of THREATS) for (const c of PROBE_CONFIG_IDS) expect(FIXTURE.coverage).toContain(THREAT_MATRIX[t][c]);
    expect(section).toMatch(/no microVM or gVisor backend/);
    expect(section).toMatch(/Do not run code you\s+believe is hostile/);
  });
});

describe("the probes on this machine", () => {
  it("tool paths: confined and strict hold all three; level off is open on all three (the control)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "gnomon-probe-parent-"));
    const home = process.env.HOME;
    try {
      const r = await runSandboxProbes({ only: TOOL_CONFIGS, scratchParent: parent });
      for (const k of FIXTURE.report_keys) expect(r, k).toHaveProperty(k);
      for (const c of r.cells) for (const k of FIXTURE.cell_keys) expect(c, k).toHaveProperty(k);
      for (const c of r.configs) for (const k of FIXTURE.config_keys) expect(c, k).toHaveProperty(k);
      for (const cfg of ["tools_confined", "tools_strict"]) {
        const cs = cellsOf(r.cells, cfg);
        expect(cs.map((c) => c.probe).sort()).toEqual(["tool_read_outside_root", "tool_symlink_out_of_root", "tool_write_outside_root"]);
        // A symlink may be unmakeable (Windows without the privilege): skipped, never a pass or a fail.
        for (const c of cs) expect(["pass", "skipped"], `${cfg} ${c.probe}: ${c.detail}`).toContain(c.status);
        expect(cs.filter((c) => c.status === "pass").length).toBeGreaterThanOrEqual(2);
      }
      const off = cellsOf(r.cells, "tools_off");
      expect(off.filter((c) => c.status === "open").length, off.map((c) => `${c.probe} ${c.status}`).join(", ")).toBeGreaterThanOrEqual(2);
      expect(r.failed).toBe(0);
      expect(r.exit).toBe(0);
      // Nothing is left behind, and HOME is the one the caller had.
      expect(readdirSync(parent)).toEqual([]);
      expect(process.env.HOME).toBe(home);
      expect(formatSandboxProbes(r).join("\n")).toMatch(/configuration and containment checks only, nothing is exploited/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("negative control: a level that does not contain, claimed anyway, is reported as FAIL with exit 2", async () => {
    const r = await runSandboxProbes({ only: ["tools_off"], assume: ["tools_off"] });
    const fails = cellsOf(r.cells, "tools_off").filter((c) => c.status === "FAIL");
    expect(fails.length).toBeGreaterThanOrEqual(2);
    expect(r.failed).toBe(fails.length);
    expect(r.exit).toBe(SANDBOX_PROBE_EXIT.failed);
  });

  it("a configuration that cannot be measured is skipped with its reason, never passed", async () => {
    const r = await runSandboxProbes({ only: ["exec_docker"], image: "gnomon-no-such-image-0123456789:absent" });
    const cfg = r.configs[0]!;
    expect(cfg.skipped).toBeTruthy();
    expect(cellsOf(r.cells, "exec_docker").every((c) => c.status === "skipped")).toBe(true);
    expect(r.exit).toBe(0);
    expect(cfg.pass + cfg.fail + cfg.open).toBe(0);
  });

  it("an image that is not a reference is refused before anything runs", async () => {
    await expect(runSandboxProbes({ image: "--privileged" })).rejects.toThrow(/not a container image reference/);
  });

  // Where the machine has no OS sandbox or no docker these say so and return: the test count
  // is the same on every machine (README's status line is checked against it), and the
  // reason is printed, not hidden.
  const osWhy = process.platform === "win32" ? "Windows" : avail.exec_os_scoped;
  it("exec = os: no claimed containment fails (says why when this machine cannot run it)", async () => {
    if (osWhy) {
      console.warn(`[SKIPPED exec = os probes: ${osWhy}]`);
      return;
    }
    const r = await runSandboxProbes({ only: ["exec_os", "exec_os_scoped", "exec_off"] });
    expect(r.cells.filter((c) => c.status === "FAIL").map((c) => `${c.config} ${c.probe}: ${c.detail}`)).toEqual([]);
    // The control that makes the pass mean something: the same probe, unsandboxed, escapes.
    const off = cellsOf(r.cells, "exec_off");
    expect(off.find((c) => c.probe === "bash_write_outside_root")!.status).toBe("open");
    expect(off.find((c) => c.probe === "bash_read_outside_root")!.status).toBe("open");
    const scoped = cellsOf(r.cells, "exec_os_scoped");
    expect(scoped.find((c) => c.probe === "bash_read_outside_root")!.status).toBe("pass");
    expect(scoped.find((c) => c.probe === "bash_credential_read")!.status).toBe("pass");
    expect(scoped.find((c) => c.probe === "bash_write_outside_root")!.status).toBe("pass");
  });

  it("[sandbox] loopback = deny: the loopback probe is claimed for exec = os and passes; by default it stays open by design", async () => {
    if (osWhy) {
      console.warn(`[SKIPPED loopback probes: ${osWhy}]`);
      return;
    }
    const only = ["exec_os", "exec_os_scoped"] as const;
    const dflt = await runSandboxProbes({ only });
    for (const c of only) {
      const cell = cellsOf(dflt.cells, c).find((k) => k.probe === "network_loopback_when_off")!;
      expect(cell.claimed, `${c} default`).toBe(false);
      expect(cell.status, `${c} default`).toBe("open");
    }
    const denied = await runSandboxProbes({ only, loopback: "deny" });
    for (const c of only) {
      const cell = cellsOf(denied.cells, c).find((k) => k.probe === "network_loopback_when_off")!;
      expect(cell.claimed, `${c} deny`).toBe(true);
      expect(cell.status, `${c} deny: ${cell.detail}`).toBe("pass");
    }
    expect(denied.cells.filter((c) => c.status === "FAIL")).toEqual([]);
  });

  const dockerWhy = process.platform === "win32" ? "Windows" : avail.exec_docker;
  it("exec = docker: no claimed containment fails (says why when this machine cannot run it)", async () => {
    if (dockerWhy) {
      console.warn(`[SKIPPED exec = docker probes: ${dockerWhy}]`);
      return;
    }
    const r = await runSandboxProbes({ only: ["exec_docker"] });
    expect(r.cells.filter((c) => c.status === "FAIL").map((c) => `${c.probe}: ${c.detail}`)).toEqual([]);
    const pass = cellsOf(r.cells, "exec_docker").filter((c) => c.status === "pass").map((c) => c.probe);
    for (const id of ["bash_read_outside_root", "bash_write_outside_root", "bash_credential_read", "docker_socket_reachable", "no_new_privileges", "container_capabilities"]) {
      expect(pass, id).toContain(id);
    }
    // No container is left running.
    const left = spawnSync("docker", ["ps", "-q", "--filter", "label=gnomon.root"], { encoding: "utf-8" });
    expect(left.stdout.trim()).toBe("");
  });
});

describe("the flag is opt-in", () => {
  it("a plain security test run has no sandbox section, and --help says what --sandbox adds", () => {
    const help = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "--help"], { encoding: "utf-8" });
    expect(help.stdout).toMatch(/security test \[--host [^\]]*\] \[--role <r>\] \[--sandbox \[--image <ref>\] \[--loopback deny\]\]/);
    expect(help.stdout).toMatch(/--sandbox adds the sandbox-escape probes/);
  });
});

describe("probe hygiene", () => {
  const posix = process.platform !== "win32";

  it.runIf(posix)("HOME is substituted for one probe at a time, never between probes", async () => {
    const home = process.env.HOME;
    const seen: Array<string | undefined> = [];
    const r = await runSandboxProbes({ only: ["exec_off"], onCell: () => seen.push(process.env.HOME) });
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h).toBe(home);
    expect(r.leftover).toBeNull();
  });

  it.runIf(posix)("the non-loopback listener lives for one probe and is closed before the next", async () => {
    const events: string[] = [];
    await runSandboxProbes({ only: ["exec_off"], onLan: (st) => events.push(`lan:${st}`), onCell: (c) => events.push(`cell:${c.probe}`) });
    const opens = events.filter((e) => e === "lan:open").length;
    expect(opens).toBeLessThanOrEqual(1);
    events.forEach((e, i) => {
      if (e === "lan:open") {
        expect(events[i + 1]).toBe("lan:closed");
        expect(events[i + 2]).toBe("cell:network_egress_when_off");
      }
    });
  });

  it("the report says the docker-socket probe connects, and sends nothing", () => {
    expect(SANDBOX_PROBE_LIMITS.join("\n")).toMatch(/docker-socket probe.*connect\(\)s to it and closes \(no bytes are sent\)/);
    expect(probeCatalog().some((p) => p.id === "docker_socket_reachable")).toBe(true);
  });

  it.runIf(posix && process.getuid?.() !== 0)("a tree that cannot be removed is reported by path, not left silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-stuck-"));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "f"), "x");
    chmodSync(sub, 0o500);
    try {
      const left = removeTree(dir, "gnomon-no-such-image:none");
      expect(left).toBe(dir);
      expect(existsSync(dir)).toBe(true);
    } finally {
      chmodSync(sub, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(removeTree(join(tmpdir(), "gnomon-never-made"), "x")).toBeNull();
  });
});
