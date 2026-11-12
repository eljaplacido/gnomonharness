/**
 * gnomon as the audit layer of another harness (CONTRACTS.md §44): the hooks
 * run an absolute gnomon or are not written; every host session that reaches
 * the guard leaves a liveness record, and one that does not is found;
 * `gnomon check --scorecard` summarises a foreign run, and every record it
 * reads and the card itself fit conformance/audit_feed_schema.json.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdGuard, gnomonTail, machineSpecific, resolveGnomonBin, shellCommand, CLAUDE_CODE_MATCHER, type GuardStatus } from "./guard.js";
import { cmdCheck } from "./check.js";
import type { Scorecard } from "./scorecard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const LAUNCHER = join(ROOT, "gnomon");
process.env.GNOMON_GUARD_BIN = LAUNCHER;
const CASES = JSON.parse(readFileSync(join(ROOT, "conformance/guard_cases.json"), "utf-8"));
const FEED = JSON.parse(readFileSync(join(ROOT, "conformance/audit_feed_schema.json"), "utf-8"));

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8" }).trim();
function governedRepo(policyExtra = ""): string {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-scorecard-")));
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".gnomon"), { recursive: true });
  for (const [f, t] of Object.entries(CASES.surface as Record<string, string>)) {
    writeFileSync(join(repo, ".gnomon", f), t.replace("{{gate}}", "on_write") + (f === "policy.toml" ? `\n[check.roles]\nclaude-code = "implement"\n${policyExtra}` : ""));
  }
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/a.ts"), "old\n");
  git("add", "-A");
  git("commit", "-q", "-m", "surface");
  return repo;
}
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

/** A Claude Code PreToolUse call through the real binary. */
function cc(session: string, tool_name: string, tool_input: Record<string, unknown>, permission_mode = "default"): string {
  const r = spawnSync(process.execPath, [LAUNCHER, "guard", "--from", "claude-code", "--agent", "claude-code"], {
    cwd: repo,
    input: JSON.stringify({ session_id: session, cwd: repo, permission_mode, hook_event_name: "PreToolUse", tool_name, tool_input }),
    encoding: "utf-8",
  });
  expect(r.status).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "allow";
}

const statusCode = (dir: string): Promise<number> => cmdGuard(["status", "--dir", dir, "--json"], () => {});
const status = async (dir: string): Promise<GuardStatus> => {
  const lines: string[] = [];
  await cmdGuard(["status", "--dir", dir, "--json"], (s) => lines.push(s));
  return JSON.parse(lines.join(""));
};

async function check(flags: Record<string, string>, json = true): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await cmdCheck({ dir: repo, json, flags }, (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

/** A Claude Code transcript (JSONL) in which the assistant called these tools. */
function transcript(file: string, session: string, tools: string[]): string {
  mkdirSync(dirname(file), { recursive: true });
  const lines = tools.map((name, i) =>
    JSON.stringify({ type: "assistant", sessionId: session, message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name, input: {} }] } })
  );
  writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content: "hi" } })}\n${lines.join("\n")}\n`);
  return file;
}

// A deliberately small JSON Schema checker: the keywords audit_feed_schema.json's
// definitions use, and a failure on any other (as .gnomon/ci.sh does for the
// enumerations schema), so the schema cannot silently say more than is checked.
const KNOWN = new Set(["type", "required", "properties", "additionalProperties", "items", "enum"]);
function conforms(inst: unknown, sch: Record<string, any>, path = "$"): string[] {
  const unknown = Object.keys(sch).filter((k) => !KNOWN.has(k));
  if (unknown.length) return [`${path}: unimplemented schema keyword(s) ${unknown.join(", ")}`];
  const errs: string[] = [];
  const types: string[] = sch.type === undefined ? [] : Array.isArray(sch.type) ? sch.type : [sch.type];
  const typeOf = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
  const t = typeOf(inst);
  if (types.length && !types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${path}: ${t} is not ${types.join("|")}`];
  if (sch.enum && !sch.enum.some((e: unknown) => e === inst)) errs.push(`${path}: ${JSON.stringify(inst)} not in ${JSON.stringify(sch.enum)}`);
  if (t === "object") {
    const o = inst as Record<string, unknown>;
    for (const k of sch.required ?? []) if (!(k in o)) errs.push(`${path}: missing ${k}`);
    if (sch.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in (sch.properties ?? {}))) errs.push(`${path}: undeclared ${k}`);
    for (const [k, sub] of Object.entries(sch.properties ?? {})) if (k in o) errs.push(...conforms(o[k], sub as Record<string, any>, `${path}.${k}`));
  }
  if (t === "array" && sch.items) (inst as unknown[]).forEach((v, i) => errs.push(...conforms(v, sch.items, `${path}[${i}]`)));
  return errs;
}

