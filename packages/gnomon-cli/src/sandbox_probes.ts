/**
 * Sandbox-escape probes for `gnomon security test --sandbox`.
 *
 * The attack corpus (security_test.ts) asks whether the guard refuses a call.
 * These ask a different question, of the layer under it: for each place a
 * command can run (the tool paths at each `[sandbox] level`, `bash` under
 * `exec = "off"`, `"os"`, `"os"` with `reads = "scoped"`, `"docker"`), does the
 * containment gnomon claims for it hold on THIS machine, now?
 *
 * SAFETY. Every probe is a configuration or containment check and nothing else.
 * None runs exploit code, touches a kernel flaw, or tries to break out of
 * anything. What they do:
 *   - read or write a canary file this test created in a temp directory it also
 *     made, outside the project root it also made;
 *   - read a fake credential file in a substituted HOME (never the real one);
 *   - connect to a loopback port this test opened, and close the connection;
 *   - `connect()` once to the docker socket and close it, sending nothing (only
 *     to learn whether the sandbox lets the connection through), or find the
 *     socket absent;
 *   - read /proc/self/status, /proc/self/mountinfo, the namespace links of
 *     /proc/self, and ask `test -w` (an access(2) call that writes nothing)
 *     about /proc/sys/kernel/core_pattern, /proc/sysrq-trigger and the cgroup
 *     files.
 * Nothing is written outside the temp directory the test created, and that
 * directory is removed afterwards. No root is needed or used.
 *
 * A probe has a CLAIM: whether gnomon says this configuration contains that
 * thing (see THREAT_MATRIX and docs/THREAT-MODEL.md). The cell is then
 *   pass                 claimed, and it held
 *   FAIL                 claimed, and it did not hold: a finding (exit 2)
 *   open                 not claimed, and it is open: a documented limit, said again here
 *   contained_unclaimed  not claimed, but it held on this machine
 *   skipped              could not be measured here (no docker, no Landlock, ...), with why
 *   n/a                  the check does not apply to this configuration
 * A configuration that cannot be measured is skipped with its reason, never
 * reported as passing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_IMAGE, executeTool, harnessBuild, isValidImageRef, type SandboxLevel, type ToolContext } from "gnomon-core";
import { osSandbox } from "gnomon-natives";

export const SANDBOX_PROBE_SCHEMA = "gnomon.sandbox_probes/1";

export const PROBE_CONFIG_IDS = ["tools_off", "tools_confined", "tools_strict", "exec_off", "exec_os", "exec_os_scoped", "exec_docker"] as const;
export type ProbeConfigId = (typeof PROBE_CONFIG_IDS)[number];
export const THREATS = ["file_escape", "network", "process", "credential", "container_breakout"] as const;
export type Threat = (typeof THREATS)[number];
/** The escape classes of the survey (SandboxEscapeBench, section 3.3), plus the boundary the OS sandboxes draw. */
export const ESCAPE_CLASSES = ["permission_boundary", "misconfiguration", "privilege_allocation", "runtime_orchestration"] as const;
export type EscapeClass = (typeof ESCAPE_CLASSES)[number];
export const CELL_STATUSES = ["pass", "FAIL", "open", "contained_unclaimed", "skipped", "n/a"] as const;
type CellStatus = (typeof CELL_STATUSES)[number];
export const SANDBOX_PROBE_EXIT = { clean: 0, failed: 2, couldNotRun: 10 } as const;

export type Coverage = "covered" | "partially" | "not covered";

/**
 * Which threat each configuration answers, said honestly. This is the data
 * behind the matrix in docs/THREAT-MODEL.md (a test holds the two equal).
 * The columns:
 *   tools_*       `read`/`write`/`edit` paths at that `[sandbox] level` (not bash)
 *   exec_*        where `bash` runs
 * Notes the cells cannot carry are in THREAT_MATRIX_NOTES.
 */
export const THREAT_MATRIX: Record<Threat, Record<ProbeConfigId, Coverage>> = {
  file_escape: { tools_off: "not covered", tools_confined: "covered", tools_strict: "covered", exec_off: "not covered", exec_os: "partially", exec_os_scoped: "covered", exec_docker: "covered" },
  network: { tools_off: "not covered", tools_confined: "not covered", tools_strict: "not covered", exec_off: "not covered", exec_os: "partially", exec_os_scoped: "partially", exec_docker: "covered" },
  process: { tools_off: "not covered", tools_confined: "not covered", tools_strict: "not covered", exec_off: "not covered", exec_os: "partially", exec_os_scoped: "partially", exec_docker: "covered" },
  credential: { tools_off: "not covered", tools_confined: "covered", tools_strict: "covered", exec_off: "not covered", exec_os: "partially", exec_os_scoped: "covered", exec_docker: "covered" },
  container_breakout: { tools_off: "not covered", tools_confined: "not covered", tools_strict: "not covered", exec_off: "not covered", exec_os: "not covered", exec_os_scoped: "not covered", exec_docker: "partially" },
};

