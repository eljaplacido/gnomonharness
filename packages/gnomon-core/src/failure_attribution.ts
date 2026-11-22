/**
 * Layer-tagged failure attribution: why did this turn or cell fail?
 *
 * A failed cell tells you it failed; it does not tell you which part of the
 * harness to look at. This module reads what gnomon already records about a
 * turn (stop reason, bucket, exit code, tool log, counters, the trail's
 * model_call, verify and tamper records) and names ONE primary cause, tagged
 * with the harness layer it belongs to, plus the other causes it also saw.
 *
 * The layers are the survey's ETCLOVG: Execution (the model and the loop),
 * Tools, Context, Lifecycle (budgets, launch), Observability, Verification,
 * Governance. A tag is a pointer to a layer, not a verdict on a model: the
 * catch-all `wrong_result` says only that the run finished, changed something,
 * ran commands, and the external check still failed. That is where the
 * harness cannot tell a wrong solution from a right one, and it says so.
 *
 * Deterministic and model-free: first match by PRECEDENCE wins, every other
 * match is listed as secondary. The precedence is the contract
 * (docs/CONTRACTS.md section 60, conformance/failure_attribution.json):
 * terminal causes outrank causes along the way, tool and policy causes outrank
 * verification causes, and the catch-all comes last.
 *
 * Pure: no I/O, no clock, no randomness. Reads only the fields below, all of
 * which `record = "metadata"` trails carry. Nothing here ever reads prompt or
 * response text.
 */

export const ATTRIBUTION_SCHEMA = "gnomon.attribution/1";

export const ETCLOVG_LAYERS = ["execution", "tools", "context", "lifecycle", "observability", "verification", "governance"] as const;
export type EtclovgLayer = (typeof ETCLOVG_LAYERS)[number];

/**
 * Every failure tag, in PRECEDENCE order (first match is the primary cause),
 * with its layer. `unknown` has no layer: nothing was recorded that says why.
 */
export const FAILURE_TAGS = [
  { tag: "record_tamper", layer: "governance" },
  { tag: "launch_failure", layer: "lifecycle" },
  { tag: "context_overflow", layer: "context" },
  { tag: "endpoint_error", layer: "execution" },
  { tag: "budget_exhausted", layer: "lifecycle" },
  { tag: "tool_call_malformed", layer: "tools" },
  { tag: "output_truncated", layer: "context" },
  { tag: "loop_stall", layer: "execution" },
  { tag: "policy_refusal", layer: "governance" },
  { tag: "edit_failed", layer: "tools" },
  { tag: "tool_timeout", layer: "tools" },
  { tag: "tool_error", layer: "tools" },
  { tag: "verify_misled", layer: "verification" },
  { tag: "verify_failed", layer: "verification" },
  { tag: "wrong_thing_verified", layer: "verification" },
  { tag: "context_loss", layer: "context" },
  { tag: "no_deliverable", layer: "execution" },
  { tag: "unverified_finish", layer: "verification" },
  { tag: "wrong_result", layer: "execution" },
  { tag: "unknown", layer: null },
] as const;
export type FailureTag = (typeof FAILURE_TAGS)[number]["tag"];
export const FAILURE_TAG_NAMES: readonly FailureTag[] = FAILURE_TAGS.map((t) => t.tag);
const LAYER_OF = new Map<string, EtclovgLayer | null>(FAILURE_TAGS.map((t) => [t.tag, t.layer]));
const RANK_OF = new Map<string, number>(FAILURE_TAGS.map((t, i) => [t.tag, i + 1]));

export const layerOf = (tag: FailureTag): EtclovgLayer | null => LAYER_OF.get(tag) ?? null;

/** The numbers behind the rules. Published, so a reader can recompute a tag. */
export const ATTRIBUTION_THRESHOLDS = {
  /** A write/edit refused, or this many path refusals, makes a policy refusal the cause. */
  path_refusals: 2,
  /** Tool-call lines that are malformed before that is the cause (a `malformed` stop is always). */
  malformed_calls: 3,
  /** Tool timeouts before they are the cause (the last call timing out always is). */
  tool_timeouts: 5,
  /** Unrecoverable tool errors (not edits, not timeouts) before they are the cause. */
  tool_errors: 3,
  /** Edit/write failures before they are the cause (the last write failing always is). */
  edit_failures: 3,
} as const;

