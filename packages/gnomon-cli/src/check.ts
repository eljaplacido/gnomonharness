/**
 * gnomon-cli: `gnomon check` — wiring, terminal output, and the Claude Code hook.
 *
 * The judging is gnomon-core's runCheck; this file turns flags into options
 * and a verdict into either JSON or the lines a person reads. Kept out of
 * index.ts so that file carries one dispatch line for it, not another hundred.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  runCheck,
  readTranscript,
  resolveUi,
  loadConfig,
  paint,
  TRANSCRIPT_FORMATS,
  type CheckOptions,
  type CheckVerdict,
  type CheckEntry,
  type ResolvedUi,
  type TranscriptFormat,
} from "gnomon-core";

export interface CheckCliArgs {
  dir?: string;
  role?: string;
  json?: boolean;
  flags: Record<string, string>;
}

export const CHECK_USAGE =
  "Usage: gnomon check --base <rev> [--head <rev>] [--role <role> | --agent <name>]\n" +
  "                    [--transcript <file> --format claude-code|opencode] [--json] [--dir <path>]\n" +
  "       gnomon check --install-hook claude-code\n" +
  "       gnomon check --hook session-start|stop   (reads Claude Code hook JSON on stdin)";

const flagOf = (args: CheckCliArgs, k: string) =>
  args.flags[k] && args.flags[k] !== "true" ? args.flags[k] : undefined;

/** Read `--transcript`/`--format` into check 5's input: commands, or why not. */
function transcriptOption(path: string | undefined, format: string | undefined): CheckOptions["transcript"] {
  if (!path) return undefined;
  if (!format || !(TRANSCRIPT_FORMATS as readonly string[]).includes(format)) {
    return `--transcript needs --format ${TRANSCRIPT_FORMATS.join("|")}${format ? ` (got "${format}")` : ""}`;
  }
  try {
    return readTranscript(resolve(path), format as TranscriptFormat);
  } catch (err) {
    return `the transcript could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Run the command; returns the process exit code rather than exiting, for tests. */
export async function cmdCheck(
  args: CheckCliArgs,
  out: (s: string) => void = console.log,
  stdin: () => string = () => readFileSync(0, "utf-8")
): Promise<number> {
  const install = flagOf(args, "install-hook") ?? (args.flags["install-hook"] === "true" ? "" : undefined);
  if (install !== undefined) return installHook(install, out);
  const hook = flagOf(args, "hook");
  if (hook) return runHook(hook, args, stdin());

  const base = flagOf(args, "base");
  if (!base) {
    // 10, not 1: the contract is 0 / 2 / 10, and a caller gating on it must not
    // read a usage error as anything but "no verdict".
    const verdict = refusal("--base <rev> is required: the revision the change is judged against");
    emit(verdict, args, out);
    if (!args.json) console.error(CHECK_USAGE);
    return 10;
  }
  const verdict = await runCheck({
    dir: args.dir,
    explicitDir: Boolean(args.dir),
    base,
    head: flagOf(args, "head"),
    role: args.role,
    agent: flagOf(args, "agent"),
    transcript: transcriptOption(flagOf(args, "transcript"), flagOf(args, "format")),
  });
  emit(verdict, args, out);
  return verdict.exit;
}

// ---------------------------------------------------------------------------
// Claude Code hooks
// ---------------------------------------------------------------------------
//
// Two hooks, because a Stop hook alone does not know where the session began.
// SessionStart records it; Stop judges everything since against the rules as
// they stood then. gnomon reads the hook's own JSON from stdin rather than
// having the snippet pipe it through jq: one less dependency on the machine,
// and the same command works in PowerShell.

interface SessionBase {
  /** HEAD when the session started: the rules are read from here. */
  head: string;
  /** `git stash create` when the tree was dirty: the diff starts here. */
  snapshot?: string;
  /** Untracked files already present, by sha256, so they are not charged. */
  untracked: Record<string, string>;
  started: string;
}

function gitIn(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A session id is a file name here; anything else is refused, not escaped. */
const safeId = (id: unknown) => (typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : null);

function governed(cwd: string): { toplevel: string; gitDir: string } | null {
  const toplevel = gitIn(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = gitIn(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!toplevel || !gitDir) return null;
  // A hook installed in user settings fires in every project. One without a
  // surface is not governed, and must not be told it failed anything.
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, ".gnomon"))) return { toplevel, gitDir };
    if (d === toplevel || dirname(d) === d) return null;
  }
}

async function runHook(kind: string, args: CheckCliArgs, raw: string): Promise<number> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error("gnomon check --hook: stdin is not the hook's JSON input");
    return 1;
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const id = safeId(input.session_id);
  const where = governed(cwd);
  if (!where || !id) return 0;
  const stateFile = join(where.gitDir, "gnomon-check", "sessions", `${id}.json`);

  if (kind === "session-start") {
    // Resume, /clear and compaction fire SessionStart again for the same
    // session. The base is where the session BEGAN, so the first record stands.
    if (existsSync(stateFile)) return 0;
    const head = gitIn(where.toplevel, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (!head) return 0; // no commit yet: nothing to read rules from
    const snapshot = gitIn(where.toplevel, ["stash", "create"]) || undefined;
    const untracked: Record<string, string> = {};
    for (const p of (gitIn(where.toplevel, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
      .split("\0")
      .filter(Boolean)) {
      try {
        untracked[p] = createHash("sha256").update(readFileSync(join(where.toplevel, p))).digest("hex");
      } catch {
        // Unreadable now means it will be judged later like any other path.
      }
    }
    const state: SessionBase = { head, snapshot, untracked, started: new Date().toISOString() };
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));
    // Nothing on stdout: SessionStart's stdout is added to the model's context.
    return 0;
  }

  if (kind !== "stop") {
    console.error(`gnomon check --hook: unknown hook "${kind}" (session-start | stop)`);
    return 1;
  }
  if (!existsSync(stateFile)) {
    console.error(
      "gnomon check: no session base was recorded for this session, so it is not judged. " +
        "Install the SessionStart hook too (`gnomon check --install-hook claude-code`)."
    );
    return 1;
  }
  const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionBase;
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : undefined;
  const verdict = await runCheck({
    dir: cwd,
    base: state.head,
    // The diff starts where the session started, never at a merge-base: the
    // session's HEAD is exactly what the agent was handed, and one that ran
    // `git reset --hard` to an older commit undid commits — a policy
    // tightening among them — that a merge-base diff would not show.
    snapshot: state.snapshot ?? state.head,
    preexisting: state.untracked,
    role: args.role,
    agent: flagOf(args, "agent"),
    transcript: transcriptOption(transcriptPath, "claude-code"),
  });
  // A turn that changed nothing and ran nothing a rule covers — a question
  // answered — has nothing to judge, and saying so after every reply would
  // train the operator to ignore the hook.
  const nothing =
    verdict.exit === 10 &&
    ((verdict.error !== undefined && /nothing to judge/.test(verdict.error)) ||
      (verdict.error === undefined && !verdict.checks.some((c) => c.status === "error" || c.status === "fail")));
  if (verdict.exit === 0 || nothing) return 0;

  const plain = { color: false } as ResolvedUi;
  for (const line of renderVerdict(verdict, plain)) console.error(line);
  if (verdict.exit === 2) {
    // Exit 2 blocks the stop and hands stderr to Claude: the session is sent
    // back with the findings, which is the in-loop behaviour from outside.
    // Once only — `stop_hook_active` means this is already the send-back, and
    // a second block could hold the session in a loop the operator never sees.
    if (input.stop_hook_active === true) {
      console.error("gnomon check: still failing after one send-back — stopping, and leaving it to the operator.");
      return 1;
    }
    console.error(
      "The repository's governance check failed on this session's changes. These are the " +
        "repository's own rules (.gnomon/ as of the session start), not an opinion. Fix what is " +
        "listed, or say plainly why it cannot be fixed."
    );
    return 2;
  }
  return 1; // no verdict: shown to the operator, never blocks
}

/**
 * Print the settings.json fragment. It does not edit anything: hooks run
 * commands on the operator's machine, and that is theirs to paste.
 */
function installHook(target: string, out: (s: string) => void): number {
  if (target !== "claude-code") {
    console.error(`gnomon check --install-hook: only "claude-code" is supported (got "${target}")`);
    return 10;
  }
  const fragment = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "gnomon check --hook session-start" }] }],
      Stop: [{ hooks: [{ type: "command", command: "gnomon check --hook stop --agent claude-code", timeout: 900 }] }],
    },
  };
  out(JSON.stringify(fragment, null, 2));
  console.error(
    [
      "",
      "Merge the above into the \"hooks\" of .claude/settings.json (this project) or",
      "~/.claude/settings.json (every project; ungoverned ones are skipped). Nothing was written.",
      "",
      "  SessionStart  records HEAD (and a snapshot of a dirty tree) in .git/gnomon-check/",
      "  Stop          runs `gnomon check` on everything since, with the session transcript",
      "                for check 5. A failure blocks the stop once and hands Claude the findings.",
      "",
      "The role comes from the surface — add to .gnomon/policy.toml:",
      "",
      "  [check.roles]",
      "  claude-code = \"implement\"",
      "",
      "or replace `--agent claude-code` with `--role <role>`. timeout is seconds: the Stop hook",
      "runs [verify], and must-fail-first runs it again.",
      "",
      "To also decide each tool call BEFORE it runs, `gnomon guard install claude-code` prints",
      "these two hooks plus a PreToolUse hook (`--write` merges them without duplicating).",
    ].join("\n")
  );
  return 0;
}

function refusal(error: string): CheckVerdict {
  return { schema: "gnomon.check/1", base: null, head: "worktree", role: null, surface_hash: null, checks: [], exit: 10, error };
}

function emit(verdict: CheckVerdict, args: CheckCliArgs, out: (s: string) => void): void {
  if (args.json) {
    out(JSON.stringify(verdict, null, 2));
    return;
  }
  // The surface's [ui] decides colour, as everywhere else; a repository whose
  // surface will not load still gets a readable, uncoloured verdict.
  let ui: ResolvedUi;
  try {
    ui = resolveUi(loadConfig(args.dir));
  } catch {
    ui = { color: false } as ResolvedUi;
  }
  for (const line of renderVerdict(verdict, ui)) out(line);
}

const MARK: Record<CheckEntry["status"], [string, string]> = {
  pass: ["✓", "green"],
  fail: ["✗", "red"],
  skipped: ["–", "gray"],
  error: ["!", "yellow"],
};

/** What one check said, in a phrase. */
function summary(c: CheckEntry): string {
  const n = c.findings?.length ?? 0;
  switch (c.status) {
    case "skipped":
      return `skipped: ${c.reason ?? ""}`;
    case "error":
      return `could not run: ${c.reason ?? ""}`;
    case "pass":
      if (c.id === "verify") return `${c.findings?.[0]?.command ?? ""} — exit 0`;
      if (c.id === "audit") return `appended, chain verified`;
      if (c.id === "must_fail_first") return `${c.inspected} test(s) fail against base sources, as they should`;
      if (c.id === "surface") return `not edited (${c.inspected} path(s) looked at)`;
      if (c.id === "bash_allow") {
        return `${c.inspected ?? 0} command(s), all allowed` + (n ? ` (${n} refused by the harness itself, not run)` : "");
      }
      return `${c.inspected ?? 0} path(s), all inside`;
    case "fail":
      if (c.id === "write_allow") return `${n} path(s) outside write_allow (${c.findings?.[0]?.listed ?? ""})`;
      if (c.id === "surface") return `the change edits the surface — an agent may not edit its own rules`;
      if (c.id === "verify") return `${c.findings?.[0]?.command ?? ""} — exit ${c.findings?.[0]?.exit ?? "?"}`;
      if (c.id === "must_fail_first") return `${n} test(s) pass against base sources — they pin nothing`;
      if (c.id === "bash_allow") {
        const ran = c.findings?.filter((f) => f.ran !== false).length ?? 0;
        return `${ran} of ${c.inspected ?? 0} command(s) break the role's bash_allow / bash_deny`;
      }
      return `${n} finding(s)`;
  }
}

