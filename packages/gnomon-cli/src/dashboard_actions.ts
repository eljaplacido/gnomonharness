/**
 * gnomon-cli: what `gnomon dashboard` may RUN, and how.
 *
 * Every button that changes, downloads or spends anything is one row of
 * DASHBOARD_ACTIONS, and every row is a gnomon command: the server spawns
 * `process.execPath` plus the CLI's own entry script with an argv built HERE,
 * from the row and typed, validated parameters. The browser never sends an
 * argv, a path, a flag or a shell string. A project is named by its id, and
 * `<dir>` is filled from the server's own list.
 *
 * Because each action IS the CLI command, it is recorded exactly as the
 * command records itself: `trust grant` writes its `trust` record, `check`
 * its `check` record, setup its facts file. The dashboard adds no record kind
 * and no authority (docs/design/SETUP-AND-COMMAND-CENTER.md, "No new
 * authority").
 *
 * Confirmation. A row with `confirm: "required"` (it writes, downloads or may
 * spend) runs only on a second request carrying a one-use `confirm` nonce. The
 * first request runs nothing and answers 428 with what the action will do,
 * stated by the server: the download's size, the grants being trusted, the
 * diff being written, the endpoint a token goes to. The nonce is bound to the
 * action, the project and the parameters, and to what was shown where that
 * can move (the surface hash for trust, the proposal digest for setup), and
 * it lasts five minutes.
 *
 * Secrets. `key.set` takes the key in the confirming request's body and hands
 * it to `gnomon key set <VARIABLE>` on stdin, the CLI's own non-terminal path.
 * It is never put in an argv, an environment variable, a log, a response or
 * any store of the dashboard's; the CLI writes it to the machine-local key
 * store exactly as a typed `gnomon key set` does.
 *
 * Contract: CONTRACTS.md §17, fixture conformance/dashboard.json.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  listEndpoints,
  resolveEndpoint,
  isLocalEndpoint,
  credentialsPath,
  recomputeManifest,
  describeEndpoints,
} from "gnomon-core";
import { ENDPOINT_PRESETS } from "./setup.js";
import { loadCatalog, defaultCatalogPath, type Catalog } from "./catalog.js";
import { diskFree } from "./setup_host.js";
import type { DashboardProject } from "./dashboard_data.js";

// ---------------------------------------------------------------------------
// The table (published)
// ---------------------------------------------------------------------------

/** `enabled` runs now; `planned` is shown, disabled, with the command it will map to. */
export const ACTION_STATES = ["enabled", "planned"] as const;
/** `required`: runs only on a second request carrying the nonce the first one returned. */
export const ACTION_CONFIRMS = ["none", "required"] as const;

/**
 * `<…>` slots are filled by the server: `<dir>` from the project's id, the
 * rest from typed parameters, `<digest>` from the proposal the person was
 * shown. `<choices>` is zero or more of `--model <tag>`, `--cloud-endpoint
 * <preset|name|url>`, `--cloud-model <model>`, `--cloud-key-env <VARIABLE>`,
 * `--mode <local|hybrid|cloud>` and `--hybrid-control <off|observe|ask|auto>`.
 */
