/**
 * gnomon-core: External anchoring of sealed trail heads — `[audit.anchor]`
 *
 * WHY THIS EXISTS. A hash chain proves a trail is internally consistent and
 * nothing more: rewrite one record, recompute every hash after it, and
 * `verifyTrail` passes. That is the ninth of nine attacks in
 * benchmarks/results/auditability-2026-08-31, the one published as undetected.
 * `[audit.attest]` signs heads, but its heads sit beside the trail and a
 * key-file signer signs for anyone on the machine (attest.ts, limits 1 and 2).
 *
 * The fix both of those point at is a copy of the head somewhere the writer of
 * the trail cannot rewrite. This module puts one there. When a trail is sealed
 * (`session_end`, which includes every checkpoint), a STATEMENT naming the
 * trail, the sealed head's seq and hash and the record count is queued, and
 * delivered asynchronously to a witness:
 *
 *   git      a commit on a ref pushed to a remote, fast-forward only. The
 *            remote refusing non-fast-forward pushes and deletions is what
 *            makes it append-only; gnomon cannot make it so and says so.
 *   rfc3161  a signed time-stamp token from a time-stamp authority, verified
 *            offline against a pinned certificate (rfc3161.ts).
 *   cmd      an operator command: the digest on stdin, a receipt on stdout,
 *            and an optional verify command. For witnesses gnomon does not
 *            speak natively (a transparency log, an object-locked bucket).
 *
 * Only the statement leaves the machine: a path, two numbers, a hash and a
 * time. The rfc3161 backend sends only its sha256.
 *
 * WHAT THE TURN PAYS: nothing. Enqueueing is one small file write at seal, and
 * delivery runs after the checkpoint at session end, in the background (the
 * CLI starts a detached `gnomon audit anchor --background`). A slow or absent
 * witness never delays a turn or a seal.
 *
 * WHEN IT CANNOT DELIVER: the statements stay queued, and the next session
 * announces and records it (degradation `audit_anchor_queued`). `gnomon audit
 * verify` lists them as PENDING. Never silent, never fatal: a trail that
 * stopped recording because the network was down would lose the records worth
 * having.
 *
 * WHAT IT DOES NOT CLOSE. Read this before believing anything above.
 *   1. Records before the seal. Anchoring is at seal; an unsealed trail (a
 *      killed run) has no anchor. Within a session the record guard is what
 *      watches the trail.
 *   2. The rfc3161 and cmd receipts live on this machine. A token proves WHEN a
 *      head existed; it does not stop someone deleting the token and having
 *      the rewritten head time-stamped afresh. Against an attacker who knows
 *      about anchoring, only a witness that keeps its own copy (the git
 *      remote, or a cmd witness whose verify command asks the witness) holds.
 *   3. The git remote's append-only property is the remote's configuration
 *      (receive.denyNonFastForwards and receive.denyDeletes, or a protected
 *      branch). gnomon pushes without force and notices a rewritten history
 *      it has seen before, but whoever can force-push the remote can erase
 *      anchors this machine never fetched.
 *   4. Time. A git anchor's time is the committer date this machine wrote; an
 *      rfc3161 anchor's is the authority's clock. Only the second is evidence
 *      against a skewed local clock. Order in the remote's history is evidence
 *      of sequence either way.
 *   5. NOT VERIFIED here: a public time-stamp authority, GitHub or any hosted
 *      remote, and Rekor. The tests use a local bare repository, an
 *      in-process fake authority, and one token produced by OpenSSL's TSA.
 *
 * A NOTE ON THE IMPORT CYCLE with audit.ts: deliberate, and safe for the
 * reason attest.ts gives -- a statement must hash records with the trail's own
 * canonicaliser, and neither module touches the other at evaluation time.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { canonicalJson, recordHash, type AuditRecord } from "./audit.js";
import type { GnomonConfig } from "./config.js";
import { recordDegradation, type DegradationSink } from "./degradation.js";
import { parseTimeStampResponse, timeStampRequest, verifyTimeStampToken } from "./rfc3161.js";
import { posixShell, NO_POSIX_SHELL } from "./tools.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const ANCHOR_BACKENDS = ["git", "rfc3161", "cmd"] as const;
export type AnchorBackend = (typeof ANCHOR_BACKENDS)[number];

/** The statement format, versioned. A third party recomputes digests from it. */
export const ANCHOR_FORMAT = "gnomon.anchor/1";

const DEFAULT_REF = "refs/heads/gnomon-anchors";
const DEFAULT_TIMEOUT_SEC = 10;
/** Receipt (cmd stdout) bound, for the reason attest.ts bounds signatures. */
const MAX_RECEIPT_BYTES = 8192;
/** A queue older than this with no delivery is announced even with no recorded failure. */
export const ANCHOR_GRACE_SEC = 120;

/** config.toml [audit.anchor] */
export interface AnchorConfig {
  /** git | rfc3161 | cmd. Declaring it is what turns anchoring on. */
  backend?: string;
  /** git: a remote URL or path, or the name of a remote of this repository. */
  remote?: string;
  /** git: the ref anchors are committed to. Default refs/heads/gnomon-anchors. */
  ref?: string;
  /** rfc3161: the time-stamp authority's URL. */
  url?: string;
  /** rfc3161: PEM certificate(s) or public key of the authority, inline or a path. */
  tsa_cert?: string;
  /** cmd: digest on stdin, receipt on stdout. */
  command?: string;
  /** cmd: digest on stdin, receipt in GNOMON_ANCHOR_RECEIPT; exit 0 = valid. */
  verify?: string;
  timeout_sec?: number;
  /** Where the queue and receipts live. Default: an `anchors/` directory in the audit directory. */
  dir?: string;
}

export interface ResolvedAnchor {
  /** Anchoring is on: a backend is declared and has what it needs. */
  enabled: boolean;
  /** An `[audit.anchor]` block is present, usable or not. */
  declared: boolean;
  backend: AnchorBackend | null;
  /** The workspace root (the parent of `.gnomon/`). */
  root: string;
  dir: string;
  /**
   * Which checkout's trails a statement is about. Opaque: sha256 of the host
   * name and the root's real path, 16 hex. Lets several checkouts share one
   * witness without one's trails reading as the other's missing ones.
   */
  scope: string;
  remote: string | null;
  ref: string;
  url: string | null;
  /** PEM text, read from disk if a path was declared. */
  tsa_cert: string | null;
  command: string | null;
  verify: string | null;
  timeout_sec: number;
  /** Declared settings that will not work, reported rather than swallowed. */
  problems: string[];
}

function scopeOf(root: string): string {
  let real = resolve(root);
  try {
    real = realpathSync(root);
  } catch {
    /* not there yet: the resolved path names it */
  }
  return createHash("sha256").update(`gnomon.anchor.scope\0${hostname()}\0${real}`).digest("hex").slice(0, 16);
}

/**
 * Resolve [audit.anchor]. `auditDir` is the resolved trail directory.
 *
 * Absent block: pure string work, no file read, no host lookup, nothing
 * enabled. That is the "absent means exactly the current behaviour" promise.
 */
