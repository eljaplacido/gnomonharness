/**
 * gnomon-cli: `gnomon check` — wiring and terminal output.
 *
 * The judging is gnomon-core's runCheck; this file turns flags into options
 * and a verdict into either JSON or the lines a person reads. Kept out of
 * index.ts so that file carries one dispatch line for it, not another hundred.
 */

import { runCheck, resolveUi, loadConfig, paint, type CheckVerdict, type CheckEntry, type ResolvedUi } from "gnomon-core";

export interface CheckCliArgs {
  dir?: string;
  role?: string;
  json?: boolean;
  flags: Record<string, string>;
}

export const CHECK_USAGE =
  "Usage: gnomon check --base <rev> [--head <rev>] [--role <role> | --agent <name>] [--json] [--dir <path>]";

/** Run the command; returns the process exit code rather than exiting, for tests. */
export async function cmdCheck(args: CheckCliArgs, out: (s: string) => void = console.log): Promise<number> {
  const base = args.flags.base;
  if (!base || base === "true") {
    // 10, not 1: the contract is 0 / 2 / 10, and a caller gating on it must not
    // read a usage error as anything but "no verdict".
    const verdict = refusal("--base <rev> is required: the revision the change is judged against");
    emit(verdict, args, out);
    if (!args.json) console.error(CHECK_USAGE);
    return 10;
  }
  const flag = (k: string) => (args.flags[k] && args.flags[k] !== "true" ? args.flags[k] : undefined);
  const verdict = await runCheck({
    dir: args.dir,
    explicitDir: Boolean(args.dir),
    base,
    head: flag("head"),
    role: args.role,
    agent: flag("agent"),
    transcript: args.flags.transcript ? "transcript adapters are not in this build" : undefined,
  });
  emit(verdict, args, out);
  return verdict.exit;
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
      return `${c.inspected ?? 0} path(s), all inside`;
    case "fail":
      if (c.id === "write_allow") return `${n} path(s) outside write_allow (${c.findings?.[0]?.listed ?? ""})`;
      if (c.id === "surface") return `the change edits the surface — an agent may not edit its own rules`;
      if (c.id === "verify") return `${c.findings?.[0]?.command ?? ""} — exit ${c.findings?.[0]?.exit ?? "?"}`;
      if (c.id === "must_fail_first") return `${n} test(s) pass against base sources — they pin nothing`;
      return `${n} finding(s)`;
  }
}

/** The indented lines under a check: what to go and look at. */
function details(c: CheckEntry): string[] {
  if (c.status === "pass" && c.id !== "audit") return [];
  const lines: string[] = [];
  for (const f of c.findings ?? []) {
    if (typeof f.path === "string") lines.push(`${f.change ? `${f.change} ` : ""}${f.path}`);
    else if (typeof f.test === "string") lines.push(String(f.test));
    else if (typeof f.trail === "string") lines.push(`${f.trail}${f.seq !== undefined ? ` · seq ${f.seq}` : ""}${f.hash ? ` · ${String(f.hash).slice(0, 16)}…` : ""}`);
    else if (typeof f.command === "string" && typeof f.output === "string" && f.output.trim()) {
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
