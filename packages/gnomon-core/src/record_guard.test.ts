/**
 * gnomon-core: the record guard -- changes to gnomon's own records that gnomon
 * did not make are found by looking at the records, not at the command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AuditTrail, type ResolvedAudit, type AuditRecord } from "./audit.js";
import { RecordGuard, snapshotRecords, foreignChanges, recordDirsOf, SNAPSHOT_LIMITS } from "./record_guard.js";
import { unresolvedTamper, resolveTamper, writeTamperRecord, writeCheckpoint, compareWithCheckpoint } from "./record_tamper.js";
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
    expect(() => resolveTamper(config, ref, "looked, it was me", { interactive: true })).toThrow(/agent session/);
    delete process.env.GNOMON_AGENT_SESSION;
    // Round-4 review: `env -u GNOMON_AGENT_SESSION` from the agent's bash
    // resolved it. Without a terminal or a person-present signer, refused.
    expect(() => resolveTamper(config, ref, "looks fine")).toThrow(/needs a person/);
    expect(() => resolveTamper(config, ref, "", { interactive: true })).toThrow(/--reason/);
    const r = resolveTamper(config, ref, "reviewed: a test of the guard", { interactive: true });
    expect(r.record).toMatchObject({ interactive: true, authorised_by: "tty", by: "cli" });
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

describe("between sessions: checkpoints (round 4)", () => {
  it("a write after a session ended is a tamper event at the next session and at accept", async () => {
    // Round-4 review: a background job a session left wrote after its last
    // check, and the next session's guard took the result as its baseline.
    // Fails before checkpoints: nothing compared the two.
    surface();
    mkdirSync(audit(), { recursive: true });
    writeFileSync(join(audit(), "old.jsonl"), "{}\n");
    const config = loadConfig(root);
    proposeSkill(config, { name: "fix it", body: "x" });
    expect(writeCheckpoint(config)).not.toBeNull();
    expect(compareWithCheckpoint(config)).toBeNull();
    // The job writes now, between sessions.
    writeFileSync(join(audit(), "old.jsonl"), '{}\n{"forged":1}\n');
    writeFileSync(join(audit(), "trial-forged.jsonl"), "{}\n");
    const since = compareWithCheckpoint(config);
    expect(since?.changes.map((c) => [c.change, c.path.slice(root.length + 1).replace(/\\/g, "/")]).sort()).toEqual([
      ["added", ".gnomon-audit/trial-forged.jsonl"],
      ["modified", ".gnomon-audit/old.jsonl"],
    ]);
    // The next session records it (and is not stopped: it did not do it).
    const record = await withBash("echo hi > notes.txt", () => runTask(loadConfig(root), "go", { role: "implement", yes: true }));
    expect(record.stop_reason).toBe("answered");
    const open = unresolvedTamper(loadConfig(root));
    expect(open.some((e) => e.record.when === "since_last_session")).toBe(true);
    expect(() => acceptSkill(loadConfig(root), "fix-it")).toThrow(RecordTamperRefusal);
  }, 30_000);

  it("deleting a tamper trail is itself a tamper event at accept", () => {
    surface();
    const config = loadConfig(root);
    proposeSkill(config, { name: "fix it", body: "x" });
    const t = writeTamperRecord(config, { when: "during_call", tool: "bash", changes: [] })!;
    writeCheckpoint(config); // the session ended, as runTask does
    rmSync(t.trail);
    expect(unresolvedTamper(config)).toEqual([]);
    let err: unknown;
    try {
      acceptSkill(config, "fix-it");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RecordTamperRefusal);
    const open = unresolvedTamper(config);
    expect(open).toHaveLength(1);
    expect(JSON.stringify(open[0]!.record.changes)).toMatch(/tamper-[^"]*","change":"removed"/);
  });

  it("a new gnomon trail another process wrote is a notice, not a stop", () => {
    // Round-4 review: the operator's own `gnomon skill reject` from a second
    // terminal stopped a live session. A modified or removed file still does.
    surface();
    mkdirSync(audit(), { recursive: true });
    writeFileSync(join(audit(), "kept.jsonl"), "{}\n");
    const live = RecordGuard.for(loadConfig(root));
    // Another process: a child node writing a sealed trail with gnomon's own writer.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const script =
      // A file URL, not a path: on Windows `D:\\…\\audit.ts` is not a valid ESM specifier.
      `import { AuditTrail } from ${JSON.stringify(pathToFileURL(join(here, "audit.ts")).href)};\n` +
      `const t = new AuditTrail({ enabled: true, dir: ${JSON.stringify(audit())}, record: "metadata", redact: [], chain: true, invalid_redact: [] }, "skill-other");\n` +
      `t.write("session_start", { mode: "skill" }); t.write("skill_reject", { skill: "x" }); t.write("session_end", {});\n`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf-8", cwd: join(here, "..") });
    expect(r.status, r.stderr).toBe(0);
    const f = live.check("between_calls");
    expect(f?.changes).toEqual([]);
    expect(f?.notices.map((c) => c.path.slice(root.length + 1).replace(/\\/g, "/"))).toEqual([".gnomon-audit/skill-other.jsonl"]);
    // Rewriting an existing file is still tampering.
    appendFileSync(join(audit(), "kept.jsonl"), "{}\n");
    expect(live.check("between_calls")?.changes.map((c) => c.change)).toEqual(["modified"]);
  }, 60_000);

  it("a person-present signer can authorise a resolution without a terminal; a signer that does not sign cannot", () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = (good: boolean) => {
      const f = join(root, good ? "good.mjs" : "bad.mjs");
      writeFileSync(
        f,
        good
          ? `import { readFileSync } from "node:fs";\nimport { createPrivateKey, sign } from "node:crypto";\nconst k = createPrivateKey(${JSON.stringify(keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString())});\nprocess.stdout.write(sign(null, readFileSync(0), k).toString("base64"));\n`
          : `process.stdout.write("bm90LWEtc2lnbmF0dXJl");\n`
      );
      return `"${process.execPath}" "${f}"`;
    };
    const PUB = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const cfgWith = (good: boolean) =>
      ({
        gnomonDir: join(root, ".gnomon"),
        config: { audit: { attest: { sign: signer(good), public_key: PUB, person_present: true } } },
        policy: {},
      }) as never;
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    const bad = cfgWith(false);
    const t1 = writeTamperRecord(bad, { when: "during_call", changes: [] })!;
    const ref1 = { trail: t1.trail.slice(root.length + 1).replace(/\\/g, "/"), seq: t1.record.seq };
    expect(() => resolveTamper(bad, ref1, "reviewed")).toThrow(/did not sign/);
    expect(unresolvedTamper(bad)).toHaveLength(1);
    const good = cfgWith(true);
    const r = resolveTamper(good, ref1, "reviewed with a touch");
    expect(r.record).toMatchObject({ interactive: false, authorised_by: "person_present_signer" });
    expect(unresolvedTamper(good)).toEqual([]);
  }, 30_000);
});

