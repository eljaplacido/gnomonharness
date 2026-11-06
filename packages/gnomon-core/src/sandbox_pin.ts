/**
 * The sandbox a session started under is a floor, not a suggestion.
 *
 * `[sandbox] exec`, `image`, `network`, `extra_roots` and `level` live in
 * .gnomon/policy.toml (and a role's `exec` and `image` in roles.toml), which
 * are files inside the project root -- and the project root is exactly what a
 * sandboxed bash may write: exec = "docker" bind-mounts it. The loop reloads
 * the surface when a tool call moves it (prompt_loop: surface drift ->
 * reloadConfig) and resolved the sandbox afresh every turn, so a contained
 * command could write `exec = "off"` into policy.toml and run on the host
 * from the next turn. The cage held the key to itself. (PR #156 second
 * review; third review, finding 1, reproduced on the released docker mode.)
 *
 * So the session PINS what it started with, per role, and every later reading
 * of the surface may only TIGHTEN it: off -> docker, network true -> false,
 * fewer extra_roots, a stricter level. A change that would loosen it -- or a
 * different image for a docker role -- is not applied; it is reported, and
 * takes effect only when the operator restarts gnomon, which re-reads the
 * surface through the trust decision (trust.ts: a role that ran contained in
 * this project and now asks for exec = "off" is a grant to be accepted, not a
 * default). Tightening is applied at once and becomes the new floor (a
 * ratchet), so it cannot be undone silently either.
 *
 * The session's own grants (`/network`, `/sandbox`) are not part of the pin:
 * those are typed by the operator, which is the consent the pin exists to
 * require.
 */

import {
  type GnomonConfig,
  type ResolvedExec,
  listRoles,
  resolveExec,
  resolveExtraRoots,
  resolveSandboxLevel,
} from "./config.js";
import type { SandboxLevel } from "./tools.js";
import { realpathSync } from "node:fs";

export interface SandboxPin {
  level: SandboxLevel;
  /** `[sandbox] network` as declared (undefined when absent). */
  network: boolean | undefined;
  extraRoots: string[];
  /** resolveExec with no role: what a role without its own `exec` gets. */
  defaultExec: ResolvedExec;
  /** Per role, as pinned (and ratcheted). */
  roles: Map<string, ResolvedExec>;
  /**
   * Each granted extra root by the REAL path it had when first pinned, or
   * null when it did not exist then. A root declared as a path the command
   * can re-point (a symlink inside the root) keeps granting what it granted
   * at the start, not wherever it points now. Null: not granted this session.
   */
  real: Map<string, string | null>;
}

function realOf(pin: SandboxPin, p: string): string | null {
  if (!pin.real.has(p)) {
    let r: string | null;
    try {
      r = realpathSync(p);
    } catch {
      r = null;
    }
    pin.real.set(p, r);
  }
  return pin.real.get(p) ?? null;
}

/** `roots` mapped to their pinned real paths; the ones that had none are dropped. */
function pinnedReal(pin: SandboxPin, roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const real = realOf(pin, r);
    if (real !== null && !out.includes(real)) out.push(real);
  }
  return out;
}

const LEVEL_RANK: Record<SandboxLevel, number> = { off: 0, confined: 1, strict: 2 };

function declaredNetwork(config: GnomonConfig): boolean | undefined {
  const n = (config.policy?.sandbox as { network?: unknown } | undefined)?.network;
  return typeof n === "boolean" ? n : undefined;
}

/** Pin the sandbox of `config`: call once, when the session starts. */
export function pinSandbox(config: GnomonConfig): SandboxPin {
  const roles = new Map<string, ResolvedExec>();
  for (const r of listRoles(config)) roles.set(r, resolveExec(config, r));
  const pin: SandboxPin = {
    level: resolveSandboxLevel(config),
    network: declaredNetwork(config),
    extraRoots: resolveExtraRoots(config),
    defaultExec: resolveExec(config),
    roles,
    real: new Map(),
  };
  for (const r of pin.extraRoots) realOf(pin, r);
  return pin;
}

