/**
 * gnomon-cli: `gnomon eval --ablate`.
 *
 * `eval --ablate [components] [--families a,b] [--run] [--k N] [--budget-usd X]
 * [--max-requests N] [--propose] [--json]` is a load-bearing analysis of the
 * project's own surface (gnomon-core ablate.ts): one arm per component, each
 * the surface with exactly that one thing removed or neutralised, measured
 * against the base on the trial spec. Dry by default. Governance (policy deny
 * rules, sandbox, guard, audit) is never a component. Contract: docs/CONTRACTS.md
 * section 60.
 */

import {
  ABLATE_SCHEMA,
  AblateRefusal,
  ImproveRefusal,
  agentReason,
  resolveExec,
  runAblate,
  type AblateReport,
  type AblateRow,
  type EvalCellRunner,
  type GnomonConfig,
  type TrustOutcome,
} from "gnomon-core";

export const ABLATE_EXIT = { ok: 0, usage: 1, refused: 3, couldNotRun: 10 } as const;

export interface AblateBindings {
  runCell?: EvalCellRunner;
  settleTrust?: (config: GnomonConfig) => TrustOutcome | undefined;
}

export interface AblateCliArgs {
  flags: Record<string, string>;
  json: boolean;
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const pp = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`;

function rowLine(r: AblateRow): string {
  const head = `  ${r.component.padEnd(28)} ${r.family.padEnd(10)}`;
  if (r.status !== "measured") return `${head} ${r.verdict.padEnd(12)} (${r.status}: ${r.reason ?? ""})`;
  const d = r.delta!;
  const cost = d.cost_usd === null ? "" : `, cost ${d.cost_usd >= 0 ? "+" : ""}$${d.cost_usd}`;
  return `${head} ${r.verdict.padEnd(12)} pass ${r.base!.passes}/${r.base!.n} -> ${r.ablated!.passes}/${r.ablated!.n} (${pp(d.pass)}, McNemar p ${r.mcnemar_p ?? "n/a"}), steps ${pct(d.steps)}, tokens ${pct(d.tokens)}${cost}, refusals ${r.base!.refusals} -> ${r.ablated!.refusals}`;
}

export function formatAblate(r: AblateReport): string[] {
  const out: string[] = [];
  out.push(r.mode === "dry-run" ? "gnomon eval --ablate (dry run): nothing is written and no model is called." : `gnomon eval --ablate (run ${r.run})`);
  out.push(`Never ablated: ${r.never_ablated.join(", ")}.`);
  out.push(r.spec ? `Spec: .gnomon/trials/${r.spec.name}.toml, k = ${r.spec.k}, ${r.spec.tasks} task(s).` : "Spec: none.");
  out.push(`Families: ${r.families.map((f) => `${f.family} (role ${f.role}, ${f.local ? "local" : "NOT local"})`).join(", ")}.`);
  out.push(`Arms (${r.plan.arms.length}), each the surface with exactly one component removed or neutralised:`);
  for (const a of r.plan.arms) out.push(`  ${a.id.padEnd(28)} ${a.action.padEnd(9)} ${a.label}  [${a.files.join(", ")}]`);
  out.push(`Estimated ${r.plan.cells} cell(s): ${r.plan.arms.length} arm(s) x ${r.families.length} famil${r.families.length === 1 ? "y" : "ies"} x ${r.plan.cells_per_arm_family} (each in a temporary clone)${r.plan.billed ? "; a family is NOT local, so cells are billed (cost needs [improve] rates, or --max-requests)" : "; local, no spend"}.`);
  if (r.mode === "run") {
    out.push("Component x family (ablated minus base):");
    for (const row of r.rows) out.push(rowLine(row));
    out.push("Verdicts (never applied automatically):");
    for (const c of r.components) out.push(`  ${c.component.padEnd(28)} ${c.verdict}${c.neutral_and_cheaper ? " (neutral and cheaper: a candidate for removal)" : ""}`);
    for (const p of r.proposals) out.push(`  proposal ${p.component}: ${p.status}${p.id ? ` ${p.id}` : ""}${p.reason ? ` (${p.reason})` : ""}`);
    out.push(`Spent ${JSON.stringify(r.budget)}.`);
  }
  for (const p of r.problems) out.push(`  problem: ${p}`);
  if (r.mode === "dry-run") out.push("Run with --run to measure. Nothing under .gnomon/ changes either way.");
  else out.push("Nothing under .gnomon/ was changed. Accepting a removal is a person's decision (--propose writes proposals for gnomon proposals).");
  return out;
}

/** Exit 0 done (a dry run included), 1 usage, 3 refused, 10 could not run. */
export async function runAblateCmd(config: GnomonConfig, a: AblateCliArgs, bind: AblateBindings = {}, out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const fail = (msg: string, code: number): number => {
    if (a.json) out(JSON.stringify({ schema: ABLATE_SCHEMA, error: msg, exit: code }, null, 2));
    else err(`gnomon eval --ablate: ${msg}`);
    return code;
  };
  const f = a.flags;
  const flag = (k: string): string | undefined => (typeof f[k] === "string" && f[k] !== "true" ? f[k] : undefined);
  const known = new Set(["ablate", "run", "dry-run", "families", "k", "budget-usd", "max-requests", "propose", "spec", "json", "profile", "dir", "yes-spend", "yes", "trust", "allow-host-probes"]);
  const stray = Object.keys(f).filter((k) => !known.has(k));
  if (stray.length > 0) return fail(`unknown option --${stray[0]}: eval --ablate [components] [--families a,b] [--run] [--k N] [--budget-usd X] [--max-requests N] [--propose] [--spec name] [--allow-host-probes] [--json]`, ABLATE_EXIT.usage);
  if (f.run !== undefined && f["dry-run"] !== undefined) return fail("--run and --dry-run are opposites; pass one", ABLATE_EXIT.usage);
  const run = f.run !== undefined;
  const k = flag("k");
  if (f.k !== undefined && (!k || !/^\d+$/.test(k) || Number(k) < 1 || Number(k) > 20)) return fail("--k is a whole number from 1 to 20 (attempts per task per arm)", ABLATE_EXIT.usage);
  const budget = flag("budget-usd");
  if (f["budget-usd"] !== undefined && (!budget || !Number.isFinite(Number(budget)) || Number(budget) < 0)) return fail("--budget-usd is a number of dollars, 0 or more", ABLATE_EXIT.usage);
  const maxReq = flag("max-requests");
  if (f["max-requests"] !== undefined && (!maxReq || !/^\d+$/.test(maxReq) || Number(maxReq) < 1)) return fail("--max-requests is a whole number of model requests, 1 or more", ABLATE_EXIT.usage);
  if (f.families !== undefined && !flag("families")) return fail("--families names model families, e.g. --families qwen,claude", ABLATE_EXIT.usage);
  if (f.propose !== undefined && !run) return fail("--propose writes proposals from measured results, so it needs --run", ABLATE_EXIT.usage);

  if (run) {
    const why = agentReason();
    if (why) return fail(`not run: ${why}. gnomon eval --ablate --run spends model time; a person starts it.`, ABLATE_EXIT.refused);
    if (f["allow-host-probes"] === undefined) {
      const level = (config.policy?.sandbox as { level?: unknown } | undefined)?.level;
      const confined = level === "confined" || level === "strict" || resolveExec(config).mode !== "off";
      if (!confined) {
        return fail('not run: arms run model-written commands on this machine and [sandbox] is not confined. Set [sandbox] level = "confined" or "strict", or exec = "docker" or "os" in policy.toml, or pass --allow-host-probes to accept that for this run.', ABLATE_EXIT.refused);
      }
    }
  }

  const sel = flag("ablate");
  const fams = flag("families");
  let report: AblateReport;
  try {
    report = await runAblate(config, {
      run,
      ...(sel ? { components: sel.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(fams ? { families: fams.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(k ? { k: Number(k) } : {}),
      ...(budget ? { budgetUsd: Number(budget) } : {}),
      ...(maxReq ? { maxRequests: Number(maxReq) } : {}),
      ...(flag("spec") ? { spec: flag("spec") } : {}),
      propose: f.propose !== undefined,
      ...bind,
      yesSpend: f["yes-spend"] !== undefined,
      log: a.json ? undefined : (l) => err(l),
    });
  } catch (e) {
    if (e instanceof AblateRefusal || e instanceof ImproveRefusal) return fail(`not run: ${e.message}`, ABLATE_EXIT.refused);
    return fail(`could not run: ${e instanceof Error ? e.message : String(e)}`, ABLATE_EXIT.couldNotRun);
  }
  if (a.json) out(JSON.stringify(report, null, 2));
  else for (const l of formatAblate(report)) out(l);
  return ABLATE_EXIT.ok;
}
