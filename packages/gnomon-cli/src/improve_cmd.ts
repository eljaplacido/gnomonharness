/**
 * gnomon-cli: `gnomon improve`.
 *
 * `improve [--dry-run] [--run] [--k N] [--budget-usd X] [--role R] [--json]`
 * mines the audit trails, drafts proposals, probes them against the base
 * surface on the project's trial spec, composes the ones that helped, and
 * writes proposals (gnomon-core improve.ts). `--dry-run` (the default) prints
 * what it would do and writes nothing and calls no model. `--schedule nightly`
 * writes a loop file a person then installs; `--scheduled` is what that loop
 * runs. Contract: docs/CONTRACTS.md section 59.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IMPROVE_SCHEMA,
  agentReason,
  callEndpoint,
  declaredImprove,
  decisionContext,
  modelTimeoutMs,
  routeRole,
  runImprove,
  splitThinking,
  loadLoops,
  writeFileIn,
  type DraftModel,
  type EvalCellRunner,
  type GnomonConfig,
  type ImproveReport,
  type TrustOutcome,
} from "gnomon-core";

export const IMPROVE_EXIT = { ok: 0, usage: 1, refused: 3, couldNotRun: 10 } as const;

export interface ImproveCliArgs {
  flags: Record<string, string>;
  json: boolean;
  dir?: string;
  role?: string;
}

/** What the real command binds: a model, a probe runner and trust. A test binds scripts. */
export interface ImproveBindings {
  model?: DraftModel;
  runCell?: EvalCellRunner;
  settleTrust?: (config: GnomonConfig) => TrustOutcome | undefined;
}

/** The drafting model: the role's endpoint, one plain request, no tools. */
export function bindDraftModel(config: GnomonConfig): DraftModel {
  return async ({ role, system, user }) => {
    const route = routeRole(config, role);
    const r = await callEndpoint(route.target, [{ role: "system", content: system }, { role: "user", content: user }], [], modelTimeoutMs(config));
    return { ok: r.code === 0, text: splitThinking(r.content).answer.trim(), tokens_in: r.usage?.input, tokens_out: r.usage?.output };
  };
}

const EVERY: Record<string, string> = { nightly: "1d", weekly: "7d" };