export const DASHBOARD_ACTIONS = [
  // Read-only. Computed in-process by verifyTrail, the function `gnomon audit
  // verify` calls, because that command prints text and the page needs fields.
  { name: "audit.verify", argv: ["audit", "verify"], state: "enabled", confirm: "none" },
  // Read-only (#105 Part I, step 2).
  { name: "doctor.scan", argv: ["doctor", "--json", "--dir", "<dir>"], state: "enabled", confirm: "none" },
  // Writes nothing and spends nothing: without --yes setup stops at the
  // proposal (exit 4). The recommendation, the cloud model and the mode are
  // each read off this.
  { name: "setup.plan", argv: ["setup", "--json", "--dir", "<dir>", "<choices>"], state: "enabled", confirm: "none" },
  // A download, so the button is the consent and the confirmation shows its
  // size. Still no --yes: the surface is written only by setup.apply.
  { name: "setup.pull", argv: ["setup", "--pull", "<tag>", "--json", "--dir", "<dir>", "<choices>"], state: "enabled", confirm: "required" },
  // Loads the model and sends one short prompt to 127.0.0.1. The button is the yes.
  { name: "setup.speed_check", argv: ["setup", "--model", "<tag>", "--speed-check", "--json", "--dir", "<dir>"], state: "enabled", confirm: "none" },
  // The key on stdin, never in argv.
  { name: "key.set", argv: ["key", "set", "<variable>", "--dir", "<dir>"], state: "enabled", confirm: "required" },
  // Writes exactly the diff the confirmation showed, or nothing (exit 3).
  { name: "setup.apply", argv: ["setup", "--yes", "--expect-proposal", "<digest>", "--json", "--dir", "<dir>", "<choices>"], state: "enabled", confirm: "required" },
  // Judges a change and records a `check` record, as the command does.
  { name: "check.run", argv: ["check", "--base", "<rev>", "--json", "--dir", "<dir>"], state: "enabled", confirm: "none" },
  { name: "trust.grant", argv: ["trust", "grant", "--dir", "<dir>"], state: "enabled", confirm: "required" },
  { name: "trust.revoke", argv: ["trust", "revoke", "--dir", "<dir>"], state: "enabled", confirm: "required" },
  // One completion of one token: on a cloud endpoint that is billed.
  { name: "endpoint.test", argv: ["endpoint", "test", "<endpoint>", "--dir", "<dir>"], state: "enabled", confirm: "required" },
  { name: "init", argv: ["init", "--dir", "<dir>"], state: "planned", confirm: "required" },
  { name: "guard.install", argv: ["guard", "install", "<harness>"], state: "planned", confirm: "required" },
] as const;

export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];
export type ActionName = DashboardAction["name"];

export const actionNamed = (name: string): DashboardAction | undefined => DASHBOARD_ACTIONS.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Typed parameters
// ---------------------------------------------------------------------------

export interface SetupChoices {
  model?: string;
  cloud_endpoint?: string;
  cloud_model?: string;
  cloud_key_env?: string;
  mode?: string;
  hybrid_control?: string;
}

export interface ActionParams {
  trail?: string;
  tag?: string;
  choices?: SetupChoices;
  variable?: string;
  rev?: string;
  endpoint?: string;
}

/** An Ollama tag or a model id: no leading `-`, no whitespace, nothing a shell would read. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** A key variable, as `gnomon key set` accepts one. */
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A git revision: `HEAD~1`, `origin/master`, `@{u}`, a sha. Never an option. */
const REV = /^[A-Za-z0-9_.~^/@{}][A-Za-z0-9_.~^/@{}+-]{0,199}$/;
/** A declared endpoint name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MODES = ["local", "hybrid", "cloud"];
const CONTROLS = ["off", "observe", "ask", "auto"];

/** Which body keys each action takes, beyond `project` and `confirm`. */
const PARAMS: Record<ActionName, readonly (keyof ActionParams | "value")[]> = {
  "audit.verify": ["trail"],
  "doctor.scan": [],
  "setup.plan": ["choices"],
  "setup.pull": ["tag", "choices"],
  "setup.speed_check": ["tag"],
  "key.set": ["variable", "value"],
  "setup.apply": ["choices"],
  "check.run": ["rev"],
  "trust.grant": [],
  "trust.revoke": [],
  "endpoint.test": ["endpoint"],
  init: [],
  "guard.install": [],
};

export const CHOICE_KEYS = ["model", "cloud_endpoint", "cloud_model", "cloud_key_env", "mode", "hybrid_control"] as const;

