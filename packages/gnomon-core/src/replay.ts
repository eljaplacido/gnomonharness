/**
 * gnomon-core: Deterministic replay of a recorded session
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * A trail is a record. Until now it was something you read and believed. This
 * module turns a trail into something you can check: it takes the JSONL the
 * AuditTrail wrote, points it at a `.gnomon/` surface, and re-derives every
 * decision the HARNESS made — which model the role routed to, which tools were
 * offered, which calls the gate stopped, which bucket a code mapped to, which
 * stage of a declared chain ran where — then reports, per record, whether the
 * re-derived value equals the recorded one.
 *
 * It does NOT call a model. It cannot. The model's answers are already in the
 * trail, and that is the point: replay is not evidence that the model would say
 * the same thing twice. It is evidence that GIVEN THOSE ANSWERS the harness
 * reached the same decisions. Overclaiming this would be worse than not
 * building it, so the vocabulary is kept narrow throughout — replay compares
 * decisions, never behaviour-in-general, and never the model.
 *
 * Concretely, three separate things a reader must not conflate:
 *
 *   1. `verifyTrail` (audit.ts) answers "was this file edited after it was
 *      written". Hash chaining. Says nothing about whether the content is
 *      sane.
 *   2. `replay` (here) answers "do the harness's own decisions in this file
 *      follow from this surface". A forged but well-chained record fails here.
 *   3. Nothing in this repository answers "would the model answer this way
 *      again". Nothing can, and this module does not pretend otherwise.
 *
 * TWO SURFACES ARE NOT COMPARABLE, AND THAT IS REPORTED FIRST.
 *
 * The first thing `replay` establishes is whether the trail's `surface_hash`
 * equals the hash of the surface it is being replayed against. If it does not,
 * `verdict` is `"not_comparable"`, `surface` carries both hashes, and every
 * check that would have had to consult the surface is returned as UNCHECKABLE
 * with that reason attached. Reporting a "divergence" there would be a lie
 * about what was compared: the two runs were under different rules, so of
 * course the decisions differ, and a reader who saw DIVERGED would draw the
 * wrong conclusion. Checks that consult only the trail (`source: "trail"`)
 * still run, because they never touch the surface at all.
 *
 * UNCHECKABLE IS A LEGITIMATE STATE, NOT A SOFT FAILURE.
 *
 * A trail recorded at `[audit] record = "metadata"` deliberately holds no
 * prompt or response text. Skill selection matches against the input, so on
 * such a trail it cannot be re-derived. That is the surface working as
 * declared. It is reported UNCHECKABLE with the reason, never DIVERGED — the
 * failure this rule exists to prevent is a governance control (record less)
 * being punished by a verification tool (report a divergence), which would push
 * an operator toward recording text they had decided not to keep.
 *
 * WHAT THIS FOUND ABOUT THE `volatile` CONTRACT.
 *
 * `TaskRecord.volatile` (prompt_loop.ts) documents that "anything OUTSIDE this
 * object is reproducible". Building replay against that claim shows it is true
 * of one half of the record and false of the other, and the record does not
 * mark which is which:
 *
 *   - HARNESS_DERIVED below re-derives exactly. Those are decisions taken by
 *     this code from the surface and from the model's answers, and running
 *     them again on the same inputs gives the same values.
 *   - MODEL_SUPPLIED below does not. `output` is the model's text. `code` is
 *     the worst tool outcome the model's chosen calls produced, and `bucket` is
 *     computed from `code`. All three sit outside `volatile`, and two runs of
 *     the same task against a model at temperature > 0 can differ in all three
 *     with nothing about the surface having changed.
 *
 * So replay treats MODEL_SUPPLIED fields as INPUTS — it reads them and never
 * claims to re-derive them — and checks HARNESS_DERIVED fields. NOT VERIFIED:
 * this is read off the code path (runAgenticTurn -> TaskRecord), not measured
 * by running one task twice against a live endpoint. The narrower claim that
 * the tests here do substantiate is: given identical model answers, every
 * harness decision in HARNESS_DERIVED reproduces.
 *
 * PUBLISHED LIMITS. Each of these is a place replay cannot see, said plainly
 * rather than papered over:
 *
 *   - Measured while building this: a `task` tool call delegates a sub-turn
 *     that runs with the SAME trail (prompt_loop.ts delegate.run passes `deps`
 *     straight through), so the sub-turn's own `tool_call` records land in the
 *     trail interleaved with the parent's, while the parent's `tool_log` never
 *     mentions them. The first version of the tool-log check demanded exact
 *     equality and reported every delegating turn as tampered. When a `task`
 *     call is attributed to a turn, replay drops to an ordering check
 *     (the turn's log must be an ordered subsequence of the records) and says
 *     so in the check's `note` rather than silently weakening.
 *   - MCP tools are named `mcp__<server>__<tool>` and are discovered from a
 *     live server at connect time. The surface declares the SERVER, not its
 *     tool list, so whether such a tool was offered is not re-derivable from
 *     `.gnomon/` and is returned UNCHECKABLE.
 *   - Read from tools.ts, NOT VERIFIED against a live server: the `gated` field
 *     on a `tool_call` record is `needsApproval(tool, gate) && offered.has(tool)`,
 *     and `needsApproval` consults a fixed set that contains no MCP name — but
 *     `dispatch` gates every `mcp__*` call whenever the gate is not `never`. A
 *     trail can therefore show `gated: false` beside an `approval` record for
 *     the same MCP call. Replay reports the MCP `gated` field UNCHECKABLE
 *     rather than reproducing a value it knows to be misleading.
 *   - `GNOMON_MODEL_URL` replaces the declared endpoint URL at resolve time.
 *     If the trail says the override was in force, the destination was
 *     machine-scoped and is not in the surface: UNCHECKABLE. If the override is
 *     set in the REPLAYING process, re-deriving the URL would return the
 *     override rather than the declaration: also UNCHECKABLE, and for the
 *     opposite reason.
 *   - If the surface declares `[audit] redact` patterns, a `full` trail's
 *     recorded input is post-redaction. Re-running skill selection against it
 *     would not reproduce what actually ran, so it is UNCHECKABLE.
 *   - A turn that ran on a role's declared fallback model is reported as a
 *     MATCH with a note. Replay cannot tell whether the primary was tried and
 *     failed or was never reached; nothing in the record says.
 *   - An `approval` decision is an operator input, not a harness decision.
 *     Replay checks that the current surface would still have ASKED, and
 *     reports the decision itself UNCHECKABLE. It has no way to know what a
 *     person would say twice, and a tool that implied otherwise would be
 *     claiming oversight it cannot see.
 *   - Replay reads the surface as it is on disk NOW. It does not reconstruct an
 *     old surface from a hash: a hash is not a preimage. Against a changed
 *     surface it reports the difference and stops, which is the only honest
 *     option available to it.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  GnomonConfig,
  listRoles,
  routeRole,
  recomputeManifest,
  resolveChain,
  resolveVerify,
} from "./config.js";
import { mapBucket } from "./session.js";
import { buildToolSet, needsApproval, ApprovalGate } from "./tools.js";
import { loadSkills, selectSkills } from "./skills.js";
import { resolveAudit, verifyTrail, AuditRecord, AuditDetail } from "./audit.js";
import { harnessBuild } from "./build.js";

// ---------------------------------------------------------------------------
// The partition this module is built on
// ---------------------------------------------------------------------------

/**
 * Record fields that are INPUTS to the harness's decisions, never one of them.
 *
 * `output` and every tool call's name, arguments and outcome are the model's.
 * `input` is the operator's. `code` is the worst outcome the model's chosen
 * calls produced. Replay reads all of them and re-derives none — producing a
 * `replayed` value for any field here would be claiming to know what a model
 * or a person would do again, which is the one thing this module must not say.
 *
 * Every name here sits OUTSIDE `TaskRecord.volatile`, and none of them is
 * reproducible run to run against a model with any temperature at all. That is
 * the gap in the `volatile` contract; see the module comment.
 */