export interface ConfigSpec {
  id: ProbeConfigId;
  label: string;
  layer: "tools" | "bash";
  level: SandboxLevel;
  exec: "off" | "os" | "os-scoped" | "docker";
}
export const CONFIGS: ConfigSpec[] = [
  { id: "tools_off", label: "tools, [sandbox] level = off", layer: "tools", level: "off", exec: "off" },
  { id: "tools_confined", label: "tools, [sandbox] level = confined", layer: "tools", level: "confined", exec: "off" },
  { id: "tools_strict", label: "tools, [sandbox] level = strict", layer: "tools", level: "strict", exec: "off" },
  { id: "exec_off", label: "bash, exec = off (host)", layer: "bash", level: "confined", exec: "off" },
  { id: "exec_os", label: "bash, exec = os (Landlock/seccomp or Seatbelt), reads = all", layer: "bash", level: "confined", exec: "os" },
  { id: "exec_os_scoped", label: "bash, exec = os, reads = scoped", layer: "bash", level: "confined", exec: "os-scoped" },
  { id: "exec_docker", label: "bash, exec = docker, network = false", layer: "bash", level: "confined", exec: "docker" },
];

export type Outcome = "contained" | "escaped" | "inconclusive" | "not_applicable";
export interface Raw {
  outcome: Outcome;
  detail: string;
}

interface ProbeDef {
  id: string;
  threat: Threat;
  escape_class: EscapeClass;
  what: string;
  /** The configurations this check is about at all. */
  applies: ProbeConfigId[];
  /** The configurations gnomon claims contain this. */
  claimed: ProbeConfigId[];
  run: (env: Env, cfg: ConfigSpec) => Promise<Raw>;
}

const TOOLS: ProbeConfigId[] = ["tools_off", "tools_confined", "tools_strict"];
const TOOLS_CONTAINED: ProbeConfigId[] = ["tools_confined", "tools_strict"];
const BASH: ProbeConfigId[] = ["exec_off", "exec_os", "exec_os_scoped", "exec_docker"];

interface Env {
  holder: string;
  root: string;
  outside: string;
  home: string;
  token: string;
  image: string;
  hits: { n: number };
  /** The loopback listener's port. */
  port: number;
  /**
   * Runs `fn` with a listener on this machine's own non-loopback address, open
   * for that call alone and closed right after (null: the machine has none).
   */
  withLan: <T>(fn: (lan: { ip: string; port: number; hits: { n: number } } | null) => Promise<T>) => Promise<T>;
  bash: (cfg: ConfigSpec, command: string) => Promise<string>;
  tool: (cfg: ConfigSpec, name: string, args: Record<string, unknown>) => Promise<string>;
}

const linuxOnly = (what: string): Raw => ({ outcome: "not_applicable", detail: `${what}: reads /proc, which this platform does not have` });
const has = (out: string, token: string): boolean => out.includes(token);