/** The indented lines under a check: what to go and look at. */
function details(c: CheckEntry): string[] {
  if (c.status === "pass" && c.id !== "audit" && c.id !== "bash_allow") return [];
  const lines: string[] = [];
  for (const f of c.findings ?? []) {
    if (typeof f.path === "string") lines.push(`${f.change ? `${f.change} ` : ""}${f.path}`);
    else if (typeof f.test === "string") lines.push(String(f.test));
    else if (typeof f.trail === "string") lines.push(`${f.trail}${f.seq !== undefined ? ` · seq ${f.seq}` : ""}${f.hash ? ` · ${String(f.hash).slice(0, 16)}…` : ""}`);
    else if (typeof f.command === "string" && typeof f.rule === "string") {
      const why = f.pattern ? `${f.rule} /${f.pattern}/` : `not on ${f.rule}`;
      lines.push(`$ ${f.command.split("\n")[0]}`);
      lines.push(`  ${why}${f.at ? ` · ${f.at}` : ""}${f.ran === false ? " · refused by the harness, not run" : ""}`);
    } else if (typeof f.command === "string" && typeof f.output === "string" && f.output.trim()) {
      for (const l of f.output.trimEnd().split("\n").slice(-8)) lines.push(`│ ${l}`);
    } else if (typeof f.detail === "string") lines.push(f.detail + (f.surface_hash_head ? ` (head surface ${String(f.surface_hash_head).slice(0, 12)}…)` : ""));
  }
  return lines;
}

