/**
 * gnomon-core: Workspace run lock tests (#279) and undeclared role tools (#274).
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, RUN_LOCK_FILENAME } from "./run_lock.js";
import { snapshotRecords } from "./record_guard.js";
import { auditSurface, loadConfig } from "./config.js";
import { runTask, taskExitCode } from "./prompt_loop.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeSurface(opts: { audit?: boolean; withToolsToml?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-runlock-"));
  roots.push(dir);
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  writeFileSync(
    join(dir, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = 32768\n\n[audit]\nenabled = ${opts.audit ? "true" : "false"}\n\n[endpoints.local]\nurl = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"\n`
  );
  writeFileSync(
    join(dir, ".gnomon", "roles.toml"),
    `[roles.builder]\nmodel = "qwen3.6:35b"\nendpoint = "local"\ntools = ["read", "write"]\nmax_steps = 8\n`
  );
  if (opts.withToolsToml !== false) {
    writeFileSync(
      join(dir, ".gnomon", "tools.toml"),
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n[[tools]]\nname = "write"\ndescription = "Write a file."\nenabled = true\n`
    );
  }
  writeFileSync(join(dir, ".gnomon", "policy.toml"), `[approval]\ngate = "on_write"\n`);
  writeFileSync(join(dir, ".gnomon", "system.md"), "be brief\n");
  return dir;
}

describe("workspace run lock (#279)", () => {
  it("acquires exclusively, refuses a second live holder, and releases cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-lockunit-"));
    roots.push(dir);
    const auditDir = join(dir, ".gnomon-audit");

    const first = acquireRunLock(auditDir, { trail: "task-a.jsonl" });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    expect(existsSync(join(auditDir, RUN_LOCK_FILENAME))).toBe(true);

    const second = acquireRunLock(auditDir, { trail: "task-b.jsonl" });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder.pid).toBe(process.pid);
      expect(second.holder.trail).toBe("task-a.jsonl");
    }

    // RecordGuard snapshots ignore run.lock so lock lifecycle never reads as tampering.
    const snap = snapshotRecords([auditDir]);
    expect([...snap.files.keys()].some((p) => p.endsWith(RUN_LOCK_FILENAME))).toBe(false);

    first.release();
    expect(existsSync(join(auditDir, RUN_LOCK_FILENAME))).toBe(false);

    const third = acquireRunLock(auditDir, { trail: "task-c.jsonl" });
    expect(third.acquired).toBe(true);
    if (third.acquired) third.release();
  });

  it("replaces a stale lock left behind by a dead PID", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-lockstale-"));
    roots.push(dir);
    const auditDir = join(dir, ".gnomon-audit");
    mkdirSync(auditDir, { recursive: true });
    // PID 999999999 does not exist on Linux/macOS/Windows.
    writeFileSync(
      join(auditDir, RUN_LOCK_FILENAME),
      JSON.stringify({ pid: 999_999_999, started: "2026-01-01T00:00:00Z", trail: "dead.jsonl", token: "stale" })
    );

    const acquired = acquireRunLock(auditDir, { trail: "fresh.jsonl" });
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      const saved = JSON.parse(readFileSync(join(auditDir, RUN_LOCK_FILENAME), "utf-8"));
      expect(saved.pid).toBe(process.pid);
      expect(saved.trail).toBe("fresh.jsonl");
      acquired.release();
    }
  });

  it("runTask refuses a concurrent run at start (exit 10) without writing to the live audit dir", async () => {
    const dir = makeSurface({ audit: true });
    const auditDir = join(dir, ".gnomon-audit");
    const held = acquireRunLock(auditDir, { trail: "task-live.jsonl" });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    try {
      const config = loadConfig(dir);
      const rec = await runTask(config, "do work", { role: "builder" });
      expect(rec.bucket).toBe("apparatus_failure");
      expect(rec.code).toBe(10);
      expect(taskExitCode(rec)).toBe(10);
      expect(rec.output).toContain(`another gnomon task (pid ${process.pid}, trail task-live.jsonl) is running in this workspace`);
      // No second trail was created beside the live lock.
      expect(readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
    } finally {
      held.release();
    }
  });
});

describe("undeclared role tools / missing tools.toml (#274)", () => {
  it("auditSurface flags missing tools.toml and names the role and missing tools", () => {
    const dir = makeSurface({ withToolsToml: false });
    const findings = auditSurface(loadConfig(dir));
    const f = findings.find((p) => p.where === ".gnomon/roles.toml [roles.builder] tools");
    expect(f).toBeDefined();
    expect(f!.problem).toContain("read, write");
    expect(f!.problem).toContain("there is no tools.toml");
    expect(f!.problem).toContain("offered no tools");
  });

  it("runTask warns on stderr when a role lists tools that are not declared", async () => {
    const dir = makeSurface({ withToolsToml: false });
    const errLines: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ message: { content: "done" } }),
    })) as unknown as typeof fetch;
    try {
      const rec = await runTask(loadConfig(dir), "hello", {
        role: "builder",
        stderr: { write: (s: string) => { errLines.push(s); } },
      });
      expect(rec.bucket).toBe("result");
      expect(errLines.join("")).toContain('role "builder" lists tools (read, write)');
      expect(errLines.join("")).toContain("offered no tools");
      expect(rec.surface_problems?.some((p) => p.where === ".gnomon/roles.toml [roles.builder] tools")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