export const MODEL_SUPPLIED = [
  "output",
  "input",
  "code",
  "tool_call.tool",
  "tool_call.args",
  "tool_call.summary",
  "tool_call.code",
] as const;

/**
 * Decisions the HARNESS took. Every one of these is re-derived by `replay`.
 *
 * The test "checks every field it lists as harness-derived" keeps this list and
 * the checks below from drifting apart: a name added here with no check behind
 * it fails the suite rather than quietly becoming a promise the code does not
 * keep.
 */
export const HARNESS_DERIVED = [
  "bucket",
  "route.model",
  "route.endpoint",
  "route.url",
  "skills",
  "offered",
  "gated",
  "gate.asks",
  "chain.role",
  "chain.of",
  "verify.command",
  "verify.unrunnable",
  "verify.passed",
  "audit.record",
  "roles",
  "tool_steps",
  "tool_log",
  "turns",
  "surface_changed",
] as const;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type ReplayStatus = "match" | "diverged" | "uncheckable";

/** Where a check got the value it compared against. */
export type CheckSource =
  /** Derived from the trail alone. Runs even across two different surfaces. */
  | "trail"
  /** Re-derived from the surface on disk. Suppressed when the hashes differ. */
  | "surface"
  /** Compared against the harness build doing the replay. */
  | "build";

export interface ReplayCheck {
  /** The decision compared, e.g. `route.model`. Names in HARNESS_DERIVED. */
  field: string;
  status: ReplayStatus;
  source: CheckSource;
  /** What the trail says. Present unless the trail carried nothing to compare. */
  recorded?: unknown;
  /** What re-deriving produced. Absent when the check could not run. */
  replayed?: unknown;
  /**
   * Why a check is UNCHECKABLE, or the caveat attached to a MATCH.
   *
   * A match with a note is a match that was checked more weakly than the
   * others; the note says how. Silently weakening a check is the failure this
   * field exists to prevent.
   */
  note?: string;
}

