/**
 * gnomon-core: the proposal lint `gnomon improve` applies to every proposal it writes.
 *
 * Deterministic and model-free. The rules come from how Hermes Agent writes
 * skills (research_notes/rea-hermes-2026-11-22/REA-HERMES.md, item A3): a
 * skill names a CLASS of situation, states a rule and one clause of why, does
 * not narrate the incident that taught it, stays short, and never carries a
 * secret. Two more are gnomon's: nothing a proposal says may loosen the
 * surface's own limits (approval, sandbox, verify, audit), and a harness edit
 * only adds.
 *
 * A finding is recorded on the proposal (`improve.lint`) and blocks
 * auto-accept (improve_policy.ts). It never blocks writing the proposal: a
 * person may still read, edit and accept one the lint dislikes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GnomonConfig } from "./config.js";
import { parseMemory } from "./memory.js";
import type { Proposal, ProposalLint } from "./proposals.js";
import { parseSkill } from "./skills.js";

/** Caps, in characters. Smaller than the proposal store's: a note that long is not a note. */
export const LINT_LIMITS = { skill_body: 1500, skill_description: 160, skill_name: 60, memory_body: 600, memory_description: 160, harness_added: 700 } as const;

const SECRETS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key (sk-...)"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "a bearer token"],
  [/\b(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?\b\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{8,}/i, "a credential assignment"],
  [/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*\d)(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/, "a long high-entropy string"],
];

