/**
 * `[sandbox] profile = "default" | "container"` in .gnomon/policy.toml
 * (docs/CONTRACTS.md §40, conformance/sandbox_profile.json).
 *
 * `container` is for a run inside a disposable container that is already the
 * sandbox (a benchmark task image, a CI job). gnomon's defaults are an
 * attended developer's sandbox, and inside such a container they stand a
 * second sandbox between the model and the one it already has. Research note
 * 15 (2026-11-08, 365 gnomon cells): cells where gnomon refused or killed
 * something solved 1 of 39 where 6.2 were expected (within-task permutation,
 * p = 0.001, post hoc); the file-tool refusal of /tmp alone 0 of 21 vs 4.4.
 * opencode and mini-swe-agent hand the model the container as it is.
 *
 * What the profile relaxes, each one named on the session_start record:
 * - `network`: the bash network-client filter and webfetch's refusal follow
 *   the container (whose own network is the boundary), whatever
 *   `[sandbox] network` says;
 * - `file_tools_scratch`: read/write/edit/glob/grep may use the system temp
 *   directories, as #171's shell rule (outside_root) already lets bash;
 * - `shell_bash`: commands run under /bin/bash when it exists (else /bin/sh);
 * - `soft_shell`: bash `soft_timeout = "handle"` unless bash declares
 *   `soft_timeout` itself;
 * - `timeout_rerun_refusal`: a command that timed out may be run again;
 * - `command_env`: PAGER=cat, TQDM_DISABLE=1, PIP_PROGRESS_BAR=off.
 *
 * What it never relaxes (`kept`): the surface, gnomon's records, git and host
 * hooks, secret and CI paths, outside-root writes other than the temp
 * directories, bash_deny/bash_allow, sudo on the host, the approval gate.
 * A timed-out command is still killed with its whole process group.
 *
 * Declared only (Rule 1): never inferred from /.dockerenv, cgroups, an
 * environment variable or the command that started gnomon. It is a
 * policy.toml value, so it moves the surface hash. The session pins it at
 * start (sandbox_pin.ts): turning it on mid-session is a loosening and is not
 * applied.
 */
import { existsSync } from "node:fs";
import type { GnomonConfig } from "./config.js";

export const SANDBOX_PROFILES = ["default", "container"] as const;
export type SandboxProfile = (typeof SANDBOX_PROFILES)[number];

/** Set in every bash command's environment under the container profile. */
export const CONTAINER_ENV: Readonly<Record<string, string>> = {
  PAGER: "cat",
  TQDM_DISABLE: "1",
  PIP_PROGRESS_BAR: "off",
};

/** What the container profile relaxes, in record order. */
export const CONTAINER_RELAXES = [
  "network",
  "file_tools_scratch",
  "shell_bash",
  "soft_shell",
  "timeout_rerun_refusal",
  "command_env",
] as const;

/** What it keeps, named on the record so a reader need not infer it. */
export const CONTAINER_KEEPS = [
  "surface",
  "record",
  "git_hooks",
  "host_hooks",
  "secret_path",
  "ci_path",
  "outside_root",
  "bash_deny",
  "sudo",
  "approval",
  "timeout_kill_process_group",
] as const;

/** `[sandbox] profile`, resolved: "default" unless "container" is declared. */
export function resolveSandboxProfile(config: GnomonConfig): SandboxProfile {
  const v = (config.policy?.sandbox as { profile?: unknown } | undefined)?.profile;
  return v === "container" ? "container" : "default";
}

/**
 * The shell the container profile runs commands under: /bin/bash when this
 * machine has one, else /bin/sh. On Windows the shell is already Git's
 * bash.exe (posixShell), so null here means "use posixShell".
 */
export function containerShell(exists: (p: string) => boolean = existsSync): string | null {
  if (process.platform === "win32") return null;
  return exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * The scaffold's bash description opens with this sentence. Under the
 * container profile with /bin/bash it would be false, so the profile replaces
 * it -- the scaffold's text only: a surface that wrote its own keeps it.
 */
export const SCAFFOLD_SH_SENTENCE = "Execute a POSIX sh command (/bin/sh, not bash: no pipefail, [[ ]] or arrays).";
export const CONTAINER_BASH_SENTENCE = "Execute a bash command (/bin/bash).";

export function containerBashDescription(description: string, shell: string | null): string {
  return shell === "/bin/bash" ? description.replace(SCAFFOLD_SH_SENTENCE, CONTAINER_BASH_SENTENCE) : description;
}

/**
 * The record of the profile for `session_start.resolved.sandbox_profile`:
 * which profile, which protections it relaxed (the soft shell only when bash
 * did not declare its own `soft_timeout`), what it kept, and the shell.
 * Undefined under "default", so a surface that declares nothing writes the
 * record it always wrote.
 */
export function sandboxProfileRecord(
  config: GnomonConfig,
  exists?: (p: string) => boolean
): { name: "container"; relaxed: string[]; kept: string[]; shell: string | null } | undefined {
  if (resolveSandboxProfile(config) !== "container") return undefined;
  const bashDecl = (config.tools?.tools ?? []).find((t) => t.name === "bash") as { soft_timeout?: unknown } | undefined;
  const relaxed = CONTAINER_RELAXES.filter((r) => r !== "soft_shell" || bashDecl?.soft_timeout === undefined);
  return { name: "container", relaxed: [...relaxed], kept: [...CONTAINER_KEEPS], shell: containerShell(exists) };
}

/**
 * Surface problems for the key. A value outside the enumeration is fatal: a
 * surface that seems to ask for a sandbox must not run with another. Not
 * fatal: the profile beside `exec = "docker"` (the commands already run in a
 * container gnomon starts, whose --network none the profile does not open),
 * and beside a bash `soft_timeout = "kill"` (declared, so it wins).
 */
export function auditSandboxProfile(
  config: GnomonConfig
): Array<{ where: string; problem: string; fix: string; fatal: boolean }> {
  const out: Array<{ where: string; problem: string; fix: string; fatal: boolean }> = [];
  const sandbox = config.policy?.sandbox as { profile?: unknown; exec?: unknown } | undefined;
  const v = sandbox?.profile;
  if (v === undefined) return out;
  if (!(SANDBOX_PROFILES as readonly unknown[]).includes(v)) {
    out.push({
      where: ".gnomon/policy.toml [sandbox] profile",
      problem: `profile = ${JSON.stringify(v)} is not "default" or "container". Refused rather than run with a sandbox the surface did not ask for.`,
      fix: 'profile = "container" (inside a disposable container that is already the sandbox), or "default".',
      fatal: true,
    });
    return out;
  }
  if (v !== "container") return out;
  if (sandbox?.exec === "docker") {
    out.push({
      where: ".gnomon/policy.toml [sandbox] profile",
      problem:
        'profile = "container" beside exec = "docker": commands already run in a container gnomon starts, ' +
        "with --network none unless network = true; the profile does not open it.",
      fix: 'Use exec = "off" when gnomon itself runs inside the disposable container.',
      fatal: false,
    });
  }
  const bashDecl = (config.tools?.tools ?? []).find((t) => t.name === "bash") as { soft_timeout?: unknown } | undefined;
  if (bashDecl?.soft_timeout === "kill") {
    out.push({
      where: ".gnomon/tools.toml bash soft_timeout",
      problem: 'profile = "container" turns the soft shell on, and bash declares soft_timeout = "kill": the declaration wins.',
      fix: 'Remove soft_timeout from bash, or keep "kill" on purpose.',
      fatal: false,
    });
  }
  return out;
}