/** The turn fields attribution reads. A TaskRecord, a `turn` record and an eval cell's record all carry them. */
export interface AttributionTurn {
  stop_reason?: string;
  bucket?: string;
  code?: number;
  stop_detail?: { repeats?: number; signal?: string; deadline?: string } | null;
  tool_log?: string[];
  verify?: string | null;
  counters?: {
    writes?: number;
    worktree_moves?: number;
    malformed_tool_calls?: number;
    stall_signals?: { limit_cycle?: { count?: number }; no_progress?: { count?: number }; novelty_cusum?: { count?: number } };
    model_calls?: { trims?: { leg?: number; overflow?: number; dropped?: number } };
  } | null;
}

/** What the caller knows about the outcome. Absent `passed`: the run's own signals decide whether it failed. */
export interface AttributionCheck {
  passed?: boolean | null;
}

export interface AttributionInput {
  turn: AttributionTurn;
  /** The trail's other records (model_call, verify, record_tamper), when there is a trail. */
  records?: ReadonlyArray<Record<string, unknown>>;
  check?: AttributionCheck;
}

export interface Attribution {
  tag: FailureTag;
  layer: EtclovgLayer | null;
  /** The primary tag's place in the precedence list (1 is first). */
  rank: number;
  /** What the rule read: short, from the record, never prose from it. */
  signals: string[];
  /** Other tags that also matched, in precedence order. */
  secondary: FailureTag[];
}

interface Hit {
  tag: FailureTag;
  signal: string;
  /** Advisory hits are listed as secondary and never become the primary cause. */
  advisory?: boolean;
  /** The catch-all: the primary cause only when nothing more specific matched, and never listed as secondary. */
  fallback?: boolean;
}

// ---- tool_log parsing -------------------------------------------------------

type Tool = { raw: string; tool: string; path: string; refused: boolean; timeout: boolean; deadline: boolean; failed: boolean; nomatch: boolean; exit: number | null; deletions: number };

const TIMEOUT = /— timeout\b/;
const EDIT_FAIL = /— (?:no match|not unique|ambiguous|stale|failed|could not)/;
const WRITE_LINE = /\(\+\d+ −(\d+)\)/;