/** Phrases that tell a story instead of stating a rule. */
const NARRATION: Array<[RegExp, string]> = [
  [/\b(yesterday|today|tonight|last (?:week|night|session|time|run)|earlier (?:today|this)|this (?:session|run|morning)|just now|a moment ago)\b/i, "a time reference"],
  [/\b(?:i|we) (?:tried|ran|noticed|found|hit|saw|discovered|realised|realized|fixed|debugged|spent)\b/i, "first-person narration"],
  [/\b(?:it|this) turned out\b|\bafter (?:a (?:long|lot)|much|some) (?:debugging|trial)\b|\bthe (?:bug|incident|outage) (?:was|happened)\b/i, "an incident story"],
  [/\b(?:pr|pull request|issue|ticket|bug)\s*#?\s*\d+\b|(?:^|[\s(])#\d{2,}\b/i, "a PR, issue or ticket number"],
  [/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, "a date"],
  [/\b(?=[0-9a-f]{8,40}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,40}\b/, "a commit hash"],
];

/** A claim a tool is broken: Hermes's "negative claims about tools that harden into refusals". */
const NEGATIVE_TOOL: RegExp[] = [
  /\b(?:does not|doesn't|never|cannot|can't|won't|will not|fails? to) work\b/i,
  /\b(?:is|are) (?:broken|unreliable|unavailable|unusable|flaky)\b/i,
  /\b(?:always|keeps?) (?:fail|crash|hang|time ?out)s?\b/i,
  /\b(?:don't|do not|never) use (?:the )?(?:\w+ )?tool\b/i,
];

/** An instruction that would loosen what the surface says: never a thing a learned note may say. */
const LOOSENING: Array<[RegExp, string]> = [
  [/\b(?:ignore|disregard|override|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|the|these|your)?\s*(?:rules?|instructions?|polic(?:y|ies)|limits?|guardrails?|constraints?)\b/i, "tells the model to ignore the rules"],
  [/\b(?:disable|bypass|skip|turn off|switch off|circumvent|work around|get around)\b[^.\n]{0,50}\b(?:approval|sandbox|verify|verification|audit|polic(?:y|ies)|gate|checks?|hash|guard|deny|refusals?|confinement|trust)\b/i, "tells the model to get around a control"],
  [/\bwithout (?:asking|approval|confirmation|permission|review|a person|the operator)\b/i, "acts without asking"],
  [/(?:^|\s)--(?:yes|no-verify|trust|force|dangerously-[a-z-]+)\b|\bsudo\b|\bchmod\s+(?:-R\s+)?[0-7]*7{2}\b|\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~)/i, "names a flag or command that bypasses a limit"],
  [/\b(?:always|auto-?)\s*approve\b|\bapproval\s*=\s*["']?(?:never|off|none)\b|\bgate\s*=\s*["']?(?:never|off|none)\b|\bsandbox\s*=\s*["']?(?:off|none)\b|\bnetwork\s*=\s*true\b/i, "declares a looser setting"],
  [/\b(?:never|don't|do not|no need to|skip)\s+(?:run|running|ask|check|verify|test)\b[^.\n]{0,40}\b(?:tests?|checks?|verification|approval|the user|operator)\b/i, "tells the model to skip verification"],
  [/\b(?:write|edit|modify|delete|change)\b[^.\n]{0,30}(?:\.gnomon|policy\.toml|roles\.toml|audit trail|audit records?)/i, "points the model at the surface or the records"],
];

/** What "rule plus why" looks like: the because-clause Hermes asks of every pitfall. */
const WHY = /\b(because|so that|since|otherwise|to avoid|to prevent|which (?:means|causes|breaks)|that way|or (?:it|the) (?:will|would|fails?)|why:)\b/i;

export interface LintFinding {
  rule: string;
  message: string;
}

function scan(text: string, where: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const [re, what] of SECRETS) if (re.test(text)) out.push({ rule: "secret", message: `${where} contains ${what}` });
  for (const [re, what] of NARRATION) if (re.test(text)) out.push({ rule: "narration", message: `${where} has ${what}: state the rule, not the incident` });
  for (const re of NEGATIVE_TOOL) {
    if (re.test(text)) {
      out.push({ rule: "negative_claim", message: `${where} claims something does not work: a claim like that hardens into a refusal; state what to do instead` });
      break;
    }
  }
  for (const [re, what] of LOOSENING) if (re.test(text)) out.push({ rule: "loosens_policy", message: `${where} ${what}` });
  return out;
}

/** An incident, an error string or a one-off in a NAME: the name should say a class of work. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "has no name";
  if (n.length > LINT_LIMITS.skill_name) return `the name is longer than ${LINT_LIMITS.skill_name} characters`;
  if (/\d{4}-\d{2}-\d{2}|\b(?:pr|issue|ticket|bug)[ -_]?\d+\b|#\d+|\b[0-9a-f]{8,}\b/i.test(n)) return `the name "${n}" holds a date, number or hash: name a class of situation, not an instance`;
  if (/\b(?:fix|fixing|patch|workaround|hotfix)\b.*\b(?:today|now|again|this|that)\b|\b(?:today|yesterday|temp|tmp|oneoff|one-off)\b/i.test(n)) return `the name "${n}" names a one-off: name a class of situation`;
  if (/\b(?:error|exception|traceback|enoent|eacces|econn\w*|exit code \d+|stack ?trace)\b/i.test(n) || /[:`'"\\/]/.test(n)) return `the name "${n}" reads like an error string: name the situation it prevents`;
  return null;
}

const tooLong = (what: string, n: number, max: number): LintFinding | null => (n > max ? { rule: "length", message: `${what} is ${n} characters; the cap is ${max}` } : null);

/** The text a harness edit adds to the file it was written against. Empty when it adds nothing. */
export function addedText(before: string, after: string): { added: string; removed: boolean } {
  if (after.startsWith(before)) return { added: after.slice(before.length), removed: false };
  const b = before.split("\n");
  const a = new Set(after.split("\n"));
  const kept = new Set(b);
  return { added: after.split("\n").filter((l) => !kept.has(l)).join("\n"), removed: b.some((l) => l.trim() && !a.has(l)) };
}

function beforeText(config: GnomonConfig, path: string): string {
  const file = join(config.gnomonDir, ...path.split("/"));
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  } catch {
    return "";
  }
}

/** Lint one proposal. Pure over the proposal and the current surface; the same input gives the same findings. */
export function lintFindings(config: GnomonConfig, p: Pick<Proposal, "kind" | "title" | "diff">): LintFinding[] {
  const out: LintFinding[] = [];
  for (const d of p.diff) {
    if (d.delete) continue; // a retirement states no text; it is a person's call on the usage evidence
    if (p.kind === "skill") {
      const id = d.path.slice("skills/".length, -3);
      const sk = parseSkill(id, d.after, true);
      const np = nameProblem(sk.name);
      if (np) out.push({ rule: "name", message: `${d.path}: ${np}` });
      const desc = sk.description ?? "";
      if (!desc) out.push({ rule: "description", message: `${d.path}: no description (one line saying when this applies)` });
      for (const f of [tooLong(`${d.path}: the description`, desc.length, LINT_LIMITS.skill_description), tooLong(`${d.path}: the body`, sk.body.length, LINT_LIMITS.skill_body)]) if (f) out.push(f);
      if (!WHY.test(sk.body)) out.push({ rule: "no_why", message: `${d.path}: states a rule but not why (add one clause: because ..., so that ..., otherwise ...)` });
      if (sk.problem) out.push({ rule: "format", message: `${d.path}: ${sk.problem}` });
      out.push(...scan(`${sk.name}\n${desc}\n${sk.body}`, d.path));
    } else if (p.kind === "memory") {
      const id = d.path.slice("memory/".length, -3);
      const m = parseMemory(id, d.after);
      const np = nameProblem(m.name);
      if (np) out.push({ rule: "name", message: `${d.path}: ${np}` });
      if (!m.description) out.push({ rule: "description", message: `${d.path}: no description` });
      for (const f of [tooLong(`${d.path}: the description`, m.description.length, LINT_LIMITS.memory_description), tooLong(`${d.path}: the body`, m.body.length, LINT_LIMITS.memory_body)]) if (f) out.push(f);
      out.push(...scan(`${m.name}\n${m.description}\n${m.body}`, d.path));
    } else {
      const { added, removed } = addedText(beforeText(config, d.path), d.after);
      if (removed) out.push({ rule: "harness_removes", message: `${d.path}: a learned note only adds; this edit removes existing lines` });
      if (!added.trim()) out.push({ rule: "harness_empty", message: `${d.path}: adds nothing` });
      const f = tooLong(`${d.path}: the added note`, added.length, LINT_LIMITS.harness_added);
      if (f) out.push(f);
      if (added.trim() && !WHY.test(added)) out.push({ rule: "no_why", message: `${d.path}: the note states a rule but not why` });
      out.push(...scan(added, d.path));
    }
  }
  // The title is a label for the list, not content the agent reads: the skill's or
  // memory entry's own name, above, is what is linted. One finding per (rule, message): a secret in the body and in the name is one thing to fix.
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(`${f.rule}\0${f.message}`) ? false : (seen.add(`${f.rule}\0${f.message}`), true)));
}

export function lintProposal(config: GnomonConfig, p: Pick<Proposal, "kind" | "title" | "diff">): ProposalLint {
  const found = lintFindings(config, p);
  return { clean: found.length === 0, problems: found.map((f) => `${f.rule}: ${f.message}`) };
}

/** The rule names a finding carries, published (Rule 6): `<rule>: <message>` in `improve.lint.problems`. */
export const LINT_RULES = ["secret", "narration", "negative_claim", "loosens_policy", "name", "description", "length", "no_why", "format", "harness_removes", "harness_empty"] as const;
