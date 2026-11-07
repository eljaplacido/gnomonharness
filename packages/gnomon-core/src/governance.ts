/**
 * gnomon-core: governance levels — how strongly a rule's verdict is applied.
 *
 * A rule (bash_deny, write_allow, the surface guard, …) says WHETHER a call is
 * wrong. `[approval] gate` says which acceptable calls still need a person.
 * The level says WHAT a deny or ask verdict DOES:
 *
 *   observe   record the verdict; the call runs, and nobody is told
 *   advise    record it and tell the agent; the call runs, warned
 *   prevent   deny or ask, exactly as gnomon always has (the default)
 *   enforce   prevent, plus proof. In this build it decides like prevent;
 *             the proof (check failures, ask→deny on hosts that cannot record
 *             an answer, containment) lands with the later governance PRs
 *
 * Every rule belongs to one FAMILY (tools.ts RULE_FAMILY), and a family's
 * level decides what happens to its verdicts. Levels are declared per layer —
 * `[governance]` in policy.toml (the repository), `[roles.<name>.governance]`
 * in roles.toml (a sub-table: gnomon's TOML subset has no inline tables),
 * and later an org layer — and composed by `max`, so a lower layer can only
 * tighten. `rules` (edits to the rules, the records, git hooks) has a floor of
 * prevent: an "audit-only" layer whose agent can delete the trail is not even
 * audit-only.
 *
 * This module only RESOLVES levels. The one place they are applied is
 * `toolCallPolicy` (tools.ts), which the turn loop and `gnomon guard` both
 * call, so the two cannot disagree. With nothing declared, `resolveLevels`
 * returns undefined and nothing downstream changes: not a decision, not a
 * record field, not a request byte.
 *
 * Imports nothing from tools.ts or config.ts on purpose: both import this.
 */

/** A published enumeration (`gnomon enumerations`, CONTRACTS.md §36). Ordered weakest first. */
export const GOVERNANCE_LEVELS = ["observe", "advise", "prevent", "enforce"] as const;
export type GovernanceLevel = (typeof GOVERNANCE_LEVELS)[number];

/** A published enumeration (`gnomon enumerations`, CONTRACTS.md §36). */
export const GOVERNANCE_FAMILIES = ["write", "bash", "network", "secrets", "rules", "ci"] as const;
export type GovernanceFamily = (typeof GOVERNANCE_FAMILIES)[number];

/** What every family resolves to when no layer says anything: today's behaviour. */
export const DEFAULT_LEVEL: GovernanceLevel = "prevent";

/**
 * The lowest level a family may resolve to, whatever is declared. `rules`
 * cannot go below prevent: an agent that may rewrite the rules, the trail or
 * the git hooks can remove the very record observe promises.
 */
export const LEVEL_FLOOR: Readonly<Partial<Record<GovernanceFamily, GovernanceLevel>>> = { rules: "prevent" };

/** The keys `[governance]` and a role's `governance` table read. */
export const GOVERNANCE_KEYS = ["level", ...GOVERNANCE_FAMILIES] as const;

const rank = (l: GovernanceLevel): number => GOVERNANCE_LEVELS.indexOf(l);

/** Is `level` at least `than`? */
export function levelAtLeast(level: GovernanceLevel, than: GovernanceLevel): boolean {
  return rank(level) >= rank(than);
}