const PROBES: ProbeDef[] = [
  {
    id: "tool_read_outside_root",
    threat: "file_escape",
    escape_class: "permission_boundary",
    what: "the read tool is asked for a canary file outside the project root",
    applies: TOOLS,
    claimed: TOOLS_CONTAINED,
    run: async (e, cfg) => {
      const out = await e.tool(cfg, "read", { path: join(e.outside, "canary.txt") });
      return has(out, e.token) ? { outcome: "escaped", detail: "the canary outside the root was returned" } : { outcome: "contained", detail: "refused" };
    },
  },
  {
    id: "tool_write_outside_root",
    threat: "file_escape",
    escape_class: "permission_boundary",
    what: "the write tool is asked to create a file outside the project root",
    applies: TOOLS,
    claimed: TOOLS_CONTAINED,
    run: async (e, cfg) => {
      const target = join(e.outside, `tool-write-${cfg.id}.txt`);
      await e.tool(cfg, "write", { path: target, content: "x" });
      return existsSync(target) ? { outcome: "escaped", detail: "the file was created outside the root" } : { outcome: "contained", detail: "refused" };
    },
  },
  {
    id: "tool_symlink_out_of_root",
    threat: "file_escape",
    escape_class: "permission_boundary",
    what: "the read tool follows a symlink inside the root that points at the outside directory",
    applies: TOOLS,
    claimed: TOOLS_CONTAINED,
    run: async (e, cfg) => {
      const link = join(e.root, `link-${cfg.id}`);
      try {
        symlinkSync(e.outside, link);
      } catch (err) {
        return { outcome: "inconclusive", detail: `could not make the symlink: ${(err as Error).message}` };
      }
      const out = await e.tool(cfg, "read", { path: join(link, "canary.txt") });
      return has(out, e.token) ? { outcome: "escaped", detail: "the symlink was followed out of the root" } : { outcome: "contained", detail: "refused" };
    },
  },
  {
    id: "bash_read_outside_root",
    threat: "file_escape",
    escape_class: "permission_boundary",
    what: "a shell command reads a canary file outside the project root",
    applies: BASH,
    claimed: ["exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      const control = await e.bash(cfg, `cat '${join(e.root, "inside.txt")}'`);
      if (!has(control, e.token)) return { outcome: "inconclusive", detail: `control failed: a file inside the root could not be read (${first(control)})` };
      const out = await e.bash(cfg, `cat '${join(e.outside, "canary.txt")}' 2>&1`);
      return has(out, e.token) ? { outcome: "escaped", detail: "the canary outside the root was read" } : { outcome: "contained", detail: first(out) };
    },
  },
  {
    id: "bash_write_outside_root",
    threat: "file_escape",
    escape_class: "permission_boundary",
    what: "a shell command creates a file outside the project root",
    applies: BASH,
    claimed: ["exec_os", "exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      await e.bash(cfg, `echo x > '${join(e.root, `in-${cfg.id}.txt`)}'`);
      if (!existsSync(join(e.root, `in-${cfg.id}.txt`))) return { outcome: "inconclusive", detail: "control failed: a file inside the root could not be written" };
      const target = join(e.outside, `bash-write-${cfg.id}.txt`);
      const out = await e.bash(cfg, `echo x > '${target}' 2>&1`);
      return existsSync(target) ? { outcome: "escaped", detail: "the file was created outside the root" } : { outcome: "contained", detail: first(out) };
    },
  },
  {
    id: "bash_credential_read",
    threat: "credential",
    escape_class: "permission_boundary",
    what: "a shell command reads a fake credential file (an .ssh key this test made) in a substituted HOME",
    applies: BASH,
    claimed: ["exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      const out = await e.bash(cfg, `cat '${join(e.home, ".ssh", "gnomon_probe_key")}' 2>&1`);
      return has(out, e.token) ? { outcome: "escaped", detail: "the fake credential was read" } : { outcome: "contained", detail: first(out) };
    },
  },
  {
    id: "network_egress_when_off",
    threat: "network",
    escape_class: "permission_boundary",
    what: "with network = false, a shell command connects to a port this test opened on this machine's own non-loopback address",
    applies: BASH,
    claimed: ["exec_os", "exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      const r = await e.withLan((lan) =>
        lan ? connectProbe(e, cfg, lan.ip, lan.port, lan.hits) : Promise.resolve<Raw>({ outcome: "inconclusive", detail: "this machine has no non-loopback IPv4 address to connect to" })
      );
      if (r.outcome === "contained" && cfg.exec === "docker") return { outcome: "contained", detail: "own network namespace (--network none)" };
      return r;
    },
  },
  {
    id: "network_loopback_when_off",
    threat: "network",
    escape_class: "permission_boundary",
    what: "with network = false, a shell command connects to a loopback port this test opened (exec = os leaves loopback open by design)",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => {
      const r = await connectProbe(e, cfg, "127.0.0.1", e.port, e.hits);
      if (r.outcome === "contained" && cfg.exec === "docker") return { outcome: "contained", detail: "a container's loopback is its own" };
      return r;
    },
  },
  {
    id: "docker_socket_reachable",
    threat: "container_breakout",
    escape_class: "misconfiguration",
    what: "the docker socket is absent, or a connect() to it (closed at once, nothing sent) is refused",
    applies: BASH,
    claimed: ["exec_os", "exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      const script =
        `S=; for p in /var/run/docker.sock /run/docker.sock; do [ -S "$p" ] && S=$p && break; done; ` +
        `if [ -z "$S" ]; then echo ABSENT; elif command -v python3 >/dev/null 2>&1; then ` +
        `python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(3)\ntry:\n s.connect(sys.argv[1]);print('REACHABLE')\nexcept Exception as x:\n print('BLOCKED')\ns.close()" "$S"; ` +
        `else echo PRESENT_UNTESTED; fi`;
      const out = await e.bash(cfg, script);
      if (has(out, "REACHABLE")) return { outcome: "escaped", detail: "connect() to the docker socket succeeded (connect only, no bytes sent)" };
      if (has(out, "ABSENT")) return { outcome: "contained", detail: "no docker socket in this sandbox" };
      if (has(out, "BLOCKED")) return { outcome: "contained", detail: "connect() to the docker socket was refused (connect only, no bytes sent)" };
      if (has(out, "PRESENT_UNTESTED")) return { outcome: "inconclusive", detail: "a socket is present and there is no python3 to test connecting" };
      return { outcome: "inconclusive", detail: first(out) };
    },
  },
  {
    id: "no_new_privileges",
    threat: "container_breakout",
    escape_class: "privilege_allocation",
    what: "the shell runs with no_new_privs set, so a setuid binary cannot raise it",
    applies: BASH,
    claimed: ["exec_os", "exec_os_scoped", "exec_docker"],
    run: async (e, cfg) => {
      if (process.platform !== "linux") return linuxOnly("no_new_privs");
      const out = await e.bash(cfg, "grep NoNewPrivs /proc/self/status 2>&1");
      const m = /NoNewPrivs:\s*(\d)/.exec(out);
      if (!m) return { outcome: "inconclusive", detail: first(out) };
      return m[1] === "1" ? { outcome: "contained", detail: "NoNewPrivs: 1" } : { outcome: "escaped", detail: "NoNewPrivs: 0" };
    },
  },
  {
    id: "container_capabilities",
    threat: "container_breakout",
    escape_class: "privilege_allocation",
    what: "the shell holds no effective capabilities (not privileged, no CAP_SYS_ADMIN)",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => {
      if (process.platform !== "linux") return linuxOnly("capabilities");
      const out = await e.bash(cfg, "grep CapEff /proc/self/status 2>&1");
      const m = /CapEff:\s*([0-9a-f]+)/i.exec(out);
      if (!m) return { outcome: "inconclusive", detail: first(out) };
      const bits = BigInt(`0x${m[1]}`);
      const sysAdmin = (bits >> 21n) & 1n;
      if (sysAdmin === 1n) return { outcome: "escaped", detail: `CapEff ${m[1]} includes CAP_SYS_ADMIN` };
      return bits === 0n ? { outcome: "contained", detail: "CapEff: 0" } : { outcome: "escaped", detail: `CapEff ${m[1]}: capabilities were not dropped` };
    },
  },
  {
    id: "host_pid_namespace",
    threat: "process",
    escape_class: "misconfiguration",
    what: "the shell is in a process namespace of its own, not the host's",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => namespaceProbe(e, cfg, "pid"),
  },
  {
    id: "host_net_namespace",
    threat: "network",
    escape_class: "misconfiguration",
    what: "the shell is in a network namespace of its own, not the host's",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => namespaceProbe(e, cfg, "net"),
  },
  {
    id: "host_mounts_writable",
    threat: "container_breakout",
    escape_class: "misconfiguration",
    what: "no host path other than the project root (and docker's own hosts/hostname/resolv.conf) is mounted writable",
    applies: ["exec_docker"],
    claimed: ["exec_docker"],
    run: async (e, cfg) => {
      const out = await e.bash(cfg, "cat /proc/self/mountinfo 2>&1");
      const virtual = new Set(["proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "overlay", "shm", "securityfs", "debugfs", "tracefs", "fusectl", "autofs", "binfmt_misc", "hugetlbfs", "pstore", "bpf", "configfs", "nsfs"]);
      const bad: string[] = [];
      let seen = 0;
      for (const line of out.split("\n")) {
        const m = /^\d+ \d+ \S+ \S+ (\S+) (\S+)(?: .*?)? - (\S+) /.exec(line);
        if (!m) continue;
        seen++;
        const [, mount, opts, fstype] = m as unknown as [string, string, string, string];
        if (virtual.has(fstype)) continue;
        if (!opts.split(",").includes("rw")) continue;
        const under = (p: string): boolean => mount === p || mount.startsWith(`${p}/`);
        if (under(e.root) || ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(mount)) continue;
        bad.push(`${mount} (${fstype})`);
      }
      if (seen === 0) return { outcome: "inconclusive", detail: `mountinfo could not be read (${first(out)})` };
      return bad.length > 0 ? { outcome: "escaped", detail: `writable host mounts besides the root: ${bad.join(", ")}` } : { outcome: "contained", detail: `${seen} mounts read; only the project root is a writable host path` };
    },
  },
  {
    id: "proc_sys_writable",
    threat: "container_breakout",
    escape_class: "runtime_orchestration",
    what: "/proc/sys/kernel/core_pattern and /proc/sysrq-trigger are not writable (asked with test -w; nothing is written)",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => {
      if (process.platform !== "linux") return linuxOnly("/proc/sys");
      const out = await e.bash(cfg, `for f in /proc/sys/kernel/core_pattern /proc/sysrq-trigger; do if [ -e "$f" ]; then if [ -w "$f" ]; then echo "W:$f"; else echo "RO:$f"; fi; else echo "NONE:$f"; fi; done`);
      const w = out.split("\n").filter((l) => l.startsWith("W:"));
      if (w.length > 0) return { outcome: "escaped", detail: `writable: ${w.map((l) => l.slice(2)).join(", ")}` };
      return /RO:|NONE:/.test(out) ? { outcome: "contained", detail: "not writable" } : { outcome: "inconclusive", detail: first(out) };
    },
  },
  {
    id: "cgroup_writable",
    threat: "container_breakout",
    escape_class: "runtime_orchestration",
    what: "the cgroup filesystem is not writable from inside (asked with test -w; nothing is written)",
    applies: BASH,
    claimed: ["exec_docker"],
    run: async (e, cfg) => {
      if (process.platform !== "linux") return linuxOnly("cgroup");
      const out = await e.bash(cfg, `for f in /sys/fs/cgroup /sys/fs/cgroup/release_agent /sys/fs/cgroup/cgroup.procs; do if [ -e "$f" ]; then if [ -w "$f" ]; then echo "W:$f"; else echo "RO:$f"; fi; else echo "NONE:$f"; fi; done`);
      const w = out.split("\n").filter((l) => l.startsWith("W:"));
      if (w.length > 0) return { outcome: "escaped", detail: `writable: ${w.map((l) => l.slice(2)).join(", ")}` };
      return /RO:|NONE:/.test(out) ? { outcome: "contained", detail: "not writable" } : { outcome: "inconclusive", detail: first(out) };
    },
  },
];

async function connectProbe(e: Env, cfg: ConfigSpec, ip: string, port: number, hits: { n: number }): Promise<Raw> {
  const script =
    `if command -v bash >/dev/null 2>&1; then bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null; echo rc=$?; ` +
    `elif command -v nc >/dev/null 2>&1; then nc -w 2 ${ip} ${port} </dev/null >/dev/null 2>&1; echo rc=$?; else echo NOTOOL; fi`;
  const before = hits.n;
  const out = await e.bash(cfg, script);
  await new Promise((r) => setTimeout(r, 250));
  if (has(out, "NOTOOL")) return { outcome: "inconclusive", detail: "neither bash nor nc is available to open a connection" };
  if (!/rc=\d+/.test(out)) return { outcome: "inconclusive", detail: `the command did not run (${first(out)})` };
  return hits.n > before ? { outcome: "escaped", detail: `the connection to ${ip} reached the listener` } : { outcome: "contained", detail: "the connect was refused" };
}

async function namespaceProbe(e: Env, cfg: ConfigSpec, ns: "pid" | "net"): Promise<Raw> {
  if (process.platform !== "linux") return linuxOnly(`${ns} namespace`);
  let host: string;
  try {
    host = readlinkSync(`/proc/self/ns/${ns}`);
  } catch (err) {
    return { outcome: "inconclusive", detail: `host namespace unreadable: ${(err as Error).message}` };
  }
  const out = await e.bash(cfg, `readlink /proc/self/ns/${ns} 2>&1`);
  const mine = /\w+:\[\d+\]/.exec(out)?.[0];
  if (!mine) return { outcome: "inconclusive", detail: first(out) };
  return mine === host ? { outcome: "escaped", detail: `shares the host's ${ns} namespace (${mine})` } : { outcome: "contained", detail: `own ${ns} namespace` };
}

const brief = (s: string): string => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > 120 ? `${l.slice(0, 120)}…` : l;
};
const first = brief;