export function resolveAnchor(config: GnomonConfig, auditDir: string): ResolvedAnchor {
  const audit = ((config.config as { audit?: { anchor?: AnchorConfig } }).audit ?? {}) as { anchor?: AnchorConfig };
  const declared = Object.prototype.hasOwnProperty.call(audit, "anchor");
  const root = resolve(config.gnomonDir, "..");
  const off: ResolvedAnchor = {
    enabled: false,
    declared,
    backend: null,
    root,
    dir: join(auditDir, "anchors"),
    scope: "",
    remote: null,
    ref: DEFAULT_REF,
    url: null,
    tsa_cert: null,
    command: null,
    verify: null,
    timeout_sec: DEFAULT_TIMEOUT_SEC,
    problems: [],
  };
  if (!declared) return off;

  const a = audit.anchor ?? {};
  const problems: string[] = [];
  // A surface whose grants this machine's user has not accepted runs clamped
  // (trust.ts), and anchoring is a grant: it pushes, posts or runs a command
  // unasked. Declared still, so the anchors directory keeps its place.
  if ((a as { untrusted?: unknown }).untrusted === true) {
    return {
      ...off,
      dir: typeof a.dir === "string" && a.dir.trim() ? (isAbsolute(a.dir.trim()) ? a.dir.trim() : join(root, a.dir.trim())) : off.dir,
      problems: [
        "[audit.anchor] is a grant this machine's user has not accepted (`gnomon trust`), so this session anchors nothing and queues nothing.",
      ],
    };
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const atRoot = (p: string) => (isAbsolute(p) ? p : join(root, p));

  const raw = str(a.backend);
  let backend: AnchorBackend | null = null;
  if (!raw) {
    problems.push(`[audit.anchor] is declared but has no \`backend\` — nothing is anchored. Set backend = ${ANCHOR_BACKENDS.map((b) => `"${b}"`).join(" | ")}.`);
  } else if ((ANCHOR_BACKENDS as readonly string[]).includes(raw)) {
    backend = raw as AnchorBackend;
  } else {
    problems.push(`[audit.anchor] backend "${raw}" is not one of ${ANCHOR_BACKENDS.join(", ")} — nothing is anchored.`);
  }

  let remote = str(a.remote);
  if (remote?.startsWith("-")) {
    // `git ls-remote --upload-pack=…` would be an option, not a remote.
    problems.push(`[audit.anchor] remote "${remote}" starts with "-" — refused.`);
    remote = null;
  }
  const ref = str(a.ref) ?? DEFAULT_REF;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    problems.push(`[audit.anchor] ref "${ref}" is not a full ref name like ${DEFAULT_REF} — nothing is anchored.`);
    backend = backend === "git" ? null : backend;
  }
  const url = str(a.url);
  const command = str(a.command);
  const verify = str(a.verify);

  let tsa_cert: string | null = null;
  const declaredCert = str(a.tsa_cert);
  if (declaredCert) {
    if (declaredCert.includes("-----BEGIN")) tsa_cert = declaredCert;
    else {
      try {
        tsa_cert = readFileSync(atRoot(declaredCert), "utf-8");
      } catch {
        problems.push(`[audit.anchor] tsa_cert is neither PEM nor a readable file: ${declaredCert} — tokens are fetched but cannot be checked`);
      }
      if (tsa_cert !== null && !tsa_cert.includes("-----BEGIN")) {
        problems.push(`[audit.anchor] tsa_cert file holds no PEM block: ${declaredCert}`);
        tsa_cert = null;
      }
    }
  }

  // Measured while writing the tests: a forced push to refs/gnomon/anchors on
  // a bare remote with receive.denyNonFastForwards AND receive.denyDeletes set
  // was ACCEPTED. git's receive-pack applies both to refs/heads/* only, and so
  // do hosted branch protections. A ref outside it is append-only only if the
  // remote has a hook or a rule of its own for it.
  if (backend === "git" && !ref.startsWith("refs/heads/")) {
    problems.push(
      `[audit.anchor] ref "${ref}" is outside refs/heads/, where git's receive.denyNonFastForwards and receive.denyDeletes do not apply — the remote can be force-pushed unless a hook or rule protects this ref.`
    );
  }
  if (backend === "git" && !remote) {
    problems.push("[audit.anchor] backend = \"git\" needs `remote` (a URL, a path, or the name of a remote of this repository) — nothing is anchored.");
    backend = null;
  }
  if (backend === "rfc3161") {
    if (!url || !/^https?:\/\//i.test(url)) {
      problems.push("[audit.anchor] backend = \"rfc3161\" needs `url`, the authority's http(s) address — nothing is anchored.");
      backend = null;
    } else if (!tsa_cert) {
      problems.push("[audit.anchor] backend = \"rfc3161\" has no `tsa_cert`, so tokens are kept but `gnomon audit verify` cannot check who signed them.");
    }
  }
  if (backend === "cmd" && !command) {
    problems.push("[audit.anchor] backend = \"cmd\" needs `command` — nothing is anchored.");
    backend = null;
  }

  let timeout_sec = DEFAULT_TIMEOUT_SEC;
  if (a.timeout_sec !== undefined) {
    const n = Number(a.timeout_sec);
    if (!Number.isFinite(n) || n <= 0) problems.push(`[audit.anchor] timeout_sec must be a positive number, got "${String(a.timeout_sec)}" — using ${DEFAULT_TIMEOUT_SEC}`);
    else timeout_sec = n;
  }

  const declaredDir = str(a.dir);
  return {
    enabled: backend !== null,
    declared,
    backend,
    root,
    dir: declaredDir ? atRoot(declaredDir) : off.dir,
    scope: scopeOf(root),
    remote,
    ref,
    url,
    tsa_cert,
    command,
    verify,
    timeout_sec,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** What is anchored: one sealed head. Published format `gnomon.anchor/1`. */
export interface AnchorStatement {
  anchor: typeof ANCHOR_FORMAT;
  /** ResolvedAnchor.scope of the checkout that wrote the trail. */
  scope: string;
  /** The trail, relative to the workspace root, POSIX separators; absolute when outside it. */
  trail: string;
  /** seq of the sealing record. */
  seq: number;
  /** Its chain hash. */
  hash: string;
  /** Records in the trail at seal. */
  records: number;
  /** The sealing record's own `ts`. */
  sealed_at: string;
}

/** sha256 over the canonical JSON of the statement: what a witness holds or signs. */
export function statementDigest(s: AnchorStatement): string {
  return createHash("sha256").update(canonicalJson(s)).digest("hex");
}

/** A trail's name in a statement. */
export function trailName(root: string, trailPath: string): string {
  const rel = relative(root, resolve(trailPath));
  return rel.startsWith("..") || isAbsolute(rel) ? resolve(trailPath) : rel.split(sep).join("/");
}

export function statementFor(
  settings: ResolvedAnchor,
  trailPath: string,
  sealing: AuditRecord,
  records: number
): AnchorStatement {
  return {
    anchor: ANCHOR_FORMAT,
    scope: settings.scope,
    trail: trailName(settings.root, trailPath),
    seq: sealing.seq,
    hash: String(sealing.hash),
    records,
    sealed_at: sealing.ts,
  };
}

// ---------------------------------------------------------------------------
// The queue: one file per statement, so an append never races a flush
// ---------------------------------------------------------------------------

interface QueueEntry {
  statement: AnchorStatement;
  digest: string;
  queued_at: string;
}

const queueDir = (s: ResolvedAnchor) => join(s.dir, "queue");
const receiptsFile = (s: ResolvedAnchor) => join(s.dir, "receipts.jsonl");
const stateFile = (s: ResolvedAnchor) => join(s.dir, "state.json");

/**
 * Queue a sealed head. The only anchoring work on the seal path: one small
 * file. Delivery is `flushAnchors`, run later and elsewhere.
 */
export function enqueueAnchor(settings: ResolvedAnchor, trailPath: string, sealing: AuditRecord, records: number): string {
  const statement = statementFor(settings, trailPath, sealing, records);
  const digest = statementDigest(statement);
  const dir = queueDir(settings);
  mkdirSync(dir, { recursive: true });
  const entry: QueueEntry = { statement, digest, queued_at: new Date().toISOString() };
  // Written beside, then renamed: a flusher reading the directory never sees
  // half a file.
  const tmp = join(dir, `.${digest}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(entry)}\n`, "utf-8");
  renameSync(tmp, join(dir, `${digest}.json`));
  return digest;
}

function readQueue(s: ResolvedAnchor): Array<{ file: string; entry: QueueEntry }> {
  let names: string[];
  try {
    names = readdirSync(queueDir(s));
  } catch {
    return [];
  }
  const out: Array<{ file: string; entry: QueueEntry }> = [];
  for (const n of names.filter((x) => /^[0-9a-f]{64}\.json$/.test(x)).sort()) {
    const file = join(queueDir(s), n);
    try {
      const entry = JSON.parse(readFileSync(file, "utf-8")) as QueueEntry;
      // A queue file whose name is not its statement's digest was not written
      // by enqueueAnchor; it is skipped rather than delivered.
      if (entry?.statement && statementDigest(entry.statement) === entry.digest && `${entry.digest}.json` === n) {
        out.push({ file, entry });
      }
    } catch {
      /* half-written or foreign: skipped */
    }
  }
  return out.sort((a, b) => (a.entry.queued_at < b.entry.queued_at ? -1 : a.entry.queued_at > b.entry.queued_at ? 1 : 0));
}

/** Queued statements, oldest first. */
export function pendingAnchors(settings: ResolvedAnchor): QueueEntry[] {
  return settings.declared ? readQueue(settings).map((q) => q.entry) : [];
}

interface AnchorState {
  last_attempt?: string;
  last_success?: string;
  last_error?: string | null;
  failures?: number;
  /** git: the remote tip the last verification saw, to notice a rewritten history. */
  remote_tip?: string;
}

function readState(s: ResolvedAnchor): AnchorState {
  try {
    return JSON.parse(readFileSync(stateFile(s), "utf-8")) as AnchorState;
  } catch {
    return {};
  }
}

function writeState(s: ResolvedAnchor, patch: AnchorState): void {
  mkdirSync(s.dir, { recursive: true });
  const next = { ...readState(s), ...patch };
  const tmp = `${stateFile(s)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  renameSync(tmp, stateFile(s));
}

// ---------------------------------------------------------------------------
// Running things: git and declared commands, asynchronously
// ---------------------------------------------------------------------------

interface Ran {
  code: number;
  out: string;
  err: string;
}

function runProcess(
  file: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutSec: number }
): Promise<Ran> {
  return new Promise((done) => {
    // Bytes, decoded once at the end: a chunk boundary inside a multi-byte
    // character would otherwise corrupt it, and `cat-file --batch` sizes are
    // byte counts.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const text = (b: Buffer[]) => Buffer.concat(b).toString("utf-8");
    const finish = (code: number, extra = "") => {
      if (!settled) {
        settled = true;
        done({ code, out: text(out), err: `${text(err)}${extra}` });
      }
    };
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish(127, (e as Error).message);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, `\ntimed out after ${opts.timeoutSec}s`);
    }, opts.timeoutSec * 1000);
    child.stdout.on("data", (b: Buffer) => {
      if (outBytes < 64 * 1024 * 1024) {
        out.push(b);
        outBytes += b.length;
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errBytes < 64 * 1024) {
        err.push(b);
        errBytes += b.length;
      }
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(e.code === "ENOENT" ? 127 : 1, e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
    child.stdin.on("error", () => {
      /* a command that exits without reading stdin is not an error here */
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** A declared command, `bash -lc`, values in the environment (attest.ts's rule). */
function runDeclared(cmd: string, input: string, env: Record<string, string>, timeoutSec: number, cwd: string): Promise<Ran> {
  const shell = process.platform === "win32" ? posixShell() : "bash";
  if (shell === null) return Promise.resolve({ code: 127, out: "", err: NO_POSIX_SHELL });
  return runProcess(shell, ["-lc", cmd], { input, env: { ...process.env, ...env }, timeoutSec, cwd });
}

function gitEnv(now: Date): NodeJS.ProcessEnv {
  const iso = now.toISOString();
  return {
    ...process.env,
    // Nothing may prompt: this runs in the background with no terminal.
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    // A fixed identity: the commit is the anchor's envelope, not authorship,
    // and a machine with no user.name must still be able to anchor.
    GIT_AUTHOR_NAME: "gnomon anchor",
    GIT_AUTHOR_EMAIL: "anchor@gnomon.invalid",
    GIT_COMMITTER_NAME: "gnomon anchor",
    GIT_COMMITTER_EMAIL: "anchor@gnomon.invalid",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  };
}

async function git(repo: string, args: string[], s: ResolvedAnchor, now: Date, input?: string): Promise<Ran> {
  return runProcess(
    "git",
    // No hooks: a pre-push hook from a global core.hooksPath would run, and
    // could wait on a terminal nobody is at. No `ext::` transport: a remote
    // must not be a way to run a command.
    ["-c", `core.hooksPath=${join(repo, "no-hooks")}`, "-c", "protocol.ext.allow=never", "--git-dir", repo, ...args],
    { input, env: gitEnv(now), timeoutSec: s.timeout_sec }
  );
}

/** A remote URL or path with any credentials stripped, for receipts and messages. */
export function redactRemote(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

/**
 * What `remote` names. A bare word is the name of a remote of the workspace's
 * own repository, read from it; a relative path is relative to the root;
 * anything else (a URL, `host:path`, an absolute path) is used as it is.
 */
async function remoteTarget(s: ResolvedAnchor, now: Date): Promise<string> {
  const r = s.remote!;
  if (/^[A-Za-z0-9._-]+$/.test(r) && !existsSync(join(s.root, r))) {
    const got = await runProcess("git", ["-C", s.root, "remote", "get-url", r], { env: gitEnv(now), timeoutSec: s.timeout_sec });
    if (got.code !== 0) throw new Error(`"${r}" is not a remote of the repository at ${s.root}`);
    return got.out.trim();
  }
  if (isAbsolute(r) || /^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^[^/\\]+:/.test(r)) return r;
  return join(s.root, r);
}

async function ensureRepo(repo: string, s: ResolvedAnchor, now: Date): Promise<void> {
  if (existsSync(join(repo, "HEAD"))) return;
  mkdirSync(repo, { recursive: true });
  const r = await runProcess("git", ["init", "--bare", "-q", repo], { env: gitEnv(now), timeoutSec: s.timeout_sec });
  if (r.code !== 0) throw new Error(`could not create the local anchor repository: ${r.err.trim() || `exit ${r.code}`}`);
}

/** The remote's tip of the anchor ref: a sha, null when the ref does not exist yet. Throws when unreachable. */
async function remoteTip(repo: string, target: string, s: ResolvedAnchor, now: Date): Promise<string | null> {
  const r = await git(repo, ["ls-remote", target, s.ref], s, now);
  if (r.code !== 0) throw new Error(`remote ${redactRemote(target)} unreachable: ${firstLine(r.err) || `git exit ${r.code}`}`);
  for (const line of r.out.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === s.ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return null;
}

const firstLine = (t: string) => t.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface AnchorDeps {
  /** The rfc3161 transport. Tests pass a fake; nothing in a test reaches a network. */
  fetch?: typeof fetch;
  now?: () => Date;
}

type Delivered = Map<string, Record<string, unknown>>;

async function deliverGit(s: ResolvedAnchor, entries: QueueEntry[], now: Date): Promise<Delivered> {
  const repo = join(s.dir, "git");
  await ensureRepo(repo, s, now);
  const target = await remoteTarget(s, now);
  // One line per statement, canonical, so anyone holding the remote can
  // recompute every digest with nothing but sha256.
  const body = entries.map((e) => canonicalJson(e.statement)).join("\n") + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    const tip = await remoteTip(repo, target, s, now);
    if (tip) {
      const f = await git(repo, ["fetch", "-q", "--no-tags", target, `+${s.ref}:${s.ref}`], s, now);
      if (f.code !== 0) throw new Error(`fetch from ${redactRemote(target)} failed: ${firstLine(f.err)}`);
    }
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], s, now, body);
    if (blob.code !== 0) throw new Error(`git hash-object failed: ${firstLine(blob.err)}`);
    const tree = await git(repo, ["mktree"], s, now, `100644 blob ${blob.out.trim()}\tanchors.jsonl\n`);
    if (tree.code !== 0) throw new Error(`git mktree failed: ${firstLine(tree.err)}`);
    const message = `gnomon anchor: ${entries.length} sealed head(s)\n\n${entries.map((e) => `${e.digest} ${e.statement.trail}`).join("\n")}\n`;
    const commit = await git(repo, ["commit-tree", "--no-gpg-sign", tree.out.trim(), ...(tip ? ["-p", tip] : []), "-m", message], s, now);
    if (commit.code !== 0) throw new Error(`git commit-tree failed: ${firstLine(commit.err)}`);
    const sha = commit.out.trim();
    await git(repo, ["update-ref", s.ref, sha], s, now);
    // Never forced. A remote that moved since the tip was read rejects this,
    // and the loop rebuilds on top of what it holds now.
    const push = await git(repo, ["push", "-q", "--no-verify", target, `${sha}:${s.ref}`], s, now);
    if (push.code === 0) {
      const out: Delivered = new Map();
      for (const e of entries) out.set(e.digest, { remote: redactRemote(target), ref: s.ref, commit: sha });
      return out;
    }
    const why = firstLine(push.err) || `git exit ${push.code}`;
    if (attempt === 0 && /non-fast-forward|fetch first|rejected|stale info/i.test(push.err)) continue;
    throw new Error(`push to ${redactRemote(target)} refused: ${why}`);
  }
  throw new Error("push did not settle after a retry");
}

async function deliverTsa(s: ResolvedAnchor, entries: QueueEntry[], deps: AnchorDeps): Promise<{ delivered: Delivered; error?: string }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const delivered: Delivered = new Map();
  for (const e of entries) {
    const nonce = randomBytes(8);
    nonce[0] = (nonce[0]! & 0x7f) | 0x01;
    try {
      const res = await fetchFn(s.url!, {
        method: "POST",
        headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
        body: new Uint8Array(timeStampRequest(e.digest, nonce)),
        signal: AbortSignal.timeout(s.timeout_sec * 1000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const resp = parseTimeStampResponse(Buffer.from(await res.arrayBuffer()));
      if ((resp.status !== 0 && resp.status !== 1) || !resp.token) {
        throw new Error(`the authority refused (status ${resp.status}${resp.statusText ? `: ${resp.statusText}` : ""})`);
      }
      const check = verifyTimeStampToken(resp.token, { digestHex: e.digest, pinned: s.tsa_cert, nonce: nonce.toString("hex") });
      if (!check.valid) throw new Error(`the token does not verify: ${check.detail}`);
      delivered.set(e.digest, {
        url: s.url,
        token: resp.token.toString("base64"),
        gen_time: check.info!.gen_time,
        serial: check.info!.serial,
        policy: check.info!.policy,
        signature_checked: check.checked,
      });
    } catch (err) {
      return { delivered, error: `${redactRemote(s.url!)}: ${(err as Error).message}` };
    }
  }
  return { delivered };
}

function anchorEnv(e: QueueEntry): Record<string, string> {
  return {
    GNOMON_ANCHOR_DIGEST: e.digest,
    GNOMON_ANCHOR_STATEMENT: canonicalJson(e.statement),
    GNOMON_ANCHOR_TRAIL: e.statement.trail,
  };
}

async function deliverCmd(s: ResolvedAnchor, entries: QueueEntry[]): Promise<{ delivered: Delivered; error?: string }> {
  const delivered: Delivered = new Map();
  for (const e of entries) {
    const r = await runDeclared(s.command!, e.digest, anchorEnv(e), s.timeout_sec, s.root);
    const out = r.out.trim();
    if (r.code !== 0) return { delivered, error: `anchor command exit ${r.code}${r.err.trim() ? `: ${firstLine(r.err)}` : ""}` };
    if (Buffer.byteLength(out, "utf-8") > MAX_RECEIPT_BYTES) return { delivered, error: `anchor command output exceeds ${MAX_RECEIPT_BYTES} bytes — refused` };
    delivered.set(e.digest, { output: out });
  }
  return { delivered };
}

export interface FlushResult {
  backend: AnchorBackend | null;
  delivered: number;
  pending: number;
  /** Another flush holds the lock. */
  busy?: boolean;
  error?: string;
}

const LOCK = "flush.lock";

/**
 * Whether the process a lock names is gone. Only a pid on this host that
 * answers ESRCH counts: an unreadable or empty lock (one written
 * before locks carried a pid) and a live pid (EPERM included) are not "gone",
 * and fall back to the age rule.
 */
function holderGone(file: string): boolean {
  let pid: number;
  try {
    const held = JSON.parse(readFileSync(file, "utf-8")) as { pid?: unknown; host?: unknown };
    // Another machine's pid says nothing here (a shared or synced directory).
    if (held.host !== hostname()) return false;
    pid = Number(held.pid);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Take `flush.lock`. The lock names its holder's pid, so a lock whose holder
 * has died -- killed, or ended by `process.exit` before a `finally` ran -- is
 * taken over at once rather than after the age limit.
 *
 * Found by GBS-AUDIT 0.1 (benchmarks/results/gbs-2026-11-04/audit): in 22 of
 * 22 anchored sessions on the v0.4.1 release, `gnomon task` exited with this
 * file left behind and no delivery running, and `gnomon audit anchor`
 * answered "already running" for up to 120 s.
 */
function takeLock(s: ResolvedAnchor): boolean {
  const file = join(s.dir, LOCK);
  const staleAfterMs = Math.max(120, s.timeout_sec * 12) * 1000;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`, "utf-8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      try {
        if (holderGone(file) || Date.now() - statSync(file).mtimeMs > staleAfterMs) unlinkSync(file);
        else return false;
      } catch {
        /* gone between the two calls: try again */
      }
    }
  }
  return false;
}