function cloudEndpointOk(v: string, declared: readonly string[]): boolean {
  if (ENDPOINT_PRESETS[v] && v !== "ollama") return true;
  if (NAME.test(v) && declared.includes(v)) return true;
  if (v.length > 500 || /[\s\u0000-\u001f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "";
  } catch {
    return false;
  }
}

export function declaredEndpointNames(p: DashboardProject): string[] {
  if (!existsSync(join(p.root, ".gnomon"))) return [];
  try {
    return listEndpoints(loadConfig(p.root));
  } catch {
    return [];
  }
}

/**
 * Read an action's parameters from a request body. Anything not in the
 * action's list is refused, so a body cannot smuggle an argv or a path in
 * under a name nothing checks.
 */
export function readParams(
  name: ActionName,
  body: Record<string, unknown>,
  p: DashboardProject
): { params: ActionParams; value?: string } | { error: string } {
  const allowed = PARAMS[name];
  for (const k of Object.keys(body)) {
    if (k === "project" || k === "confirm") continue;
    if (!allowed.includes(k as keyof ActionParams)) return { error: `${name} takes no "${k}"` };
  }
  const params: ActionParams = {};
  const str = (k: string): string | undefined | { error: string } => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "string" ? v : { error: `"${k}" must be a string` };
  };
  const take = (k: "trail" | "tag" | "variable" | "rev" | "endpoint", re: RegExp | null, what: string): string | undefined => {
    const v = str(k);
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(v.error);
    if (re && !re.test(v)) throw new Error(`"${k}" is not ${what}`);
    params[k] = v;
    return v;
  };
  try {
    take("trail", null, "");
    take("tag", TAG, "a model tag");
    take("variable", VARIABLE, "a key variable name (A-Z, 0-9, _)");
    take("rev", REV, "a git revision");
    take("endpoint", NAME, "an endpoint name");
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  if (body.choices !== undefined) {
    if (typeof body.choices !== "object" || body.choices === null || Array.isArray(body.choices)) return { error: '"choices" must be an object' };
    const c = body.choices as Record<string, unknown>;
    const out: SetupChoices = {};
    for (const k of Object.keys(c)) {
      if (!(CHOICE_KEYS as readonly string[]).includes(k)) return { error: `"choices" takes no "${k}"` };
      const v = c[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") return { error: `choices.${k} must be a string` };
      out[k as (typeof CHOICE_KEYS)[number]] = v;
    }
    if (out.model !== undefined && !TAG.test(out.model)) return { error: "choices.model is not a model tag" };
    if (out.cloud_model !== undefined && !TAG.test(out.cloud_model)) return { error: "choices.cloud_model is not a model id" };
    if (out.cloud_key_env !== undefined && !VARIABLE.test(out.cloud_key_env)) return { error: "choices.cloud_key_env is not a key variable name" };
    if (out.mode !== undefined && !MODES.includes(out.mode)) return { error: `choices.mode is one of ${MODES.join(", ")}` };
    if (out.hybrid_control !== undefined && !CONTROLS.includes(out.hybrid_control)) return { error: `choices.hybrid_control is one of ${CONTROLS.join(", ")}` };
    if (out.cloud_endpoint !== undefined && !cloudEndpointOk(out.cloud_endpoint, declaredEndpointNames(p))) {
      return { error: "choices.cloud_endpoint is not a preset, a declared endpoint or an http(s) URL" };
    }
    if ((out.cloud_model || out.cloud_key_env) && !out.cloud_endpoint) return { error: "choices.cloud_model and cloud_key_env go with cloud_endpoint" };
    if (name === "setup.pull" && out.model) return { error: "setup.pull names its model as `tag`; choices.model goes with an installed one" };
    params.choices = out;
  }

  // What each action needs.
  if ((name === "setup.pull" || name === "setup.speed_check") && !params.tag) return { error: `${name} needs "tag"` };
  if (name === "key.set" && !params.variable) return { error: 'key.set needs "variable"' };
  if (name === "check.run" && !params.rev) return { error: 'check.run needs "rev": the revision the change is judged against' };
  if (name === "endpoint.test") {
    if (!params.endpoint) return { error: 'endpoint.test needs "endpoint"' };
    if (!declaredEndpointNames(p).includes(params.endpoint)) return { error: `"${params.endpoint}" is not an endpoint this project declares` };
  }

  let value: string | undefined;
  if (name === "key.set" && body.value !== undefined) {
    if (typeof body.value !== "string") return { error: '"value" must be a string' };
    value = body.value.trim();
    // A key is one line of printable text. A newline would end `gnomon key
    // set`'s stdin read early; a control character is never part of a key.
    if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return { error: "that is not a key: one line of printable text, up to 4096 characters" };
  }
  return value === undefined ? { params } : { params, value };
}

function choiceFlags(c: SetupChoices | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.model) out.push("--model", c.model);
  if (c.cloud_endpoint) out.push("--cloud-endpoint", c.cloud_endpoint);
  if (c.cloud_model) out.push("--cloud-model", c.cloud_model);
  if (c.cloud_key_env) out.push("--cloud-key-env", c.cloud_key_env);
  if (c.mode) out.push("--mode", c.mode);
  if (c.hybrid_control) out.push("--hybrid-control", c.hybrid_control);
  return out;
}

/** The argv an action runs: the row, with every slot filled by the server. */
export function argvFor(action: DashboardAction, p: DashboardProject, params: ActionParams, digest?: string): string[] {
  const out: string[] = [];
  for (const part of action.argv) {
    switch (part) {
      case "<dir>":
        out.push(p.root);
        break;
      case "<choices>":
        out.push(...choiceFlags(params.choices));
        break;
      case "<tag>":
        out.push(params.tag!);
        break;
      case "<variable>":
        out.push(params.variable!);
        break;
      case "<rev>":
        out.push(params.rev!);
        break;
      case "<endpoint>":
        out.push(params.endpoint!);
        break;
      case "<digest>":
        out.push(digest!);
        break;
      default:
        if (part.startsWith("<")) throw new Error(`no value for ${part}`);
        out.push(part);
    }
  }
  return out;
}

/** The command a person would type for the same thing. */
export function commandText(argv: readonly string[]): string {
  return ["gnomon", ...argv.map((a) => (/^[A-Za-z0-9_./\\:@~^{}+=-]+$/.test(a) ? a : JSON.stringify(a)))].join(" ");
}

/** The same parameters in one fixed order: what a nonce is bound to. */
export function paramsKey(name: string, projectId: string, params: ActionParams): string {
  const c = params.choices ?? {};
  return JSON.stringify([
    name,
    projectId,
    params.trail ?? null,
    params.tag ?? null,
    params.variable ?? null,
    params.rev ?? null,
    params.endpoint ?? null,
    CHOICE_KEYS.map((k) => c[k] ?? null),
  ]);
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export interface Pending {
  action: ActionName;
  key: string;
  expires: number;
  /** What was shown that can move before the click: re-checked before running. */
  surfaceHash?: string;
  digest?: string;
}

export class Confirmations {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  issue(p: Omit<Pending, "expires">): { nonce: string; expires_in_s: number } {
    this.sweep();
    const nonce = randomBytes(18).toString("base64url");
    this.pending.set(nonce, { ...p, expires: Date.now() + this.ttlMs });
    return { nonce, expires_in_s: Math.round(this.ttlMs / 1000) };
  }

  /** One use: a nonce is gone after this, whether or not it matched. */
  take(nonce: string, action: ActionName, key: string): Pending | null {
    this.sweep();
    const p = this.pending.get(nonce);
    if (!p) return null;
    this.pending.delete(nonce);
    return p.action === action && p.key === key ? p : null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [n, p] of this.pending) if (p.expires < now) this.pending.delete(n);
  }
}

// ---------------------------------------------------------------------------
// What a confirmation states, per action
// ---------------------------------------------------------------------------

let catalogCache: Catalog | null | undefined;
function catalog(): Catalog | null {
  if (catalogCache === undefined) {
    try {
      catalogCache = loadCatalog(defaultCatalogPath());
    } catch {
      catalogCache = null;
    }
  }
  return catalogCache;
}

/** The cloud presets setup knows, with the catalog's default model for each. */
export function cloudPresets(): Array<{ key: string; note: string; url: string; key_env: string | null; model: string | null; model_note: string | null }> {
  const cat = catalog();
  return Object.entries(ENDPOINT_PRESETS)
    .filter(([k]) => k !== "ollama")
    .map(([key, p]) => {
      const d = cat?.cloud.find((c) => c.preset === key);
      return { key, note: p.note, url: p.url, key_env: p.api_key_env ?? null, model: d?.model ?? null, model_note: d?.note ?? null };
    });
}

export function catalogInfo(): { as_of: string; label: string } | null {
  const c = catalog();
  return c ? { as_of: c.asOf, label: c.label } : null;
}

export function pullFacts(tag: string): { download_gb: number | null; disk_free: { path: string | null; bytes: number | null } } {
  const entry = catalog()?.models.find((m) => m.tag === tag || m.aliases.includes(tag));
  const disk = diskFree();
  return {
    download_gb: entry?.downloadGb ?? null,
    disk_free: { path: disk.path ?? null, bytes: disk.bytes ?? null },
  };
}

export function endpointFacts(p: DashboardProject, name: string): { url: string; local: boolean; model: string | null } {
  const config = loadConfig(p.root);
  const ep = resolveEndpoint(config, name);
  const row = describeEndpoints(config).find((r) => r.name === name);
  return { url: ep.url, local: isLocalEndpoint(ep.url), model: row?.probeModel ?? null };
}

export function surfaceHashOf(p: DashboardProject): string | null {
  try {
    return recomputeManifest(join(p.root, ".gnomon")).surface_hash;
  } catch {
    return null;
  }
}

export const keyStorePath = (): string => credentialsPath();

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

export interface SpawnResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * process.execPath plus the CLI's own entry script, never a shell and never a
 * .cmd shim: Node will not spawn one on Windows without a shell.
 */
export function runCli(
  entry: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  opts: { stdin?: string; onStderr?: (text: string) => void; track?: Set<ChildProcess> } = {}
): Promise<SpawnResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    opts.track?.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, more: Buffer) => (s.length < 1 << 20 ? s + more.toString("utf-8") : s);
    child.stdout!.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr!.on("data", (d: Buffer) => {
      stderr = cap(stderr, d);
      opts.onStderr?.(d.toString("utf-8"));
    });
    if (opts.stdin !== undefined) {
      // A child that exits before reading (a usage error) closes the pipe;
      // that is its answer, not the server's error.
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.stdin);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.track?.delete(child);
      done({ exit: null, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.track?.delete(child);
      done({ exit: code, stdout, stderr, timedOut });
    });
  });
}

