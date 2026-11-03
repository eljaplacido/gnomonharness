/**
 * gnomon-core: Skill candidates, mined from the record
 *
 * `gnomon skill mine` reads the audit trails and writes CANDIDATES: evidence
 * that a skill might help, not skill text. It is deterministic, makes no model
 * call and costs nothing (docs/design/SKILL-TRIALS.md, part 1).
 *
 * Why candidates and not skills
 * -----------------------------
 * An agent that writes its own skills from experience learns fast and
 * entrenches its mistakes just as fast: the judgement that a note helped is
 * the agent's own. Here the record does the noticing, a person or a later
 * draft step does the writing, and a trial does the measuring. A candidate is
 * only the first of those, so it carries counts and pointers, never advice a
 * model made up.
 *
 * Where they live
 * ---------------
 * `.gnomon-skills/candidates/<id>.json`, beside `.gnomon/` and outside it,
 * like `.gnomon-audit/`. Mining must never move the surface hash: nothing
 * here changes what the agent does until a person accepts a skill.
 *
 * Each candidate points at the records it was mined from as `{trail, seq,
 * hash}`, so a reader can open the trail, find the record, and check it with
 * `gnomon audit verify` rather than trusting the miner's summary.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { GnomonConfig } from "./config.js";
import { resolveAudit, type AuditRecord } from "./audit.js";

/**
 * The signals `mine` reports, published (Rule 6).
 *
 * Only what is implemented. The design lists four more -- a verify that failed
 * and then passed after the same fix, an approval declined in favour of
 * another route, the same exploration at the start of many sessions, turns
 * that stalled on the same kind of task -- and none of them is here yet. A
 * value in this list that nothing can emit would be a promise, not a contract.
 */
export const CANDIDATE_SIGNALS = ["repeated_refusal"] as const;
export type CandidateSignal = (typeof CANDIDATE_SIGNALS)[number];

/**
 * A rule must refuse the same role on the same thing in this many SESSIONS
 * before it is a pattern. Sessions, not records: one session retrying a
 * refused write four times is one episode of flailing, which the loop's
 * anti-flailing nudge already answers. A skill is for what every new session
 * rediscovers, and only distinct sessions show that.
 */
export const MIN_REPEATS = 3;

export const CANDIDATES_DIR = join(".gnomon-skills", "candidates");

/** One record a candidate was mined from, checkable with `gnomon audit verify`. */
export interface RecordPointer {
  /** The trail file, repo-relative with POSIX separators when inside the repo */
  trail: string;
  seq: number;
  /** Null for a trail written with chaining off */
  hash: string | null;
}

export interface SkillCandidate {
  v: 1;
  id: string;
  signal: CandidateSignal;
  /** The policy rule that refused (tools.ts POLICY_RULES) */
  rule: string;
  role: string;
  /** The tools whose calls were refused, sorted */
  tools: string[];
  /** What was refused, generalised: a path pattern, a deny pattern, a command */
  pattern: string;
  count: number;
  /** Distinct trails the refusals came from */
  sessions: number;
  /** What a skill drafted from this would teach. A sentence, not a skill. */
  suggestion: string;
  records: RecordPointer[];
}

// ---------------------------------------------------------------------------
// Reading refusals off a tool_call record
// ---------------------------------------------------------------------------

/**
 * Which rule refused a call, and what it refused, from fields the record has.
 *
 * `tool_call` records do not carry the rule: the tool's precheck knows it and
 * the outcome handed to the loop drops it (tools.ts, outcomeOf). What the
 * record does carry is the one-line `summary`, and each refusal writes its
 * own fixed form there. Those forms are read here, and a record with a `rule`
 * field is believed over its summary, so a trail that starts recording the
 * rule needs no change to this file.
 *
 * Every rule in tools.ts POLICY_RULES has its forms here, and only those
 * rules: `skill_mine.test.ts` drives each precheck that returns a rule and
 * asserts this function reads the same rule back off the summary it wrote.
 * Until 2026-11 the `tools`, `malformed` and `url` forms and webfetch's
 * `network` form were missing, so those refusals read as "no rule named" in
 * the dashboard and could never become candidates.
 *
 * Anything that is not one of these forms is not a policy refusal -- a person
 * declining an approval is also a `refusal`, and is a different signal; so is
 * a delegation `task_allow` refused, which no published rule names -- and is
 * skipped rather than guessed at.
 */