/** The stricter of two levels. */
export function maxLevel(a: GovernanceLevel, b: GovernanceLevel): GovernanceLevel {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The levels in force for one role. `layers` names who said something, for
 * the record: "repo", "role:<name>", and later "org:<name>".
 */
export interface GovernanceLevels {
  levels: Record<GovernanceFamily, GovernanceLevel>;
  layers: string[];
}

/** A value outside the enumeration, or a block of the wrong shape. Fatal: a misspelt `prevnt` must not read as "nothing declared". */
export class GovernanceError extends Error {}

/** One layer's declaration, read: family → level, plus the layer default. */
export interface GovernanceLayer {
  name: string;
  level?: GovernanceLevel;
  families: Partial<Record<GovernanceFamily, GovernanceLevel>>;
}

/**
 * Read one `[governance]`-shaped table. Unknown keys are ignored here (the
 * surface audit warns with did-you-mean); a known key with a value outside
 * the enumeration throws.
 */
export function readGovernanceLayer(name: string, where: string, raw: unknown): GovernanceLayer | null {
  if (raw === undefined) return null;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    // gnomon's TOML subset reads an inline table as a string (CONTRACTS.md
    // §5.3): `governance = { bash = "enforce" }` would hash, look declared and
    // do nothing. Refused, with the spelling that is read.
    throw new GovernanceError(
      `${where} is written as an inline table, which gnomon's TOML subset reads as the string ${JSON.stringify(raw)}; ` +
        `write it as a table of its own, ${where.replace(/^.* (\[[^\]]+\])$/, "$1")}, one family per line`
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GovernanceError(`${where} must be a table (family = "level"), not ${Array.isArray(raw) ? "an array" : typeof raw}`);
  }
  const body = raw as Record<string, unknown>;
  const value = (key: string): GovernanceLevel | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !(GOVERNANCE_LEVELS as readonly string[]).includes(v)) {
      throw new GovernanceError(
        `${where} ${key} = ${JSON.stringify(v)} is not a governance level (${GOVERNANCE_LEVELS.join(" | ")})`
      );
    }
    return v as GovernanceLevel;
  };
  const layer: GovernanceLayer = { name, families: {} };
  const level = value("level");
  if (level) layer.level = level;
  for (const f of GOVERNANCE_FAMILIES) {
    const v = value(f);
    if (v) layer.families[f] = v;
  }
  return layer;
}

/**
 * The repository's and the role's layers, as declared on the surface. The org
 * layer arrives with `[extends]` (shared-governance PR 7a); until then the
 * repository is the outermost layer.
 */
export function declaredLayers(
  policy: Record<string, unknown> | undefined,
  role: string,
  roleDef: Record<string, unknown> | undefined
): GovernanceLayer[] {
  const out: GovernanceLayer[] = [];
  const repo = readGovernanceLayer("repo", ".gnomon/policy.toml [governance]", policy?.governance);
  if (repo) out.push(repo);
  const own = readGovernanceLayer(`role:${role}`, `.gnomon/roles.toml [roles.${role}.governance]`, roleDef?.governance);
  if (own) out.push(own);
  return out;
}

/**
 * effective(family) = max over layers of (layer[family] ?? layer.level),
 * ordered observe < advise < prevent < enforce; a layer that says nothing
 * about a family is skipped; prevent when no layer says anything; never
 * below the family's floor.
 *
 * Within one layer a family key may sit below that layer's `level` (that is
 * how `ci = "advise"` sits under `level = "prevent"`). Across layers only max
 * applies, so a role can tighten its repository and never loosen it.
 *
 * Undefined when no layer is declared: the caller then behaves exactly as a
 * build without levels.
 */
export function composeLevels(layers: readonly GovernanceLayer[]): GovernanceLevels | undefined {
  if (layers.length === 0) return undefined;
  const levels = {} as Record<GovernanceFamily, GovernanceLevel>;
  for (const f of GOVERNANCE_FAMILIES) {
    let effective: GovernanceLevel | undefined;
    for (const layer of layers) {
      const said = layer.families[f] ?? layer.level;
      if (said) effective = effective ? maxLevel(effective, said) : said;
    }
    const floor = LEVEL_FLOOR[f];
    levels[f] = floor ? maxLevel(effective ?? DEFAULT_LEVEL, floor) : (effective ?? DEFAULT_LEVEL);
  }
  return { levels, layers: layers.map((l) => l.name) };
}

/**
 * The levels in force for `role` under this surface, or undefined when
 * neither `[governance]` nor the role's `governance` is declared. Throws
 * GovernanceError on a value outside the enumeration.
 */
export function resolveLevels(
  config: { policy?: unknown; roles?: Record<string, unknown> },
  role: string
): GovernanceLevels | undefined {
  return composeLevels(
    declaredLayers(
      config.policy as Record<string, unknown> | undefined,
      role,
      config.roles?.[role] as Record<string, unknown> | undefined
    )
  );
}

/**
 * The agent-facing line at advise: what would have happened under prevent.
 * Appended to the tool result in gnomon's own loop. For other harnesses the
 * delivery channel is a post-tool hook (shared-governance PR 4); until then
 * the guard records `delivered: false`.
 */
export function adviseText(hits: ReadonlyArray<{ rule: string; verdict: "deny" | "ask"; reason: string }>): string {
  return hits
    .map(
      (h) =>
        `gnomon ▸ advise: ${h.rule} would ${h.verdict === "deny" ? "refuse this" : "ask a person before this"} under prevent: ` +
        h.reason.replace(/^Refused:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 400)
    )
    .join("\n");
}