function loopFile(every: string): string {
  return [
    "# Written by `gnomon improve --schedule`. A loop is part of the surface: review and commit it.",
    "# `gnomon loop install improve` is the separate step that puts it in cron.",
    "[loop]",
    'name = "improve"',
    `every = "${every}"`,
    'description = "Propose surface improvements from the audit trails. Dry unless policy.toml sets [improve] scheduled = run"',
    "",
    "[act]",
    'run = "gnomon improve --scheduled"',
    "timeout_sec = 3600",
    "",
    "[limits]",
    "max_runs_per_hour = 1",
    "max_consecutive_failures = 3",
    "",
  ].join("\n");
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export function formatImprove(r: ImproveReport): string[] {
  const out: string[] = [];
  out.push(r.mode === "dry-run" ? "gnomon improve (dry run): nothing is written and no model is called." : `gnomon improve (run ${r.run})`);
  out.push(`Mined ${r.mined.trails} trail(s), ${r.mined.records} record(s): ${r.mined.candidates} candidate(s).`);
  for (const n of r.mined.notes) out.push(`  note: ${n}`);
  for (const c of r.candidates) {
    out.push(`  ${c.family.padEnd(8)} ${c.signal.padEnd(18)} ${c.title.slice(0, 44).padEnd(44)} ${String(c.counts.sessions ?? c.counts.firings ?? c.counts.count ?? "").padStart(3)}  ${c.action === "propose" ? (r.mode === "dry-run" ? "would propose" : "proposed") : `${c.action}: ${c.reason}`}`);
  }
  out.push(r.role ? `Draft role: ${r.role.name} (${r.role.local ? "local" : "NOT local"}; ${r.role.why}).` : "Draft role: none (the deterministic templates are the text).");
  out.push(
    r.probe.spec
      ? `Probe: .gnomon/trials/${r.probe.spec}.toml, k = ${r.probe.k}, ${r.probe.tasks} task(s): ${r.probe.cells_per_candidate} cells per candidate, each in a temporary clone.`
      : `Probe: none, so every proposal is unprobed (${"hint" in r.probe ? r.probe.hint : ""}).`
  );
  out.push(
    r.policy.declared
      ? `Policy: [improve] auto_accept = ${r.policy.auto_accept.join(", ")}: accepts only lint-clean, probed proposals that meet the declared thresholds.`
      : "Policy: no [improve] auto_accept is declared, so a person decides every proposal."
  );
  for (const p of r.policy.problems) out.push(`  policy problem: ${p}`);
  for (const p of r.proposals) {
    const pr = p.probe;
    const probe =
      pr.status === "probed"
        ? `probed ${pr.pairs?.valid}/${pr.pairs?.planned} pairs: pass ${pr.base!.passes}/${pr.base!.n} -> ${pr.candidate!.passes}/${pr.candidate!.n} (${pct(pr.pass_delta)}), output tokens ${pct(pr.token_delta)}, steps ${pct(pr.request_delta)}, refusals ${pr.base!.refusals} -> ${pr.candidate!.refusals}${pr.regressed ? ", REGRESSED" : pr.improved ? ", improved" : ""}`
        : `${pr.status}${pr.reason ? `: ${pr.reason}` : ""}`;
    out.push(`  ${p.id}  ${p.kind}/${p.candidate}  ${p.title}`, `      ${probe}`, `      lint ${p.lint.clean ? "clean" : `${p.lint.problems.length} problem(s): ${p.lint.problems[0]}`}${p.composed_of ? `; combines ${p.composed_of.join(", ")}` : ""}`);
    if (p.auto) out.push(`      policy: ${p.auto.accepted ? "ACCEPTED (policy:improve.auto_accept)" : `not accepted: ${p.auto.reason}`}`);
  }
  if (r.mode === "run") out.push(`Spent ${JSON.stringify(r.budget)}.`);
  for (const p of r.problems) out.push(`  problem: ${p}`);
  if (r.mode === "dry-run") out.push("Run `gnomon improve --run` to draft, probe and write proposals. Nothing reaches .gnomon/ until a person accepts one (gnomon proposals).");
  else if (r.proposals.length > 0) out.push(`Wrote ${r.proposals.length} proposal(s). Read them with \`gnomon proposals\`; nothing changed under .gnomon/ except what policy accepted.`);
  return out;
}

/** Exit 0 done (including a dry run and a run that found nothing), 1 usage, 3 refused, 10 could not run. */
export async function runImproveCmd(config: GnomonConfig, a: ImproveCliArgs, bind: ImproveBindings = {}, out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const fail = (msg: string, code: number): number => {
    if (a.json) out(JSON.stringify({ schema: IMPROVE_SCHEMA, error: msg, exit: code }, null, 2));
    else err(`gnomon improve: ${msg}`);
    return code;
  };
  const f = a.flags;
  const flag = (k: string): string | undefined => (typeof f[k] === "string" && f[k] !== "true" ? f[k] : undefined);
  const known = new Set(["run", "dry-run", "k", "budget-usd", "role", "json", "schedule", "scheduled", "profile", "dir", "yes-spend", "trust", "yes"]);
  const stray = Object.keys(f).filter((k) => !known.has(k));
  if (stray.length > 0) return fail(`unknown option --${stray[0]}: improve [--dry-run] [--run] [--k N] [--budget-usd X] [--role R] [--schedule nightly|weekly] [--json]`, IMPROVE_EXIT.usage);

  if (f.schedule !== undefined) {
    const every = EVERY[flag("schedule") ?? ""];
    if (!every) return fail(`--schedule is one of ${Object.keys(EVERY).join(", ")}`, IMPROVE_EXIT.usage);
    const why = agentReason();
    if (why) return fail(`not scheduled: ${why}. Setting up a schedule is a person's: it adds a file to the surface.`, IMPROVE_EXIT.refused);
    if (!decisionContext().interactive) return fail("not scheduled: this adds .gnomon/loops/improve.toml to the surface, so it needs a person at a terminal. Write the file yourself from docs/GUIDE.md (Governed self-improvement) instead.", IMPROVE_EXIT.refused);
    const root = resolve(config.gnomonDir, "..");
    if (loadLoops(config.gnomonDir).some((l) => l.name === "improve") || existsSync(join(config.gnomonDir, "loops", "improve.toml"))) {
      return fail("a loop named improve already exists (.gnomon/loops/improve.toml); it was not changed", IMPROVE_EXIT.usage);
    }
    writeFileIn(root, join(config.gnomonDir, "loops", "improve.toml"), loopFile(every));
    const run = declaredImprove(config)?.scheduled === "run";
    const lines = [
      `Wrote .gnomon/loops/improve.toml (every ${every}). That is a change to the surface: review it and commit it.`,
      `Then \`gnomon loop install improve\` puts it in cron (nothing is scheduled until you do).`,
      run ? 'policy.toml sets [improve] scheduled = "run": each tick will draft, probe and write proposals.' : 'Each tick is a dry run unless policy.toml sets [improve] scheduled = "run".',
    ];
    if (a.json) out(JSON.stringify({ schema: IMPROVE_SCHEMA, scheduled: { file: ".gnomon/loops/improve.toml", every, dry: !run } }, null, 2));
    else for (const l of lines) out(l);
    return IMPROVE_EXIT.ok;
  }

  if (f.run !== undefined && f["dry-run"] !== undefined) return fail("--run and --dry-run are opposites; pass one", IMPROVE_EXIT.usage);
  const policy = declaredImprove(config);
  const scheduledRun = f.scheduled !== undefined && policy?.scheduled === "run";
  const run = f.run !== undefined || scheduledRun;
  const k = flag("k");
  if (f.k !== undefined && (!k || !/^\d+$/.test(k) || Number(k) < 1 || Number(k) > 20)) return fail("--k is a whole number from 1 to 20 (attempts per task per arm)", IMPROVE_EXIT.usage);
  const budget = flag("budget-usd");
  if (f["budget-usd"] !== undefined && (!budget || !Number.isFinite(Number(budget)) || Number(budget) < 0)) return fail("--budget-usd is a number of dollars, 0 or more", IMPROVE_EXIT.usage);
  if (run) {
    const why = agentReason();
    if (why && !scheduledRun) return fail(`not run: ${why}. gnomon improve --run spends model time and writes proposals; a person or a schedule starts it.`, IMPROVE_EXIT.refused);
  }

  let report: ImproveReport;
  try {
    report = await runImprove(config, {
      run,
      ...(k ? { k: Number(k) } : {}),
      ...(budget ? { budgetUsd: Number(budget) } : {}),
      role: a.role ?? flag("role"),
      ...bind,
      yesSpend: f["yes-spend"] !== undefined,
      log: a.json ? undefined : (l) => err(l),
    });
  } catch (e) {
    return fail(`could not run: ${e instanceof Error ? e.message : String(e)}`, IMPROVE_EXIT.couldNotRun);
  }
  if (f.scheduled !== undefined && !run && !a.json) out("(scheduled, dry: set [improve] scheduled = \"run\" in policy.toml to let the schedule write proposals)");
  if (a.json) out(JSON.stringify(report, null, 2));
  else for (const l of formatImprove(report)) out(l);
  return IMPROVE_EXIT.ok;
}