export function renderVerdict(v: CheckVerdict, ui: ResolvedUi): string[] {
  const out: string[] = [];
  const short = (s: string | null) => (s && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 12) : (s ?? "?"));
  out.push("");
  out.push(
    `${paint(ui, "bold", "gnomon check")}  ${short(v.base)} → ${short(v.head)}` +
      (v.role ? `  ·  role ${paint(ui, "bold", v.role)}` : "")
  );
  if (v.surface_hash) out.push(paint(ui, "gray", `  rules: surface ${v.surface_hash.slice(0, 16)}… as of base`));
  for (const r of v.recovered ?? []) {
    out.push(paint(ui, "yellow", `  ⚠ restored ${r} — an earlier check was interrupted mid re-run`));
  }
  out.push("");
  if (v.error) {
    out.push(`  ${paint(ui, "yellow", "!")} ${v.error}`);
  }
  const width = Math.max(0, ...v.checks.map((c) => c.id.length));
  for (const c of v.checks) {
    const [mark, color] = MARK[c.status];
    out.push(`  ${paint(ui, color, mark)} ${c.id.padEnd(width)}  ${summary(c)}`);
    for (const d of details(c)) out.push(paint(ui, "gray", `      ${d}`));
  }
  if (v.audit && !v.audit.surface_audit_enabled) {
    out.push(paint(ui, "gray", `      ([audit] is off for sessions; check verdicts are always recorded)`));
  }
  out.push("");
  const failed = v.checks.filter((c) => c.status === "fail").length;
  if (v.exit === 0) out.push(`  ${paint(ui, "green", "HELD")} — every check that applied passed (exit 0)`);
  else if (v.exit === 2) out.push(`  ${paint(ui, "red", "FAILED")} — ${failed} check(s) failed (exit 2)`);
  else out.push(`  ${paint(ui, "yellow", "NO VERDICT")} — the check could not run, or inspected nothing (exit 10)`);
  out.push("");
  return out;
}
