/**
 * gnomon-core: the harness signature -- what an evaluation report states about
 * the harness so two results can be compared and a failure attributed.
 *
 * The survey "Agent Harness Engineering" (2026), Table 3 (p.32), lists per
 * ETCLOVG layer the minimum configuration to report. Every field here is a
 * fact gnomon already holds and already hashes; this only assembles them, in
 * a fixed order, into one block (`harness_signature`, docs/CONTRACTS.md §47
 * and §51). Nothing is added to the prompt loop, a request, or a session
 * record: a normal session is byte-identical.
 *
 * What it never carries: a credential or an env var name's value, a URL with
 * userinfo (the endpoint is its name, kind and host), a path outside the
 * project, a command's text (verify is its sha256), or the system prompt's text
 * (its sha256). `NOT_REPORTED` names the Table 3 rows gnomon has nothing to
 * fill, so a reader never mistakes an absent row for a clean one.
 */

import { createHash } from "node:crypto";
import {
  type GnomonConfig,
  resolveRouting,
  routeRole,
  resolveContext,
  resolveMasking,
  resolveExec,
  resolveApprovalGate,
  resolveSandboxLevel,
  resolveVerify,
  type RouteTarget,
} from "./config.js";
import { buildToolSet } from "./tools.js";
import { toolsHash } from "./tools_hash.js";
import { resolveEditVariant } from "./sweep_knobs.js";
import { resolveThinkCap } from "./think_cap.js";
import { inlineMaxTokens } from "./skills.js";
import { resolveLevels } from "./governance.js";
import { harnessBuild } from "./build.js";

export const HARNESS_SIGNATURE_SCHEMA = "gnomon.harness_signature/1";

/** The seven ETCLOVG layers, in Table 3's order. */
export const SIGNATURE_LAYERS = ["E", "T", "C", "L", "O", "V", "G"] as const;
export type SignatureLayer = (typeof SIGNATURE_LAYERS)[number];

/**
 * Table 3's "configuration to report" rows, each mapped to the signature field
 * that fills it, or to `null` when gnomon cannot. Published in
 * docs/GUIDE.md and CONTRACTS.md §47 and pinned by
 * conformance/harness_signature.json: the three must agree.
 */
export const TABLE3_MAP: ReadonlyArray<{ layer: SignatureLayer; row: string; field: string | null; note: string }> = [
  { layer: "E", row: "Execution image", field: "environment.exec", note: "mode and, under docker, the image name; a digest is not recorded" },
  { layer: "E", row: "Dependencies", field: null, note: "the project's own; a [verify] setup is named by hash under validation.verify" },
  { layer: "E", row: "Reset policy", field: "environment.reset", note: "a fresh clone per eval cell; a live session has none" },
  { layer: "E", row: "Resource limits", field: "environment.tool_timeout_seconds", note: "the bash timeout; no CPU or memory limit is set by gnomon" },
  { layer: "E", row: "Isolation boundary", field: "environment.sandbox", note: "level, network, exec mode, reads scope, profile" },
  { layer: "T", row: "Tool names", field: "tools.names", note: "the tools offered to the reporting role" },
  { layer: "T", row: "Schemas", field: "tools.hash", note: "sha256 over the offered definitions (tools_hash.ts)" },
  { layer: "T", row: "Versions", field: "build.version", note: "tools are versioned with the build; there is no per-tool version" },
  { layer: "T", row: "Routing or discovery policy", field: "tools.mcp_servers", note: "gnomon offers a role's list; MCP servers are named, never discovered" },
  { layer: "T", row: "Session semantics", field: "tools.edit_format", note: "edit variant; every other tool is stateless per call" },
  { layer: "C", row: "System prompt", field: "context.system_prompt_sha256", note: "hash, never the text" },
  { layer: "C", row: "Retrieval source", field: null, note: "gnomon has no retrieval layer" },
  { layer: "C", row: "Memory policy", field: null, note: "gnomon keeps no cross-session memory the model reads" },
  { layer: "C", row: "Compaction rule", field: "context.compaction", note: "policy, compaction, retain_after, reserve, masking, think cap, skills inline cap" },
  { layer: "C", row: "Model-visible state", field: "context.window", note: "the resolved window and where the number came from" },
  { layer: "L", row: "Control graph", field: "control.task_allow", note: "which roles may delegate to which" },
  { layer: "L", row: "Retry and stopping rules", field: "control.max_steps_total", note: "step budgets, verify rounds, attempts" },
  { layer: "L", row: "Checkpoints", field: "control.max_steps", note: "a leg's checkpoint; sessions resume from the record" },
  { layer: "L", row: "Handoffs", field: "control.task_allow", note: "task delegation and escalation declared in the role" },
  { layer: "L", row: "Durable task state", field: null, note: "the session record is the state; it is not part of the signature" },
  { layer: "O", row: "Trace schema", field: "observability.record_schemas", note: "the schemas the run's records carry" },
  { layer: "O", row: "Identifiers", field: null, note: "session and trail ids are per run, so not a configuration" },
  { layer: "O", row: "Sampling policy", field: null, note: "gnomon records every turn; there is no sampling" },
  { layer: "O", row: "Cost and latency fields", field: "observability.record_schemas", note: "tokens, requests and wall time are in every record" },
  { layer: "O", row: "Retention window", field: null, note: "the project's; gnomon never deletes a trail" },
  { layer: "V", row: "Task version", field: "validation.task_spec_sha256", note: "the trial spec's hash (an eval), else null" },
  { layer: "V", row: "Environment checks", field: "validation.verify", note: "the [verify] gate: hash of the command, when, rounds" },
  { layer: "V", row: "Grader or judge version", field: "validation.verify.command_sha256", note: "the declared check; gnomon has no model judge" },
  { layer: "V", row: "Repeats", field: "validation.attempts", note: "k per task (an eval), else null" },
  { layer: "V", row: "Aggregation rule", field: "validation.aggregation", note: "how an eval aggregates; null outside one" },
  { layer: "G", row: "Principal identity", field: null, note: "gnomon records the OS user's session, not a principal" },
  { layer: "G", row: "Permission scope", field: "governance.rules", note: "bash_allow/bash_deny/write_allow counts and the surface hash" },
  { layer: "G", row: "Approval policy", field: "governance.approval", note: "the gate" },
  { layer: "G", row: "Audit fields", field: "observability.record_schemas", note: "the hash-chained audit trail's kinds are published" },
  { layer: "G", row: "Escalation path", field: "control.escalate", note: "declared escalation, when the role has one" },
];

