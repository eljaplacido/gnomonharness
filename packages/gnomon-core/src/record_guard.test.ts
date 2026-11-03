/**
 * gnomon-core: the record guard -- changes to gnomon's own records that gnomon
 * did not make are found by looking at the records, not at the command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AuditTrail, type ResolvedAudit, type AuditRecord } from "./audit.js";
import { RecordGuard, snapshotRecords, foreignChanges, recordDirsOf, SNAPSHOT_LIMITS } from "./record_guard.js";
import { unresolvedTamper, resolveTamper, writeTamperRecord } from "./record_tamper.js";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";
import { acceptSkill, proposeSkill, RecordTamperRefusal } from "./skills.js";
import { bashPrecheck, type ToolContext } from "./tools.js";

let root: string;
const audit = () => join(root, ".gnomon-audit");
const settings = (): ResolvedAudit => ({
  enabled: true,
  dir: audit(),
  record: "metadata",
  redact: [],
  chain: true,
  invalid_redact: [],
});

let marker: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-guard-"));
  marker = process.env.GNOMON_AGENT_SESSION;
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  if (marker === undefined) delete process.env.GNOMON_AGENT_SESSION;
  else process.env.GNOMON_AGENT_SESSION = marker;
  rmSync(root, { recursive: true, force: true });
});

describe("snapshots", () => {
  it("gnomon's own writes are not changes; anyone else's are", () => {
    const t = new AuditTrail(settings(), "s");
    t.write("session_start", {});
    const g = new RecordGuard([audit(), join(root, ".gnomon-trials")]);
    t.write("turn", { n: 1 });
    expect(g.check("during_call")).toBeNull();

    appendFileSync(join(audit(), "s.jsonl"), '{"forged":1}\n');
    writeFileSync(join(audit(), "new.jsonl"), "{}\n");
    mkdirSync(join(root, ".gnomon-trials", "x"), { recursive: true });
    writeFileSync(join(root, ".gnomon-trials", "x", "report.json"), "{}");
    const f = g.check("during_call");
    expect(f?.changes.map((c) => [c.change, c.path.slice(root.length + 1).replace(/\\/g, "/")]).sort()).toEqual([
      ["added", ".gnomon-audit/new.jsonl"],
      ["added", ".gnomon-trials/x/report.json"],
      ["modified", ".gnomon-audit/s.jsonl"],
    ]);
    // The baseline moved on: the same state is not reported twice.
    expect(g.check("between_calls")).toBeNull();
    rmSync(join(audit(), "new.jsonl"));
    expect(g.check("between_calls")?.changes).toEqual([{ path: join(audit(), "new.jsonl"), change: "removed" }]);
  });

  it("a write gnomon makes after someone else's does not launder it", () => {
    // Someone appends; then gnomon appends too. Without the pre-write check
    // the file would match gnomon's own last write and pass.
    const t = new AuditTrail(settings(), "s");
    t.write("session_start", {});
    const g = new RecordGuard([audit()]);
    appendFileSync(join(audit(), "s.jsonl"), '{"forged":1}\n');
    t.write("turn", { n: 1 });
    expect(g.check("between_calls")?.changes.map((c) => c.change)).toEqual(["modified"]);
  });

  it.skipIf(process.platform === "win32")("a symlink made inside the records is a change", () => {
    mkdirSync(audit(), { recursive: true });
    const g = new RecordGuard([audit()]);
    symlinkSync("/etc/hostname", join(audit(), "l.jsonl"));
    expect(g.check("during_call")?.changes.map((c) => c.change)).toEqual(["added"]);
  });

  it("states its cost: stat for every file, a hash for the newest few", () => {
    mkdirSync(audit(), { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(audit(), `t-${i}.jsonl`), `{"i":${i}}\n`);
    const s = snapshotRecords([audit()]);
    expect(s.files.size).toBe(300);
    expect([...s.files.values()].filter((f) => f.sha).length).toBe(SNAPSHOT_LIMITS.hashNewest);
    expect(s.truncated).toBe(false);
    expect(foreignChanges(s, snapshotRecords([audit()]))).toEqual([]);
  });

  it("names the custom [audit] dir as a record dir", () => {
    const dirs = recordDirsOf({ gnomonDir: join(root, ".gnomon"), config: { audit: { dir: "var/trail" } } } as never);
    expect(dirs.map((d) => d.slice(root.length + 1).replace(/\\/g, "/"))).toEqual([".gnomon-audit", ".gnomon-trials", "var/trail"]);
  });
});

// ---------------------------------------------------------------------------
// In the loop
// ---------------------------------------------------------------------------

function surface(): void {
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(".gnomon/config.toml", `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n\n[audit]\nenabled = true\n`);
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read', 'bash']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "bash"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", "x\n");
}

/** One bash call, then an answer. */
async function withBash<T>(command: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () =>
        i++ === 0
          ? { message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] }, eval_count: 1 }
          : { message: { content: "done" }, eval_count: 1 },
    }) as unknown as Response) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("a tool call that changes gnomon's records", () => {
  it("stops the turn with a refusal and a record_tamper, by a route no pattern names", async () => {
    // `cp -r stage/. .`: the target is the repository root, so the `record`
    // rule's patterns let it through (round-3 review), and it overwrites the
    // trail with whatever stage/.gnomon-audit holds. Fails before the guard.
    surface();
    mkdirSync(join(root, "stage", ".gnomon-audit"), { recursive: true });
    writeFileSync(join(root, "stage", ".gnomon-audit", "trial-forged.jsonl"), '{"kind":"skill_trial"}\n');
    const command = "cp -r stage/. .";
    const ctx = { root, sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 10_000, maxOutputBytes: 32_000 } as ToolContext;
    expect(bashPrecheck({ command }, ctx)).toBeNull();

    const record = await withBash(command, () => runTask(loadConfig(root), "go", { role: "implement", yes: true }));
    expect(record.stop_reason).toBe("tamper");
    expect(record.code).toBe(3);
    expect(record.bucket).toBe("refusal");
    expect(existsSync(join(audit(), "trial-forged.jsonl"))).toBe(true);

    const open = unresolvedTamper(loadConfig(root));
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0]!.record).toMatchObject({ when: "during_call", tool: "bash", target: command });
    expect(JSON.stringify(open[0]!.record.changes)).toContain(".gnomon-audit/trial-forged.jsonl");
  }, 30_000);

  it("blocks skill accept until a person resolves it, and the agent cannot", async () => {
    surface();
    const config = loadConfig(root);
    proposeSkill(config, { name: "fix it", body: "x" });
    const t = writeTamperRecord(config, { when: "during_call", tool: "bash", changes: [] })!;
    let err: unknown;
    try {
      acceptSkill(config, "fix-it");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RecordTamperRefusal);
    const ref = { trail: t.trail.slice(root.length + 1).replace(/\\/g, "/"), seq: t.record.seq };
    process.env.GNOMON_AGENT_SESSION = "s-agent";
    expect(() => resolveTamper(config, ref, "looked, it was me")).toThrow(/agent session/);
    delete process.env.GNOMON_AGENT_SESSION;
    expect(() => resolveTamper(config, ref, "")).toThrow(/--reason/);
    resolveTamper(config, ref, "reviewed: a test of the guard");
    expect(unresolvedTamper(config)).toEqual([]);
    expect(acceptSkill(config, "fix-it").record?.kind).toBe("skill_accept");
  });

  it("an ordinary run leaves no tamper event behind", async () => {
    surface();
    const record = await withBash("echo hello > notes.txt", () => runTask(loadConfig(root), "go", { role: "implement", yes: true }));
    expect(record.stop_reason).toBe("answered");
    expect(unresolvedTamper(loadConfig(root))).toEqual([]);
    const trails = readdirSync(audit()).filter((f) => f.endsWith(".jsonl"));
    const kinds = trails.flatMap((f) =>
      readFileSync(join(audit(), f), "utf-8").trim().split("\n").map((l) => (JSON.parse(l) as AuditRecord).kind)
    );
    expect(kinds).not.toContain("record_tamper");
  }, 30_000);
});

describe("ln -s resolves its source from the link's directory", () => {
  it("refuses a relative symlink into the records, and cp -l / link", () => {
    mkdirSync(audit(), { recursive: true });
    writeFileSync(join(audit(), "a.jsonl"), "{}\n");
    const ctx = { root, sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 10_000, maxOutputBytes: 32_000 } as ToolContext;
    for (const command of [
      "mkdir -p sub && ln -s ../.gnomon-audit sub/l && echo x >> sub/l/a.jsonl",
      "ln -s ../../.gnomon-audit/a.jsonl deep/er/x",
      "cp -l .gnomon-audit/a.jsonl h.jsonl",
      "cp -al .gnomon-audit bk",
      "link .gnomon-audit/a.jsonl h.jsonl",
    ]) {
      expect(bashPrecheck({ command }, ctx)?.rule, command).toBe("record");
    }
    expect(bashPrecheck({ command: "ln -s ../lib sub/lib" }, ctx)).toBeNull();
  });
});
