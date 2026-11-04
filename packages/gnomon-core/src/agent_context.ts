/**
 * Is this process running for an agent, and is a person at a terminal?
 *
 * `gnomon skill accept`, `skill reject` and `audit resolve` are a person's
 * decisions. Until 0.4.1 the only test was `GNOMON_AGENT_SESSION` in this
 * process's own environment, which the agent's shell can drop: GBS-GOVERNANCE
 * 0.1 (benchmarks/results/gbs-2026-11-04/governance) had the agent accept its
 * own pending skill with `env -u GNOMON_AGENT_SESSION gnomon skill accept …`
 * in 4 of 4 runs. A variable set to the empty string passed as well.
 *
 * What is checked now, each on its own sufficient to refuse:
 *
 * 1. **The marker in this environment, with any value.** Present and empty
 *    counts: the harness never sets it empty, so empty is somebody's edit.
 * 2. **The marker in an ancestor's environment** (Linux, /proc). The harness
 *    starts the bash tool's shell with the marker. A process can change its
 *    own environment and its children's, never the environment another
 *    process was started with: `/proc/<pid>/environ` of the agent's shell
 *    still holds it after `unset`, `export X=`, `env -u`, `env -i`, `nohup`
 *    or `setsid` in front of the command.
 * 3. **A gnomon process among the ancestors** (Linux, /proc): the harness
 *    itself. When the shell `exec`s the command (`exec env -i gnomon …`, or
 *    bash's own exec of a lone command) there is no shell left between the
 *    command and the harness, and the harness's own environment never held
 *    the marker. Its command line does name gnomon, and a child cannot change
 *    its parent's. A person's `gnomon skill accept` has no gnomon above it.
 *    The one gnomon ancestor allowed is a launcher of this same command.
 *
 * And, separately, a person: decisions need stdin and stdout on a terminal
 * (the bash tool gives its shell pipes, and `detached` gives it no
 * controlling terminal), or a declared person-present signer that signs the
 * decision.
 *
 * **Limits, said plainly.** This is a refusal with reasons, not containment.
 * A process of the same user can still reach a terminal it did not inherit
 * and leave the harness's process tree at the same time: allocate a pty in a
 * process that has been re-parented to init (`setsid -f script …`), type into
 * an existing tmux session, or have systemd, cron or ssh start the command.
 * Against an agent that does that, the guarantee is a signer that needs a
 * person for each signature (`[audit.attest] person_present = true`) or the
 * docker sandbox (`[sandbox] exec = "docker"`), which keeps the agent away
 * from the host's processes and terminals. On a platform without /proc
 * (macOS, Windows) checks 2 and 3 do not run.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AGENT_SESSION_ENV } from "./tools.js";

export interface DecisionContext {
  /** Why this process is an agent's, or null when nothing says it is. Checks 2 and 3 above. */
  agent: string | null;
  /** stdin and stdout are both a terminal. */
  interactive: boolean;
}

/** How far up the process tree to look. A real chain is a handful deep. */
const MAX_DEPTH = 64;

/** A file that names gnomon's CLI entry: the npm bin, the checkout launcher, or the module either runs. */
const GNOMON_ENTRY = /(^|[\\/])(gnomon(\.m?js|\.exe)?|gnomon-cli[\\/](dist|src)[\\/]index\.[jt]s)$/;
/** An interpreter that runs a script given after its own flags. */
const INTERPRETER = /(^|[\\/])(node|nodejs|bun|deno|sh|bash|dash|zsh|ksh)\d*(\.exe)?$/;
/** Interpreter flags that take the next argument as their value. */
const INLINE = new Set(["-c", "-e", "--eval", "-p", "--print"]);
const FLAG_WITH_VALUE = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file"]);

/**
 * Whether a command line is a gnomon CLI process other than a launcher of a
 * skill decision itself. Exported for its tests.
 */