/**
 * `fresh`, held to `pinned`: every field that would loosen keeps the pinned
 * value, and each kept field is named in `loosened`.
 */
export function tightenExec(pinned: ResolvedExec, fresh: ResolvedExec): { exec: ResolvedExec; loosened: string[] } {
  const loosened: string[] = [];
  let mode = fresh.mode;
  let image = fresh.image;
  if (pinned.mode !== "off" && fresh.mode !== pinned.mode) {
    loosened.push(`exec = "${fresh.mode}" (pinned: "${pinned.mode}")`);
    mode = pinned.mode;
    image = pinned.image;
  } else if (pinned.mode === "docker" && fresh.image !== pinned.image) {
    // Another image is another program set the commands run with -- one the
    // surface (that is, the container) chose. Not applied mid-session.
    loosened.push(`image = "${fresh.image}" (pinned: "${pinned.image}")`);
    image = pinned.image;
  }
  let network = fresh.network;
  if (fresh.network && !pinned.network) {
    loosened.push("network = true (pinned: false)");
    network = false;
  }
  return { exec: { ...fresh, mode, image, network }, loosened };
}

export interface PinnedSandbox {
  level: SandboxLevel;
  network: boolean | undefined;
  extraRoots: string[];
  exec: ResolvedExec;
  /** What the surface asked for that was NOT applied, for the operator. */
  loosened: string[];
}

/**
 * The sandbox `config` asks for, for `role`, held to `pin` -- and the pin
 * ratcheted to the result, so a tightening stays.
 */
export function applySandboxPin(pin: SandboxPin, config: GnomonConfig, role: string): PinnedSandbox {
  const loosened: string[] = [];

  let level = resolveSandboxLevel(config);
  if (LEVEL_RANK[level] < LEVEL_RANK[pin.level]) {
    loosened.push(`level = "${level}" (pinned: "${pin.level}")`);
    level = pin.level;
  }

  let network = declaredNetwork(config);
  if (network === true && pin.network !== true) {
    loosened.push(`network = true (pinned: ${pin.network === false ? "false" : "unset"})`);
    network = pin.network;
  }

  const freshRoots = resolveExtraRoots(config);
  const added = freshRoots.filter((r) => !pin.extraRoots.includes(r));
  if (added.length > 0) loosened.push(`extra_roots += ${added.join(", ")}`);
  const extraRoots = freshRoots.filter((r) => pin.extraRoots.includes(r));

  // A role the session did not start with gets what a role without its own
  // `exec` had at the start: a new role named `exec = "off"` is a loosening.
  const pinnedExec = pin.roles.get(role) ?? pin.defaultExec;
  const t = tightenExec(pinnedExec, resolveExec(config, role));
  loosened.push(...t.loosened);

  pin.level = level;
  pin.network = network;
  pin.extraRoots = extraRoots;
  pin.roles.set(role, t.exec);
  return {
    level,
    network,
    extraRoots: pinnedReal(pin, extraRoots),
    exec: t.exec,
    loosened,
  };
}

/**
 * What a freshly loaded surface asks for that the pin will not apply, for
 * every role -- without moving the pin. For the reload notice.
 */
export function describeLoosening(pin: SandboxPin, config: GnomonConfig): string[] {
  const copy: SandboxPin = {
    level: pin.level,
    network: pin.network,
    extraRoots: [...pin.extraRoots],
    defaultExec: pin.defaultExec,
    roles: new Map(pin.roles),
    real: new Map(pin.real),
  };
  const out = new Set<string>();
  for (const r of new Set([...listRoles(config), ...pin.roles.keys()])) {
    for (const l of applySandboxPin(copy, config, r).loosened) out.add(l);
  }
  return [...out];
}