function parseTool(raw: string): Tool {
  const first = raw.split(" ")[0] ?? "";
  const tool = first === "bash" || first === "write" || first === "edit" || first === "read" || first === "compute" || first === "verify" ? first : first;
  const second = raw.split(" ")[1] ?? "";
  const exit = /^bash — exit (\d+)/.exec(raw) ?? /^verify — bash — exit (\d+)/.exec(raw);
  const del = WRITE_LINE.exec(raw);
  return {
    raw,
    tool,
    path: second === "—" ? "" : second,
    refused: /— refused \(/.test(raw),
    timeout: TIMEOUT.test(raw),
    deadline: /— timeout \(deadline\)/.test(raw),
    failed: EDIT_FAIL.test(raw),
    nomatch: /— no match/.test(raw),
    exit: exit ? Number(exit[1]) : null,
    deletions: del ? Number(del[1]) : 0,
  };
}

const isWriteTool = (t: Tool): boolean => (t.tool === "write" || t.tool === "edit") && !t.refused;
/** A path a person would read as a test or a check, not as the deliverable. */
const TESTISH = /(^|\/)(tests?|spec|specs|__tests__)\/|(^|\/)test_[^/]*$|[._-](?:test|spec)\.[a-z]+$|(^|\/)[^/]*(?:check|verify)[^/]*\.(?:py|sh|ts|js|mjs|rb)$/i;
const DOCISH = /\.(?:md|txt|rst)$/i;
const SCRATCH = /(^|\/)\.gnomon-[a-z]+\//;

// ---- the rules --------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function evaluate(input: AttributionInput): { hits: Hit[]; failed: boolean; evidence: boolean } {
  const t = input.turn;
  const stop = t.stop_reason ?? "";
  const code = num(t.code);
  const log = (t.tool_log ?? []).map(parseTool);
  const records = input.records ?? [];
  const cn = t.counters ?? {};
  const hits: Hit[] = [];
  const add = (tag: FailureTag, signal: string, advisory = false, fallback = false): void => {
    hits.push({ tag, signal, ...(advisory ? { advisory } : {}), ...(fallback ? { fallback } : {}) });
  };

  const modelErrors = records.filter((r) => r.kind === "model_call" && num(r.code) !== 0);
  const lastModelCode = (() => {
    const calls = records.filter((r) => r.kind === "model_call");
    return calls.length ? num(calls[calls.length - 1]!.code) : 0;
  })();
  const verifyRecords = records.filter((r) => r.kind === "verify");
  const lastVerifyRecord = verifyRecords.length ? verifyRecords[verifyRecords.length - 1]! : null;

  // 1 record_tamper
  if (stop === "tamper") add("record_tamper", "stop_reason tamper");
  else if (records.some((r) => r.kind === "record_tamper")) add("record_tamper", "a record_tamper record");

  // 2 launch_failure
  if (stop === "apparatus") add("launch_failure", "stop_reason apparatus (the run could not start)");

  // 3 context_overflow: code 13, "the context could not be fitted"
  if (stop === "endpoint_error" && code === 13) add("context_overflow", "endpoint_error code 13");
  else if (lastModelCode === 13) add("context_overflow", "the last model_call code 13");

  // 4 endpoint_error: the provider failed past the transport grace
  if (stop === "endpoint_error" && code !== 13) add("endpoint_error", `endpoint_error code ${code}`);
  else if ([10, 11, 12].includes(lastModelCode)) add("endpoint_error", `the last model_call code ${lastModelCode}`);
  else if (modelErrors.length > 0) add("endpoint_error", `${modelErrors.length} model_call(s) failed`, true);

  // 5 budget_exhausted: the clock or the step cap ended the run
  if (stop === "deadline" || stop === "step_wall" || stop === "killed") add("budget_exhausted", `stop_reason ${stop}`);
  else if (log.some((l) => l.deadline)) add("budget_exhausted", "a tool call was cut by the deadline");

  // 6 tool_call_malformed: calls the loop could not run
  const malformedLines = log.filter((l) => /— command is not a string|— malformed|— invalid arguments/.test(l.raw)).length;
  const malformedCount = Math.max(num(cn.malformed_tool_calls), malformedLines);
  if (stop === "malformed") add("tool_call_malformed", "stop_reason malformed");
  else if (stop === "truncated" && num(t.stop_detail?.repeats) > 0) add("tool_call_malformed", `stop_reason truncated with repeats ${num(t.stop_detail?.repeats)} (tool calls cut at the output limit)`);
  else if (malformedCount >= ATTRIBUTION_THRESHOLDS.malformed_calls) add("tool_call_malformed", `${malformedCount} malformed tool call(s)`);
  else if (malformedCount > 0) add("tool_call_malformed", `${malformedCount} malformed tool call(s)`, true);

  // 7 output_truncated: a reply cut at the output limit with no tool call to blame
  if (stop === "truncated" && !(num(t.stop_detail?.repeats) > 0)) add("output_truncated", "stop_reason truncated");

  // 8 loop_stall
  const ss = cn.stall_signals ?? {};
  const stalled = num(ss.limit_cycle?.count) + num(ss.no_progress?.count) + num(ss.novelty_cusum?.count);
  if (stop === "stall") add("loop_stall", "stop_reason stall");
  else if (stalled > 0) add("loop_stall", `${stalled} stall signal(s)`, true);

  // 9 policy_refusal: a boundary the run could not cross
  // A refused write into the OS temp directory is scratch the agent re-routes, not a blocked deliverable.
  const scratch = (l: Tool): boolean => /^\/(?:var\/)?tmp\//.test(l.path);
  const pathRefusals = log.filter((l) => l.refused && !scratch(l) && /refused \((?:outside the root|outside sandbox|surface is read-only)\)/.test(l.raw));
  const writeRefused = log.some((l) => (l.tool === "write" || l.tool === "edit") && l.refused && !scratch(l));
  if (writeRefused || pathRefusals.length >= ATTRIBUTION_THRESHOLDS.path_refusals) {
    add("policy_refusal", writeRefused ? "a write or edit was refused" : `${pathRefusals.length} calls refused outside the root or sandbox`);
  } else if (log.some((l) => l.refused)) {
    add("policy_refusal", `${log.filter((l) => l.refused).length} refused call(s)`, true);
  }

  // 10 edit_failed
  const writes = log.filter((l) => (l.tool === "write" || l.tool === "edit") && !l.refused);
  const editFails = writes.filter((l) => l.failed);
  const lastWrite = writes.length ? writes[writes.length - 1]! : null;
  if (editFails.length > 0 && ((lastWrite && lastWrite.failed) || editFails.length >= ATTRIBUTION_THRESHOLDS.edit_failures)) {
    add("edit_failed", `${editFails.length} edit/write call(s) failed (${editFails.some((l) => l.nomatch) ? "no match" : "failed"})`);
  } else if (editFails.length > 0) add("edit_failed", `${editFails.length} edit/write call(s) failed`, true);

  // 11 tool_timeout
  const timeouts = log.filter((l) => l.timeout);
  const acting = log.filter((l) => l.tool !== "todo" && l.tool !== "note");
  if (timeouts.length > 0 && ((acting.length > 0 && acting[acting.length - 1]!.timeout) || timeouts.length >= ATTRIBUTION_THRESHOLDS.tool_timeouts)) {
    add("tool_timeout", `${timeouts.length} bash timeout(s)`);
  } else if (timeouts.length > 0) add("tool_timeout", `${timeouts.length} bash timeout(s)`, true);

  // 12 tool_error: a tool that kept failing for reasons other than edits and timeouts
  const toolErrors = log.filter((l) => (l.tool === "compute" || l.tool === "glob" || l.tool === "grep" || l.tool === "read") && /— (?:unknown name|unexpected|the exponent|failed|error)/.test(l.raw));
  if (toolErrors.length >= ATTRIBUTION_THRESHOLDS.tool_errors) add("tool_error", `${toolErrors.length} tool error(s)`);
  else if (toolErrors.length > 0) add("tool_error", `${toolErrors.length} tool error(s)`, true);

  // 13 verify_misled / 14 verify_failed: the declared check, against the external one
  const verifyState = t.verify ?? (lastVerifyRecord && lastVerifyRecord.declined !== true ? (lastVerifyRecord.passed === true || lastVerifyRecord.ok === true ? "passed" : lastVerifyRecord.unrunnable === true ? "unrunnable" : "failed") : null);
  const externalFailed = input.check?.passed === false;
  if (verifyState === "passed" && externalFailed) add("verify_misled", "the declared [verify] check passed and the external check failed");
  if (verifyState === "failed") add("verify_failed", "the declared [verify] check failed at the end");

  // 15 wrong_thing_verified: a failing check was edited until it passed
  const twv = wrongThingVerified(log);
  if (twv) add("wrong_thing_verified", twv);

  // 16 context_loss: the provider refused a request as too long and gnomon dropped half the context
  const trims = cn.model_calls?.trims ?? {};
  if (num(trims.overflow) > 0) add("context_loss", `${num(trims.overflow)} overflow trim(s), ${num(trims.dropped)} message(s) dropped`);

  // 17 no_deliverable / 18 unverified_finish / 19 wrong_result: finished normally, failed anyway
  const finished = stop === "answered" || stop === "empty";
  const realWrites = writes.filter((l) => !l.failed && !DOCISH.test(l.path) && !SCRATCH.test(l.path));
  if (finished && num(cn.writes) === 0 && num(cn.worktree_moves) === 0 && writes.length === 0) add("no_deliverable", "answered with no write, no edit and no change to the tree");
  const lastReal = realWrites.length ? log.lastIndexOf(realWrites[realWrites.length - 1]!) : -1;
  if (finished && lastReal >= 0 && !log.slice(lastReal + 1).some((l) => l.exit !== null)) add("unverified_finish", "no command ran after the last deliverable write");
  if (finished && (writes.length > 0 || num(cn.writes) > 0 || num(cn.worktree_moves) > 0)) add("wrong_result", "answered after a change and a command, and the check still failed", false, true);

  const evidence = log.length > 0 || records.length > 0 || stop !== "" || t.bucket !== undefined;
  const abnormal = (stop !== "" && stop !== "answered" && stop !== "empty") || (t.bucket !== undefined && t.bucket !== "result") || verifyState === "failed";
  return { hits, failed: input.check?.passed === false ? true : input.check?.passed === true ? false : abnormal, evidence };
}

