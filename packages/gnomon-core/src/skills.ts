/**
 * gnomon-core: Skills
 *
 * A skill is a note the harness has learned about this repository, kept as a
 * file in `.gnomon/skills/`. Skills whose pattern matches the turn are added
 * to the system prompt, so knowledge accumulates without being re-derived.
 *
 * The determinism problem, and how it is resolved
 * ----------------------------------------------
 * `.gnomon/` is content-hashed, and the harness's central claim is that the
 * same surface plus the same prompt yields the same outcome. An agent that
 * rewrote its own skills mid-session would break that claim: the hash would
 * change underneath the run that changed it.
 *
 * So authorship is a proposal, never a self-application. A role with the
 * `skill` tool writes to `.gnomon/skills/proposed/`, which is NOT loaded.
 * A human accepts it (`gnomon skill accept <name>`), which moves it into
 * `.gnomon/skills/`, changes the surface hash deliberately, and takes effect
 * on the next session. Learning stays reviewable and the hash stays honest.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { escapesBase } from "./rel_path.js";
import { createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { GnomonConfig, parseToml, recomputeManifest, manifestHash } from "./config.js";
import { AuditTrail, resolveAudit, verifyTrail, recordHash, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";
import { unresolvedTamper, compareWithCheckpoint, writeTamperRecord, writeCheckpoint, personPresentSigner } from "./record_tamper.js";
import { agentReason, decisionContext } from "./agent_context.js";
import { describeChanges } from "./record_guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  /** Filename stem — the identity used by accept/reject */
  id: string;
  name: string;
  description?: string;
  /** Case-insensitive pattern; absent means "always applies" */
  match?: string;
  /** Roles this applies to; absent means all */
  roles?: string[];
  /** The instruction body */
  body: string;
  /** Whether this came from skills/ (active) or skills/proposed/ */
  proposed: boolean;
  /**
   * Why this file is not the skill its author meant to write.
   *
   * Set only when the file parses but the result is not what the text says —
   * today, YAML front matter. Never a reason to drop the skill: it is reported
   * beside it, because a skill that vanishes is harder to debug than one that
   * says what is wrong with it.
   */
  problem?: string;
}

export const SKILLS_DIR = "skills";
export const PROPOSED_DIR = join("skills", "proposed");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a skill file: TOML front matter between `+++` fences, then markdown.
 *
 * A file without front matter is still a skill — it just always applies. That
 * keeps the cheapest possible note (drop a .md in the directory) valid.
 */
export function parseSkill(id: string, raw: string, proposed: boolean): Skill {
  const fence = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*\n?/;
  const m = raw.match(fence);
  if (!m) {
    // YAML front matter, caught rather than swallowed.
    //
    // "No front matter" and "front matter this parser does not read" are not
    // the same file, and treating them the same is silent. A `---` skill got
    // name = the filename, NO description, NO match — so it applied to every
    // turn — and its own front matter went into the model's prompt as
    // instruction text, because the body was the whole file.
    //
    // The mistake is likely, not hypothetical: `---` is the dominant
    // convention, and THIS repository ships both — .claude/skills/ uses YAML,
    // .gnomon/skills/ uses TOML. Someone copying the shape they just read
    // writes this file.
    const yaml = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
    if (yaml) {
      return {
        id,
        name: id,
        // Strip it regardless: whatever else is true, `---\nname: …\n---` is
        // not instruction text and must not reach the prompt.
        body: raw.slice(yaml[0].length).trim(),
        proposed,
        problem:
          "front matter is YAML (--- fences); gnomon skills use TOML (+++ fences). " +
          "Its name, description and match were NOT read, so this skill applies to " +
          "every turn. Change the fences to +++ and the `key: value` lines to " +
          '`key = "value"`.',
      };
    }
    return { id, name: id, body: raw.trim(), proposed };
  }
  const meta = parseToml(m[1]) as Record<string, unknown>;
  const body = raw.slice(m[0].length).trim();
  return {
    id,
    name: typeof meta.name === "string" ? meta.name : id,
    description: typeof meta.description === "string" ? meta.description : undefined,
    match: typeof meta.match === "string" ? meta.match : undefined,
    roles: Array.isArray(meta.roles) ? (meta.roles as string[]).map(String) : undefined,
    body,
    proposed,
  };
}

