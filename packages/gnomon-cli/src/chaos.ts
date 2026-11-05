/**
 * gnomon-cli: `gnomon chaos` — the fault-injection suite (gnomon-core
 * chaos.ts, chaos_suite.ts), its taxonomy, and its endpoint served for another
 * harness.
 *
 * A separate suite, in the sense docs/benchmarks/CHAOS.md and the adoption
 * ladder use the word: it runs in a scratch project against a loopback
 * endpoint, never against a benchmark surface, and nothing it does changes a
 * default anything else reads.
 */

import { writeFileSync, appendFileSync } from "node:fs";
import {
  CHAOS_FAULTS,
  CHAOS_SCHEDULES,
  CHAOS_TASKS,
  ChaosEndpoint,
  caseSeed,
  chaosExpected,
  chaosFault,
  chaosTaskInput,
  chaosToken,
  mulberry32,
  runChaosSuite,
  unknownChaosFaults,
  type ChaosCaseRow,
  type ChaosSchedule,
  type ChaosScorecard,
} from "gnomon-core";

export const CHAOS_USAGE = `Usage: gnomon chaos [--json] [--seed <n>] [--faults <id,...>] [--schedules <s,...>] [--out <file>] [--keep]
       gnomon chaos list [--json]
       gnomon chaos serve [--port <n>] [--fault <id>] [--schedule <s>] [--seed <n>] [--log <file.jsonl>]

Runs a fixed task set against a scripted model behind a loopback endpoint that
injects one fault per case, and scores each fault ANNOUNCED (an exit status, a
stop_reason, a declared degradation, or a stderr line naming it, each read
against a clean run of the same task) or SILENT. gnomon is measured as
\`gnomon task --json\` runs it. Spec: docs/benchmarks/CHAOS.md.

  --faults      ids or types from \`gnomon chaos list\` (empty = empty.content and empty.tool_calls)
  --schedules   ${CHAOS_SCHEDULES.join(", ")}
  --seed        the run's seed (default 1); same build + same seed = same scorecard outside \`volatile\`
  --out         also write the scorecard JSON to <file>
  --keep        keep the scratch project; its audit trail holds every case

serve runs the endpoint alone, for another harness pointed at it as an
OpenAI-compatible endpoint. POST /chaos/case {"fault","schedule","seed"} starts
a case, GET /chaos/log reads its span.

Exit: 0 every injected fault announced, 1 one or more silent, 2 the run is void
(a control did not hold, a clean run failed, or a fault never fired).`;

interface ChaosArgs {
  sub?: string;
  flags: Record<string, string>;
  positional: string[];
}

export function parseChaosArgs(argv: string[]): ChaosArgs {
  const out: ChaosArgs = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = "true";
    } else if (out.sub === undefined && out.positional.length === 0 && (a === "list" || a === "serve" || a === "run")) {
      out.sub = a;
    } else out.positional.push(a);
  }
  return out;
}

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Run the command; returns the exit code rather than exiting, for tests. */
export async function cmdChaos(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  err: (s: string) => void = (s) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`)
): Promise<number> {
  const args = parseChaosArgs(argv);
  if (args.flags.help === "true" || args.flags.h === "true") {
    out(CHAOS_USAGE);
    return 0;
  }
  if (args.positional.length > 0) {
    err(`gnomon chaos: unexpected argument "${args.positional[0]}"\n\n${CHAOS_USAGE}`);
    return 2;
  }
  if (args.sub === "list") return listFaults(args, out);
  if (args.sub === "serve") return serve(args, out, err);

  const seed = args.flags.seed === undefined ? 1 : Number(args.flags.seed);
  if (!Number.isInteger(seed) || seed < 0) {
    err(`gnomon chaos: --seed takes a non-negative integer, not "${args.flags.seed}"`);
    return 2;
  }
  const faults = list(args.flags.faults);
  const unknown = unknownChaosFaults(faults);
  if (unknown.length > 0) {
    err(`gnomon chaos: no fault named ${unknown.map((u) => `"${u}"`).join(", ")} — see \`gnomon chaos list\``);
    return 2;
  }
  const schedules = list(args.flags.schedules);
  const badSchedule = schedules.filter((s) => !(CHAOS_SCHEDULES as readonly string[]).includes(s));
  if (badSchedule.length > 0) {
    err(`gnomon chaos: no schedule named ${badSchedule.map((u) => `"${u}"`).join(", ")} — one of ${CHAOS_SCHEDULES.join(", ")}`);
    return 2;
  }
  const json = args.flags.json === "true";
  const live = !json;
  if (live) out(`gnomon chaos — seed ${seed}, measuring \`gnomon task --json\` against a scripted model on 127.0.0.1`);

  const card = await runChaosSuite({
    seed,
    faults,
    schedules: schedules as ChaosSchedule[],
    keep: args.flags.keep === "true",
    onPhase: live ? (l) => out(`  · ${l}`) : undefined,
    onCase: live ? (r) => out(caseLine(r)) : undefined,
  });

  if (args.flags.out && args.flags.out !== "true") {
    writeFileSync(args.flags.out, `${JSON.stringify(card, null, 2)}\n`);
  }
  if (json) out(JSON.stringify(card, null, 2));
  else out(renderCard(card));
  return card.exit;
}

function caseLine(r: ChaosCaseRow): string {
  const verdict = !r.fired ? "NOT FIRED" : r.silent ? "SILENT   " : "announced";
  const how = r.channels.length ? r.channels.join("+") : "—";
  return `    ${verdict}  ${r.id.padEnd(34)} ${how.padEnd(28)} ${r.recovered ? "recovered" : "not recovered"}`;
}

