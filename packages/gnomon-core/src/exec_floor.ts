/**
 * Exec floors: where each project's bash last ran on this machine, in a file
 * of their own beside the trust store.
 *
 * WHY (fifth review, finding 1). The floors lived inside trust.json, and
 * loadTrust read a corrupt trust.json as an empty store. A contained command
 * that got one host write into trust.json (a symlinked history file) erased
 * every floor with it, and the next session with `exec = "off"` in a surface
 * the container had rewritten ran on the host, unasked. Now:
 *
 *   - floors are their own file, written whole and renamed into place;
 *   - a floor file (or trust store) that exists and cannot be read is LOST,
 *     not empty: every project is treated as contained -- per its own
 *     declaration where that is contained, docker otherwise, never off --
 *     until `gnomon trust grant` says otherwise for it;
 *   - a floor file rebuilt after a loss remembers when (`lost`), and a
 *     project with no entry in it is still treated as contained.
 *
 * Also read by git_safe.ts, so a gnomon process that never started a
 * session (the dashboard, `gnomon check`) knows which roots a container may
 * be writing.
 */
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { escapesBase } from "./rel_path.js";
import { randomBytes } from "node:crypto";
import { gnomonDataDir, restrictToOwner } from "./credentials.js";

export interface ExecFloor {
  root: string;
  roles: Record<string, { mode: string; image: string }>;
  /**
   * `[sandbox] network` when a session here last started contained (seventh
   * review, B4). false is a floor: `gnomon check` will not run [verify] with
   * the network on until `gnomon trust grant` records otherwise. Absent in
   * floors written before it was recorded.
   */
  network?: boolean;
  at: string;
  /** When a session here last started with a role contained. */
  last?: string;
}

export interface FloorStore {
  v: 1;
  floors: ExecFloor[];
  /**
   * Set when this file was rebuilt after the previous one (or the trust
   * store) could not be read: when. A project with no entry is then
   * contained until it is granted.
   */
  lost?: string;
}

export type FloorRead = { ok: true; store: FloorStore } | { ok: false; reason: string };

export const FLOORS_FILE = "exec-floors.json";

export function floorsPath(): string {
  return join(gnomonDataDir(), FLOORS_FILE);
}

/** The floors file beside a given trust store (tests pass their own). */
export function floorsPathFor(trustPath: string): string {
  return join(dirname(trustPath), FLOORS_FILE);
}

function isFloor(f: unknown): f is ExecFloor {
  if (!f || typeof f !== "object") return false;
  const x = f as ExecFloor;
  if (typeof x.root !== "string" || !x.roles || typeof x.roles !== "object") return false;
  if (x.network !== undefined && typeof x.network !== "boolean") return false;
  return Object.values(x.roles).every((e) => e && typeof e.mode === "string" && typeof e.image === "string");
}

/** Absent: no floors, ok. Present and unreadable or malformed in any part: not ok. */
export function readFloors(path = floorsPath()): FloorRead {
  if (!existsSync(path)) return { ok: true, store: { v: 1, floors: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return { ok: false, reason: `${path} could not be read (${(e as Error).message.split("\n")[0]})` };
  }
  const p = parsed as Partial<FloorStore>;
  if (!p || typeof p !== "object" || p.v !== 1 || !Array.isArray(p.floors) || !p.floors.every(isFloor)) {
    return { ok: false, reason: `${path} is not an exec floor file` };
  }
  return { ok: true, store: { v: 1, floors: p.floors, ...(typeof p.lost === "string" ? { lost: p.lost } : {}) } };
}

/** Owner-only, a fresh temp file renamed into place. */
export function writeFloors(store: FloorStore, path = floorsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw e;
  }
  restrictToOwner(path, "The exec floor file");
}

/** Move an unreadable file aside (kept for the operator), so a new one can be written. */
export function setAside(path: string): string | null {
  if (!existsSync(path)) return null;
  const to = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, to);
    return to;
  } catch {
    return null;
  }
}

export function within(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !escapesBase(rel);
}

export const containedMode = (mode: string): boolean => mode !== "off";

/** The strictest entry of a floor: a contained one, preferring the default's. */
export function strictestOf(floor: ExecFloor): { mode: string; image: string } | undefined {
  const star = floor.roles["*"];
  if (star && containedMode(star.mode)) return star;
  return Object.values(floor.roles).find((e) => containedMode(e.mode));
}

/**
 * The floor that governs `root`: its own, else the nearest floored ancestor's
 * (a `.gnomon/` that appeared below a floored root -- fifth review, finding
 * 4 -- is held to where the root above it ran).
 */
export function governingFloor(floors: readonly ExecFloor[], root: string): { floor: ExecFloor; exact: boolean } | undefined {
  const exact = floors.find((f) => f.root === root);
  if (exact) return { floor: exact, exact: true };
  let best: ExecFloor | undefined;
  for (const f of floors) {
    if (within(f.root, root) && strictestOf(f) && (!best || f.root.length > best.root.length)) best = f;
  }
  if (!best) return undefined;
  const strict = strictestOf(best)!;
  return {
    floor: { root, roles: { "*": { ...strict } }, ...(best.network !== undefined ? { network: best.network } : {}), at: best.at },
    exact: false,
  };
}

/**
 * Might a contained command be writing somewhere `paths` overlap, as far as
 * this machine's floors say? True when a contained floor's root and one of
 * the paths contain one another, or when the floors cannot be read or were
 * lost (then every project is treated as contained).
 */
export function containedRootOverlaps(paths: readonly string[], path = floorsPath()): boolean {
  const r = readFloors(path);
  if (!r.ok || r.store.lost) return true;
  for (const f of r.store.floors) {
    if (!strictestOf(f)) continue;
    if (paths.some((p) => within(f.root, p) || within(p, f.root))) return true;
  }
  return false;
}