/** A child's JSON document, or null when it printed something else. */
export function jsonOf(stdout: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stdout) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How long each spawned action may take before it is stopped. */
export const TIMEOUT_MS: Record<ActionName, number> = {
  "audit.verify": 60_000,
  "doctor.scan": 60_000,
  "setup.plan": 120_000,
  // A 24 GB download on a slow line.
  "setup.pull": 6 * 3600_000,
  // Loading a large model from disk is most of it.
  "setup.speed_check": 10 * 60_000,
  "key.set": 30_000,
  "setup.apply": 120_000,
  "check.run": 30 * 60_000,
  "trust.grant": 30_000,
  "trust.revoke": 30_000,
  "endpoint.test": 120_000,
  init: 60_000,
  "guard.install": 30_000,
};

// ---------------------------------------------------------------------------
// Jobs: an action that outlives one request (a download)
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  action: ActionName;
  project: string;
  command: string;
  state: "running" | "done";
  started: string;
  /** The last lines the command wrote to stderr: its progress. */
  progress: string[];
  exit: number | null;
  timed_out: boolean;
  result: Record<string, unknown> | null;
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();

  start(action: ActionName, project: string, command: string, run: (progress: (text: string) => void) => Promise<SpawnResult>): Job {
    const job: Job = {
      id: randomBytes(9).toString("base64url"),
      action,
      project,
      command,
      state: "running",
      started: new Date().toISOString(),
      progress: [],
      exit: null,
      timed_out: false,
      result: null,
    };
    this.jobs.set(job.id, job);
    let partial = "";
    const progress = (text: string): void => {
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) job.progress.push(l.trimEnd());
      if (job.progress.length > 40) job.progress.splice(0, job.progress.length - 40);
    };
    void run(progress).then((r) => {
      if (partial.trim()) job.progress.push(partial.trimEnd());
      job.state = "done";
      job.exit = r.exit;
      job.timed_out = r.timedOut;
      job.result = jsonOf(r.stdout);
    });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  running(project: string): Job | undefined {
    return [...this.jobs.values()].find((j) => j.project === project && j.state === "running");
  }
}