/** The scorecard as a table. */
export function renderCard(card: ChaosScorecard & { workdir?: string }): string {
  const lines: string[] = [""];
  const a = card.apparatus;
  if (!a.ok) {
    lines.push("  THE RUN IS VOID — nothing below may be read as a result:");
    for (const p of a.problems) lines.push(`    ✗ ${p}`);
    lines.push("");
  }
  const controls = card.controls.filter((c) => c.ok).length;
  lines.push(
    `  controls ${controls}/${card.controls.length} held · lane check ${a.lane_check.serial_equals_concurrent && a.lane_check.garbling_caught ? "held" : "FAILED"} (serial = concurrent, a garbling lane caught) · clean runs ${a.baselines.filter((b) => b.recovered).length}/${a.baselines.length} finished`
  );
  lines.push("");
  const head = ["fault", "cases", "announced", "named", "recovered", "wasted tok", "verdict"];
  const rows = card.faults.map((f) => [
    f.id,
    String(f.cases),
    `${f.announced}/${f.fired}`,
    `${f.named}/${f.fired}`,
    `${f.recovered}/${f.fired}`,
    String(f.tokens_wasted),
    f.verdict === "silent" ? "SILENT" : f.verdict === "not_fired" ? "NOT FIRED" : "announced",
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => "  " + r.map((c, i) => (i === 0 ? c.padEnd(width[i]!) : c.padStart(width[i]!))).join("  ");
  lines.push(fmt(head));
  for (const r of rows) lines.push(fmt(r));
  lines.push("");
  const s = card.summary;
  lines.push(
    `  ANNOUNCED ${s.faults_announced}/${s.faults} faults (${s.cases_announced}/${s.cases_fired} cases; ${s.cases_named} named the fault)` +
      (s.faults_silent.length ? ` · silent: ${s.faults_silent.join(", ")}` : "")
  );
  lines.push(
    `  silent-failure share ${s.silent_failures}/${s.failed} = ${(s.silent_failure_share * 100).toFixed(1)}% ` +
      `(failed cases no channel announced; AgentChaos measured 21–66% across five published systems)`
  );
  lines.push(`  ${s.tokens_wasted} tokens billed beyond the clean runs · plan ${card.plan_hash.slice(0, 12)} · ${card.harness}`);
  if (card.workdir) lines.push(`  scratch project kept at ${card.workdir}`);
  lines.push(`  exit ${card.exit}`);
  return lines.join("\n");
}

function listFaults(args: ChaosArgs, out: (s: string) => void): number {
  if (args.flags.json === "true") {
    out(
      JSON.stringify(
        {
          schedules: CHAOS_SCHEDULES,
          tasks: CHAOS_TASKS,
          faults: CHAOS_FAULTS.map((f) => ({ ...f, names: f.names.source })),
        },
        null,
        2
      )
    );
    return 0;
  }
  out(`${CHAOS_FAULTS.length} faults · schedules: ${CHAOS_SCHEDULES.join(", ")} · tasks: ${CHAOS_TASKS.join(", ")}\n`);
  for (const f of CHAOS_FAULTS) {
    out(`  ${f.id.padEnd(22)} ${f.family.padEnd(16)} ${f.task.padEnd(6)} ${(f.stream ? "stream" : "json").padEnd(6)} ${f.schedules.join(",")}`);
    out(`  ${"".padEnd(22)} ${f.injects}`);
  }
  return 0;
}

async function serve(args: ChaosArgs, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const seed = args.flags.seed === undefined ? 1 : Number(args.flags.seed);
  const port = args.flags.port === undefined ? 0 : Number(args.flags.port);
  const faultId = args.flags.fault;
  const fault = faultId ? chaosFault(faultId) : null;
  if (faultId && !fault) {
    err(`gnomon chaos serve: no fault named "${faultId}" — see \`gnomon chaos list\``);
    return 2;
  }
  const schedule = (args.flags.schedule ?? fault?.schedules[0] ?? "single") as ChaosSchedule;
  if (!(CHAOS_SCHEDULES as readonly string[]).includes(schedule)) {
    err(`gnomon chaos serve: no schedule named "${schedule}"`);
    return 2;
  }
  const logFile = args.flags.log;
  const ep = await ChaosEndpoint.start({
    port,
    onRequest: (entry, caseId) => {
      const line = JSON.stringify({ case: caseId, ...entry });
      if (logFile) appendFileSync(logFile, `${line}\n`);
      else out(line);
    },
  });
  const id = fault ? `${fault.id}/${schedule}` : "clean";
  ep.setCase({ id, fault: fault ?? null, schedule, seed: caseSeed(seed, id) });
  const token = chaosToken(mulberry32(caseSeed(seed, "serve")));
  err(`gnomon chaos serve — ${ep.url}`);
  err(`  case ${id} (seed ${seed}). Point an OpenAI-compatible harness at the URL above, model "chaos-model".`);
  err(`  Give it one of these tasks; a finished task's answer contains the expected text:`);
  for (const t of CHAOS_TASKS) err(`    ${t.padEnd(6)} "${chaosTaskInput(t, token)}"  → ${chaosExpected(t, token)}`);
  err(`  read needs chaos/input.txt holding ${chaosExpected("read", token).split(" ")[1]}; fix needs the check in docs/benchmarks/CHAOS.md.`);
  err(`  One JSON line per request${logFile ? ` to ${logFile}` : " on stdout"}. Ctrl+C stops.`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await ep.close();
  return 0;
}