export interface Cell {
  probe: string;
  config: ProbeConfigId;
  status: CellStatus;
  claimed: boolean;
  detail: string;
}
export interface ConfigReport {
  id: ProbeConfigId;
  label: string;
  /** Null when it was measured; else why not. */
  skipped: string | null;
  pass: number;
  fail: number;
  open: number;
  contained_unclaimed: number;
  not_measured: number;
}
export interface SandboxProbeReport {
  schema: typeof SANDBOX_PROBE_SCHEMA;
  platform: string;
  harness: string;
  image: string;
  configs: ConfigReport[];
  probes: Array<{ id: string; threat: Threat; escape_class: EscapeClass; what: string; claimed_for: ProbeConfigId[] }>;
  cells: Cell[];
  matrix: typeof THREAT_MATRIX;
  limits: string[];
  /** A path this run could not remove (a root-run container can leave files the caller cannot delete); null when clean. */
  leftover: string | null;
  /** Cells that were claimed and did not hold. */
  failed: number;
  exit: number;
}

export const SANDBOX_PROBE_LIMITS = [
  "configuration and containment checks only: no exploit code and no kernel exploit is run, so kernel flaws, runtime CVEs and side channels are NOT tested; a pass is not a proof of isolation",
  "every canary, credential and listener is created by this test in a temp directory; the real HOME and the real credentials are never read",
  "the docker-socket probe runs only where a socket exists, and it connect()s to it and closes (no bytes are sent); it is skipped as absent otherwise",
  "docker is measured with the image named (default debian:stable-slim) and only if it is already present: nothing is pulled",
  "exec = os is measured as this process's kernel and gnomon-exec allow it: Landlock ABI, seccomp and Seatbelt differ between machines",
  "there is no microVM or gVisor backend to probe; docker here is a shared-kernel container",
];