/** Render a skill back to file form. */
export function renderSkill(skill: Omit<Skill, "id" | "proposed">): string {
  const lines = ["+++", `name = "${skill.name}"`];
  if (skill.description) lines.push(`description = "${skill.description}"`);
  // Single-quoted: a literal TOML string, so a regex needs no escaping.
  if (skill.match) lines.push(`match = '${skill.match}'`);
  if (skill.roles?.length) {
    lines.push(`roles = [${skill.roles.map((r) => `"${r}"`).join(", ")}]`);
  }
  lines.push("+++", "", skill.body.trim(), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readDirSkills(dir: string, proposed: boolean): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort()
    .map((file) =>
      parseSkill(
        file.replace(/\.md$/, ""),
        readFileSync(join(dir, file), "utf-8"),
        proposed
      )
    );
}

/** Active skills — `.gnomon/skills/*.md`. Proposals are excluded by design. */
export function loadSkills(config: GnomonConfig): Skill[] {
  return readDirSkills(join(config.gnomonDir, SKILLS_DIR), false);
}

/** Pending proposals — written by an agent, not yet accepted. */
export function loadProposedSkills(config: GnomonConfig): Skill[] {
  return readDirSkills(join(config.gnomonDir, PROPOSED_DIR), true);
}

/**
 * The skills that apply to one turn.
 *
 * A skill with no `match` always applies; one with an unparseable pattern is
 * skipped rather than throwing, so a malformed note cannot break every turn.
 *
 * That catch stays — one bad note must not break every turn — but it was the
 * ONLY thing that ever happened to a broken pattern. `return false` on every
 * turn is indistinguishable from a pattern that simply never matches, so a
 * skill accepted into the surface, hashed, and listed by `gnomon skill list`
 * could be inert for its whole life with nothing anywhere saying so. The same
 * silence covers `roles = ["implementer"]` when the role is spelled
 * "implementor": the filter on the line above drops it and says nothing.
 *
 * auditSurface (config.ts) now iterates loadSkills and reports both, plus a
 * control character anywhere in the file — it runs before the first turn, which
 * is the only moment an operator is in a position to fix the file. Refusing
 * here instead would trade a lost note for a dead session; that is the wrong
 * trade, so the catch below is unchanged on purpose.
 */
/**
 * The skills this ROLE may use, whatever the turn is about.
 *
 * The role filter and the `match` filter answer different questions, and
 * collapsing them loses one. `roles` says a skill is not for this role at all;
 * `match` says it did not come up this time. Only the second is worth telling
 * the model about, which is what makes this split useful rather than cosmetic.
 */
export function roleSkills(skills: Skill[], role: string): Skill[] {
  return skills.filter((s) => !s.roles || s.roles.includes(role));
}

export function selectSkills(skills: Skill[], role: string, input: string): Skill[] {
  return skills.filter((s) => {
    if (s.roles && !s.roles.includes(role)) return false;
    if (!s.match) return true;
    try {
      return new RegExp(s.match, "i").test(input);
    } catch {
      // Reported by auditSurface at startup, not swallowed silently.
      return false;
    }
  });
}

/**
 * Append the applicable skills to the system prompt.
 *
 * Marked as learned notes rather than presented as core rules: a skill is
 * something this repository observed, and it should not be able to quietly
 * outrank system.md.
 */
/**
 * State the working invariant the model otherwise has to guess.
 *
 * Without it a session watched a model invent `/repo`, run `find /repo`, get
 * exit 2, and spend three tool calls rediscovering where it was. The wording
 * is deliberately path-free: an absolute path would make the prompt differ
 * between machines, which is the thing this harness exists to avoid.
 */
export const WORKING_CONTEXT =
  "## Working context\n\n" +
  "You are operating inside a single repository. Every tool path is resolved " +
  "relative to its root, and paths outside it are refused — so use relative " +
  "paths like `src/main.rs` or `.` and never guess an absolute one. `read` on " +
  "a directory lists it; start there rather than shelling out to find.";

export function withWorkingContext(systemPrompt: string): string {
  return `${systemPrompt}\n\n${WORKING_CONTEXT}`;
}

export function applySkills(
  systemPrompt: string,
  skills: Skill[],
  /**
   * Skills this role may use whose `match` did not fire on this input. Listed
   * by name and path, never by body.
   *
   * Without this the model cannot know they exist. A skill whose pattern is
   * slightly wrong is then indistinguishable from a skill nobody wrote — it
   * sits in the surface, hashed and inert, and the one thing that would fix it
   * (someone noticing) never happens. Naming them costs a line each and is
   * still derived from the surface plus the role, so the same checkout
   * produces the same list on every machine.
   */
  dormant: Skill[] = [],
  /** Where those files live, relative to the root, for the model to `read`. */
  dirRel = ".gnomon/skills"
): string {
  let out = systemPrompt;
  if (skills.length > 0) {
    const blocks = skills.map(
      (s) => `### ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.body}`
    );
    out +=
      `\n\n## Learned skills for this repository\n\n` +
      `These are notes accepted into .gnomon/skills/. They inform how you work ` +
      `here; they do not override the rules above.\n\n` +
      blocks.join("\n\n");
  }
  if (dormant.length > 0) {
    const lines = dormant.map(
      (s) => `- \`${dirRel}/${s.id}.md\` — ${s.name}${s.description ? `: ${s.description}` : ""}`
    );
    out +=
      `\n\n## Other notes available here, not loaded\n\n` +
      `These exist for your role but did not match this request, so only their ` +
      `names are above. If one looks relevant, \`read\` the file — do not act on ` +
      `the description alone, because it is a label and not the note.\n\n` +
      lines.join("\n");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authorship
// ---------------------------------------------------------------------------

export interface SkillProposal {
  name: string;
  description?: string;
  match?: string;
  roles?: string[];
  body: string;
}

/** Filenames are derived, never taken from the model. */
export function skillId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "skill";
}

/** A proposal gnomon will not write, and why. The `skill` tool returns it as a refusal. */
export class ProposalRefused extends Error {}

/**
 * Write a proposal into `.gnomon/skills/proposed/`.
 *
 * The path is derived from the name, so a proposal cannot be aimed at
 * `../../system.md` or at an existing active skill. This is the whole reason
 * authorship is safe to grant.
 *
 * Deriving the NAME was not enough on its own (LN8, orthogonality suite).
 * `proposed/` is excluded from the surface hash, so a link planted there moved
 * nothing, and the write followed it: `proposed/x.md -> ../../system.md` made
 * the skill tool rewrite the system prompt, a hard link to `policy.toml` made
 * it rewrite the policy, and `proposed -> .` made a proposal an ACTIVE skill
 * with no accept. All three returned TOOL_OK under `strict`. So the staging
 * directory must really be `.gnomon/skills/proposed/`, a proposal is never
 * written through an existing link, and the file is written new and renamed
 * into place, which replaces a directory entry and never writes through one.
 */
export function proposeSkill(
  config: GnomonConfig,
  proposal: SkillProposal
): { id: string; path: string; existed: boolean } {
  const id = skillId(proposal.name);
  for (const sub of [SKILLS_DIR, PROPOSED_DIR]) {
    let link = false;
    try {
      link = lstatSync(join(config.gnomonDir, sub)).isSymbolicLink();
    } catch {
      /* absent: created below */
    }
    if (link) {
      throw new ProposalRefused(
        `.gnomon/${sub.split(sep).join("/")} is a symbolic link, so a proposal written there could ` +
          `land anywhere, the surface included. Proposals are written only into the real directory.`
      );
    }
  }
  const dir = join(config.gnomonDir, PROPOSED_DIR);
  mkdirSync(dir, { recursive: true });
  if (realpathSync(dir) !== join(realpathSync(config.gnomonDir), PROPOSED_DIR)) {
    throw new ProposalRefused(
      `.gnomon/skills/proposed/ does not resolve to itself, so a proposal written there could land ` +
        `anywhere, the surface included.`
    );
  }
  const path = join(dir, `${id}.md`);
  let existed = false;
  try {
    const st = lstatSync(path);
    existed = true;
    if (!st.isFile() || st.nlink > 1) {
      const what = st.isSymbolicLink() ? "a symbolic link" : st.isFile() ? "a hard link to another file" : "not a regular file";
      throw new ProposalRefused(
        `.gnomon/skills/proposed/${id}.md is ${what}; writing the proposal would write through it. ` +
          `A person can remove it, and the proposal can then be made again.`
      );
    }
  } catch (err) {
    if (err instanceof ProposalRefused) throw err;
    /* absent */
  }
  const tmp = join(dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, renderSkill(proposal), { encoding: "utf-8", flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { id, path, existed };
}

// ---------------------------------------------------------------------------
// Decisions: accept and reject, each with its own audit record
// ---------------------------------------------------------------------------

/**
 * Who made a skill decision, and anything they said about it.
 *
 * `by` is "human" from the CLI: `gnomon skill accept` is a person at a
 * terminal or in a script, and no model holds a tool that reaches this code.
 * `user` and `host` are what the process can see; they identify, they do not
 * authenticate.
 */
export interface SkillDecisionOptions {
  by?: string;
  /** Why a proposal was rejected. Recorded as given. */
  reason?: string;
  /**
   * Whether a person is at a terminal: stdin AND stdout. Defaults to what this
   * process sees (agent_context.ts). Without one, a decision needs a
   * person-present signer, and is refused otherwise.
   */
  interactive?: boolean;
  /**
   * Accept only: the path of a `gnomon skill trial` report.json, relative to
   * the repository root or absolute. Checked by `checkEvidence` before the
   * file moves; its hash is what the `skill_accept` record cites.
   */
  evidence?: string;
}

export interface SkillDecision {
  /** Where the skill file is now (accept), or where it was (reject). */
  path: string;
  /** The `skill_accept` / `skill_reject` record, with its hash. */
  record: AuditRecord | null;
  /** The trail it was written to. */
  trail: string | null;
  /**
   * Whether the closing session_end was written. False means the change was
   * made and recorded, but the trail is unsealed; `gnomon audit verify` will
   * say so.
   */
  sealed: boolean;
}

/** sha256 of a skill file's bytes: the identity a trial and an accept agree on. */
export function skillContentHash(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * A skill decision refused by a rule -- not a failure to carry it out. The
 * CLI exits 3 (refused_by_gate, docs/CONTRACTS.md §1) for every subclass and
 * 1 for anything else, so each new refusal reason extends this rather than
 * adding its own case to the CLI.
 */
export class SkillRefusal extends Error {}

/**
 * Refused: a skill decision made from inside an agent session.
 *
 * The harness sets GNOMON_AGENT_SESSION in every tool subprocess (tools.ts,
 * AGENT_SESSION_ENV). Found in re-review: `gnomon skill accept` run through
 * the agent's own bash was recorded `by: "human"`. Acceptance is a person's.
 * GBS-GOVERNANCE 0.1 then had the agent's bash accept its own skill by
 * unsetting the variable, 4 of 4: the checks are now agent_context.ts's.
 */
export class AgentSessionRefusal extends SkillRefusal {}

/** Refused: nobody was shown to be there. No terminal, and no person-present signer. */
export class NoPersonRefusal extends SkillRefusal {}

type Verb = "accept" | "reject";
const done = (verb: Verb) => (verb === "accept" ? "accepted" : "rejected");

function refuseInAgentSession(verb: Verb): void {
  const why = agentReason();
  if (why) {
    throw new AgentSessionRefusal(
      `Not ${done(verb)}: ${why}. Accepting or rejecting a skill is a person's decision; ` +
        `run \`gnomon skill ${verb}\` yourself, at a terminal, outside the agent.`
    );
  }
}

/**
 * Who authorises the decision: a person at a terminal ("tty"), or, without
 * one, a signer that needs a person for each signature
 * ("person_present_signer"), which must then sign the decision before it is
 * applied. `audit resolve` has had this rule since #115 (record_tamper.ts);
 * skill decisions had only the marker, which the agent's shell can drop.
 */
function requirePerson(config: GnomonConfig, verb: Verb, opts: SkillDecisionOptions): { interactive: boolean; authorised_by: "tty" | "person_present_signer" } {
  const interactive = opts.interactive ?? decisionContext().interactive;
  if (interactive) return { interactive, authorised_by: "tty" };
  if (personPresentSigner(config)) return { interactive, authorised_by: "person_present_signer" };
  throw new NoPersonRefusal(
    `Not ${done(verb)}: a skill decision needs a person -- run \`gnomon skill ${verb}\` at a terminal (stdin and ` +
      `stdout), or declare a signer that needs a person for each signature ([audit.attest] person_present = true, ` +
      `with ssh-add -c, a FIDO or hardware key, or a passphrase prompt).`
  );
}

function whoDecided(opts: SkillDecisionOptions, person: { interactive: boolean; authorised_by: string }): Record<string, unknown> {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (a container with an arbitrary uid). The variable is the
    // next best thing, and absent is better than invented.
    user = process.env.USER ?? process.env.USERNAME;
  }
  return {
    // "cli", not "human": the command cannot see who typed it. It refuses
    // inside an agent session, but a process can drop the marker (`env -u`),
    // and a record must not claim a certainty it does not have.
    by: opts.by ?? "cli",
    // Always "absent" on a record that was written: present is refused.
    agent_session_marker: process.env.GNOMON_AGENT_SESSION ? "present" : "absent",
    user,
    host: hostname(),
    interactive: person.interactive,
    authorised_by: person.authorised_by,
  };
}

/**
 * A skill decision on gnomon's own trail: a sealed three-record trail of its
 * own (session_start, the decision, session_end).
 *
 * Written even when the surface has `[audit] enabled = false`, for the reason
 * `gnomon check` writes its verdict regardless (check.ts, appendVerdict). The
 * flag governs what a SESSION records: turns, tool calls and possibly prompt
 * text. An accept is none of that. It is the one moment a person changes what
 * the agent is, it holds no model text, and before this it left nothing behind
 * but a moved file: the trail showed the surface hash change, never that a
 * person accepted a named skill, or what its content was. Chaining is forced
 * on because the record's hash is what a later reader cites.
 *
 * Write-ahead, in two calls. `openSkillDecision` writes session_start and the
 * decision BEFORE the file is touched; `seal` writes session_end after, saying
 * whether the change was applied. So there is never a moved file without a
 * record. A crash between the two leaves the record unsealed, which `gnomon
 * audit verify` reports as such, rather than a sealed record of a change that
 * did not happen. The order was the other way round until review found both
 * halves of that: a crash after the move left an accept with no record, and a
 * failed session_end undid an accept whose record was already written.
 */
function openSkillDecision(
  config: GnomonConfig,
  kind: "skill_accept" | "skill_reject",
  fields: Record<string, unknown>,
  surfaceHash: string
): {
  record: AuditRecord | null;
  trail: string | null;
  seal: (end: Record<string, unknown>) => void;
  /** Sign the head now, covering the decision. False when nothing signed it. */
  attest: () => boolean;
} {
  const settings = resolveAudit(config);
  const forced = { ...settings, enabled: true, chain: true };
  // A random suffix as well as the time and pid: two decisions in one process
  // inside one millisecond (a script accepting several proposals) would
  // otherwise name the same file, and the second trail would restart at seq
  // 0 on top of the first, a chain that no longer verifies.
  const id = `skill-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const trail = new AuditTrail(forced, id);
  trail.write("session_start", {
    surface_hash: surfaceHash,
    harness: harnessBuild(),
    cwd: process.cwd(),
    mode: "skill",
  });
  const record = trail.write(kind, fields);
  return { record, trail: trail.path, seal: (end) => void trail.write("session_end", end), attest: () => {
    // Signed, and the signature checks out against the declared key or
    // verify command: a signer that prints anything still gets a head written.
    if (!trail.attestHead() || !trail.path || !forced.attest) return false;
    const v = verifyTrail(trail.path, { attest: forced.attest });
    return v.attestation?.status === "signed" && v.attestation.unattested === 0;
  } };
}

/**
 * The id a skill file must have: the slug `skillId` derives. Everything the
 * CLI is given is checked against it before it becomes a path, so `skill
 * reject ../keep` cannot reach `.gnomon/skills/keep.md` -- which it did.
 */
function assertSkillId(id: string): void {
  if (skillId(id) !== id) {
    throw new Error(
      `"${id}" is not a skill id: ids are lower-case letters, digits and dashes ` +
        `(\`gnomon skill list\` shows them).`
    );
  }
}

// ---------------------------------------------------------------------------
// Evidence: a trial report, checked before an accept
// ---------------------------------------------------------------------------

/** What a `skill_accept` record says about the trial it cites. */
export interface SkillEvidence {
  /** The report, repo-relative with POSIX separators when inside the repo */
  report: string;
  report_sha256: string;
  meets_thresholds: true | false | "undetermined";
  /** The `skill_trial` record that names this report's hash. */
  trial_record: { trail: string; seq: number; hash: string };
  /**
   * Whether the trail was also checked against signed heads ([audit.attest]).
   * False means the chain verified and the record agrees with the report,
   * which proves consistency, not provenance: anyone who can write the
   * directory can build a consistent trail. With a signer declared, an
   * unsigned or broken anchor is refused.
   */
  attested: boolean;
}

/**
 * `[skills] require_trial` in policy.toml. Off by default: a small project
 * should not need a trial to save a note. A team turns it on.
 */
export function requireTrial(config: GnomonConfig): boolean {
  const s = (config.policy as { skills?: { require_trial?: unknown } } | undefined)?.skills;
  return s?.require_trial === true;
}

/**
 * Whether the surface declares a signer that can anchor a trail: `[audit.attest]`
 * with a `sign` command, and a `verify` command or `public_key` to check its
 * heads with.
 *
 * `require_trial` needs one. Without it a sealed, chained trial trail proves
 * consistency and nothing else, and re-review built one by hand with
 * `recordHash` -- any process with a shell can. An anchor outside the file is
 * the only thing that makes "a trial produced this" checkable (audit.ts).
 */
export function signerDeclared(config: GnomonConfig): boolean {
  const a = resolveAudit(config).attest;
  return Boolean(a?.enabled && (a.verify || a.public_key));
}

/**
 * Why the declared verifier is not pinned by the surface hash, or null when
 * it is.
 *
 * Round-3 review: with `public_key = "keys/audit.pub"` -- a file outside
 * `.gnomon/` -- swapping the key for one the agent holds moved nothing, and a
 * report the agent signed was accepted under require_trial. So, under
 * require_trial, what CHECKS a signature must be part of the surface: a PEM
 * inline in config.toml, or a key file under `.gnomon/` (hashed); a `verify`
 * command whose every path-like word names a file under `.gnomon/`. Then
 * changing either moves the hash, and a surface that grants more than the
 * scaffold needs a person's trust again.
 */
export function verifierOutsideSurface(config: GnomonConfig): string | null {
  const raw = (config.config as { audit?: { attest?: { public_key?: unknown; verify?: unknown } } } | undefined)
    ?.audit?.attest;
  const root = resolve(config.gnomonDir, "..");
  const gnomon = resolve(config.gnomonDir);
  const unhashed = [join(gnomon, "skills", "proposed"), join(gnomon, "extensions")];
  const pinned = (p: string): boolean => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    const inside = (base: string) => {
      const rel = relative(base, abs);
      return rel !== "" && !escapesBase(rel);
    };
    return inside(gnomon) && !unhashed.some(inside);
  };
  // An in-process public key, which gnomon checks itself, is required.
  // Round-4 review: path-word pinning of a `verify` COMMAND cannot follow
  // `make -s verify-head`, `npm run verify`, `python3 -m verifier` -- the
  // agent edited the Makefile the command ran, and a junk signature passed.
  // A verify command may still be declared; under require_trial it is not
  // used to judge evidence (checkEvidence passes the key alone).
  const key = typeof raw?.public_key === "string" ? raw.public_key.trim() : "";
  if (!key) {
    return `no public_key is declared. require_trial needs a key gnomon verifies itself -- inline in config.toml, or a file under .gnomon/ -- because a verify command can run anything (make, npm run) that the surface hash does not cover.`;
  }
  if (!key.startsWith("-----BEGIN") && !pinned(key)) {
    return `public_key = "${key}" is a file outside .gnomon/, so replacing it does not move the surface hash. Put the PEM inline in config.toml, or the file under .gnomon/.`;
  }
  return null;
}

/**
 * What a signer proves, said where the refusal is read. A signer any process
 * of this user can run proves only that some process of this user signed --
 * it does not stop an agent that has a shell, which can run it too.
 */
const SIGNER_GUARANTEE =
  "What a signer proves depends on who can make it sign. A key file or an unconfirmed " +
  "ssh-agent signs for any process of yours, the agent's shell included: a script that runs " +
  "a trial with a stubbed runner and lets that signer sign gets an accepted skill. So it proves " +
  "only that the trail was not edited afterwards by someone without the key. The guarantee " +
  "against an agent with a shell comes ONLY from a signer that needs a person for each " +
  "signature -- confirming it at the end of the trial (ssh-agent with `ssh-add -c`, a FIDO or " +
  "hardware key that needs a touch, a passphrase prompt). A kernel sandbox (exec os), which " +
  "would keep the agent away from the key, is proposed (#74/#156) but not yet merged. require_trial is off by default.";

const SIGNER_HOWTO =
  "Declare a signer in .gnomon/config.toml, so trial trails are anchored outside the file:\n" +
  "  [audit.attest]\n" +
  '  sign = "<command: digest on stdin, signature on stdout>"\n' +
  '  public_key = "<inline PEM, or a file under .gnomon/>"   # or verify = "<command>"\n' +
  "(README, \"[audit.attest] — an anchor outside the file\"). Or turn require_trial off.\n" +
  SIGNER_GUARANTEE;

/**
 * Check a trial report against the skill about to be accepted.
 *
 * Refused, whatever `require_trial` says, when the report is evidence about
 * something else -- that would put a hash on the record that proves nothing
 * about this decision:
 *   - not a `gnomon.trial/1` report;
 *   - a different skill content (`content_sha256`);
 *   - a different base surface (`arms.base.surface_hash`): the trial measured
 *     the skill against a surface that is not the one it is joining;
 *   - no `skill_trial` record vouches for the report. Vouching means: the
 *     record names the report's sha256; it sits in a sealed trail of exactly
 *     session_start (mode "trial"), skill_trial, session_end whose chain
 *     verifies, every record hash recomputed; it agrees with the report on
 *     skill, content, both surface hashes and the verdict; and, when the
 *     surface declares [audit.attest], the trail's signed heads verify and
 *     cover it. Until review, a single hand-written line
 *     `{"kind":"skill_trial","report_sha256":X}` in any .jsonl counted.
 *
 * With `require_trial` on, a report that does not meet its declared
 * thresholds is refused too. With it off, the person may accept anyway; the
 * record says what the report found, so the choice is visible.
 */
export function checkEvidence(
  config: GnomonConfig,
  want: { content: string; surface: string; required: boolean; report: string }
): SkillEvidence {
  const root = resolve(config.gnomonDir, "..");
  const file = isAbsolute(want.report) ? want.report : join(root, want.report);
  const shown = (p: string) => {
    const rel = relative(root, p);
    return escapesBase(rel) ? p : rel.split(sep).join("/");
  };
  const refuse = (why: string): never => {
    throw new SkillRefusal(`Not accepted: ${why}`);
  };
  if (!existsSync(file)) refuse(`no trial report at ${want.report}.`);
  const body = readFileSync(file);
  let report: TrialReportFields;
  try {
    report = JSON.parse(body.toString("utf-8"));
  } catch {
    return refuse(`${want.report} is not JSON.`);
  }
  if (report.schema !== "gnomon.trial/1") refuse(`${want.report} is not a gnomon skill trial report.`);
  if (report.content_sha256 !== want.content) {
    refuse(
      `the report is for different skill content (${String(report.content_sha256).slice(0, 12)}); ` +
        `this proposal is ${want.content.slice(0, 12)}. Trial the proposal as it is now.`
    );
  }
  const base = report.arms?.base?.surface_hash;
  if (base !== want.surface) {
    refuse(
      `the trial ran against surface ${String(base).slice(0, 12)}; this surface is ` +
        `${want.surface.slice(0, 12)}. Trial it again on the current surface.`
    );
  }
  const report_sha256 = createHash("sha256").update(body).digest("hex");
  const found = findTrialRecord(config, report_sha256, report, want.required);
  if ("refused" in found) refuse(found.refused);
  const { trial_record, attested } = found as { trial_record: SkillEvidence["trial_record"]; attested: boolean };
  // Belt and braces: acceptSkill refuses require_trial without a signer before
  // it gets here, and findTrialRecord refuses an unsigned trail when one is
  // declared. A caller that reaches this some other way still cannot pass.
  if (want.required && !attested) refuse(`require_trial is on and the trial's trail is not attested. ${SIGNER_HOWTO}`);
  const meets = report.meets_thresholds;
  const verdict = meets === true || meets === false ? meets : "undetermined";
  if (want.required && verdict !== true) {
    refuse(`require_trial is on, and this trial's meets_thresholds is ${JSON.stringify(verdict)}.`);
  }
  return { report: shown(file), report_sha256, meets_thresholds: verdict, trial_record, attested };
}

/** The report fields evidence is checked against. */
interface TrialReportFields {
  schema?: unknown;
  skill?: unknown;
  content_sha256?: unknown;
  arms?: { base?: { surface_hash?: unknown }; skill?: { surface_hash?: unknown } };
  meets_thresholds?: unknown;
}

/**
 * The `skill_trial` record that vouches for a report (see checkEvidence), or
 * why none does. Every candidate trail is checked; the first that passes
 * wins, and otherwise the last reason is the one reported.
 */
function findTrialRecord(
  config: GnomonConfig,
  reportSha: string,
  report: TrialReportFields,
  /** require_trial: heads are checked against the in-process public_key only. */
  keyOnly = false
): { trial_record: SkillEvidence["trial_record"]; attested: boolean } | { refused: string } {
  const root = resolve(config.gnomonDir, "..");
  const audit = resolveAudit(config);
  const dir = audit.dir;
  const attest = audit.attest;
  const signer = Boolean(attest && (attest.enabled || attest.verify || attest.public_key));
  let why = `no skill_trial record in the audit trail names this report (${reportSha.slice(0, 12)}).`;
  if (!existsSync(dir)) return { refused: why };
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    const file = join(dir, f);
    const text = readFileSync(file, "utf-8");
    if (!text.includes(reportSha)) continue;
    let records: AuditRecord[];
    try {
      records = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      why = `the trail naming this report (${f}) does not parse.`;
      continue;
    }
    const r = records[1];
    if (
      records.length !== 3 ||
      records[0]!.kind !== "session_start" ||
      records[0]!.mode !== "trial" ||
      r?.kind !== "skill_trial" ||
      records[2]!.kind !== "session_end"
    ) {
      why = `${f} is not a trial's own sealed trail (session_start mode "trial", skill_trial, session_end).`;
      continue;
    }
    if (r.report_sha256 !== reportSha) continue;
    // verifyTrail recomputes every record's hash and checks each link; a
    // record without a hash in a chained trail is broken, and a trail without
    // any hash is not chained at all -- refused here, since the trial always
    // writes a chained one.
    // Under require_trial, only the public_key gnomon checks itself decides:
    // a verify command can run what the surface hash does not cover.
    const checker = attest && keyOnly ? { ...attest, verify: null } : attest;
    const v = verifyTrail(file, signer && checker ? { attest: checker } : {});
    if (!v.ok || !v.sealed || typeof r.hash !== "string" || r.hash !== recordHash(r)) {
      why = `the trail naming this report (${f}) does not verify as a sealed hash chain.`;
      continue;
    }
    if (signer) {
      const a = v.attestation;
      if (!a || a.status !== "signed" || a.unattested > 0) {
        why = `[audit.attest] is declared and ${f} is not covered by signed heads (${a?.status ?? "unchecked"}).`;
        continue;
      }
    }
    const disagree = [
      ["skill", r.skill, report.skill],
      ["content_sha256", r.content_sha256, report.content_sha256],
      ["surface_hash_base", r.surface_hash_base, report.arms?.base?.surface_hash],
      ["surface_hash_skill", r.surface_hash_skill, report.arms?.skill?.surface_hash],
      ["meets_thresholds", r.meets_thresholds, report.meets_thresholds],
    ].filter(([, a, b]) => a !== b).map(([k]) => k);
    if (disagree.length > 0) {
      why = `the skill_trial record in ${f} disagrees with the report on ${disagree.join(", ")}.`;
      continue;
    }
    const rel = relative(root, file);
    const trail = escapesBase(rel) ? file : rel.split(sep).join("/");
    return { trial_record: { trail, seq: r.seq, hash: r.hash }, attested: signer };
  }
  return { refused: why };
}

/**
 * Refused: a skill accepted while gnomon's own records show a change gnomon
 * did not make (record_guard.ts) that no person has resolved. A trail that
 * has been tampered with is not evidence for anything, including the trial a
 * skill is accepted on. The CLI exits 3 (refused_by_gate).
 */
export class RecordTamperRefusal extends SkillRefusal {}

/**
 * Accept a proposal: move it into `.gnomon/skills/`, and record that it
 * happened.
 *
 * This changes the surface hash on purpose. It is a human action, and it takes
 * effect on the next session rather than the running one.
 *
 * The `skill_accept` record carries the skill's content hash and the surface
 * hash before and after, so the trail names the person's act and not only its
 * effect. It is written before the file moves (`openSkillDecision`); an accept
 * whose record cannot be written does not happen, and one whose move fails is
 * sealed `applied: false`.
 */
export function acceptSkill(
  config: GnomonConfig,
  id: string,
  opts: SkillDecisionOptions = {}
): SkillDecision {
  assertSkillId(id);
  refuseInAgentSession("accept");
  const person = requirePerson(config, "accept", opts);
  {
    // The records against the last checkpoint a session left: a change in
    // the gap between sessions -- a background job, a deleted tamper trail --
    // is recorded here as a tamper event, and then blocks like any other.
    const since = compareWithCheckpoint(config, "at_accept");
    if (since?.changes.length) {
      writeTamperRecord(config, {
        when: since.when,
        changes: describeChanges(resolve(config.gnomonDir, ".."), since.changes),
        changed: since.changes.length,
      });
      writeCheckpoint(config);
    }
    const open = unresolvedTamper(config);
    if (open.length > 0) {
      throw new RecordTamperRefusal(
        `Not accepted: gnomon's own records were changed by something other than gnomon, and ` +
          `${open.length} such event(s) are unresolved (first: ${open[0]!.trail}:${open[0]!.seq}). ` +
          `Look at \`gnomon audit tamper\`, then \`gnomon audit resolve <trail>:<seq> --reason "…"\`.`
      );
    }
  }
  const from = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(from)) {
    throw new Error(`No proposed skill "${id}". Run \`gnomon skill list\`.`);
  }
  const raw = readFileSync(from);
  const skill = parseSkill(id, raw.toString("utf-8"), true);
  const content = skillContentHash(raw);
  const { manifest, surface_hash: before } = recomputeManifest(config.gnomonDir);
  // Evidence is checked before anything is written or moved: a refused
  // accept leaves the proposal exactly where it was, and records nothing.
  const required = requireTrial(config);
  if (required && !signerDeclared(config)) {
    throw new SkillRefusal(
      `Not accepted: [skills] require_trial is on, but no signer is declared. Without one, a sealed ` +
        `trial trail can be built by hand with the chain's own hash function, so a trial report ` +
        `proves nothing. ${SIGNER_HOWTO}`
    );
  }
  if (required) {
    const loose = verifierOutsideSurface(config);
    if (loose) throw new SkillRefusal(`Not accepted: [skills] require_trial is on, and ${loose}`);
  }
  if (required && !opts.evidence) {
    throw new SkillRefusal(
      `Not accepted: [skills] require_trial is on in policy.toml. Run \`gnomon skill trial ${id}\` ` +
        `and pass its report: \`gnomon skill accept ${id} --evidence <report.json>\`.`
    );
  }
  const evidence = opts.evidence
    ? checkEvidence(config, { content, surface: before, required, report: opts.evidence })
    : "none";
  // The hash the move WILL produce, named before it happens.
  const rel = `.gnomon/skills/${id}.md`;
  const after = manifestHash([...manifest.filter((s) => s.path !== rel), { path: rel, sha256: content }]);

  let open: ReturnType<typeof openSkillDecision>;
  try {
    open = openSkillDecision(
      config,
      "skill_accept",
      {
        skill: id,
        name: skill.name,
        path: rel,
        content_sha256: content,
        surface_hash_before: before,
        surface_hash_after: after,
        // The trial report this decision cites, or plainly "none": accepted on
        // reading alone.
        evidence,
        require_trial: required,
        ...whoDecided(opts, person),
      },
      before
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Not accepted: the skill_accept record could not be written (${why}).`);
  }

  signedByPerson(open, person, "accept");

  const dir = join(config.gnomonDir, SKILLS_DIR);
  const to = join(dir, `${id}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    renameSync(from, to);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    sealQuietly(open, { applied: false, error: why });
    throw new Error(`Not accepted: the proposal could not be moved (${why}). The record says so.`);
  }
  const sealed = sealQuietly(open, {
    applied: true,
    surface_hash_after: recomputeManifest(config.gnomonDir).surface_hash,
  });
  return { path: to, record: open.record, trail: open.trail, sealed };
}

/**
 * Without a terminal, the person-present signer is the person: it signs the
 * head covering the decision before anything is applied. A signature it does
 * not give (declined, or the key is not there) refuses the decision, sealed
 * `applied: false`, as a refused resolution is (record_tamper.ts).
 */
function signedByPerson(
  open: { attest: () => boolean; seal: (end: Record<string, unknown>) => void },
  person: { authorised_by: string },
  verb: Verb
): void {
  if (person.authorised_by !== "person_present_signer") return;
  if (open.attest()) return;
  const error = "the person-present signer did not sign the decision";
  sealQuietly(open, { applied: false, error });
  throw new NoPersonRefusal(`Not ${done(verb)}: ${error}, and there is no terminal. The record says so.`);
}

/**
 * Seal a decision, and say whether that worked rather than throw: by now the
 * change is either made or refused, and undoing a made change because its
 * closing record failed is the inconsistency the write-ahead order removes.
 */
function sealQuietly(open: { seal: (end: Record<string, unknown>) => void }, end: Record<string, unknown>): boolean {
  try {
    open.seal(end);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discard a proposal, and record that it happened. Active skills are never
 * removed by this: the id is checked, so no path outside `proposed/` is
 * reachable.
 *
 * The record is written BEFORE the file is removed, so a reject that cannot
 * be recorded leaves the proposal where it was. The surface hash is the same
 * before and after -- proposals are not hashed -- and the record says so in
 * the same two fields an accept uses, so a reader needs one shape for both.
 */
export function rejectSkill(
  config: GnomonConfig,
  id: string,
  opts: SkillDecisionOptions = {}
): SkillDecision {
  assertSkillId(id);
  refuseInAgentSession("reject");
  const person = requirePerson(config, "reject", opts);
  const path = join(config.gnomonDir, PROPOSED_DIR, `${id}.md`);
  if (!existsSync(path)) {
    throw new Error(`No proposed skill "${id}".`);
  }
  const raw = readFileSync(path);
  const skill = parseSkill(id, raw.toString("utf-8"), true);
  const surface = recomputeManifest(config.gnomonDir).surface_hash;
  const open = openSkillDecision(
    config,
    "skill_reject",
    {
      skill: id,
      name: skill.name,
      path: `.gnomon/skills/proposed/${id}.md`,
      content_sha256: skillContentHash(raw),
      surface_hash_before: surface,
      surface_hash_after: surface,
      reason: opts.reason,
      ...whoDecided(opts, person),
    },
    surface
  );
  signedByPerson(open, person, "reject");
  try {
    rmSync(path);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    sealQuietly(open, { applied: false, error: why });
    throw new Error(`Not rejected: the proposal could not be removed (${why}). The record says so.`);
  }
  const sealed = sealQuietly(open, { applied: true });
  return { path, record: open.record, trail: open.trail, sealed };
}
