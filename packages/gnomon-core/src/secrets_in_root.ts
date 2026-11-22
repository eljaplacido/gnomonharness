/**
 * gnomon-core: declared secrets inside a root an OS sandbox grants.
 *
 * `exec = "os"` (Landlock) grants the whole project root; it cannot take one
 * file back out of it. The governance secret check reads the WORDS of a
 * command, so `python3 -c "print(open('.env'+'.matrix').read())"` -- a path
 * built at run time -- names no secret and reads one (issue #227). Under
 * `exec = "docker"` a declared secret is hidden by an empty mount
 * (tools.ts hiddenSecretMounts); under `exec = "os"` there is no such
 * mechanism, so at `[governance] level = "prevent"` (the secrets family at
 * prevent or above) the session REFUSES TO START while a declared-secret file
 * sits inside the root, unless the surface opts in:
 *
 *     [governance]
 *     secrets_in_root = "allow"
 *
 * which `session_start.resolved.secrets_in_root` records, with the files.
 * Below prevent, and without exec = "os", nothing here applies.
 *
 * Surface findings in auditSurface's shape; the callers that stop a session on
 * a fatal finding (chat, task, acp) add these to theirs.
 */
import { relative, resolve } from "node:path";
import { listRoles, resolveExec, type GnomonConfig, type SurfaceProblem } from "./config.js";
import { levelAtLeast, resolveLevels, resolveProtectedPaths } from "./governance.js";
import { secretFilesInRoot } from "./tools.js";

/** The `[governance]` key that accepts the risk, and the one value it reads. */
export const SECRETS_IN_ROOT_KEY = "secrets_in_root";

/** Declared in policy.toml as `secrets_in_root = "allow"`. */
export function secretsInRootAllowed(config: GnomonConfig): boolean {
  const gov = (config.policy as { governance?: Record<string, unknown> } | undefined)?.governance;
  return gov?.[SECRETS_IN_ROOT_KEY] === "allow";
}

/**
 * The declared-secret files inside the root, for a surface where some role
 * runs under exec = "os" with the secrets family at prevent or above. Empty
 * everywhere else (so nothing changes for an existing surface).
 */
export function exposedSecretFiles(config: GnomonConfig): string[] {
  if (!config.gnomonDir) return [];
  let exposed = false;
  let lists;
  for (const role of listRoles(config)) {
    if (resolveExec(config, role).mode !== "os") continue;
    let levels;
    try {
      levels = resolveLevels(config, role);
      lists ??= resolveProtectedPaths(config, levels);
    } catch {
      continue; // a malformed [governance] is auditGovernance's to report
    }
    if (levels && levelAtLeast(levels.levels.secrets, "prevent")) exposed = true;
  }
  if (!exposed || !lists) return [];
  return secretFilesInRoot(resolve(config.gnomonDir, ".."), lists.secrets);
}

/** Root-relative names, for a message or a record. */
function names(config: GnomonConfig, files: string[]): string[] {
  const root = resolve(config.gnomonDir, "..");
  return files.map((f) => relative(root, f));
}

/** The finding: fatal unless the surface opted in. */
export function auditSecretsInRoot(config: GnomonConfig): SurfaceProblem[] {
  const files = exposedSecretFiles(config);
  if (files.length === 0) return [];
  const list = names(config, files);
  const shown = `${list.slice(0, 5).join(", ")}${list.length > 5 ? `, +${list.length - 5} more` : ""}`;
  const allowed = secretsInRootAllowed(config);
  return [
    {
      where: ".gnomon/policy.toml [governance]",
      problem:
        `exec = "os" grants the whole project root, and a declared secret sits inside it (${shown}). ` +
        `Any interpreter the role may run (python3, node, ...) can read it by a path built at run time, ` +
        `which the word check cannot see.` +
        (allowed ? ` Accepted: ${SECRETS_IN_ROOT_KEY} = "allow" (recorded in session_start).` : ""),
      fix:
        `Move the file out of the repository (and point the tool at it by an environment variable or an absolute path), ` +
        `or use exec = "docker", which hides it. To accept the risk, set ${SECRETS_IN_ROOT_KEY} = "allow" under [governance].`,
      fatal: !allowed,
    },
  ];
}

/** `session_start.resolved.secrets_in_root`: present only when the opt-in is taken with files exposed. */
export function secretsInRootRecord(config: GnomonConfig): { accepted: true; files: string[] } | undefined {
  if (!secretsInRootAllowed(config)) return undefined;
  const files = exposedSecretFiles(config);
  return files.length > 0 ? { accepted: true, files: names(config, files) } : undefined;
}