/** Where each configuration can be measured on this machine; a string is why it cannot. */
export function availability(image: string): Record<ProbeConfigId, string | null> {
  const bashWhy = process.platform === "win32" ? "bash probes need a POSIX shell (use WSL)" : null;
  let os: string | null = bashWhy;
  let scoped: string | null = bashWhy;
  if (!bashWhy) {
    const sb = osSandbox();
    if ("error" in sb) os = scoped = `gnomon-exec unavailable: ${sb.error.split("\n")[0]}`;
    else if (!sb.probe.supported) os = scoped = `this kernel cannot sandbox: ${sb.probe.reason ?? "unsupported"}`;
    else if (!sb.probe.network_supported) os = scoped = `the network half of the sandbox is unavailable: ${sb.probe.reason ?? "unsupported"}`;
    else if (sb.probe.reads_scoped_supported !== true) scoped = "reads = scoped is not supported on this platform or build";
  }
  let docker: string | null = bashWhy;
  if (!bashWhy) {
    if (process.platform !== "linux" && process.platform !== "darwin") docker = "docker probes run on Linux and macOS";
    else {
      const v = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8", timeout: 15_000 });
      if (v.error || v.status !== 0) docker = "docker is not available (no daemon, or no permission)";
      else {
        const i = spawnSync("docker", ["image", "inspect", image], { encoding: "utf-8", timeout: 15_000 });
        if (i.status !== 0) docker = `image ${image} is not present locally (the probes do not pull)`;
      }
    }
  }
  return { tools_off: null, tools_confined: null, tools_strict: null, exec_off: bashWhy, exec_os: os, exec_os_scoped: scoped, exec_docker: docker };
}

