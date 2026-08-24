/**
 * gnomon-core: Session store tests
 *
 * Resume shipped verified only by hand. These pin the behaviour it depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSessionStore,
  saveSession,
  listSessions,
  loadSession,
  SESSION_FORMAT,
  SessionSnapshot,
  ResolvedSessionStore,
} from "./session_store.js";

let root: string;
let store: ResolvedSessionStore;

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  format: SESSION_FORMAT,
  id: "s1",
  started: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
  surface_hash: "abc123",
  cwd: "/somewhere",
  currentRole: "implement",
  exchanges: [],
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-sess-"));
  store = { persist: true, dir: join(root, ".gnomon-sessions"), keep: 20 };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveSessionStore", () => {
  it("persists by default — a session you cannot resume is one you lose", () => {
    const cfg: any = { gnomonDir: join(root, ".gnomon"), config: {} };
    expect(resolveSessionStore(cfg).persist).toBe(true);
  });

  it("lives outside .gnomon/, so snapshots never change the surface hash", () => {
    const cfg: any = { gnomonDir: join(root, ".gnomon"), config: {} };
    const r = resolveSessionStore(cfg);
    expect(r.dir.startsWith(join(root, ".gnomon") + "/")).toBe(false);
    expect(r.dir).toBe(join(root, ".gnomon-sessions"));
  });

  it("can be switched off", () => {
    const cfg: any = { gnomonDir: join(root, ".gnomon"), config: { session: { persist: false } } };
    expect(resolveSessionStore(cfg).persist).toBe(false);
  });
});

describe("saving", () => {
  it("writes nothing when persistence is off", () => {
    const off = { ...store, persist: false };
    expect(saveSession(off, snap())).toBeNull();
    expect(existsSync(off.dir)).toBe(false);
  });

  it("round-trips a conversation", () => {
    saveSession(store, snap({
      exchanges: [{ turn: 1, role: "implement", input: "hi", output: "hello", model: "m", code: 0, bucket: "result", duration_ms: 5 }],
      summary: "we discussed X",
    }));
    const back = loadSession(store);
    expect(back.exchanges).toHaveLength(1);
    expect(back.exchanges[0].input).toBe("hi");
    expect(back.summary).toBe("we discussed X");
  });

  it("keeps only the newest `keep` snapshots", () => {
    const small = { ...store, keep: 3 };
    for (const id of ["a", "b", "c", "d", "e"]) saveSession(small, snap({ id }));
    const kept = readdirSync(small.dir).sort();
    expect(kept).toEqual(["c.json", "d.json", "e.json"]);
  });

  it("keep = 0 prunes nothing", () => {
    const unlimited = { ...store, keep: 0 };
    for (const id of ["a", "b", "c"]) saveSession(unlimited, snap({ id }));
    expect(readdirSync(unlimited.dir)).toHaveLength(3);
  });
});

describe("listing", () => {
  it("is empty rather than throwing when nothing exists", () => {
    expect(listSessions(store)).toEqual([]);
  });

  it("summarises each snapshot for recognition", () => {
    saveSession(store, snap({
      id: "x",
      currentRole: "plan",
      exchanges: [{ turn: 1, role: "plan", input: "audit the parser", output: "…", model: "m", code: 0, bucket: "result", duration_ms: 1 }],
    }));
    const [entry] = listSessions(store);
    expect(entry.id).toBe("x");
    expect(entry.turns).toBe(1);
    expect(entry.currentRole).toBe("plan");
    expect(entry.opening).toBe("audit the parser");
  });

  it("a corrupt snapshot does not hide the readable ones", () => {
    saveSession(store, snap({ id: "good" }));
    writeFileSync(join(store.dir, "broken.json"), "{ not json");
    expect(listSessions(store).map((e) => e.id)).toEqual(["good"]);
  });
});

describe("loading", () => {
  it("with no id, resumes the most recent", () => {
    saveSession(store, snap({ id: "2026-01-01" }));
    saveSession(store, snap({ id: "2026-06-01", currentRole: "verifier" }));
    expect(loadSession(store).currentRole).toBe("verifier");
  });

  it("names what is available when an id is wrong", () => {
    saveSession(store, snap({ id: "real" }));
    expect(() => loadSession(store, "typo")).toThrow(/real/);
  });

  it("reports an empty store rather than returning nothing", () => {
    expect(() => loadSession(store)).toThrow(/No sessions/);
  });

  it("refuses a snapshot from a newer format instead of half-reading it", () => {
    // Replaying fields this build does not understand would silently drop
    // conversation, which is worse than declining to resume.
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(
      join(store.dir, "future.json"),
      JSON.stringify({ ...snap({ id: "future" }), format: SESSION_FORMAT + 1 })
    );
    expect(() => loadSession(store, "future")).toThrow(/newer gnomon/);
  });

  it("carries the surface hash it ran under, so drift can be reported", () => {
    saveSession(store, snap({ surface_hash: "hash-at-save" }));
    expect(loadSession(store).surface_hash).toBe("hash-at-save");
  });
});
