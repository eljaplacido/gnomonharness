/**
 * gnomon-core: the policy linter -- contradictory, shadowed, impossible and
 * uncovered rules in a surface (docs/CONTRACTS.md §6, "policy lint").
 *
 * The rules a role carries (`bash_allow`, `bash_deny`, `write_allow`, `tools`,
 * `task_allow`) and the policy around them (`[sandbox]`, `[governance]`,
 * tools.toml) are data, and data can say something its author did not mean: a
 * pattern both allowed and denied, a glob a broader one already covers, a
 * pattern that cannot match anything, a role granted a tool the policy then
 * always refuses, a category nothing covers.
 *
 * This reasons with the real matchers and never a second one: `bashPolicy`
 * decides whether a deny refuses an allow entry, `globToRegExp` is the glob
 * every write_allow check compiles, `new RegExp` is what bash_allow/bash_deny
 * compile. `gnomon guard` decides through the same role rules
 * (toolCallPolicy), so one lint covers the loop and the guard.
 *
 * Findings are WARNINGS. Nothing here changes a decision at run time or the
 * prompt loop; `gnomon check` reports them and `--strict-policy` turns them
 * into a failing exit.
 */

import { bashPolicy, globToRegExp } from "./tools.js";
import { governanceGaps } from "./governance.js";
import type { GnomonConfig, RoleDef } from "./config.js";

export const POLICY_LINT_SCHEMA = "gnomon.policy_lint/1";

/** Published: conformance/policy_lint.json. */
export const POLICY_LINT_KINDS = ["contradiction", "shadowed", "never_matches", "unreachable", "always_denied", "uncovered"] as const;
export type PolicyLintKind = (typeof POLICY_LINT_KINDS)[number];

export interface PolicyLintFinding {
  kind: PolicyLintKind;
  /** The file and table the rule is in, e.g. `.gnomon/roles.toml [roles.plan]`. */
  where: string;
  /** The role, when the finding is about one. */
  role?: string;
  /** The key: bash_allow, bash_deny, write_allow, tools, task_allow, sandbox, governance, mcp. */
  rule: string;
  /** The pattern or value it is about, when there is one. */
  pattern?: string;
  message: string;
}

const PROBES = ["", "ls", "git status", "git push --force origin main", "rm -rf /"];
const LITERAL = /^[A-Za-z0-9 _./:=@%+,-]+$/;
const GLOB_LITERAL = /^[^*?]*$/;
const hasWildcard = (g: string) => !GLOB_LITERAL.test(g);

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** A regex that is satisfiable only by text it can never see: `$` before more text, `^` after some. */
function impossibleAnchors(pattern: string): string | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "$") {
      const next = pattern[i + 1];
      if (next !== undefined && next !== ")" && next !== "|" && !"*?".includes(next)) return "`$` is followed by more pattern, so nothing can follow the end of the text";
    }
    if (c === "^") {
      const prev = pattern[i - 1];
      const prev2 = pattern.slice(Math.max(0, i - 3), i);
      const atStart = prev === undefined || prev === "|" || prev === "(" || prev2 === "(?:";
      if (!atStart) return "`^` follows other pattern, so nothing can precede the start of the text";
    }
  }
  return null;
}

function matchesEverything(re: RegExp): boolean {
  return PROBES.every((p) => re.test(p));
}

/** Why a write_allow glob can never match a root-relative file path, or null. */
function globNeverMatches(glob: string): string | null {
  const g = glob.trim();
  if (g.length === 0) return null; // ignored at run time, like an absent entry
  // Absolute, `../` and `~/` patterns name places outside the root: tools.ts outsideWriteAllowed.
  if (g.startsWith("/") || /^[A-Za-z]:[\\/]/.test(g) || g.startsWith("../") || g === "~" || g.startsWith("~/")) return null;
  if (g.includes("\\")) return "a backslash is a literal character in a glob, and paths are matched with `/`";
  if (g.split("/").includes("..")) return "`..` is collapsed before matching, so a path never contains it";
  if (g.endsWith("/")) return "a trailing `/` names a directory, and the pattern is matched against file paths: write `dir/**`";
  if (/[{}]/.test(g)) return "braces are not expanded: `{a,b}` matches the literal text only";
  if (g.includes("[")) return "character classes are not supported: `[` is matched literally";
  return null;
}