export interface ReplayEntry {
  /** 0-based line number in the trail, so a reader can go and look. */
  index: number;
  seq: number | null;
  kind: string;
  status: ReplayStatus;
  checks: ReplayCheck[];
}

export interface ReplaySurface {
  /** The hash the trail says it ran under, or null if it recorded none. */
  recorded: string | null;
  /** The hash of the surface being replayed against, or null if unreadable. */
  current: string | null;
  status: "same" | "different" | "unknown";
  note: string;
}

export interface ReplayIntegrity {
  records: number;
  /** Line numbers that are not JSON — a truncated or corrupted trail. */
  malformed: number[];
  /** `verifyTrail`: does the hash chain hold. */
  chain_ok: boolean;
  broken: number[];
  /** `verifyTrail`: does the trail close with `session_end`. */
  sealed: boolean;
  /** Sequence numbers absent from the file. Capped; see `seq_gaps_truncated`. */
  seq_gaps: number[];
  seq_gaps_truncated: boolean;
}

export interface ReplayResult {
  /** The trail replayed, as given. */
  trail: string;
  /** Read this first. Two surfaces are not comparable. */
  surface: ReplaySurface;
  /** Same surface, different code, is still a different run. Reported, not folded in. */
  harness: { recorded: string | null; current: string; status: "same" | "different" | "unknown" };
  detail: AuditDetail | "unknown";
  integrity: ReplayIntegrity;
  entries: ReplayEntry[];
  totals: {
    checks: number;
    match: number;
    diverged: number;
    uncheckable: number;
    entries_diverged: number;
  };
  /**
   * The verdict, in reading order — `not_comparable` outranks `diverged`
   * because a divergence between two different surfaces is not a finding.
   */
  verdict: "empty" | "not_comparable" | "diverged" | "clean";
  /** Everything a reader must be told, most important first. */
  notes: string[];
}