// ---------------------------------------------------------------------------
// install: an absolute gnomon, or nothing
// ---------------------------------------------------------------------------

describe("gnomon guard install writes an absolute gnomon path, or refuses", () => {
  it("refuses, writing nothing, when no gnomon answers `gnomon guard`", async () => {
    const r = governedRepo();
    const res = resolveGnomonBin("/nonexistent/gnomon");
    expect("error" in res && res.error).toMatch(/no gnomon that answers `gnomon guard`[\s\S]*\/nonexistent\/gnomon/);
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r, "--bin", "/nonexistent/gnomon"])).toBe(10);
    expect(existsSync(join(r, ".claude"))).toBe(false);
    // An older gnomon without `guard` is refused the same way (the 2026-11-12 "oldbin" arm).
    const old = join(r, "old-gnomon");
    writeFileSync(old, "#!/bin/sh\necho 'Unknown command: guard' >&2\nexit 1\n", { mode: 0o755 });
    if (process.platform !== "win32") expect(await cmdGuard(["install", "cursor", "--write", "--dir", r, "--bin", old])).toBe(10);
    expect(existsSync(join(r, ".cursor"))).toBe(false);
  });

  it("writes the resolved path into every hook, and brings an older install up to date in place", async () => {
    const r = governedRepo();
    mkdirSync(join(r, ".claude"));
    // What an older gnomon wrote: bare `gnomon`, and a matcher without MCP, WebSearch or Agent.
    writeFileSync(
      join(r, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "gnomon check --hook session-start" }] }],
          PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|Grep|Glob", hooks: [{ type: "command", command: "gnomon guard --from claude-code --agent claude-code", timeout: 30 }] }],
          Stop: [{ hooks: [{ type: "command", command: "gnomon check --hook stop --agent claude-code", timeout: 900 }] }],
        },
      })
    );
    git("add", "-A");
    git("commit", "-qm", "old hooks");
    // An older gnomon's hook is `outdated`, a warning: an upgrade alone must not read as tampering.
    let st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "outdated", detail: expect.stringMatching(/older gnomon's PreToolUse matcher/) });
    expect(st.findings).toEqual([]);
    expect(st.warnings.join("\n")).toMatch(/claude-code: outdated/);
    expect(await statusCode(r)).toBe(0);
    const card = JSON.parse((await check({ scorecard: "true" })).out) as Scorecard;
    expect(card.findings).toEqual([]);
    expect(card.warnings.join("\n")).toMatch(/claude-code: outdated/);
    // The same matcher with the guard's matcher widened by hand is not gnomon's: modified.
    const settings = readFileSync(join(r, ".claude/settings.json"), "utf-8");
    writeFileSync(join(r, ".claude/settings.json"), settings.replace("Read|WebFetch|Grep|Glob", "Read|Grep"));
    expect((await status(r)).hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "modified" });
    writeFileSync(join(r, ".claude/settings.json"), settings);
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    // Updated by install and not committed yet: still outdated (HEAD holds the older hook), not modified.
    st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "outdated", detail: expect.stringMatching(/commit the file/) });
    expect(await statusCode(r)).toBe(0);
    const s = JSON.parse(readFileSync(join(r, ".claude/settings.json"), "utf-8"));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe(CLAUDE_CODE_MATCHER);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(shellCommand([LAUNCHER], "guard --from claude-code --agent claude-code"));
    expect(s.hooks.Stop[0].hooks[0].command).toBe(shellCommand([LAUNCHER], "check --hook stop --agent claude-code"));
    git("add", "-A");
    git("commit", "-qm", "hooks");
    st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "ok" });

    // A hook whose program is not there lets the host run every call unguarded: a finding.
    for (const host of ["opencode", "cursor"]) expect(await cmdGuard(["install", host, "--write", "--dir", r])).toBe(0);
    const text = readFileSync(join(r, ".claude/settings.json"), "utf-8").split(LAUNCHER).join("/nonexistent/gnomon");
    writeFileSync(join(r, ".claude/settings.json"), text);
    git("add", "-A");
    git("commit", "-qm", "broken program");
    st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "modified", detail: expect.stringMatching(/does not exist/) });
    expect(st.hosts.find((h) => h.host === "opencode")!.state).toBe("ok");
    expect(st.hosts.find((h) => h.host === "cursor")!.state).toBe("ok");
  }, 120_000);

  it("reads a gnomon command whatever program runs it", () => {
    expect(gnomonTail("gnomon guard --from claude-code --agent claude-code")).toBe("guard --from claude-code --agent claude-code");
    expect(gnomonTail("'/opt/my tools/node' '/x/bin/gnomon.mjs' check --hook session-start")).toBe("check --hook session-start");
    expect(gnomonTail("/bin/true guard --from claude-code --agent claude-code")).toBeNull();
    expect(gnomonTail("echo hi")).toBeNull();
    expect(shellCommand(["/a b/gnomon"], "guard")).toBe(process.platform === "win32" ? `"/a b/gnomon" guard` : `'/a b/gnomon' guard`);
  });

  it("says when the path is this machine's: under $HOME, or under a versioned (nvm) directory", () => {
    const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
    const j = (...p: string[]) => (process.platform === "win32" ? p.join("\\") : p.join("/"));
    expect(machineSpecific([j(home, ".nvm/versions/node/v22.22.2/bin/node"), j(home, "src/gnomon/gnomon.js")], home)).toMatch(
      /versioned directory \(v22\.22\.2\)[\s\S]*under your home directory/
    );
    expect(machineSpecific([j(home, "bin/gnomon")], home)).toMatch(/under your home directory/);
    if (process.platform !== "win32") {
      expect(machineSpecific(["/usr/local/bin/gnomon"], home)).toBeNull();
      expect(machineSpecific(["/home/user2/bin/gnomon"], home)).toBeNull();
    }
    expect(machineSpecific(["gnomon"], home)).toBeNull();
  });

  it("--local keeps the hook out of git: Claude Code's settings.local.json, or .git/info/exclude; status follows it", async () => {
    const r = governedRepo();
    expect(await cmdGuard(["install", "claude-code", "--write", "--local", "--dir", r])).toBe(0);
    expect(existsSync(join(r, ".claude/settings.json"))).toBe(false);
    const local = JSON.parse(readFileSync(join(r, ".claude/settings.local.json"), "utf-8"));
    expect(local.hooks.PreToolUse[0].matcher).toBe(CLAUDE_CODE_MATCHER);
    expect(await cmdGuard(["install", "opencode", "--write", "--local", "--dir", r])).toBe(0);
    // Neither shows up as something to commit.
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(readFileSync(join(r, ".git/info/exclude"), "utf-8")).toMatch(/^\/\.opencode\/plugins\/gnomon-guard\.js$/m);
    let st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "ok", file: expect.stringMatching(/settings\.local\.json$/) });
    expect(st.hosts.find((h) => h.host === "opencode")!.state).toBe("ok");
    // A local hook is still watched: removing it is a finding.
    rmSync(join(r, ".claude/settings.local.json"));
    st = await status(r);
    expect(st.hosts.find((h) => h.host === "claude-code")).toMatchObject({ state: "missing", file: expect.stringMatching(/settings\.local\.json$/) });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