/** Release `flush.lock` if this process holds it. Synchronous: it runs from an `exit` handler too. */
function releaseLock(s: ResolvedAnchor): void {
  const file = join(s.dir, LOCK);
  try {
    if (Number(JSON.parse(readFileSync(file, "utf-8")).pid) !== process.pid) return;
  } catch {
    return;
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Deliver every queued statement. Run in the background by the CLI, in the
 * foreground by `gnomon audit anchor`. A witness that cannot be reached does
 * not throw: the statements stay queued and the failure goes to state.json,
 * for the next session to announce. (A file system error in the anchors
 * directory itself does throw.)
 *
 * Statements queued while a delivery runs -- another session sealing -- are
 * picked up by a second round rather than left for the next session end.
 *
 * The lock is released on every way out: the `finally` below, and an `exit`
 * handler for a process that ends while the delivery is still awaiting. That
 * second path is the one the 0.4.1 release took on every anchored `gnomon
 * task`: with no launcher to start a detached delivery from, the flush ran
 * unawaited in-process, and the task's `process.exit` skipped the `finally`.
 * An unfinished delivery leaves its statements queued, for the next one.
 */
export async function flushAnchors(settings: ResolvedAnchor, deps: AnchorDeps = {}): Promise<FlushResult> {
  const backend = settings.backend;
  if (!settings.enabled || !backend) return { backend, delivered: 0, pending: pendingAnchors(settings).length };
  mkdirSync(settings.dir, { recursive: true });
  if (!takeLock(settings)) return { backend, delivered: 0, pending: readQueue(settings).length, busy: true };
  const onExit = (): void => releaseLock(settings);
  process.once("exit", onExit);
  try {
    let total = 0;
    for (let round = 0; ; round++) {
      const r = await flushRound(settings, backend, deps);
      total += r.delivered;
      if (r.error || r.pending > 0 || round >= 2 || readQueue(settings).length === 0) {
        return { ...r, delivered: total, pending: readQueue(settings).length };
      }
    }
  } finally {
    process.removeListener("exit", onExit);
    releaseLock(settings);
  }
}

async function flushRound(settings: ResolvedAnchor, backend: AnchorBackend, deps: AnchorDeps): Promise<FlushResult> {
  const now = (deps.now ?? (() => new Date()))();
  {
    const queued = readQueue(settings);
    if (queued.length === 0) return { backend, delivered: 0, pending: 0 };
    const entries = queued.map((q) => q.entry);
    let delivered: Delivered = new Map();
    let error: string | undefined;
    try {
      if (backend === "git") delivered = await deliverGit(settings, entries, now);
      else if (backend === "rfc3161") ({ delivered, error } = await deliverTsa(settings, entries, deps));
      else ({ delivered, error } = await deliverCmd(settings, entries));
    } catch (e) {
      error = (e as Error).message;
    }
    const at = new Date().toISOString();
    for (const q of queued) {
      const receipt = delivered.get(q.entry.digest);
      if (!receipt) continue;
      appendFileSync(
        receiptsFile(settings),
        `${JSON.stringify({ digest: q.entry.digest, backend, statement: q.entry.statement, queued_at: q.entry.queued_at, delivered_at: at, receipt })}\n`,
        "utf-8"
      );
      try {
        unlinkSync(q.file);
      } catch {
        /* removed already: the receipt is what counts */
      }
    }
    const failures = error ? (readState(settings).failures ?? 0) + 1 : 0;
    writeState(settings, {
      last_attempt: at,
      ...(delivered.size > 0 ? { last_success: at } : {}),
      last_error: error ?? null,
      failures,
    });
    return { backend, delivered: delivered.size, pending: queued.length - delivered.size, ...(error ? { error } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Scheduling: asynchronous, off the turn path
// ---------------------------------------------------------------------------

export type AnchorScheduler = (settings: ResolvedAnchor) => void;

/** In a library caller: deliver in this process, without awaiting. */
const inProcess: AnchorScheduler = (s) => {
  void flushAnchors(s).catch(() => {
    /* flushAnchors records its own failures; nothing else to do here */
  });
};
let scheduler: AnchorScheduler = inProcess;

/**
 * Who delivers. The CLI installs one that starts a detached `gnomon audit
 * anchor --background`, so a `gnomon task` that exits right after its
 * checkpoint does not take the delivery with it. Null restores the default.
 */
export function setAnchorScheduler(fn: AnchorScheduler | null): void {
  scheduler = fn ?? inProcess;
}

/** Start a delivery when something is queued. Never throws, never waits. */
export function scheduleAnchorFlush(settings: ResolvedAnchor | undefined): void {
  if (!settings?.enabled) return;
  try {
    if (readdirSync(queueDir(settings)).some((n) => n.endsWith(".json"))) scheduler(settings);
  } catch {
    /* nothing queued yet */
  }
}

// ---------------------------------------------------------------------------
// Announcing a backlog: queued, then announced — never silent
// ---------------------------------------------------------------------------

export interface AnchorBacklog {
  pending: number;
  oldest: string | null;
  last_error: string | null;
  last_attempt: string | null;
}

export function anchorBacklog(settings: ResolvedAnchor): AnchorBacklog {
  const queued = pendingAnchors(settings);
  const st = settings.declared ? readState(settings) : {};
  return {
    pending: queued.length,
    oldest: queued[0]?.queued_at ?? null,
    last_error: st.last_error ?? null,
    last_attempt: st.last_attempt ?? null,
  };
}

function backendLabel(s: ResolvedAnchor): string {
  if (s.backend === "git") return `git (${redactRemote(s.remote ?? "")} ${s.ref})`;
  if (s.backend === "rfc3161") return `rfc3161 (${redactRemote(s.url ?? "")})`;
  if (s.backend === "cmd") return "cmd";
  return "no backend";
}

/**
 * At session start: say so, and record it, when heads are waiting.
 *
 * Announced when a delivery attempt failed since the oldest was queued, or
 * when the oldest has waited past ANCHOR_GRACE_SEC with no attempt (the
 * background delivery never ran). A queue a delivery is working through right
 * now is not a degradation yet, and starting a second delivery for it would
 * only cost this session's start the ~5 ms of a spawn; an announced one is
 * retried in the background.
 */
export function announceAnchorBacklog(
  settings: ResolvedAnchor | undefined,
  out: { say: (line: string) => void; audit?: DegradationSink; now?: Date }
): AnchorBacklog | null {
  if (!settings?.declared) return null;
  for (const p of settings.problems) out.say(`  ${p}`);
  if (!settings.enabled) return null;
  const b = anchorBacklog(settings);
  if (b.pending === 0) return null;
  const now = (out.now ?? new Date()).getTime();
  const failedSince = b.last_error && b.last_attempt && b.oldest && b.last_attempt >= b.oldest;
  const stale = b.oldest !== null && now - Date.parse(b.oldest) > ANCHOR_GRACE_SEC * 1000;
  if (failedSince || stale) {
    out.say(
      `  [anchor] ${b.pending} sealed trail head(s) queued since ${b.oldest} are not yet anchored to ${backendLabel(settings)}` +
        `${b.last_error ? `: ${b.last_error}` : " — no delivery has run"}. Retried in the background; \`gnomon audit anchor\` retries now.`
    );
    recordDegradation(out.audit, {
      id: "audit_anchor_queued",
      declared: `sealed trail heads anchored to ${backendLabel(settings)} at seal`,
      actual: `${b.pending} head(s) queued on this machine since ${b.oldest}, not anchored off it`,
      detail: { backend: settings.backend, pending: b.pending, oldest: b.oldest, last_error: b.last_error },
    });
    scheduleAnchorFlush(settings);
    return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the anchors back
// ---------------------------------------------------------------------------

export interface CollectedAnchor {
  statement: AnchorStatement;
  digest: string;
  /** git: committer date; rfc3161: the authority's genTime; cmd: delivery time. */
  anchored_at: string;
  /** Where it came from, for a reader: `git <commit>`, `rfc3161 serial …`, `cmd`. */
  via: string;
  /** Whether the anchor itself checks out, apart from any trail. */
  check: "valid" | "invalid" | "unchecked";
  detail?: string;
}

export interface AnchorLog {
  backend: AnchorBackend | null;
  /**
   * remote: read from the witness just now. local-copy: the witness could not
   * be reached and this machine's copy was read, which this machine can
   * rewrite. receipts: rfc3161 and cmd, whose evidence is the receipt itself.
   */
  source: "remote" | "local-copy" | "receipts" | "none";
  anchors: CollectedAnchor[];
  /** Findings about the log itself: unreachable, rewritten history, a receipt that does not parse. */
  problems: string[];
  /** Problems that are definite findings of tampering, as opposed to "could not check". */
  findings: string[];
}

function readReceipts(s: ResolvedAnchor): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(receiptsFile(s), "utf-8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      out.push({ malformed: line.slice(0, 80) });
    }
  }
  return out;
}

async function collectGit(s: ResolvedAnchor, offline: boolean, now: Date): Promise<AnchorLog> {
  const log: AnchorLog = { backend: "git", source: "remote", anchors: [], problems: [], findings: [] };
  const repo = join(s.dir, "git");
  const verifyRef = "refs/gnomon/verify";
  let ref = verifyRef;
  try {
    await ensureRepo(repo, s, now);
  } catch (e) {
    log.problems.push((e as Error).message);
    log.source = "none";
    return log;
  }
  const delivered = readReceipts(s).filter((r) => r.backend === "git").length;
  if (offline) {
    log.source = "local-copy";
    ref = s.ref;
  } else {
    try {
      const target = await remoteTarget(s, now);
      const tip = await remoteTip(repo, target, s, now);
      if (!tip) {
        if (delivered > 0) {
          log.findings.push(`the remote holds no ${s.ref}, yet ${delivered} anchor(s) were delivered to it: the ref was deleted`);
        }
        return log;
      }
      const f = await git(repo, ["fetch", "-q", "--no-tags", target, `+${s.ref}:${verifyRef}`], s, now);
      if (f.code !== 0) throw new Error(`fetch failed: ${firstLine(f.err)}`);
      const seen = readState(s).remote_tip;
      if (seen && seen !== tip) {
        const anc = await git(repo, ["merge-base", "--is-ancestor", seen, tip], s, now);
        if (anc.code === 1) {
          log.findings.push(`the remote's anchor history was rewritten: ${seen.slice(0, 12)}, seen before, is no longer in it — anchors may have been removed`);
        } else if (anc.code !== 0) {
          log.problems.push(`could not tell whether the remote history was rewritten (${seen.slice(0, 12)} is not in the local copy)`);
        }
      }
      try {
        writeState(s, { remote_tip: tip });
      } catch {
        /* a read-only copy: the check above still ran */
      }
    } catch (e) {
      log.problems.push(`${(e as Error).message} — read the local copy instead, which this machine can rewrite`);
      log.source = "local-copy";
      ref = s.ref;
    }
  }

  const list = await git(repo, ["log", "--reverse", "--format=%H %cI", ref], s, now);
  if (list.code !== 0) {
    if (log.source === "local-copy") log.problems.push("there is no local copy of the anchors");
    return log;
  }
  const commits = list.out.split("\n").filter(Boolean).map((l) => {
    const [sha, at] = l.split(" ");
    return { sha: sha!, at: at! };
  });
  if (commits.length === 0) return log;
  const batch = await git(repo, ["cat-file", "--batch"], s, now, commits.map((c) => `${c.sha}:anchors.jsonl`).join("\n") + "\n");
  // The batch output is `<sha> blob <size>\n<content>\n` per object, or
  // `<name> missing\n`. Content is read by size, never by line.
  const buf = Buffer.from(batch.out, "utf-8");
  let p = 0;
  for (const c of commits) {
    const nl = buf.indexOf(10, p);
    if (nl < 0) break;
    const header = buf.subarray(p, nl).toString("utf-8");
    p = nl + 1;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) {
      log.problems.push(`commit ${c.sha.slice(0, 12)} holds no anchors.jsonl`);
      continue;
    }
    const size = Number(m[1]);
    const body = buf.subarray(p, p + size).toString("utf-8");
    p += size + 1;
    for (const line of body.split("\n").filter(Boolean)) {
      try {
        const statement = JSON.parse(line) as AnchorStatement;
        log.anchors.push({
          statement,
          digest: statementDigest(statement),
          anchored_at: new Date(c.at).toISOString(),
          via: `git ${c.sha.slice(0, 12)}`,
          check: log.source === "remote" ? "valid" : "unchecked",
          ...(log.source === "remote" ? {} : { detail: "read from this machine's copy, not the remote" }),
        });
      } catch {
        log.problems.push(`commit ${c.sha.slice(0, 12)} holds a line that is not a statement`);
      }
    }
  }
  return log;
}

async function collectReceipts(s: ResolvedAnchor): Promise<AnchorLog> {
  const log: AnchorLog = { backend: s.backend, source: "receipts", anchors: [], problems: [], findings: [] };
  for (const r of readReceipts(s)) {
    if (r.malformed !== undefined) {
      log.findings.push(`receipts.jsonl holds a line that is not a receipt: ${String(r.malformed)}`);
      continue;
    }
    if (r.backend !== s.backend) continue;
    const statement = r.statement as AnchorStatement;
    const digest = statementDigest(statement);
    const receipt = (r.receipt ?? {}) as Record<string, unknown>;
    if (digest !== r.digest) {
      log.anchors.push({ statement, digest, anchored_at: String(r.delivered_at), via: String(s.backend), check: "invalid", detail: "the receipt's digest is not its statement's" });
      continue;
    }
    if (s.backend === "rfc3161") {
      let token: Buffer;
      try {
        token = Buffer.from(String(receipt.token ?? ""), "base64");
      } catch {
        token = Buffer.alloc(0);
      }
      const check = verifyTimeStampToken(token, { digestHex: digest, pinned: s.tsa_cert });
      log.anchors.push({
        statement,
        digest,
        anchored_at: check.info?.gen_time ?? String(r.delivered_at),
        via: `rfc3161 serial ${check.info?.serial ?? "?"}`,
        check: !check.valid ? "invalid" : check.checked ? "valid" : "unchecked",
        ...(check.detail ? { detail: check.detail } : {}),
      });
    } else {
      let check: CollectedAnchor["check"] = "unchecked";
      let detail: string | undefined = "no `verify` command is declared, so the receipt was not checked";
      if (s.verify) {
        const e: QueueEntry = { statement, digest, queued_at: String(r.queued_at ?? "") };
        const v = await runDeclared(s.verify, digest, { ...anchorEnv(e), GNOMON_ANCHOR_RECEIPT: String(receipt.output ?? "") }, s.timeout_sec, s.root);
        if (v.code === 0) {
          check = "valid";
          detail = undefined;
        } else if (v.code === 124 || v.code === 126 || v.code === 127) {
          detail = `verify command could not run (exit ${v.code})`;
        } else {
          check = "invalid";
          detail = `verify command exit ${v.code}${v.err.trim() ? `: ${firstLine(v.err)}` : ""}`;
        }
      }
      log.anchors.push({ statement, digest, anchored_at: String(r.delivered_at), via: "cmd", check, ...(detail ? { detail } : {}) });
    }
  }
  return log;
}

/**
 * Every anchor the witness holds. `offline` reads the git backend's local
 * copy instead of fetching; the log then says so.
 */
export async function collectAnchors(settings: ResolvedAnchor, opts: { offline?: boolean; deps?: AnchorDeps } = {}): Promise<AnchorLog> {
  if (!settings.enabled) return { backend: settings.backend, source: "none", anchors: [], problems: [], findings: [] };
  const now = (opts.deps?.now ?? (() => new Date()))();
  return settings.backend === "git" ? collectGit(settings, Boolean(opts.offline), now) : collectReceipts(settings);
}

// ---------------------------------------------------------------------------
// Checking trails against the anchors
// ---------------------------------------------------------------------------

/**
 * anchored    every anchor naming the trail matches it.
 * rechained   an anchor names a head the trail no longer has: the re-chain.
 * invalid     an anchor naming the trail does not itself check out.
 * unchecked   anchors match, but none could be checked (no tsa_cert, no verify).
 * pending     not anchored yet; its statement is queued.
 * unanchored  sealed, after anchoring began here, and no anchor and nothing queued.
 * predates    sealed before the first anchor this checkout made.
 * unsealed    never sealed, so never anchored (a killed run).
 */
export type AnchorTrailStatus = "anchored" | "rechained" | "invalid" | "unchecked" | "pending" | "unanchored" | "predates" | "unsealed";

export interface AnchorMismatch {
  seq: number;
  reason: "hash_mismatch" | "missing_record" | "shrunk";
  anchored_hash: string;
  /** The hash the trail's record at that seq recomputes to now; null when the record is gone. */
  current_hash: string | null;
  anchored_at: string;
  via: string;
}

export interface AnchorTrailResult {
  trail: string;
  status: AnchorTrailStatus;
  /** Anchors naming this trail, from this checkout. */
  anchors: number;
  matched: number;
  /** Highest seq covered by a matching anchor. */
  covered_through: number | null;
  /** The last anchor that still matches, before the first that does not. */
  last_match?: { seq: number; anchored_at: string; via: string };
  first_mismatch?: AnchorMismatch;
  /**
   * The seq range the rewrite must touch: after the last matching anchor's seq,
   * up to the first mismatching one's. The rewrite happened after
   * `first_mismatch.anchored_at`, when that head was still the one written.
   */
  rewritten?: { from_seq: number; to_seq: number; after: string };
  /** A later anchor that matches the rewritten content: someone anchored the forgery too. */
  reanchored?: { seq: number; anchored_at: string; via: string };
  detail: string;
}

export interface AnchorReport {
  scope: string;
  backend: AnchorBackend | null;
  source: AnchorLog["source"];
  trails: AnchorTrailResult[];
  /** Anchored trails of this checkout that are no longer on disk. */
  missing: Array<{ trail: string; seq: number; anchored_at: string; via: string }>;
  /** The newest anchored checkpoint is gone and nothing newer replaced it. */
  rollback?: { checkpoint: string; anchored_at: string };
  /** Anchors from other checkouts sharing the witness: counted, not judged. */
  other_scopes: number;
  problems: string[];
  findings: string[];
  /** No finding, and everything that should have been checked was. */
  ok: boolean;
}

const CHECKPOINT_TRAIL = /(^|\/)checkpoints\/(checkpoint-[^/]+)\.jsonl$/;

interface TrailFacts {
  lines: number;
  bySeq: Map<number, string>;
  sealed: boolean;
  sealedAt: string | null;
}

function trailFacts(path: string): TrailFacts | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter(Boolean);
  const bySeq = new Map<number, string>();
  let last: AuditRecord | null = null;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as AuditRecord;
      last = r;
      // Recomputed, never read from `hash`: a re-chain rewrites the stored
      // hashes to agree with each other.
      if (typeof r.seq === "number") bySeq.set(r.seq, recordHash(r));
    } catch {
      last = null;
    }
  }
  const sealed = last?.kind === "session_end";
  return { lines: lines.length, bySeq, sealed, sealedAt: sealed ? String(last!.ts) : null };
}

/**
 * Judge trails against an anchor log. `trails` are absolute paths. Pure but for
 * reading the trails, the queue and the disk for missing checkpoints.
 */
export function verifyAgainstAnchors(
  settings: ResolvedAnchor,
  log: AnchorLog,
  trails: string[],
  opts: {
    scope?: string;
    /**
     * Do not count `unchecked` anchors against `ok`. For a caller that asked
     * for the local copy (`--offline`) and knows what it is reading.
     */
    acceptUnchecked?: boolean;
  } = {}
): AnchorReport {
  const scope = opts.scope ?? settings.scope;
  const mine = log.anchors.filter((a) => a.statement?.scope === scope && a.statement?.anchor === ANCHOR_FORMAT);
  const other_scopes = log.anchors.length - mine.length;
  const queued = new Set(pendingAnchors(settings).filter((q) => q.statement.scope === scope).map((q) => q.statement.trail));
  // When anchoring began here: the earliest sealed_at among this checkout's
  // anchors and queue. A trail sealed before it had nothing to anchor it.
  const starts = [...mine.map((a) => a.statement.sealed_at), ...pendingAnchors(settings).map((q) => q.statement.sealed_at)].sort();
  const began = starts[0] ?? null;

  const results: AnchorTrailResult[] = [];
  const findings = [...log.findings];
  for (const path of trails) {
    const name = trailName(settings.root, path);
    const facts = trailFacts(path);
    const relevant = mine.filter((a) => a.statement.trail === name);
    const base = { trail: name, anchors: relevant.length, matched: 0, covered_through: null as number | null };
    if (!facts) {
      results.push({ ...base, status: "unanchored", detail: "trail could not be read" });
      continue;
    }
    let first: AnchorMismatch | undefined;
    let firstIndex = -1;
    const matches: Array<{ i: number; a: CollectedAnchor }> = [];
    let invalid: CollectedAnchor | undefined;
    relevant.forEach((a, i) => {
      if (a.check === "invalid") {
        invalid ??= a;
        return;
      }
      const s = a.statement;
      const now = facts.bySeq.get(s.seq);
      let reason: AnchorMismatch["reason"] | null = null;
      if (now === undefined) reason = "missing_record";
      else if (now !== s.hash) reason = "hash_mismatch";
      else if (facts.lines < s.records) reason = "shrunk";
      if (reason) {
        if (!first) {
          first = { seq: s.seq, reason, anchored_hash: s.hash, current_hash: now ?? null, anchored_at: a.anchored_at, via: a.via };
          firstIndex = i;
        }
      } else matches.push({ i, a });
    });
    const matched = matches.length;
    const covered = matched ? Math.max(...matches.map((m) => m.a.statement.seq)) : null;
    if (first) {
      const before = matches.filter((m) => m.a.statement.seq < first!.seq).sort((x, y) => x.a.statement.seq - y.a.statement.seq).pop();
      const later = matches.find((m) => m.i > firstIndex);
      const from = before ? before.a.statement.seq + 1 : 0;
      const what =
        first.reason === "hash_mismatch"
          ? `seq ${first.seq} was anchored as ${first.anchored_hash.slice(0, 12)}…, the trail now holds ${first.current_hash!.slice(0, 12)}…`
          : first.reason === "missing_record"
            ? `seq ${first.seq} was anchored, and the trail no longer has it`
            : `${relevant.find((a) => a.statement.seq === first!.seq)?.statement.records} records were anchored, ${facts.lines} remain`;
      results.push({
        ...base,
        status: "rechained",
        matched,
        covered_through: covered,
        ...(before ? { last_match: { seq: before.a.statement.seq, anchored_at: before.a.anchored_at, via: before.a.via } } : {}),
        first_mismatch: first,
        rewritten: { from_seq: from, to_seq: first.seq, after: first.anchored_at },
        ...(later ? { reanchored: { seq: later.a.statement.seq, anchored_at: later.a.anchored_at, via: later.a.via } } : {}),
        detail:
          `${what} (anchored ${first.anchored_at}, ${first.via}). The change is in seq ${from}–${first.seq} and was made after that anchor` +
          `${before ? `; the anchor at seq ${before.a.statement.seq} (${before.a.anchored_at}) still matches` : ""}` +
          `${later ? `; the rewrite itself was anchored later (${later.a.anchored_at}, ${later.a.via})` : ""}.`,
      });
      continue;
    }
    if (invalid) {
      results.push({ ...base, status: "invalid", matched, covered_through: covered, detail: `an anchor for this trail does not check out: ${invalid.detail ?? "invalid"} (${invalid.via})` });
      continue;
    }
    if (matched > 0) {
      const checked = matches.some((m) => m.a.check === "valid");
      const tail = facts.lines - (covered! + 1);
      results.push({
        ...base,
        status: checked ? "anchored" : "unchecked",
        matched,
        covered_through: covered,
        detail: checked
          ? `matches ${matched} anchor(s), through seq ${covered}${tail > 0 ? `; ${tail} later record(s) not anchored yet` : ""}`
          : `matches ${matched} anchor(s), none of which could be checked: ${matches[0]!.a.detail ?? "unchecked"}`,
      });
      continue;
    }
    if (queued.has(name)) {
      results.push({ ...base, status: "pending", detail: "queued, not delivered yet" });
      continue;
    }
    if (!facts.sealed) {
      results.push({ ...base, status: "unsealed", detail: "not sealed, so never anchored" });
      continue;
    }
    if (began === null || (facts.sealedAt !== null && facts.sealedAt < began)) {
      results.push({ ...base, status: "predates", detail: "sealed before this checkout began anchoring" });
      continue;
    }
    results.push({ ...base, status: "unanchored", detail: "sealed after anchoring began here, yet no anchor names it and nothing is queued" });
  }

  // Anchored trails no longer on disk. Checkpoints are pruned by design, so
  // only the newest anchored one is owed: gone, with nothing newer, is the
  // rollback CONTRACTS.md §14 said needed an anchor off the machine.
  const missing: AnchorReport["missing"] = [];
  const seen = new Set<string>();
  let newestCheckpoint: CollectedAnchor | null = null;
  for (const a of mine) {
    const m = CHECKPOINT_TRAIL.exec(a.statement.trail);
    if (m) {
      if (!newestCheckpoint || basename(a.statement.trail) > basename(newestCheckpoint.statement.trail)) newestCheckpoint = a;
      continue;
    }
    if (seen.has(a.statement.trail)) continue;
    seen.add(a.statement.trail);
    const abs = isAbsolute(a.statement.trail) ? a.statement.trail : join(settings.root, a.statement.trail);
    if (!existsSync(abs)) missing.push({ trail: a.statement.trail, seq: a.statement.seq, anchored_at: a.anchored_at, via: a.via });
  }
  let rollback: AnchorReport["rollback"];
  if (newestCheckpoint) {
    const abs = isAbsolute(newestCheckpoint.statement.trail) ? newestCheckpoint.statement.trail : join(settings.root, newestCheckpoint.statement.trail);
    if (!existsSync(abs)) {
      const dir = join(abs, "..");
      let newer = false;
      try {
        newer = readdirSync(dir).some((n) => /^checkpoint-.*\.jsonl$/.test(n) && n > basename(abs));
      } catch {
        newer = false;
      }
      if (!newer) rollback = { checkpoint: newestCheckpoint.statement.trail, anchored_at: newestCheckpoint.anchored_at };
    }
  }

  for (const m of missing) findings.push(`${m.trail} was anchored (${m.anchored_at}, ${m.via}) and is no longer on disk`);
  if (rollback) findings.push(`the newest anchored checkpoint ${rollback.checkpoint} (${rollback.anchored_at}) is gone and nothing newer replaced it: a rollback`);
  const bad = results.some(
    (r) =>
      r.status === "rechained" ||
      r.status === "invalid" ||
      r.status === "unanchored" ||
      (r.status === "unchecked" && !opts.acceptUnchecked)
  );
  return {
    scope,
    backend: log.backend,
    source: log.source,
    trails: results,
    missing,
    ...(rollback ? { rollback } : {}),
    other_scopes,
    problems: log.problems,
    findings,
    ok: !bad && findings.length === 0 && log.problems.length === 0,
  };
}