export function classifyRefusal(
  r: Pick<AuditRecord, "kind"> & Record<string, unknown>
): { rule: string; pattern: string } | null {
  if (r.kind !== "tool_call" || r.bucket !== "refusal") return null;
  const summary = typeof r.summary === "string" ? r.summary : "";
  const tool = typeof r.tool === "string" ? r.tool : "";
  const target = typeof r.target === "string" ? r.target : "";

  let m: RegExpExecArray | null;
  if ((m = /— denied by bash_deny \((.*)\)$/.exec(summary))) {
    return { rule: "bash_deny", pattern: m[1]! };
  }
  // A deny pattern that does not compile refuses every command, fail-closed.
  if (summary === "bash — deny pattern will not compile") {
    return { rule: "bash_deny", pattern: commandHead(target) };
  }
  // `tools`: the role was not given the tool. The pattern is the tool's name,
  // which is what was refused; the target says nothing about it.
  if ((m = /^(\S+) — not available to this role$/.exec(summary))) {
    return { rule: "tools", pattern: m[1]! };
  }
  // `malformed`: arguments that cannot be read as the tool's. Also by name.
  if (
    (m = /^(\S+) — malformed arguments \(/.exec(summary)) ||
    (m = /^(read) — no path given$/.exec(summary)) ||
    (m = /^(write) — no content given$/.exec(summary)) ||
    (m = /^(bash) — command is not a string$/.exec(summary))
  ) {
    return { rule: "malformed", pattern: m[1]! };
  }
  // webfetch records no target (its argument is a url, not a path or a
  // command), so the host or scheme is read from the summary instead.
  if ((m = /^webfetch (\S+) — refused \(network disabled\)$/.exec(summary))) {
    return { rule: "network", pattern: urlHost(m[1]!) };
  }
  if ((m = /^webfetch — (\S+) refused$/.exec(summary))) {
    return { rule: "url", pattern: m[1]! };
  }
  if ((m = /^webfetch (\S+) — refused \(private address\)$/.exec(summary))) {
    return { rule: "url", pattern: m[1]! };
  }
  if ((m = /^bash — writes (.+), not permitted for this role$/.exec(summary))) {
    return { rule: "write_allow", pattern: pathPattern(m[1]!) };
  }
  if ((tool === "write" || tool === "edit") && / — not permitted for this role$/.test(summary)) {
    return { rule: "write_allow", pattern: pathPattern(target) };
  }
  if (tool === "bash" && summary === "bash — not permitted for this role") {
    return { rule: "bash_allow", pattern: commandHead(target) };
  }
  const fixed: Array<[RegExp, string]> = [
    [/refused \(outside sandbox\)$/, "sandbox"],
    [/refused \(surface is read-only\)$/, "surface"],
    [/refused \(network = false\)$/, "network"],
    [/refused \(sudo\)$/, "sudo"],
    [/refused \(gnomon's records\)$/, "record"],
  ];
  const rule =
    typeof r.rule === "string" ? r.rule : fixed.find(([re]) => re.test(summary))?.[1];
  if (!rule) return null;
  return { rule, pattern: tool === "bash" ? commandHead(target) : pathPattern(target) };
}

/**
 * A path generalised to its directory and extension: `generated/a.ts` and
 * `generated/b.ts` are both `generated/*.ts`. Deliberately coarse and
 * deliberately simple -- the candidate lists every record, so a reader sees
 * the paths themselves; the pattern only decides what is counted together.
 */
export function pathPattern(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!p) return "";
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash) : "";
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${dir ? `${dir}/` : ""}*${ext}`;
}

/** A URL's host, or the text as given when it does not parse as one. */
function urlHost(raw: string): string {
  try {
    return new URL(raw).hostname || raw;
  } catch {
    return raw;
  }
}

/** The first word of a command: what bash_allow judges a segment by. */
function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

function readRecords(file: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditRecord);
    } catch {
      // A line that does not parse is `gnomon audit verify`'s finding, not
      // this one's. Mining reports what it can read.
    }
  }
  return out;
}

/** A file-name-safe rendering of text read from a trail. */
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  );
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/**
 * Mine the trails in `[audit] dir` for candidates.
 *
 * Pure over the files: the same trails produce the same candidates, in the
 * same order, byte for byte. There is no timestamp in a candidate for that
 * reason; the records it points at carry theirs.
 */
export function mineCandidates(config: GnomonConfig): SkillCandidate[] {
  const root = resolve(config.gnomonDir, "..");
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return [];
  const show = (file: string): string => {
    const rel = relative(root, file);
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel.split(sep).join("/");
  };

  type Group = {
    rule: string;
    role: string;
    pattern: string;
    tools: Set<string>;
    trails: Set<string>;
    records: RecordPointer[];
  };
  const groups = new Map<string, Group>();

  // Byte-wise order, not localeCompare: the candidate files must not depend on
  // the machine's collation (the same reasoning as recomputeManifest's sort).
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const f of files) {
    const file = join(dir, f);
    const trail = show(file);
    for (const r of readRecords(file)) {
      const hit = classifyRefusal(r);
      if (!hit || !hit.pattern) continue;
      const role = typeof r.role === "string" ? r.role : "";
      const key = `${hit.rule}\0${role}\0${hit.pattern}`;
      let g = groups.get(key);
      if (!g) {
        g = { rule: hit.rule, role, pattern: hit.pattern, tools: new Set(), trails: new Set(), records: [] };
        groups.set(key, g);
      }
      if (typeof r.tool === "string") g.tools.add(r.tool);
      g.trails.add(trail);
      g.records.push({ trail, seq: r.seq, hash: typeof r.hash === "string" ? r.hash : null });
    }
  }

  const out: SkillCandidate[] = [];
  for (const [key, g] of groups) {
    if (g.trails.size < MIN_REPEATS) continue;
    const who = g.role ? `the ${g.role} role` : "a role";
    out.push({
      v: 1,
      // Role and rule come from trail records, which a file name must not
      // trust: a role of "../../x" would otherwise write outside candidates/.
      // The hash keeps ids distinct when two roles slug alike.
      id: `refusal-${slug(g.rule)}-${slug(g.role || "any")}-${shortHash(key)}`,
      signal: "repeated_refusal",
      rule: g.rule,
      role: g.role,
      tools: [...g.tools].sort(),
      pattern: g.pattern,
      count: g.records.length,
      sessions: g.trails.size,
      suggestion:
        `Teach the rule up front: ${g.rule} refused ${who} ${g.records.length} times ` +
        `across ${g.trails.size} session(s) on \`${g.pattern}\`. Say what this repository ` +
        `forbids there and what to do instead.`,
      records: g.records,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The candidates already on disk, by id. */
export function loadCandidates(config: GnomonConfig): SkillCandidate[] {
  const dir = join(resolve(config.gnomonDir, ".."), CANDIDATES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf-8")) as SkillCandidate];
      } catch {
        return [];
      }
    });
}

/**
 * Write candidates to `.gnomon-skills/candidates/`, one file each.
 *
 * A candidate already on disk is rewritten with the current counts, so its
 * pointers grow as the trail does. `fresh` lists the ids that were not there
 * before -- what the session-end nudge would announce.
 */
export function writeCandidates(
  config: GnomonConfig,
  candidates: SkillCandidate[]
): { dir: string; written: string[]; fresh: string[] } {
  const dir = join(resolve(config.gnomonDir, ".."), CANDIDATES_DIR);
  const known = new Set(loadCandidates(config).map((c) => c.id));
  if (candidates.length > 0) mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const c of candidates) {
    writeFileSync(join(dir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`, "utf-8");
    written.push(c.id);
  }
  return { dir, written, fresh: written.filter((id) => !known.has(id)) };
}