describe("liveness: which host sessions reached the guard", () => {
  it("guard status lists the sessions seen and the last decision; a started session the guard never saw is listed", async () => {
    const r = governedRepo();
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    let st = await status(r);
    expect([st.sessions_seen, st.last_decision]).toEqual([0, null]);
    // Claude Code's SessionStart hook for two sessions; only one reaches the guard.
    for (const id of ["live-1", "dead-1"]) {
      expect(await cmdCheck({ flags: { hook: "session-start" } }, () => {}, () => JSON.stringify({ session_id: id, cwd: r }))).toBe(0);
    }
    expect(cc("live-1", "Read", { file_path: join(r, "src/a.ts") })).toBe("allow");
    st = await status(r);
    expect(st.sessions_seen).toBe(1);
    expect(st.sessions[0]).toMatchObject({ id: "live-1", via: "claude-code", agent: "claude-code", kind: "session_start" });
    expect(st.last_decision).toBe(st.sessions[0]!.last_decision);
    expect(st.unguarded_sessions.map((u) => u.session)).toEqual(["dead-1"]);
    const record = JSON.parse(readFileSync(liveRecord("live-1.json"), "utf-8"));
    expect(conforms(record, FEED.definitions.liveness_record)).toEqual([]);
  }, 60_000);

  it("gnomon check warns of a session whose transcript has calls the guard never saw; --require-guard fails it", async () => {
    const r = governedRepo();
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    expect(cc("live-2", "Read", { file_path: join(r, "src/a.ts") })).toBe("allow");
    const dead = transcript(join(r, "..", `t-${Date.now()}`, "dead-2.jsonl"), "dead-2", ["Bash", "TodoWrite", "Edit"]);
    const live = transcript(join(dirname(dead), "live-2.jsonl"), "live-2", ["Read"]);
    let res = await check({ base: "HEAD", transcript: dead, format: "claude-code" });
    const verdict = JSON.parse(res.out);
    expect(verdict.warnings.join("\n")).toMatch(/session dead-2 made 2 call\(s\) the guard hook selects/);
    expect(res.code).not.toBe(2);
    res = await check({ base: "HEAD", transcript: dead, format: "claude-code", "require-guard": "true" });
    expect(res.code).toBe(2);
    res = await check({ base: "HEAD", transcript: live, format: "claude-code", "require-guard": "true" });
    expect(res.code).not.toBe(2);
    expect(JSON.parse(res.out).warnings ?? []).not.toContainEqual(expect.stringMatching(/liveness/));
    rmSync(dirname(dead), { recursive: true, force: true });
  }, 120_000);
});