/**
 * A check or test file edited after a failing command, then a command that
 * exits 0, with no change to any other file in between: the check was made to
 * pass, not the code. Reads only the tool log.
 */
function wrongThingVerified(log: Tool[]): string | null {
  for (let i = 0; i < log.length; i++) {
    const l = log[i]!;
    if (!(l.tool === "edit" || (l.tool === "write" && l.deletions > 0)) || l.refused || !TESTISH.test(l.path)) continue;
    let fail = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (log[j]!.exit !== null && log[j]!.exit !== 0) {
        fail = j;
        break;
      }
    }
    if (fail < 0) continue;
    let pass = -1;
    for (let j = i + 1; j < log.length; j++) {
      if (log[j]!.exit === 0) {
        pass = j;
        break;
      }
    }
    if (pass < 0) continue;
    const other = log.slice(fail + 1, pass).some((x, k) => isWriteTool(x) && fail + 1 + k !== i && !TESTISH.test(x.path) && !SCRATCH.test(x.path));
    if (!other) return `${l.path} was edited after a failing command and a command then passed, with no other file changed`;
  }
  return null;
}

/**
 * The primary cause of a failed turn, or null when there is no failure to
 * explain (the check passed, or the run shows no failure signal at all).
 */
export function attributeFailure(input: AttributionInput): Attribution | null {
  if (input.check?.passed === true) return null;
  const { hits, failed, evidence } = evaluate(input);
  if (!failed) return null;
  const primary = hits.find((h) => !h.advisory);
  if (!primary) {
    return { tag: "unknown", layer: null, rank: RANK_OF.get("unknown")!, signals: [evidence ? "no recorded signal explains the failure" : "no record to read"], secondary: [...new Set(hits.map((h) => h.tag))] };
  }
  const secondary: FailureTag[] = [];
  for (const h of hits) if (h !== primary && !h.fallback && h.tag !== primary.tag && !secondary.includes(h.tag)) secondary.push(h.tag);
  return { tag: primary.tag, layer: layerOf(primary.tag), rank: RANK_OF.get(primary.tag)!, signals: [primary.signal], secondary };
}