/** Rows Table 3 lists that gnomon cannot fill, derived from the map: `<layer>:<row>`. */
export const NOT_REPORTED: readonly string[] = TABLE3_MAP.filter((r) => r.field === null).map((r) => `${r.layer}:${r.row}`);

export interface HarnessSignature {
  schema: typeof HARNESS_SIGNATURE_SCHEMA;
  build: { id: string; version: string; revision: string | null; dirty: boolean };
  surface_hash: string | null;
  role: string;
  model: { model: string; endpoint: string | null; provider: string | null; host: string | null; local: boolean; temperature: number; top_p: number };
  fallback: { model: string; endpoint: string | null; provider: string | null; host: string | null } | null;
  environment: {
    sandbox: { level: string; network: boolean; reads: string; profile: string };
    exec: { mode: string; image: string | null };
    reset: string;
    tool_timeout_seconds: number | null;
  };
  tools: { names: string[]; hash: string; mcp_servers: string[]; edit_format: string };
  context: {
    system_prompt_sha256: string;
    policy: string;
    compaction: string;
    retain_after: number;
    reserve_output: number;
    token_estimate: string;
    window: { tokens: number | null; source: string | null };
    masking: { keep_last: number; at_fill: number; batch: number } | null;
    think_cap: number | null;
    skills_inline_max_tokens: number | null;
  };
  control: {
    max_steps: number | null;
    max_steps_total: number | null;
    task_allow: string[] | null;
    escalate: boolean;
  };
  observability: { record_schemas: string[] };
  validation: {
    verify: { declared: boolean; command_sha256: string | null; after: string | null; max_rounds: number | null; contract: string | null };
    task_spec_sha256: string | null;
    attempts: number | null;
    aggregation: string | null;
  };
  governance: {
    approval: string;
    levels: Record<string, string> | null;
    rules: { bash_allow: number; bash_deny: number; write_allow: number };
  };
  not_reported: string[];
}