/** A liveness record, wherever gnomon's per-repository state put it (under the test's XDG_DATA_HOME). */
function liveRecord(name: string): string {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name && p.includes(join("guard", "live"))) hits.push(p);
    }
  };
  walk(process.env.XDG_DATA_HOME!);
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

describe("gnomon check --scorecard", () => {
  it("summarises the guard's decisions, coverage, liveness, the hash chains and the checks — and fits the published schema", async () => {
    const r = governedRepo(`\n[audit]\nenabled = true\n`);
    // [audit] lives in config.toml.
    writeFileSync(join(r, ".gnomon/config.toml"), `${readFileSync(join(r, ".gnomon/config.toml"), "utf-8")}\n[audit]\nenabled = true\n`);
    git("add", "-A");
    git("commit", "-qm", "audit on");
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    git("add", ".claude");
    git("commit", "-qm", "hooks");
    expect(cc("run-1", "Bash", { command: "git push --force origin main" })).toBe("deny");
    expect(cc("run-1", "Write", { file_path: join(r, "src/n.ts"), content: "x" })).toBe("ask");
    expect(cc("run-1", "Read", { file_path: join(r, "src/a.ts") })).toBe("allow");
    expect(cc("run-1", "mcp__github__create_issue", { title: "t" })).toBe("allow");
    expect(cc("run-1", "Agent", { description: "d", prompt: "p" })).toBe("allow");
    // A recorded check verdict on a change, for the card to read back.
    writeFileSync(join(r, "src/a.ts"), "new\n");
    const judged = await check({ base: "HEAD", agent: "claude-code" });
    expect(JSON.parse(judged.out).audit).toBeDefined();

    let res = await check({ scorecard: "true" });
    const card = JSON.parse(res.out) as Scorecard;
    expect(conforms(card, FEED.definitions.scorecard)).toEqual([]);
    expect(card.decisions).toMatchObject({ total: 5, by_decision: { deny: 1, ask: 1, allow: 3 } });
    // No [governance] here: each decision counts under its rule's family.
    expect(card.decisions.by_family).toEqual({ bash: { deny: 1 }, write: { ask: 1 }, none: { allow: 1 }, ungoverned: { allow: 2 } });
    expect(card.decisions.by_via).toEqual({ "claude-code": 5 });
    const mcp = card.coverage.tools.find((t) => t.tool === "mcp__github__create_issue")!;
    expect(mcp).toEqual({ tool: "mcp__github__create_issue", kind: "mcp__github__create_issue", calls: 1, governed: false });
    expect(card.coverage.tools.find((t) => t.tool === "Bash")).toMatchObject({ kind: "bash", governed: true });
    expect([card.coverage.calls, card.coverage.governed_calls, card.coverage.ratio]).toEqual([5, 3, 0.6]);
    expect(card.liveness.sessions_seen).toBe(1);
    expect(card.audit.chain_ok).toBe(true);
    expect(card.audit.trails.some((t) => t.kind === "guard" && t.ok && t.sealed)).toBe(true);
    expect(card.checks.recent.length).toBeGreaterThan(0);
    expect(card.warnings.join("\n")).toMatch(/no gnomon rule governs \(mcp__github__create_issue\)/);
    expect({ findings: card.findings, exit: card.exit, code: res.code }).toEqual({ findings: [], exit: 0, code: 0 });

    // Every record in the guard trail is the published feed.
    const dir = card.audit.dir!;
    for (const f of readdirSync(dir).filter((x) => x.startsWith("guard-"))) {
      for (const line of readFileSync(join(dir, f), "utf-8").trim().split("\n")) {
        const rec = JSON.parse(line);
        const def = { session_start: "guard_session_start", session_resume: "guard_session_resume", guard: "guard_decision", session_end: "guard_session_end" }[rec.kind as string]!;
        expect({ kind: rec.kind, errors: conforms(rec, FEED.definitions[def]) }).toEqual({ kind: rec.kind, errors: [] });
      }
    }

    // markdown, for a person or a PR comment
    res = await check({ scorecard: "true" }, false);
    expect(res.out).toMatch(/^# gnomon scorecard/);
    for (const h of ["## Guard decisions", "## Coverage", "## Liveness", "## Audit trail", "## gnomon check"]) expect(res.out).toContain(h);

    // A record rewritten after the fact: the chain no longer holds, and the card fails.
    const trail = join(dir, "guard-run-1.jsonl");
    writeFileSync(trail, readFileSync(trail, "utf-8").replace('"decision":"deny"', '"decision":"allow"'));
    res = await check({ scorecard: "true" });
    const broken = JSON.parse(res.out) as Scorecard;
    expect([broken.audit.chain_ok, broken.exit, res.code]).toEqual([false, 2, 2]);
    expect(broken.findings.join("\n")).toMatch(/guard-run-1\.jsonl: the hash chain does not hold/);
  }, 180_000);

  it("finds a Claude Code session whose transcript shows calls the guard never decided", async () => {
    const r = governedRepo();
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    expect(await cmdCheck({ flags: { hook: "session-start" } }, () => {}, () => JSON.stringify({ session_id: "ghost", cwd: r }))).toBe(0);
    const cfg = mkdtempSync(join(tmpdir(), "gnomon-claude-cfg-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      transcript(join(cfg, "projects", "-tmp-x", "ghost.jsonl"), "ghost", ["Bash", "Bash"]);
      const res = await check({ scorecard: "true" });
      const card = JSON.parse(res.out) as Scorecard;
      expect(card.liveness.unguarded_sessions.map((u) => u.session)).toEqual(["ghost"]);
      expect(card.findings.join("\n")).toMatch(/session ghost: its transcript has 2 call\(s\) the guard hook selects/);
      expect(res.code).toBe(2);
      // limited to one session, with the transcript given
      const one = JSON.parse((await check({ scorecard: "true", session: "ghost", transcript: join(cfg, "projects", "-tmp-x", "ghost.jsonl") })).out) as Scorecard;
      expect(one.coverage.transcript).toMatchObject({ session: "ghost", selected: 2, guard_seen: false, gap: true });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      rmSync(cfg, { recursive: true, force: true });
    }
  }, 60_000);

  it("--require-guard: a card with no evidence the guard ran fails (a fresh clone with the hooks committed passes without it)", async () => {
    const r = governedRepo();
    // No hook at all.
    let res = await check({ scorecard: "true", "require-guard": "true" });
    expect(res.code).toBe(2);
    expect((JSON.parse(res.out) as Scorecard).findings.join("\n")).toMatch(/no guard hook is installed or committed/);
    // Hooks committed, nothing decided: what a CI checkout sees.
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", r])).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "hooks");
    res = await check({ scorecard: "true" });
    let card = JSON.parse(res.out) as Scorecard;
    expect([res.code, card.findings]).toEqual([0, []]);
    expect(card.warnings.join("\n")).toMatch(/has not decided a single call[\s\S]*fresh clone or CI checkout/);
    res = await check({ scorecard: "true", "require-guard": "true" });
    card = JSON.parse(res.out) as Scorecard;
    expect(res.code).toBe(2);
    expect(card.findings.join("\n")).toMatch(/has not decided a single call/);
    // A named session the guard never saw fails too; once it decides, the card passes.
    res = await check({ scorecard: "true", "require-guard": "true", session: "s-1" });
    expect(res.code).toBe(2);
    expect(cc("s-1", "Read", { file_path: join(r, "src/a.ts") })).toBe("allow");
    res = await check({ scorecard: "true", "require-guard": "true", session: "s-1" });
    expect([res.code, (JSON.parse(res.out) as Scorecard).findings]).toEqual([0, []]);
    expect((await check({ scorecard: "true", "require-guard": "true" })).code).toBe(0);
  }, 60_000);

  it("is exit 10 where no .gnomon/ governs", async () => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-scorecard-plain-")));
    git("init", "-q");
    const res = await check({ scorecard: "true" });
    expect(res.code).toBe(10);
    expect((JSON.parse(res.out) as Scorecard).governed).toBe(false);
  });
});