export interface ReplayOptions {
  /**
   * The build string to compare the trail's `harness` against.
   *
   * Defaults to `harnessBuild()`. Overridable so a caller can replay on behalf
   * of a build that is not the one running — and so this module's own tests do
   * not depend on the git state of the tree they run in.
   */
  harness?: string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TrailRead {
  records: AuditRecord[];
  /** Line numbers that would not parse. */
  malformed: number[];
  /** Set when the file could not be read at all. */
  problem?: string;
}

/**
 * Read a trail without throwing.
 *
 * A trail is written by appending, and a process killed mid-append leaves a
 * half-line. That is an ordinary state for this harness — it kills its own runs
 * — so an unparseable tail is data to report, never an exception. Line
 * numbering matches `verifyTrail`'s (`split("\n").filter(Boolean)`) so the two
 * report the same indices for the same file.
 */
export function readTrail(path: string): TrailRead {
  if (!existsSync(path)) {
    return { records: [], malformed: [], problem: `No such trail: ${path}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      records: [],
      malformed: [],
      problem: `Trail could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const lines = raw.split("\n").filter(Boolean);
  const records: AuditRecord[] = [];
  const malformed: number[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed.push(i);
        continue;
      }
      records.push(parsed as AuditRecord);
    } catch {
      malformed.push(i);
    }
  }
  return { records, malformed };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const SEQ_GAP_CAP = 100;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const short = (h: string | null): string => (h ? h.slice(0, 12) : "(none)");

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Replay a trail against a surface.
 *
 * `config` is taken rather than loaded so the caller decides which surface is
 * under test — a trail is often replayed against a checkout other than the cwd,
 * and silently guessing which one would defeat the purpose.
 */
export function replay(
  trailPath: string,
  config: GnomonConfig,
  options: ReplayOptions = {}
): ReplayResult {
  const read = readTrail(trailPath);
  const records = read.records;

  const chain = verifyTrail(trailPath);
  const integrity: ReplayIntegrity = {
    records: chain.records,
    malformed: read.malformed,
    chain_ok: chain.ok,
    broken: chain.broken,
    sealed: chain.sealed,
    ...seqGaps(records),
  };

  const currentHash = (() => {
    try {
      return recomputeManifest(config.gnomonDir, "0.1.0").surface_hash;
    } catch {
      return null;
    }
  })();
  // The interactive loop writes "" when it could not hash the surface, so an
  // empty string is an absent hash, not a hash that happens to be empty.
  const recordedHash = str(records.find((r) => str(r.surface_hash))?.surface_hash);

  const surfaceStatus: ReplaySurface["status"] =
    recordedHash === null || currentHash === null
      ? "unknown"
      : recordedHash === currentHash
        ? "same"
        : "different";
  const comparable = surfaceStatus === "same";
  const surface: ReplaySurface = {
    recorded: recordedHash,
    current: currentHash,
    status: surfaceStatus,
    note:
      surfaceStatus === "same"
        ? `the trail ran under the surface it is being replayed against (${short(recordedHash)})`
        : surfaceStatus === "different"
          ? `SURFACE DIFFERS: the trail ran under ${short(recordedHash)}; this surface is ${short(currentHash)}. ` +
            `Decisions were NOT compared — they were taken under different rules. A hash is not a preimage, ` +
            `so replay cannot reconstruct the older surface to compare against.`
          : recordedHash === null
            ? `the trail records no surface hash, so there is nothing to compare it to`
            : `the surface at ${config.gnomonDir} could not be hashed, so there is nothing to compare the trail to`,
  };
  // Suppression reason, attached verbatim to every surface check that did not run.
  const blocked = comparable ? null : surface.note;

  const currentHarness = options.harness ?? harnessBuild();
  const recordedHarness = str(records.find((r) => str(r.harness))?.harness);
  const harness = {
    recorded: recordedHarness,
    current: currentHarness,
    status: (recordedHarness === null
      ? "unknown"
      : recordedHarness === currentHarness
        ? "same"
        : "different") as "same" | "different" | "unknown",
  };

  const detail = resolveDetail(records);

  // Resolved once: the same values the loop resolves once per turn.
  const gateNow = ((config.policy as { approval?: { gate?: string } } | undefined)?.approval?.gate ??
    config.config.defaults?.approval ??
    "on_write") as ApprovalGate;
  const offeredByRole = new Map<string, Set<string>>();
  const offeredFor = (role: string): Set<string> => {
    let s = offeredByRole.get(role);
    if (!s) {
      // No MCP tools passed: a live server's tool list is not in the surface.
      s = new Set(buildToolSet(config, role).schemas.map((t) => t.function.name));
      offeredByRole.set(role, s);
    }
    return s;
  };

  const entries: ReplayEntry[] = [];

  // --- per-entry helpers ---------------------------------------------------

  // Returns void, not the new length: several call sites are written as
  // `return uncheckable(...)` for early exit, and a numeric return there is a
  // type error waiting for whoever widens their signatures.
  const push = (e: ReplayEntry, c: ReplayCheck): void => {
    e.checks.push(c);
  };

  /** Compare two values the trail alone supplies. */
  const tcmp = (e: ReplayEntry, field: string, recorded: unknown, replayed: unknown, note?: string) =>
    push(e, {
      field,
      source: "trail",
      status: same(recorded, replayed) ? "match" : "diverged",
      recorded,
      replayed,
      ...(note ? { note } : {}),
    });

  const uncheckable = (
    e: ReplayEntry,
    field: string,
    source: CheckSource,
    note: string,
    recorded?: unknown
  ) =>
    push(e, {
      field,
      source,
      status: "uncheckable",
      ...(recorded !== undefined ? { recorded } : {}),
      note,
    });

  /**
   * Compare a value against one re-derived from the surface.
   *
   * Suppressed entirely when the hashes differ: a comparison across two
   * surfaces is not a comparison, and reporting one as DIVERGED would tell a
   * reader something false.
   */
  const scmp = (
    e: ReplayEntry,
    field: string,
    recorded: unknown,
    derive: () => unknown,
    note?: string
  ) => {
    if (blocked) return uncheckable(e, field, "surface", blocked, recorded);
    let replayed: unknown;
    try {
      replayed = derive();
    } catch (err) {
      return uncheckable(
        e,
        field,
        "surface",
        `could not be re-derived from this surface: ${msg(err)}`,
        recorded
      );
    }
    push(e, {
      field,
      source: "surface",
      status: same(recorded, replayed) ? "match" : "diverged",
      recorded,
      replayed,
      ...(note ? { note } : {}),
    });
  };

  // --- the two composite checks, kept out of the switch for legibility ------
  function routeChecks(e: ReplayEntry, role: string, record: AuditRecord): void {
    if (record.model !== undefined) {
      if (blocked) {
        uncheckable(e, "route.model", "surface", blocked, record.model);
      } else {
        try {
          const r = routeRole(config, role);
          const fb = r.fallback?.model;
          if (same(record.model, r.target.model)) {
            push(e, {
              field: "route.model",
              source: "surface",
              status: "match",
              recorded: record.model,
              replayed: r.target.model,
            });
          } else if (fb !== undefined && same(record.model, fb)) {
            push(e, {
              field: "route.model",
              source: "surface",
              status: "match",
              recorded: record.model,
              replayed: fb,
              note:
                `the turn ran on this role's declared FALLBACK model; the primary is "${r.target.model}". ` +
                `Nothing in the record says whether the primary was tried and failed or was never reached.`,
            });
          } else {
            push(e, {
              field: "route.model",
              source: "surface",
              status: "diverged",
              recorded: record.model,
              replayed: r.target.model,
            });
          }
        } catch (err) {
          uncheckable(
            e,
            "route.model",
            "surface",
            `could not be re-derived from this surface: ${msg(err)}`,
            record.model
          );
        }
      }
    }

    if (record.endpoint !== undefined) {
      scmp(e, "route.endpoint", record.endpoint, () => routeRole(config, role).target.endpoint);
    }

    if (record.endpoint_url !== undefined) {
      if (blocked) {
        uncheckable(e, "route.url", "surface", blocked, record.endpoint_url);
      } else if (record.endpoint_overridden === true) {
        uncheckable(
          e,
          "route.url",
          "surface",
          "GNOMON_MODEL_URL was set when this ran: the destination was machine-scoped and is not in the surface, so no surface can reproduce it",
          record.endpoint_url
        );
      } else if (process.env.GNOMON_MODEL_URL) {
        uncheckable(
          e,
          "route.url",
          "surface",
          "GNOMON_MODEL_URL is set in the replaying process, so re-deriving the url would return that override rather than what the surface declares",
          record.endpoint_url
        );
      } else {
        scmp(e, "route.url", record.endpoint_url, () => routeRole(config, role).target.url);
      }
    }
  }

  function skillChecks(e: ReplayEntry, role: string, record: AuditRecord): void {
    if (!Array.isArray(record.skills)) return;
    // Measured while writing the tests: with a changed surface AND a metadata
    // trail, this reported "no input text" — true, but not the reason that
    // matters. A reader given the narrower reason would think the surface
    // question had been settled. The surface question dominates every other
    // reason a check could not run, in every branch below.
    if (blocked) return uncheckable(e, "skills", "surface", blocked, record.skills);
    if (typeof record.input !== "string") {
      return uncheckable(
        e,
        "skills",
        "surface",
        `skill selection matches against the turn's input, and this trail records no input text` +
          (detail === "metadata" ? ` (record = "metadata"). That is the surface working as declared, not a divergence.` : `.`),
        record.skills
      );
    }
    let redacting = false;
    try {
      redacting = resolveAudit(config).redact.length > 0;
    } catch {
      redacting = false;
    }
    if (redacting) {
      return uncheckable(
        e,
        "skills",
        "surface",
        "this surface declares [audit] redact patterns, so the recorded input is post-redaction; re-running selection against it would not reproduce what ran",
        record.skills
      );
    }
    scmp(e, "skills", record.skills, () =>
      selectSkills(loadSkills(config), role, record.input as string).map((s) => s.id)
    );
  }

  // --- walk ---------------------------------------------------------------

  // Records that belong to the turn (or chain stage) not yet closed. A
  // `turn` or `chain_stage` record closes one.
  let pendingCalls: AuditRecord[] = [];
  let turnsSeen = 0;
  let lastStage: AuditRecord | null = null;

  const closeSteps = (
    e: ReplayEntry,
    recordedSteps: unknown,
    recordedLog: unknown
  ): void => {
    const calls = pendingCalls;
    pendingCalls = [];
    const delegated = calls.some((c) => c.tool === "task");

    if (typeof recordedSteps === "number") {
      if (delegated) {
        // A delegated sub-turn's calls are in this trail but not in this
        // record's counts. Only the inequality survives.
        push(e, {
          field: "tool_steps",
          source: "trail",
          status: recordedSteps <= calls.length ? "match" : "diverged",
          recorded: recordedSteps,
          replayed: calls.length,
          note:
            `a \`task\` call delegated a sub-turn whose own tool_call records are in this trail but ` +
            `not in this record's count, so only \`recorded <= records\` could be checked`,
        });
      } else {
        tcmp(e, "tool_steps", recordedSteps, calls.length);
      }
    }

    if (!Array.isArray(recordedLog)) {
      if (recordedLog === undefined && calls.length > 0 && lastStage === null) {
        uncheckable(
          e,
          "tool_log",
          "trail",
          "this record carries no tool_log, so the tool_call records could not be matched against one"
        );
      }
      return;
    }

    // The loop pushes one entry per tool call (`outcome.summary`) plus one per
    // declared-verify run, which is the only other writer and always prefixed.
    const fromCalls = calls.map((c) => c.summary);
    const logged = (recordedLog as unknown[]).filter(
      (l) => !(typeof l === "string" && l.startsWith("verify — "))
    );
    if (delegated) {
      push(e, {
        field: "tool_log",
        source: "trail",
        status: orderedSubsequence(logged, fromCalls) ? "match" : "diverged",
        recorded: logged,
        replayed: fromCalls,
        note:
          `a \`task\` call delegated a sub-turn; its tool_call records are in this trail but not in ` +
          `this log, so the log was checked as an ordered subsequence of the records rather than as equal to them`,
      });
    } else {
      tcmp(e, "tool_log", logged, fromCalls);
    }
  };

  // Malformed lines are re-inserted at their own line numbers, so the entries
  // read in file order and an index in the result is an index in the file.
  const ordered: Array<{ index: number; record: AuditRecord | null }> = [];
  {
    const bad = new Set(read.malformed);
    let ri = 0;
    const total = records.length + read.malformed.length;
    for (let i = 0; i < total; i++) {
      ordered.push(bad.has(i) ? { index: i, record: null } : { index: i, record: records[ri++]! });
    }
  }

  for (const { index, record } of ordered) {
    if (record === null) {
      entries.push({
        index,
        seq: null,
        kind: "(unparseable)",
        status: "uncheckable",
        checks: [
          {
            field: "line",
            source: "trail",
            status: "uncheckable",
            note: "this line is not JSON — the trail is truncated or corrupt here, and nothing after it can be attributed with confidence",
          },
        ],
      });
      continue;
    }

    const kind = typeof record.kind === "string" ? record.kind : "(no kind)";
    const e: ReplayEntry = {
      index,
      seq: typeof record.seq === "number" ? record.seq : null,
      kind,
      status: "uncheckable",
      checks: [],
    };

    switch (kind) {
      case "session_start": {
        // The headline. Run whether or not the surfaces match — it IS the
        // question of whether they match.
        if (currentHash === null) {
          uncheckable(
            e,
            "surface_hash",
            "surface",
            `the surface at ${config.gnomonDir} could not be hashed`,
            record.surface_hash
          );
        } else {
          push(e, {
            field: "surface_hash",
            source: "surface",
            status: same(str(record.surface_hash), currentHash) ? "match" : "diverged",
            recorded: record.surface_hash,
            replayed: currentHash,
            ...(surfaceStatus === "different" ? { note: surface.note } : {}),
          });
        }
        if (record.record !== undefined) {
          scmp(e, "audit.record", record.record, () => resolveAudit(config).record);
        }
        if (Array.isArray(record.roles)) {
          scmp(e, "roles", record.roles, () => listRoles(config));
        }
        // `gnomon task` names the one role it ran as; the interactive loop
        // lists them all. Either way the question is the same: does this
        // surface still define what the trail says it used.
        const started = str(record.role);
        if (started !== null) {
          scmp(e, "roles", started, () =>
            listRoles(config).includes(started) ? started : "(not defined by this surface)"
          );
        }
        break;
      }

      case "session_resume": {
        if (str(record.surface_hash_at_save) !== null && str(record.surface_hash) !== null) {
          tcmp(
            e,
            "surface_changed",
            record.surface_changed,
            record.surface_hash_at_save !== record.surface_hash
          );
        }
        break;
      }

      case "turn": {
        turnsSeen++;
        const role = str(record.role);

        if (typeof record.code === "number") {
          tcmp(e, "bucket", record.bucket, mapBucket(record.code));
        } else if (record.bucket !== undefined) {
          uncheckable(
            e,
            "bucket",
            "trail",
            "the record carries a bucket but no numeric code to map from",
            record.bucket
          );
        }

        if (role === null) {
          uncheckable(
            e,
            "route.model",
            "surface",
            "the record names no role, so routing could not be re-derived"
          );
        } else {
          routeChecks(e, role, record);
          skillChecks(e, role, record);
        }

        // In a chain the turn record repeats the LAST stage's numbers; the
        // calls themselves were attributed to that stage.
        if (pendingCalls.length === 0 && lastStage !== null) {
          uncheckable(
            e,
            "tool_steps",
            "trail",
            "a chain ran: the tool_call records were attributed to the chain_stage records, and this turn record repeats the last stage's counts"
          );
          if (typeof record.tool_steps === "number" && typeof lastStage.tool_steps === "number") {
            tcmp(
              e,
              "tool_steps",
              record.tool_steps,
              lastStage.tool_steps,
              "compared against the last chain_stage record, which this turn record summarises"
            );
          }
        } else {
          closeSteps(e, record.tool_steps, record.tool_log);
        }
        lastStage = null;
        break;
      }

      case "chain_stage": {
        const stage = typeof record.stage === "number" ? record.stage : null;
        if (stage !== null) {
          scmp(e, "chain.role", record.role, () => resolveChain(config)[stage - 1] ?? "(no such stage)");
        }
        if (record.of !== undefined) {
          scmp(e, "chain.of", record.of, () => resolveChain(config).length);
        }
        if (typeof record.code === "number") {
          tcmp(e, "bucket", record.bucket, mapBucket(record.code));
        }
        closeSteps(e, record.tool_steps, record.tool_log);
        lastStage = record;
        break;
      }

      case "tool_call": {
        const tool = str(record.tool);
        const role = str(record.role);

        if (typeof record.code === "number") {
          tcmp(e, "bucket", record.bucket, mapBucket(record.code));
        }

        if (tool === null) {
          uncheckable(e, "offered", "surface", "the record names no tool");
        } else if (tool.startsWith("mcp__")) {
          uncheckable(
            e,
            "offered",
            "surface",
            "an MCP tool is discovered from a live server at connect time; the surface declares the server, not its tool list",
            tool
          );
          uncheckable(
            e,
            "gated",
            "surface",
            "the `gated` field is computed from a fixed mutating-tool set that contains no MCP name, while dispatch gates every MCP call under any gate but `never` — replay will not reproduce a value it can see is misleading",
            record.gated
          );
        } else if (role === null) {
          uncheckable(
            e,
            "offered",
            "surface",
            "the record names no role, so the offered tool set could not be re-derived",
            tool
          );
        } else {
          // Recorded evidence of offering: executeTool answers code 4 for a
          // name that was not in the offered set.
          scmp(e, "offered", record.code !== 4, () => offeredFor(role).has(tool),
            "recorded side inferred from the outcome code: 4 is the refusal executeTool returns for a tool the role was not offered");
          if (record.gated !== undefined) {
            scmp(e, "gated", record.gated, () => needsApproval(tool, gateNow) && offeredFor(role).has(tool));
          }
        }
        pendingCalls.push(record);
        break;
      }

      case "approval": {
        const tool = str(record.tool);
        if (tool === null) {
          uncheckable(e, "gate.asks", "surface", "the record names no tool");
        } else {
          scmp(
            e,
            "gate.asks",
            true,
            () =>
              needsApproval(tool, gateNow) ||
              (tool.startsWith("mcp__") && gateNow !== "never"),
            "recorded side is the fact that the harness asked at all; the check is whether this surface would still ask"
          );
        }
        uncheckable(
          e,
          "decision",
          "trail",
          "an approval decision is an operator input, not a harness decision — replay cannot re-derive it, and a tool that implied it could would be claiming oversight it cannot see",
          record.decision
        );
        break;
      }

      case "verify": {
        if (record.command !== undefined) {
          scmp(e, "verify.command", record.command, () => resolveVerify(config)?.command ?? "(no [verify] declared)");
        }
        if (typeof record.exit === "number") {
          if (record.unrunnable !== undefined) {
            tcmp(e, "verify.unrunnable", record.unrunnable, record.exit === 126 || record.exit === 127);
          }
          if (typeof record.passed === "boolean") {
            tcmp(e, "verify.passed", record.passed, record.exit === 0);
          }
        } else if (record.unrunnable !== undefined || record.passed !== undefined) {
          uncheckable(
            e,
            "verify.passed",
            "trail",
            "the record carries a verdict but no exit status to derive it from"
          );
        }
        break;
      }

      case "session_end": {
        if (record.turns !== undefined) {
          tcmp(e, "turns", record.turns, turnsSeen);
        }
        break;
      }

      default:
        uncheckable(
          e,
          "kind",
          "trail",
          `this build has no replay rules for records of kind "${kind}" — it was written by a different harness build, or the record is not a trail record`,
          kind
        );
    }

    e.status = e.checks.some((c) => c.status === "diverged")
      ? "diverged"
      : e.checks.some((c) => c.status === "match")
        ? "match"
        : "uncheckable";
    entries.push(e);
  }

  // Anything still pending belongs to a turn that was never closed.
  if (pendingCalls.length > 0) {
    entries.push({
      index: ordered.length,
      seq: null,
      kind: "(unclosed)",
      status: "uncheckable",
      checks: [
        {
          field: "tool_log",
          source: "trail",
          status: "uncheckable",
          recorded: pendingCalls.length,
          note: `${pendingCalls.length} tool_call record(s) are followed by no turn or chain_stage record — the trail ends mid-turn, so they could not be attributed`,
        },
      ],
    });
  }

  // --- totals and verdict --------------------------------------------------

  const all = entries.flatMap((x) => x.checks);
  const totals = {
    checks: all.length,
    match: all.filter((c) => c.status === "match").length,
    diverged: all.filter((c) => c.status === "diverged").length,
    uncheckable: all.filter((c) => c.status === "uncheckable").length,
    entries_diverged: entries.filter((x) => x.status === "diverged").length,
  };

  const verdict: ReplayResult["verdict"] =
    records.length === 0 && read.malformed.length === 0
      ? "empty"
      : surfaceStatus !== "same"
        ? "not_comparable"
        : totals.entries_diverged > 0
          ? "diverged"
          : "clean";

  const notes: string[] = [];
  // The surface question is always first. Everything below it is conditional
  // on the answer.
  notes.push(surface.note);
  if (read.problem) notes.push(read.problem);
  if (harness.status === "different") {
    notes.push(
      `HARNESS DIFFERS: the trail was written by ${harness.recorded} and replayed by ${harness.current}. ` +
        `The same surface read by different code can decide differently — the comparisons below were re-derived ` +
        `by the replaying build, not by the one that wrote the trail.`
    );
  } else if (harness.status === "unknown") {
    notes.push(
      `the trail names no harness build, so there is no way to tell whether the code that wrote it is the code replaying it`
    );
  }
  if (verdict === "not_comparable" && totals.diverged > 0) {
    const fields = [
      ...new Set(all.filter((c) => c.status === "diverged").map((c) => c.field)),
    ];
    notes.push(
      `${totals.diverged} check(s) diverged without consulting the surface (${fields.join(", ")}). ` +
        `These are internal inconsistencies in the trail and hold regardless of which surface it is replayed against.`
    );
  }
  if (!integrity.chain_ok) {
    notes.push(
      `the hash chain does not hold at seq ${integrity.broken.join(", ")} — this trail was edited after it was written, ` +
        `and every comparison below is against content that cannot be trusted to be what was recorded`
    );
  }
  if (!integrity.sealed) {
    notes.push(
      `the trail does not close with session_end — it was truncated, or the run was killed before it could write one`
    );
  }
  if (integrity.malformed.length > 0) {
    notes.push(
      `${integrity.malformed.length} line(s) would not parse (line ${integrity.malformed.join(", ")})`
    );
  }
  if (integrity.seq_gaps.length > 0) {
    notes.push(
      `sequence number(s) ${integrity.seq_gaps.join(", ")}${integrity.seq_gaps_truncated ? ", …" : ""} are absent from the file`
    );
  }
  if (detail === "metadata") {
    notes.push(
      `the trail was recorded at record = "metadata": prompt and response text is absent BY DESIGN. Checks that need it are UNCHECKABLE, not divergences.`
    );
  }

  return {
    trail: trailPath,
    surface,
    harness,
    detail,
    integrity,
    entries,
    totals,
    verdict,
    notes,
  };

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDetail(records: AuditRecord[]): AuditDetail | "unknown" {
  const declared = records.find((r) => r.kind === "session_start" && typeof r.record === "string");
  if (declared) {
    const v = declared.record;
    if (v === "full" || v === "metadata") return v;
  }
  // Text present proves `full`. Text ABSENT proves nothing on its own — a
  // `full` trail of an empty turn looks the same — so absence is reported as
  // unknown rather than guessed at.
  const hasText = records.some(
    (r) =>
      typeof r.input === "string" ||
      typeof r.output === "string" ||
      typeof r.args === "string" ||
      typeof r.result === "string"
  );
  return hasText ? "full" : "unknown";
}

function seqGaps(records: AuditRecord[]): { seq_gaps: number[]; seq_gaps_truncated: boolean } {
  const seqs = records
    .map((r) => (typeof r.seq === "number" ? r.seq : null))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  let truncated = false;
  const add = (n: number) => {
    if (gaps.length >= SEQ_GAP_CAP) {
      truncated = true;
      return;
    }
    gaps.push(n);
  };
  if (seqs.length > 0) {
    for (let n = 0; n < seqs[0]!; n++) add(n);
    for (let i = 1; i < seqs.length; i++) {
      for (let n = seqs[i - 1]! + 1; n < seqs[i]!; n++) add(n);
    }
  }
  return { seq_gaps: gaps, seq_gaps_truncated: truncated };
}

/** Is `needles` an ordered subsequence of `haystack`? */
function orderedSubsequence(needles: unknown[], haystack: unknown[]): boolean {
  let i = 0;
  for (const h of haystack) {
    if (i < needles.length && same(h, needles[i])) i++;
  }
  return i === needles.length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A replay result as lines a person can read.
 *
 * Ordered the way the result must be read: the surface question, then the
 * build, then the verdict, then the divergences. A renderer that led with the
 * verdict would let a reader take "clean" from a comparison that never
 * happened.
 */
export function formatReplay(result: ReplayResult): string[] {
  const out: string[] = [];
  out.push(`trail: ${result.trail}`);
  for (const n of result.notes) out.push(`  ${n}`);
  out.push(
    `  records ${result.integrity.records} · chain ${result.integrity.chain_ok ? "ok" : "BROKEN"} · ` +
      `${result.integrity.sealed ? "sealed" : "UNSEALED"} · recorded at ${result.detail}`
  );
  out.push(
    `  verdict: ${result.verdict}  (${result.totals.match} matched, ` +
      `${result.totals.diverged} diverged, ${result.totals.uncheckable} uncheckable, ` +
      `over ${result.totals.checks} checks)`
  );
  for (const e of result.entries) {
    if (e.status !== "diverged") continue;
    out.push(`  line ${e.index} (seq ${e.seq ?? "?"}, ${e.kind}) DIVERGED:`);
    for (const c of e.checks) {
      if (c.status !== "diverged") continue;
      out.push(
        `    ${c.field}: recorded ${JSON.stringify(c.recorded)} · replayed ${JSON.stringify(c.replayed)}`
      );
    }
  }
  return out;
}