export interface SignatureOptions {
  /** The role the report speaks for. Default: the surface's routing default. */
  role?: string;
  /** The surface's hash, from the manifest the caller already computed. */
  surfaceHash?: string | null;
  /** An eval's facts: the spec's hash, k per task. */
  task_spec_sha256?: string;
  attempts?: number;
  aggregation?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

const isLoopback = (host: string | null) => host !== null && /^(localhost|127\.|\[::1\]|::1)/.test(host);

function parseBuild(id: string): HarnessSignature["build"] {
  const m = /^gnomon\/([^+]+)\+(.+)$/.exec(id);
  if (!m) return { id, version: id, revision: null, dirty: false };
  const dirty = m[2]!.endsWith("-dirty");
  const rev = dirty ? m[2]!.slice(0, -"-dirty".length) : m[2]!;
  return { id, version: m[1]!, revision: rev === "unknown" ? null : rev, dirty };
}

function target(t: RouteTarget) {
  const host = hostOf(t.url);
  return { model: t.model, endpoint: t.endpoint ?? null, provider: t.kind ?? "openai", host };
}

/** Assemble the signature for one role of one loaded surface. */
export function buildHarnessSignature(config: GnomonConfig, opts: SignatureOptions = {}): HarnessSignature {
  const role = opts.role ?? resolveRouting(config).default;
  const def = (config.roles?.[role] ?? {}) as {
    max_steps?: number;
    max_steps_total?: number;
    task_allow?: string[];
    bash_allow?: unknown[];
    bash_deny?: unknown[];
    write_allow?: unknown[];
    escalate?: unknown;
  };
  const routed = routeRole(config, role);
  const ctx = resolveContext(config, routed.target);
  const exec = resolveExec(config, role);
  const sandbox = (config.policy?.sandbox ?? {}) as { profile?: unknown };
  const verify = resolveVerify(config);
  const masking = resolveMasking(config);
  const bashTool = (config.tools?.tools ?? []).find((t) => t.name === "bash");
  const set = buildToolSet(config, role);
  let levels: Record<string, string> | null = null;
  try {
    levels = resolveLevels(config, role)?.levels ?? null;
  } catch {
    levels = null;
  }
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const host = hostOf(routed.target.url);
  return {
    schema: HARNESS_SIGNATURE_SCHEMA,
    build: parseBuild(harnessBuild()),
    surface_hash: opts.surfaceHash ?? null,
    role,
    model: {
      ...target(routed.target),
      local: isLoopback(host),
      temperature: routed.temperature,
      top_p: routed.top_p,
    } as HarnessSignature["model"],
    fallback: routed.fallback ? target(routed.fallback) : null,
    environment: {
      sandbox: {
        level: resolveSandboxLevel(config),
        network: exec.network,
        reads: exec.reads,
        profile: typeof sandbox.profile === "string" ? sandbox.profile : "default",
      },
      exec: { mode: exec.mode, image: exec.mode === "docker" ? exec.image : null },
      reset: opts.attempts !== undefined ? "fresh clone per cell" : "none",
      tool_timeout_seconds: n((bashTool as { timeout_seconds?: unknown } | undefined)?.timeout_seconds),
    },
    tools: {
      names: set.schemas.map((s) => s.function.name).sort(),
      hash: toolsHash(set.schemas),
      mcp_servers: Object.keys(config.tools?.mcp_servers ?? {}).sort(),
      edit_format: resolveEditVariant(config),
    },
    context: {
      system_prompt_sha256: sha256(config.system?.content ?? ""),
      policy: ctx.policy,
      compaction: ctx.compaction,
      retain_after: ctx.retain_after,
      reserve_output: ctx.reserve_output,
      token_estimate: ctx.token_estimate,
      window: { tokens: ctx.max_context_tokens, source: routed.target.contextSource ?? "default" },
      masking: masking ? { keep_last: masking.keep_last, at_fill: masking.at_fill, batch: masking.batch } : null,
      think_cap: resolveThinkCap(config) ?? null,
      skills_inline_max_tokens: inlineMaxTokens(config) ?? null,
    },
    control: {
      max_steps: n(def.max_steps),
      max_steps_total: n(def.max_steps_total),
      task_allow: Array.isArray(def.task_allow) ? [...def.task_allow].sort() : null,
      escalate: def.escalate !== undefined,
    },
    observability: { record_schemas: ["session record (CONTRACTS.md section 4)", "hash-chained audit trail (CONTRACTS.md section 44)"] },
    validation: {
      verify: {
        declared: verify !== null,
        command_sha256: verify ? sha256(verify.command) : null,
        after: verify?.after ?? null,
        max_rounds: verify?.max_rounds ?? null,
        contract: verify?.contract ?? null,
      },
      task_spec_sha256: opts.task_spec_sha256 ?? null,
      attempts: opts.attempts ?? null,
      aggregation: opts.aggregation ?? null,
    },
    governance: {
      approval: resolveApprovalGate(config),
      levels,
      rules: { bash_allow: count(def.bash_allow), bash_deny: count(def.bash_deny), write_allow: count(def.write_allow) },
    },
    not_reported: [...NOT_REPORTED],
  };
}