/** A per-tag and per-layer count of attributions. */
export interface AttributionHistogram {
  failed: number;
  by_tag: Record<string, number>;
  by_layer: Record<string, number>;
}

export function attributionHistogram(items: ReadonlyArray<Pick<Attribution, "tag" | "layer"> | null | undefined>): AttributionHistogram {
  const h: AttributionHistogram = { failed: 0, by_tag: {}, by_layer: {} };
  for (const a of items) {
    if (!a) continue;
    h.failed++;
    h.by_tag[a.tag] = (h.by_tag[a.tag] ?? 0) + 1;
    const layer = a.layer ?? "none";
    h.by_layer[layer] = (h.by_layer[layer] ?? 0) + 1;
  }
  const order = (m: Record<string, number>, keys: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of keys) if (m[k] !== undefined) out[k] = m[k]!;
    return out;
  };
  return { failed: h.failed, by_tag: order(h.by_tag, FAILURE_TAG_NAMES), by_layer: order(h.by_layer, [...ETCLOVG_LAYERS, "none"]) };
}

/** What a session trail's records say about a failure: the last turn record and all the records. */
export function attributeTrail(records: ReadonlyArray<Record<string, unknown>>, check?: AttributionCheck): Attribution | null {
  const turns = records.filter((r) => r.kind === "turn");
  const last = turns.length ? turns[turns.length - 1]! : null;
  if (!last) return null;
  // A session of several turns: the tool log is the whole session's, so a pattern across turns is seen.
  const log = turns.flatMap((r) => (Array.isArray(r.tool_log) ? (r.tool_log as string[]) : []));
  return attributeFailure({ turn: { ...(last as AttributionTurn), tool_log: log }, records, ...(check ? { check } : {}) });
}

/** The words a person reads: "Tools / tool_call_malformed". */
export const describeAttribution = (a: Pick<Attribution, "tag" | "layer">): string => `${a.layer ?? "no layer"} / ${a.tag}`;
