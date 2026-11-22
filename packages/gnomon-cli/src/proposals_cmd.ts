/**
 * gnomon-cli: `gnomon proposals` and `gnomon memory`.
 *
 * `proposals [list|show <id>|accept <id>|reject <id> [--note <text>]]` reads
 * and decides the proposals to change `.gnomon/` (gnomon-core proposals.ts).
 * Accept and reject are a person's: they refuse inside an agent session and
 * without a terminal or a person-present signer, exit 3, as `gnomon skill
 * accept` does. `memory [list|show <name>]` reads the accepted entries in
 * `.gnomon/memory/` (memory.ts). Both are read-only except accept and reject.
 *
 * Contract: docs/CONTRACTS.md section 58.
 */

import {
  acceptProposal,
  findMemory,
  listProposals,
  loadMemory,
  readProposal,
  rejectProposal,
  renderDiff,
  proposalPaths,
  SkillRefusal,
  PROPOSALS_DIR,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type GnomonConfig,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
} from "gnomon-core";

export const PROPOSALS_CLI_SCHEMA = "gnomon.proposals/1";
export const MEMORY_CLI_SCHEMA = "gnomon.memory/1";

export interface ProposalsArgs {
  sub: string;
  positional: string[];
  flags: Record<string, string>;
  json: boolean;
}

const flag = (v: string | undefined): string | undefined => (typeof v === "string" && v !== "true" ? v : undefined);

const row = (p: Proposal): string => `${p.id}  ${p.status.padEnd(8)} ${p.kind.padEnd(8)} ${p.title}  (${proposalPaths(p).join(", ")})`;

function show(config: GnomonConfig, p: Proposal): string {
  const out = [
    `${p.id}  ${p.status}  ${p.kind}  (from ${p.source}, ${p.created})`,
    `  ${p.title}`,
  ];
  if (p.rationale) out.push("", ...p.rationale.split("\n").map((l) => `  ${l}`));
  if (p.evidence?.length) out.push("", `  evidence: ${p.evidence.map((e) => [e.trail, e.seq !== undefined ? `#${e.seq}` : "", e.note ?? ""].join("")).join(", ")}`);
  out.push("", renderDiff(config, p));
  if (p.decided_at) out.push("", `  ${p.status} ${p.decided_at} by ${p.decided_by}${p.note ? `: ${p.note}` : ""}`);
  return out.join("\n");
}

/** Exit code: 0 done, 1 a usage error or a proposal that is not there, 3 a decision a rule refused. */
export function runProposals(config: GnomonConfig, a: ProposalsArgs, out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const fail = (msg: string, code = 1): number => {
    if (a.json) out(JSON.stringify({ schema: PROPOSALS_CLI_SCHEMA, error: msg }, null, 2));
    else err(`gnomon proposals: ${msg}`);
    return code;
  };
  const sub = a.sub || "list";
  const given = a.positional[0] ?? "";
  try {
    switch (sub) {
      case "list": {
        const status = flag(a.flags["status"]);
        const kind = flag(a.flags["kind"]);
        if (status && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) return fail(`--status is one of ${PROPOSAL_STATUSES.join(", ")}`);
        if (kind && !(PROPOSAL_KINDS as readonly string[]).includes(kind)) return fail(`--kind is one of ${PROPOSAL_KINDS.join(", ")}`);
        // Pending by default: what a person has to decide.
        const l = listProposals(config, { status: (status ?? "pending") as ProposalStatus, ...(kind ? { kind: kind as ProposalKind } : {}) });
        if (a.json) out(JSON.stringify({ schema: PROPOSALS_CLI_SCHEMA, dir: PROPOSALS_DIR, proposals: l.proposals, problems: l.problems }, null, 2));
        else {
          if (l.proposals.length === 0) out(`No ${status ?? "pending"} proposals.`);
          for (const p of l.proposals) out(row(p));
          for (const m of l.problems) err(`gnomon proposals: ${m}`);
        }
        return 0;
      }
      case "show": {
        const p = readProposal(config, given);
        if (!p) return fail(`no proposal "${given}" (a full id, or a prefix that names one)`);
        out(a.json ? JSON.stringify({ schema: PROPOSALS_CLI_SCHEMA, proposal: p }, null, 2) : show(config, p));
        return 0;
      }
      case "accept":
      case "reject": {
        if (!given) return fail(`usage: gnomon proposals ${sub} <id>`);
        const p = readProposal(config, given);
        if (!p) return fail(`no proposal "${given}" (a full id, or a prefix that names one)`);
        const note = flag(a.flags["note"]) ?? flag(a.flags["reason"]);
        const d = sub === "accept" ? acceptProposal(config, p.id) : rejectProposal(config, p.id, { reason: note });
        if (a.json) out(JSON.stringify({ schema: PROPOSALS_CLI_SCHEMA, decision: d }, null, 2));
        else {
          out(sub === "accept" ? `Accepted ${d.id}: wrote ${d.paths.map((x) => `.gnomon/${x}`).join(", ")}` : `Rejected ${d.id}`);
          if (sub === "accept") out("The surface hash has changed. It applies from the next session.");
          if (d.trail) out(`Recorded in ${d.trail}`);
          if (!d.sealed) err("The change was made and recorded, but the trail could not be sealed; `gnomon audit verify` will report it unsealed.");
        }
        return 0;
      }
      default:
        return fail(`unknown subcommand "${sub}": list, show <id>, accept <id>, reject <id> [--note <text>]`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), e instanceof SkillRefusal ? 3 : 1);
  }
}

/** `gnomon memory [list|show <name>]`: the entries a person accepted. Exit 0, or 1 for a name that is not there. */
export function runMemory(config: GnomonConfig, a: ProposalsArgs, out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const fail = (msg: string): number => {
    if (a.json) out(JSON.stringify({ schema: MEMORY_CLI_SCHEMA, error: msg }, null, 2));
    else err(`gnomon memory: ${msg}`);
    return 1;
  };
  const sub = a.sub || "list";
  const entries = loadMemory(config);
  if (sub === "list") {
    if (a.json) out(JSON.stringify({ schema: MEMORY_CLI_SCHEMA, dir: ".gnomon/memory", entries: entries.map(({ body: _b, ...e }) => e) }, null, 2));
    else if (entries.length === 0) out("No memory entries (.gnomon/memory/). An entry exists only through an accepted proposal.");
    else for (const e of entries) out(`${e.id}  ${e.name}${e.description ? ` — ${e.description}` : ""}${e.problem ? `  (${e.problem})` : ""}`);
    return 0;
  }
  if (sub === "show") {
    const e = findMemory(entries, a.positional[0] ?? "");
    if (!e) return fail(`no memory entry "${a.positional[0] ?? ""}" (gnomon memory list shows them)`);
    if (a.json) out(JSON.stringify({ schema: MEMORY_CLI_SCHEMA, entry: e }, null, 2));
    else {
      out(`${e.id}  ${e.name}`);
      if (e.description) out(`  ${e.description}`);
      out(`  provenance: proposal ${e.provenance || "(none)"}${e.source_trail ? `, ${e.source_trail}${e.source_seq !== undefined ? `#${e.source_seq}` : ""}` : ""}  created ${e.created || "?"}\n\n${e.body}`);
    }
    return 0;
  }
  return fail(`unknown subcommand "${sub}": list, show <name>`);
}