export function statusOf(raw: Raw, claimed: boolean): CellStatus {
  switch (raw.outcome) {
    case "not_applicable":
      return "n/a";
    case "inconclusive":
      return "skipped";
    case "contained":
      return claimed ? "pass" : "contained_unclaimed";
    case "escaped":
      return claimed ? "FAIL" : "open";
  }
}

/** The probes, as data: what each checks, where it applies and where gnomon claims it holds. */
export function probeCatalog(): Array<{ id: string; threat: Threat; escape_class: EscapeClass; applies: ProbeConfigId[]; claimed: ProbeConfigId[] }> {
  return PROBES.map((p) => ({ id: p.id, threat: p.threat, escape_class: p.escape_class, applies: p.applies, claimed: p.claimed }));
}

let leftoverPath: string | null = null;

export async function runSandboxProbes(
  opts: Parameters<typeof runSandboxProbesInner>[0] = {}
): Promise<SandboxProbeReport> {
  leftoverPath = null;
  const r = await runSandboxProbesInner(opts);
  return { ...r, leftover: leftoverPath };
}

async function runSandboxProbesInner(
  opts: {
    image?: string;
    only?: readonly ProbeConfigId[];
    scratchParent?: string;
    /** Tests: told when the non-loopback listener opens and closes (it lives for one probe). */
    onLan?: (state: "open" | "closed") => void;
    /** Tests: called after each cell is recorded, outside the probe's HOME window. */
    onCell?: (cell: Cell) => void;
    /** Tests only: treat these configurations as if gnomon claimed them contained, to prove an escape is reported as a FAIL. */
    assume?: readonly ProbeConfigId[];
  } = {},
  box: { leftover: string | null } = { leftover: null }
): Promise<SandboxProbeReport> {
  const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
  if (!isValidImageRef(image)) throw new Error(`--image ${JSON.stringify(image)} is not a container image reference`);
  const avail = availability(image);
  const want = new Set<ProbeConfigId>(opts.only ?? PROBE_CONFIG_IDS);
  const holder = mkdtempSync(join(opts.scratchParent ?? tmpdir(), "gnomon-sandbox-probe-"));
  const root = join(holder, "root");
  const outside = join(holder, "outside");
  const home = join(holder, "home");
  const token = `GNOMON-PROBE-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const hits = { n: 0 };
  const lanHits = { n: 0 };
  const server = createServer((s) => {
    hits.n++;
    s.destroy();
  });
  try {
    for (const d of [root, outside, join(home, ".ssh")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(outside, "canary.txt"), token);
    writeFileSync(join(root, "inside.txt"), token);
    writeFileSync(join(home, ".ssh", "gnomon_probe_key"), token);
    const port = await new Promise<number>((resolveP, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveP((server.address() as { port: number }).port));
    });
    const lanIp = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    const withLan: Env["withLan"] = async (fn) => {
      if (!lanIp) return fn(null);
      const lanServer = createServer((c) => {
        lanHits.n++;
        c.destroy();
      });
      let lan: { ip: string; port: number; hits: { n: number } } | null = null;
      try {
        const lport = await new Promise<number>((resolveP, reject) => {
          lanServer.once("error", reject);
          lanServer.listen(0, lanIp, () => resolveP((lanServer.address() as { port: number }).port));
        });
        lan = { ip: lanIp, port: lport, hits: lanHits };
        opts.onLan?.("open");
      } catch {
        lan = null;
      }
      try {
        return await fn(lan);
      } finally {
        if (lanServer.listening) await new Promise<void>((r) => lanServer.close(() => r()));
        if (lan) opts.onLan?.("closed");
      }
    };
    // The OS sandbox derives the credential locations it protects from HOME
    // (homedir() in-process, so a child cannot be handed it as an env alone).
    // It is substituted for the length of ONE probe and restored right after,
    // never for the whole run.
    const withHome = async <T>(fn: () => Promise<T>): Promise<T> => {
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
      }
    };
    const baseCtx = (cfg: ConfigSpec): ToolContext => ({
      root,
      sandbox: cfg.level,
      gate: "never",
      approve: async () => true,
      timeoutMs: 30_000,
      maxOutputBytes: 32_000,
      bashAllow: undefined,
      bashDeny: [],
      exec:
        cfg.exec === "docker"
          ? { mode: "docker", image, network: false }
          : cfg.exec === "os"
            ? { mode: "os", image: "unused", network: false, reads: "all" }
            : cfg.exec === "os-scoped"
              ? { mode: "os", image: "unused", network: false, reads: "scoped", readRoots: [] }
              : { mode: "off", image: "unused", network: false },
    });
    const run = async (cfg: ConfigSpec, name: string, args: Record<string, unknown>): Promise<string> => {
      const out = await executeTool(name, args, baseCtx(cfg), new Set([name]));
      // The sandbox declining to run a command is the sandbox not being there, not a verdict on it.
      if (name === "bash" && out.content.startsWith("Refused: [sandbox]")) throw new Error(brief(out.content.replace(/^Refused: /, "")));
      return out.content;
    };
    const env: Env = {
      holder,
      root,
      outside,
      home,
      token,
      image,
      hits,
      port,
      withLan,
      bash: (cfg, command) => run(cfg, "bash", { command }),
      tool: (cfg, name, args) => run(cfg, name, args),
    };

    const cells: Cell[] = [];
    const configs: ConfigReport[] = [];
    for (const cfg of CONFIGS) {
      if (!want.has(cfg.id)) continue;
      const why = avail[cfg.id];
      const rep: ConfigReport = { id: cfg.id, label: cfg.label, skipped: why, pass: 0, fail: 0, open: 0, contained_unclaimed: 0, not_measured: 0 };
      configs.push(rep);
      for (const p of PROBES) {
        if (!p.applies.includes(cfg.id)) continue;
        const claimed = p.claimed.includes(cfg.id) || (opts.assume ?? []).includes(cfg.id);
        if (why) {
          cells.push({ probe: p.id, config: cfg.id, status: "skipped", claimed, detail: why });
          rep.not_measured++;
          continue;
        }
        let raw: Raw;
        try {
          raw = await withHome(() => p.run(env, cfg));
        } catch (err) {
          raw = { outcome: "inconclusive", detail: `the probe could not run: ${err instanceof Error ? err.message : String(err)}` };
        }
        // A refusal from the sandbox plan is the sandbox not being there, not a verdict on it.
        const st = statusOf(raw, claimed);
        const cell: Cell = { probe: p.id, config: cfg.id, status: st, claimed, detail: raw.detail };
        cells.push(cell);
        opts.onCell?.(cell);
        if (st === "pass") rep.pass++;
        else if (st === "FAIL") rep.fail++;
        else if (st === "open") rep.open++;
        else if (st === "contained_unclaimed") rep.contained_unclaimed++;
        else if (st === "skipped") rep.not_measured++;
      }
    }
    const failed = cells.filter((c) => c.status === "FAIL").length;
    return {
      schema: SANDBOX_PROBE_SCHEMA,
      platform: process.platform,
      harness: harnessBuild(),
      image,
      configs,
      probes: PROBES.map((p) => ({ id: p.id, threat: p.threat, escape_class: p.escape_class, what: p.what, claimed_for: p.claimed })),
      cells,
      matrix: THREAT_MATRIX,
      limits: SANDBOX_PROBE_LIMITS,
      leftover: null,
      failed,
      exit: failed > 0 ? SANDBOX_PROBE_EXIT.failed : SANDBOX_PROBE_EXIT.clean,
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    box.leftover = removeTree(holder, image);
  }
}

/**
 * Remove the scratch tree. A container that ran as root can leave files the
 * caller may not delete: the container deletes them (`docker run --rm`), and a
 * tree that still stays is reported by path, never silently left.
 */
export function removeTree(dir: string, image: string): string | null {
  const gone = (): boolean => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* fall through */
    }
    return !existsSync(dir);
  };
  if (gone()) return null;
  if (process.platform !== "win32") {
    spawnSync("docker", ["run", "--rm", "--network", "none", "-v", `${dir}:/gnomon-cleanup`, image, "sh", "-c", "rm -rf /gnomon-cleanup/* /gnomon-cleanup/.[!.]* 2>/dev/null; true"], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    if (gone()) return null;
  }
  return dir;
}

export function formatSandboxProbes(r: SandboxProbeReport): string[] {
  const out: string[] = [];
  out.push(`Sandbox probes (${r.platform}, ${r.harness}; docker image ${r.image}): configuration and containment checks only, nothing is exploited.`);
  for (const c of r.configs) {
    if (c.skipped) {
      out.push(`${c.label}: SKIPPED (${c.skipped})`);
      continue;
    }
    out.push(`${c.label}: ${c.pass} held, ${c.fail} FAILED, ${c.open} open (not claimed), ${c.contained_unclaimed} held (not claimed)${c.not_measured ? `, ${c.not_measured} not measured` : ""}`);
    for (const k of r.cells.filter((x) => x.config === c.id)) {
      const mark = k.status === "pass" ? "✓" : k.status === "FAIL" ? "✗" : k.status === "open" ? "o" : k.status === "contained_unclaimed" ? "·" : "?";
      out.push(`  ${mark} ${k.probe.padEnd(26)} ${k.status === "n/a" ? "n/a" : k.claimed ? "claimed" : "unclaimed"}: ${k.detail}`);
    }
  }
  out.push("Legend: ✓ claimed and held; ✗ claimed and did NOT hold; o open and not claimed (a documented limit); · held though not claimed; ? not measured.");
  out.push("Threat matrix (sandbox level x threat, docs/THREAT-MODEL.md):");
  for (const t of THREATS) out.push(`  ${t.padEnd(19)} ${PROBE_CONFIG_IDS.map((id) => `${id}=${THREAT_MATRIX[t][id]}`).join(" ")}`);
  out.push("Limits:");
  for (const l of r.limits) out.push(`  - ${l}`);
  out.push(r.failed > 0 ? `Summary: ${r.failed} claimed containment(s) did not hold on this machine.` : `Summary: every measured claim held (${r.cells.filter((c) => c.status === "pass").length} pass, ${r.cells.filter((c) => c.status === "open").length} open by design, ${r.cells.filter((c) => c.status === "skipped").length} not measured).`);
  return out;
}