export function isGnomonAncestor(argv: string[]): boolean {
  if (argv.length === 0) return false;
  let i = -1;
  if (GNOMON_ENTRY.test(argv[0]!)) i = 0;
  else if (INTERPRETER.test(argv[0]!)) {
    for (let j = 1; j < argv.length; j++) {
      const a = argv[j]!;
      // An inline program (`sh -c "…"`, `node -e "…"`) is not a script file,
      // whatever its text ends with.
      if (INLINE.has(a) || /^-[A-Za-z]*[ce][A-Za-z]*$/.test(a)) break;
      if (FLAG_WITH_VALUE.has(a)) {
        j++;
        continue;
      }
      if (a.startsWith("-")) continue;
      if (GNOMON_ENTRY.test(a)) i = j;
      break;
    }
  }
  if (i < 0) return false;
  const words = argv.slice(i + 1).filter((a) => !a.startsWith("-"));
  // A launcher between the person's shell and this very command (gnomon.js
  // falls back to a tsx child; a sh wrapper may not exec).
  if (words[0] === "skill" && (words[1] === "accept" || words[1] === "reject")) return false;
  if (words[0] === "audit" && words[1] === "resolve") return false;
  return true;
}

function readProc(proc: string, pid: number, file: string): string | null {
  try {
    return readFileSync(`${proc}/${pid}/${file}`, "latin1");
  } catch {
    return null;
  }
}

function parentOf(proc: string, pid: number): number | null {
  const stat = readProc(proc, pid, "stat");
  if (!stat) return null;
  // `pid (comm) state ppid …`: comm may hold spaces and parentheses.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/**
 * Checks 2 and 3: walk from `pid` (this process) up the parent chain. `proc`
 * is the /proc mount, for tests. Null when nothing says this is an agent's,
 * including on a platform with no /proc.
 */
export function agentAncestry(opts: { pid?: number; proc?: string } = {}): string | null {
  const proc = opts.proc ?? "/proc";
  let pid: number | null = opts.pid ?? process.pid;
  const self = pid;
  const marker = `${AGENT_SESSION_ENV}=`;
  for (let depth = 0; pid !== null && pid > 0 && depth < MAX_DEPTH; depth++) {
    const environ = readProc(proc, pid, "environ");
    if (environ !== null) {
      const found = environ.split("\0").find((e) => e.startsWith(marker));
      if (found !== undefined) {
        const who = pid === self ? "this process was" : `ancestor process ${pid} was`;
        return `${who} started inside agent session ${found.slice(marker.length) || "(empty)"}`;
      }
    }
    if (pid !== self) {
      const cmdline = readProc(proc, pid, "cmdline");
      const argv = cmdline ? cmdline.split("\0").filter(Boolean) : [];
      if (isGnomonAncestor(argv)) {
        return `ancestor process ${pid} is gnomon itself (${argv.slice(0, 3).map((a) => basename(a)).join(" ")} …)`;
      }
    }
    if (pid === 1) break;
    pid = parentOf(proc, pid);
  }
  return null;
}

function defaultProbe(): DecisionContext {
  return {
    agent: process.platform === "linux" ? agentAncestry() : null,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

let probe: () => DecisionContext = defaultProbe;

/** The ancestry and terminal facts for this process. */
export function decisionContext(): DecisionContext {
  return probe();
}

/**
 * Test seam: replace the ancestry and terminal probe; null restores it. A
 * suite that makes a person's decisions runs it so that the suite itself,
 * started from an agent's shell, does not refuse every one. Not exported from
 * the package index. Check 1, this environment's marker, is not replaceable.
 */
export function setDecisionContextProbe(fn: (() => DecisionContext) | null): void {
  probe = fn ?? defaultProbe;
}

/**
 * Why a person's decision must be refused here, or null. Check 1, then the
 * probe's checks 2 and 3.
 */
export function agentReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (Object.prototype.hasOwnProperty.call(env, AGENT_SESSION_ENV)) {
    return `this is running inside an agent session (${AGENT_SESSION_ENV}=${env[AGENT_SESSION_ENV] || "(empty)"})`;
  }
  const a = decisionContext().agent;
  return a ? `this is running inside an agent session: ${a}` : null;
}