/** Does glob `a` already cover everything glob `b` can match? Sound, not complete. */
function globCovers(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "**" || a === "**/*") return true;
  if (!hasWildcard(b)) {
    try {
      return globToRegExp(a).test(b);
    } catch {
      return false;
    }
  }
  if (a.endsWith("/**")) {
    const prefix = a.slice(0, -3);
    if (prefix && !hasWildcard(prefix) && b.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

const holds = (def: RoleDef | undefined, tool: string): boolean => !def?.tools || def.tools.includes(tool);

export function lintPolicy(config: Pick<GnomonConfig, "policy" | "roles" | "tools"> & { gnomonDir?: string }): PolicyLintFinding[] {
  const out: PolicyLintFinding[] = [];
  const roles = (config.roles ?? {}) as Record<string, RoleDef>;
  const roleNames = Object.keys(roles).sort();
  const policy = (config.policy ?? {}) as { sandbox?: { network?: unknown; level?: unknown }; governance?: unknown };
  const toolDefs = config.tools?.tools ?? [];
  const mcpServers = Object.keys(config.tools?.mcp_servers ?? {});

  for (const role of roleNames) {
    const def = roles[role] ?? ({} as RoleDef);
    const where = `.gnomon/roles.toml [roles.${role}]`;
    const add = (f: Omit<PolicyLintFinding, "where" | "role">) => out.push({ ...f, where, role });
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const allow = strs(def.bash_allow);
    const deny = strs(def.bash_deny);
    const writeAllow = strs(def.write_allow);
    const holdsBash = holds(def, "bash");
    const holdsWrite = holds(def, "write") || holds(def, "edit");

    // --- rules declared for a tool the role does not hold -------------------
    if (!holdsBash) {
      for (const [key, list] of [["bash_allow", allow], ["bash_deny", deny]] as const) {
        if (list.length > 0) add({ kind: "unreachable", rule: key, message: `${key} is declared but this role's tools do not include bash, so it is never consulted` });
      }
    }
    if (!holdsWrite && writeAllow.length > 0) {
      add({ kind: "unreachable", rule: "write_allow", message: "write_allow is declared but this role holds neither write nor edit, so it is never consulted" });
    }

    // --- bash_allow / bash_deny --------------------------------------------
    const seen = { allow: new Set<string>(), deny: new Set<string>() };
    let allowLive = 0;
    for (const [key, list] of [["bash_allow", allow], ["bash_deny", deny]] as const) {
      const side = key === "bash_allow" ? seen.allow : seen.deny;
      list.forEach((pattern, i) => {
        const re = compile(pattern);
        if (!re) {
          if (key === "bash_deny") {
            add({ kind: "always_denied", rule: key, pattern, message: `bash_deny pattern is not a valid regular expression, so bash is refused outright for this role (fail closed)` });
          } else {
            add({ kind: "never_matches", rule: key, pattern, message: "bash_allow pattern is not a valid regular expression, so it contributes nothing and the role is narrower than it reads" });
          }
          return;
        }
        if (side.has(pattern)) {
          add({ kind: "shadowed", rule: key, pattern, message: `${key} lists this pattern more than once` });
          return;
        }
        side.add(pattern);
        const anchors = impossibleAnchors(pattern);
        if (anchors) {
          add({ kind: "never_matches", rule: key, pattern, message: `${key} pattern can never match: ${anchors}` });
          return;
        }
        if (key === "bash_allow") allowLive++;
        if (matchesEverything(re)) {
          if (key === "bash_deny") {
            add({ kind: "always_denied", rule: key, pattern, message: "bash_deny pattern matches every command, so bash is refused outright for this role" });
          } else {
            add({ kind: "shadowed", rule: key, pattern, message: "bash_allow pattern matches every command, so it admits everything and makes every other bash_allow entry redundant" });
          }
          return;
        }
        // An earlier, broader pattern in the same list already decides what this one would.
        if (LITERAL.test(pattern)) {
          const earlier = list.slice(0, i).find((p) => {
            const r = compile(p);
            return r !== null && p !== pattern && r.test(pattern);
          });
          if (earlier !== undefined) {
            add({ kind: "shadowed", rule: key, pattern, message: `${key} pattern is already covered by the broader ${JSON.stringify(earlier)} listed before it` });
          }
        }
      });
    }
    // Same pattern allowed and denied; deny wins, so the allow entry does nothing.
    for (const pattern of allow) {
      if (deny.includes(pattern)) {
        add({ kind: "contradiction", rule: "bash_allow", pattern, message: "the same pattern is in bash_allow and bash_deny; deny wins, so the allow entry never admits anything" });
        continue;
      }
      // A plain-text allow entry the real matcher refuses through some deny pattern.
      if (LITERAL.test(pattern) && deny.length > 0 && compile(pattern)) {
        const refused = bashPolicy(pattern, undefined, deny);
        if (refused && refused.rule === "bash_deny" && refused.pattern !== undefined && !deny.every((d) => compile(d) === null)) {
          add({ kind: "contradiction", rule: "bash_allow", pattern, message: `this bash_allow entry is itself refused by the bash_deny pattern ${JSON.stringify(refused.pattern)}; deny wins, so it never admits that command` });
        }
      }
    }
    if (holdsBash && allow.length > 0 && allowLive === 0) {
      add({ kind: "always_denied", rule: "bash_allow", message: "no bash_allow pattern can match, so bash is refused for every command in this role" });
    }

    // --- write_allow --------------------------------------------------------
    const globs = writeAllow.filter((g) => g.trim().length > 0);
    let globsLive = 0;
    globs.forEach((glob, i) => {
      const why = globNeverMatches(glob);
      if (why) {
        add({ kind: "never_matches", rule: "write_allow", pattern: glob, message: `write_allow pattern can never match a path: ${why}` });
        return;
      }
      const dupe = globs.indexOf(glob) < i;
      if (dupe) {
        add({ kind: "shadowed", rule: "write_allow", pattern: glob, message: "write_allow lists this glob more than once" });
        return;
      }
      globsLive++;
      const broader = globs.find((a) => a !== glob && globNeverMatches(a) === null && globCovers(a, glob));
      if (broader !== undefined) {
        add({ kind: "shadowed", rule: "write_allow", pattern: glob, message: `write_allow glob is already covered by the broader ${JSON.stringify(broader)}` });
      }
    });
    if (holdsWrite && globs.length > 0 && globsLive === 0) {
      add({ kind: "always_denied", rule: "write_allow", message: "no write_allow glob can match a path, so write and edit are refused for every file in this role" });
    }

    // --- tools granted but refused or unavailable ---------------------------
    for (const tool of def.tools ?? []) {
      const declared = toolDefs.find((t) => t.name === tool);
      if (declared?.enabled === false) {
        add({ kind: "always_denied", rule: "tools", pattern: tool, message: `this role is granted ${tool}, but tools.toml declares it enabled = false, so it is never offered` });
      }
      if (tool === "webfetch" && policy.sandbox?.network === false && declared?.enabled !== false) {
        add({ kind: "always_denied", rule: "tools", pattern: tool, message: "this role is granted webfetch, but [sandbox] network = false makes webfetch refuse every call" });
      }
      if (tool.startsWith("mcp__")) {
        const server = tool.split("__")[1] ?? "";
        if (!mcpServers.includes(server)) {
          add({ kind: "never_matches", rule: "tools", pattern: tool, message: `this role is granted ${tool}, but tools.toml declares no MCP server named "${server}"` });
        }
      }
    }
    if (holds(def, "task") && Array.isArray(def.task_allow)) {
      const targets = strs(def.task_allow);
      if (targets.length === 0) {
        add({ kind: "always_denied", rule: "task_allow", message: "this role holds task, but task_allow is empty, so it may not delegate at all" });
      } else if (targets.every((t) => !roleNames.includes(t))) {
        add({ kind: "never_matches", rule: "task_allow", pattern: targets.join(", "), message: "task_allow names no role this surface declares, so every delegation is refused" });
      } else {
        for (const t of targets.filter((x) => !roleNames.includes(x))) {
          add({ kind: "never_matches", rule: "task_allow", pattern: t, message: `task_allow names "${t}", which is not a role this surface declares` });
        }
      }
    }
  }

  // --- uncovered categories (surface level) ----------------------------------
  const policyWhere = ".gnomon/policy.toml";
  const acting = roleNames.filter((r) => holds(roles[r], "bash") || holds(roles[r], "write") || holds(roles[r], "edit"));
  if (acting.length > 0) {
    const gaps = governanceGaps({ policy: config.policy, roles: roles as Record<string, unknown> }, acting);
    if (gaps.undeclared.length > 0) {
      out.push({
        kind: "uncovered",
        where: `${policyWhere} [governance]`,
        rule: "governance",
        pattern: "secrets, ci, outside_root_writes",
        message:
          `no [governance] is declared for ${gaps.undeclared.length === acting.length ? "any role" : gaps.undeclared.join(", ")}: ` +
          "reading credentials, writing CI definitions and shell writes outside the repository are covered by no rule",
      });
    }
    if (policy.sandbox?.level === "off") {
      out.push({ kind: "uncovered", where: `${policyWhere} [sandbox]`, rule: "sandbox", pattern: "outside_root_writes", message: "[sandbox] level = \"off\" leaves writes outside the repository root to the model's own restraint" });
    }
    if (policy.sandbox?.network === true && gaps.undeclared.length > 0) {
      out.push({ kind: "uncovered", where: `${policyWhere} [sandbox]`, rule: "sandbox", pattern: "network", message: "[sandbox] network = true opens the network and no [governance] network family covers what goes over it" });
    }
    for (const role of acting) {
      const def = roles[role]!;
      if (!holds(def, "bash")) continue;
      const none = strs0(def.bash_allow).length === 0 && strs0(def.bash_deny).length === 0;
      if (none && gaps.undeclared.includes(role)) {
        out.push({ kind: "uncovered", where: `.gnomon/roles.toml [roles.${role}]`, role, rule: "bash", message: "this role runs bash with no bash_allow, no bash_deny and no governance: no rule covers what it runs" });
      }
    }
  }
  if (mcpServers.length > 0) {
    for (const role of roleNames) {
      if (roles[role]!.tools === undefined) {
        out.push({ kind: "uncovered", where: `.gnomon/roles.toml [roles.${role}]`, role, rule: "mcp", message: `tools.toml declares MCP server(s) (${mcpServers.join(", ")}) and this role has no tools list, so every tool of every server is offered to it` });
      }
    }
  }

  return out;
}

function strs0(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

/** A document `gnomon check --json` carries as `policy_lint`. */
export function policyLintSummary(findings: PolicyLintFinding[]): { schema: typeof POLICY_LINT_SCHEMA; count: number; by_kind: Record<string, number>; findings: PolicyLintFinding[] } {
  const by_kind: Record<string, number> = {};
  for (const f of findings) by_kind[f.kind] = (by_kind[f.kind] ?? 0) + 1;
  return { schema: POLICY_LINT_SCHEMA, count: findings.length, by_kind, findings };
}
