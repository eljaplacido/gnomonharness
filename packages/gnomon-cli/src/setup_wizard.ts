/**
 * gnomon-cli: `gnomon setup` — scan this machine, plug in a local model it can
 * run, then connect a cloud model.
 *
 * Steps 2 to 5 of docs/design/SETUP-AND-COMMAND-CENTER.md, as one flow:
 *
 *   1. probe the machine (probe.ts; read-only);
 *   2. recommend a local model from the dated catalog (catalog.ts), with why;
 *   3. pull it, only on an explicit yes (`--pull TAG` off a terminal);
 *   4. a short speed check, only on a yes (`--speed-check` off a terminal);
 *   5. optionally a cloud model, its key read hidden and stored outside the
 *      repository, exactly as `gnomon key set` does;
 *   6. suggest a mode: local only, hybrid or cloud first;
 *   7. show the change to `.gnomon/` as a diff, and write it only when a
 *      person accepts it (or `--yes` does, for a script).
 *
 * Nothing is downloaded, written or spent without an explicit yes. `--yes`
 * approves the surface write and nothing else: a download needs `--pull` to
 * name the tag, and a cloud call needs a person at the prompt.
 *
 * Every effect goes through SetupDeps, so the tests drive every path with a
 * fake machine, a fake Ollama and a scripted person, and no network.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { recomputeManifest, keyHostIsDefault } from "gnomon-core";
import { probeMachine, formatProbe, RUNTIME_PORTS, type MachineProbe, type ProbeHost, type RuntimeId } from "./probe.js";
import {
  recommend,
  formatRecommendation,
  suggestMode,
  fitOf,
  machineMemory,
  PROFILE_FOR,
  type Catalog,
  type ModelOption,
  type ModeSuggestion,
  type Recommendation,
  type SpeedResult,
  type Suggestion,
} from "./catalog.js";
import {
  planSurface,
  changeDiff,
  endpointFor,
  declaredEndpoints,
  rolesWithModels,
  SETUP_FILES,
  type EndpointBlock,
  type SurfaceTexts,
} from "./setup_surface.js";
import { ENDPOINT_PRESETS, hostName, withheldWhy } from "./setup.js";
import { initSurface, scaffoldTexts } from "./init.js";
import { FALLBACK_LARGE, FALLBACK_SMALL } from "./detect.js";

// ---------------------------------------------------------------------------
// Published values (docs/CONTRACTS.md §16)
// ---------------------------------------------------------------------------

/** Hybrid control, per escalation block, once PR #102's `escalate` exists. */
export const HYBRID_CONTROLS = ["off", "observe", "ask", "auto"] as const;
export type HybridControl = (typeof HYBRID_CONTROLS)[number];

/** `gnomon setup` exits. 3 is a surface that moved under setup; 10 a catalog that cannot be read. */
export const SETUP_EXIT = { written: 0, usage: 1, surfaceMoved: 3, needsConsent: 4, catalog: 10, runtimeStopped: 12 } as const;

/** Machine facts beside `.gnomon/`, gitignored: what doctor compares against. */
export const SETUP_FACTS_FILE = ".gnomon-setup.json";

/** `--mode` accepts these short names too. */
export const MODE_ALIASES: Record<string, Suggestion> = {
  local: "local_only",
  local_only: "local_only",
  hybrid: "hybrid",
  cloud: "cloud_first",
  cloud_first: "cloud_first",
};

const ESCALATE_NOTE =
  "recorded as your preference; it takes effect only when escalation ([roles.X.escalate], PR #102) is merged, " +
  "and `gnomon setup` will then propose it in the surface";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface SetupIO {
  /** A person is at a terminal. Off one, nothing is asked. */
  interactive: boolean;
  say(line?: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  /** Read without echo, as `gnomon key set` does. */
  askSecret(question: string): Promise<string>;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}
export type PullResult = { ok: true } | { ok: false; error: string; unreachable: boolean };
export type SpeedOutcome = SpeedResult | { error: string; unreachable: boolean };

export interface SpeedRequest {
  runtime: RuntimeId;
  chatUrl: string;
  model: string;
  system: string;
}

export interface SetupDeps {
  host: ProbeHost;
  io: SetupIO;
  catalog: Catalog;
  now(): Date;
  /** Ollama's own pull on 127.0.0.1:11434. Only ever called after a yes. */
  pull(tag: string, onProgress: (p: PullProgress) => void): Promise<PullResult>;
  /** One short chat request to a local model. Only ever called after a yes. */
  speedCheck(req: SpeedRequest): Promise<SpeedOutcome>;
  /** Free disk where Ollama keeps models, when it can tell. */
  diskFree(): { path?: string; bytes?: number };
  /** The machine-local key store `gnomon key` uses. Values are never returned. */
  keys: { held(variable: string): boolean; store(variable: string, value: string): void; where(): string };
  /** One token through a cloud endpoint: spends. Only after a person's yes. */
  checkCloud(endpoint: EndpointBlock, model: string): Promise<{ ok: boolean; status?: number; detail?: string }>;
  /** A cloud endpoint's model listing: a GET, spends nothing. */
  listCloudModels(endpoint: EndpointBlock): Promise<string[]>;
  /**
   * The trust step would run this project's surface as declared (trusted, or
   * granting nothing beyond the scaffold). Absent means no: an endpoint taken
   * from the surface whose host is not a known provider is then not checked
   * with its key (docs/CONTRACTS.md §8).
   */
  surfaceTrusted?(): boolean;
  /** Commands this build dispatches, for the closing "Next" lines. */
  commands: readonly string[];
}

export interface SetupOptions {
  /** Project root. */
  dir: string;
  json: boolean;
  /** Approves the surface write. Never a download, never spending. */
  yes: boolean;
  /** Consent to download exactly this tag. */
  pull?: string;
  /** Use this installed model. */
  model?: string;
  /** Run the speed check off a terminal. */
  speedCheck: boolean;
  mode?: Suggestion;
  /** A URL, a preset (opencode-go, openrouter, opencode-zen) or a declared endpoint name. */
  cloudEndpoint?: string;
  cloudModel?: string;
  cloudKeyEnv?: string;
  hybridControl: HybridControl;
  /** Run from `gnomon launch`'s picker: it starts the session itself. */
  fromLaunch?: boolean;
  /**
   * `--expect-proposal DIGEST`: write only if the change is exactly the one a
   * person reviewed (`proposal.digest` of an earlier run without `--yes`).
   * Anything else exits 3 and writes nothing. This is how the dashboard's
   * Accept writes the diff it showed, and not a re-plan of a moved surface.
   */
  expectProposal?: string;
}

// ---------------------------------------------------------------------------
// The report (`--json`, schema gnomon.setup/1)
// ---------------------------------------------------------------------------

export interface SetupReport {
  schema: "gnomon.setup/1";
  dir: string;
  catalog: { as_of: string; label: string; path: string; stale?: string };
  machine?: ReturnType<typeof machineJson>;
  runtimes?: ReturnType<typeof runtimesJson>;
  recommendation?: ReturnType<typeof recommendationJson>;
  local: null | { tag: string; runtime: RuntimeId; installed: boolean; small: string; endpoint?: string };
  pull: null | { tag: string; command: string; download_gb?: number; status: "pulled" | "declined" | "no_runtime" | "failed"; error?: string };
  speed: null | SpeedResult | { skipped: true } | { error: string };
  cloud: null | { endpoint: string; url: string; model: string; key_env?: string; key_held: boolean; checked: "ok" | "failed" | "skipped"; detail?: string };
  mode: null | { suggested: Suggestion; chosen: Suggestion; role_profile: string; why: string; provisional: boolean };
  hybrid_control: null | { value: HybridControl; active: false; note: string };
  proposal: null | {
    fresh: boolean;
    files: Array<{ path: string; action: "create" | "modify"; diff: string[] }>;
    facts_file: string;
    applied: boolean;
    /** sha256 of the surface hash before and the files' diffs: what `--expect-proposal` names. */
    digest: string;
  };
  surface_hash?: { before?: string; after?: string };
  steps: Array<{ id: string; status: string }>;
  next: string[];
  why?: string;
  exit: number;
}

export function machineJson(probe: MachineProbe) {
  const hw = probe.hardware;
  return {
    os: hw.os,
    arch: hw.arch,
    cpu_model: hw.cpuModel,
    cpu_count: hw.cpuCount,
    ram_gib: round1(hw.ramBytes / 1024 ** 3),
    gpus: hw.gpus.map((g) => ({
      vendor: g.vendor,
      name: g.name,
      memory_gib: g.memoryBytes !== undefined ? round1(g.memoryBytes / 1024 ** 3) : null,
      unified: g.unified,
      source: g.source,
    })),
    notes: hw.notes,
    took_ms: probe.tookMs,
  };
}

export function runtimesJson(probe: MachineProbe) {
  return probe.runtimes.map((r) => ({
    id: r.id,
    label: r.label,
    port: r.port,
    url: r.url,
    state: r.state,
    models: r.models,
    ...(r.why ? { why: r.why } : {}),
  }));
}

export function recommendationJson(rec: Recommendation) {
  return {
    memory: { kind: rec.memory.kind, gib: rec.memory.gib, ram_gib: rec.memory.ramGib, label: rec.memory.label },
    options: rec.options.map((o) => ({
      tag: o.tag,
      runtime: o.runtime,
      installed: o.installed,
      catalog: o.entry ? { name: o.entry.name, tier: o.entry.tier, measured: o.entry.measured } : null,
      fit: o.fit,
      fit_why: o.fitWhy,
      ...(o.downloadGb !== undefined ? { download_gb: o.downloadGb } : {}),
      verified: o.verified,
      status: o.status,
    })),
    top: rec.top?.tag ?? null,
    best_installed: rec.bestInstalled?.tag ?? null,
    why: rec.why,
    notes: rec.notes,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const yes = (a: string) => /^y(es)?$/i.test(a.trim());

/** Where a runtime takes chat requests, on 127.0.0.1. */
export function chatUrlFor(runtime: RuntimeId): { url: string; kind: "ollama" | "openai" } {
  const port = RUNTIME_PORTS.find((r) => r.id === runtime)!.port;
  return runtime === "ollama"
    ? { url: `http://127.0.0.1:${port}/api/chat`, kind: "ollama" }
    : { url: `http://127.0.0.1:${port}/v1/chat/completions`, kind: "openai" };
}

/** Endpoint names to try for a runtime's endpoint, in order. */
const LOCAL_NAMES: Record<RuntimeId, string[]> = {
  ollama: ["local", "ollama"],
  llamacpp: ["llamacpp", "local-llamacpp"],
  lmstudio: ["lmstudio", "local-lmstudio"],
  vllm: ["vllm", "local-vllm"],
};

/**
 * The `smol` model: the chosen one, unless a small catalog model is already
 * installed on the same runtime. Setup never downloads a second model.
 */
export function smallFor(chosen: ModelOption, probe: MachineProbe, catalog: Catalog): string {
  if (chosen.entry && (chosen.entry.tier === "small" || chosen.entry.tier === "tiny")) return chosen.tag;
  const rt = probe.runtimes.find((r) => r.id === chosen.runtime && r.state === "serving");
  const small = catalog.models.filter((m) => m.tier === "small");
  for (const m of small) {
    const served = rt?.models.find((n) => n === m.tag || m.aliases.includes(n));
    if (served) return served;
  }
  return chosen.tag;
}

/** A cloud endpoint, resolved from `--cloud-endpoint` or a picker answer. */
interface CloudChoice {
  name: string;
  block: EndpointBlock;
  /** Declared already in config.toml: nothing to add there. */
  declared: boolean;
  preset?: string;
  /**
   * The URL and key variable are the surface's, not a preset's or what the
   * person typed: a cloned repository may have chosen them.
   */
  fromSurface?: boolean;
}

/**
 * Read `--cloud-endpoint`: a declared endpoint name, a preset key, or a URL.
 * A URL that is a preset's is that preset.
 */
export function resolveCloudEndpoint(value: string, configText: string | undefined, keyEnv?: string): CloudChoice | { error: string } {
  const declared = declaredEndpoints(configText);
  const parsed = configTextEndpoints(configText)[value];
  if (parsed) {
    if (isLoopback(parsed.url)) return { error: `"${value}" is a local endpoint (${parsed.url}), not a cloud one` };
    return { name: value, block: parsed, declared: true, fromSurface: true };
  }
  const preset = ENDPOINT_PRESETS[value] ?? Object.entries(ENDPOINT_PRESETS).find(([, p]) => p.url === value)?.[1];
  const presetKey = Object.entries(ENDPOINT_PRESETS).find(([, p]) => p === preset)?.[0];
  if (preset && presetKey !== "ollama") {
    const block: EndpointBlock = { url: preset.url, kind: preset.kind, ...(preset.api_key_env ? { api_key_env: preset.api_key_env } : {}), ...(preset.provider ? { provider: preset.provider } : {}) };
    const existing = Object.entries(declared).find(([, u]) => u === preset.url);
    return { name: existing?.[0] ?? preset.name, block, declared: Boolean(existing), preset: presetKey };
  }
  if (/^https?:\/\//.test(value)) {
    if (isLoopback(value)) return { error: `${value} is on this machine; a cloud endpoint is somewhere else` };
    const existing = Object.entries(declared).find(([, u]) => u === value);
    const kind = /\/api\/chat\/?$/.test(value) ? "ollama" : "openai";
    const name = existing?.[0] ?? (declared.cloud === undefined ? "cloud" : `cloud-${Object.keys(declared).length + 1}`);
    const block: EndpointBlock = { url: value, kind, api_key_env: keyEnv ?? "CLOUD_API_KEY" };
    return { name, block, declared: Boolean(existing) };
  }
  return {
    error: `--cloud-endpoint "${value}" is not a declared endpoint, a preset (${Object.keys(ENDPOINT_PRESETS).filter((k) => k !== "ollama").join(", ")}) or an http(s) URL`,
  };
}

function configTextEndpoints(configText: string | undefined): Record<string, EndpointBlock> {
  if (!configText) return {};
  const all = declaredEndpoints(configText);
  // declaredEndpoints only carries URLs; re-read the full blocks.
  const out: Record<string, EndpointBlock> = {};
  const lines = configText.split("\n");
  for (const name of Object.keys(all)) {
    const start = lines.findIndex((l) => l.trim() === `[endpoints.${name}]`);
    const block: Record<string, string> = {};
    for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]!); i++) {
      const m = lines[i]!.match(/^\s*(url|kind|api_key_env|provider)\s*=\s*"([^"]*)"/);
      if (m) block[m[1]!] = m[2]!;
    }
    out[name] = { url: block.url ?? all[name]!, kind: block.kind ?? (/\/api\/chat/.test(all[name]!) ? "ollama" : "openai"), ...(block.api_key_env ? { api_key_env: block.api_key_env } : {}), ...(block.provider ? { provider: block.provider } : {}) };
  }
  return out;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/**
 * A cloud model the surface already routes a role to, with its key held:
 * "a cloud endpoint is configured", which is when hybrid is suggested.
 */
function configuredCloud(texts: SurfaceTexts, deps: SetupDeps): { choice: CloudChoice; model: string } | undefined {
  const blocks = configTextEndpoints(texts["config.toml"]);
  const sources = [texts["roles.toml"], ...SETUP_FILES.filter((f) => f.startsWith("profiles/")).map((f) => texts[f])];
  for (const text of sources) {
    if (!text) continue;
    for (const role of rolesWithModels(text)) {
      const m = text.match(new RegExp(`\\[roles\\.${role}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`));
      const model = m?.[1]?.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
      const endpoint = m?.[1]?.match(/^\s*endpoint\s*=\s*"([^"]+)"/m)?.[1];
      const block = endpoint ? blocks[endpoint] : undefined;
      if (!model || !endpoint || !block || isLoopback(block.url)) continue;
      if (block.api_key_env && !deps.keys.held(block.api_key_env)) continue;
      return { choice: { name: endpoint, block, declared: true, fromSurface: true }, model };
    }
  }
  return undefined;
}

function readSurface(gnomonDir: string): SurfaceTexts {
  const out: SurfaceTexts = {};
  for (const rel of [...SETUP_FILES, "system.md"]) {
    const p = join(gnomonDir, ...rel.split("/"));
    out[rel] = existsSync(p) ? readFileSync(p, "utf-8") : undefined;
  }
  return out;
}

/** Add `.gnomon-setup.json` to the project's .gitignore, once. */
export function ignoreFactsFile(root: string): boolean {
  const ignore = join(root, ".gitignore");
  const text = existsSync(ignore) ? readFileSync(ignore, "utf-8") : "";
  if (text.split(/\r?\n/).some((l) => l.trim().replace(/^\//, "") === SETUP_FACTS_FILE)) return false;
  writeFileSync(
    ignore,
    (text && !text.endsWith("\n") ? text + "\n" : text) +
      "# gnomon setup: this machine's hardware facts, compared by `gnomon doctor`; never commit.\n" +
      `${SETUP_FACTS_FILE}\n`,
    "utf-8"
  );
  return true;
}

function bytesGb(n: number): string {
  return `${(n / 1e9).toFixed(0)} GB`;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<SetupReport> {
  const { io, catalog } = deps;
  const say = (l = "") => io.say(l);
  const root = resolve(opts.dir);
  const gnomonDir = join(root, ".gnomon");
  const report: SetupReport = {
    schema: "gnomon.setup/1",
    dir: root,
    catalog: { as_of: catalog.asOf, label: catalog.label, path: catalog.path },
    local: null,
    pull: null,
    speed: null,
    cloud: null,
    mode: null,
    hybrid_control: null,
    proposal: null,
    steps: [],
    next: [],
    exit: 0,
  };
  const step = (id: string, status: string) => report.steps.push({ id, status });
  let section = 0;
  const heading = (title: string) => {
    say("");
    say(`${++section}. ${title}`);
  };
  const done = (exit: number, why?: string): SetupReport => {
    report.exit = exit;
    if (why) {
      report.why = why;
      say("");
      say(why);
    }
    return report;
  };

  say("gnomon setup — scan this machine, plug in a local model it can run, then connect a cloud model.");
  say("Nothing is downloaded, written or spent without your yes.");

  // ── 1. The machine ──────────────────────────────────────────────────────
  const probe = await probeMachine(deps.host);
  report.machine = machineJson(probe);
  report.runtimes = runtimesJson(probe);
  heading("This machine");
  for (const l of formatProbe(probe)) say(`  ${l}`);
  step("probe", "ok");

  // ── 2. The recommendation ───────────────────────────────────────────────
  const rec = recommend(probe, catalog, { now: deps.now() });
  if (rec.catalog.stale) report.catalog.stale = rec.catalog.stale;
  report.recommendation = recommendationJson(rec);
  heading("A local model");
  for (const l of formatRecommendation(rec, { max: 8 })) say(`  ${l}`);
  step("recommend", rec.top ? "ok" : "none_fits");

  const surfaceTexts: SurfaceTexts = existsSync(gnomonDir) ? readSurface(gnomonDir) : {};

  // ── 3. Which one ────────────────────────────────────────────────────────
  let chosen: ModelOption | undefined;
  const optionFor = (tag: string): ModelOption => {
    const found = rec.options.find((o) => o.tag === tag);
    if (found) return found;
    const entry = catalog.models.find((m) => m.tag === tag || m.aliases.includes(tag));
    const fit = entry ? fitOf(entry, rec.memory, catalog) : { fit: "unknown" as const, why: "not in the catalog: its size is not known here" };
    return {
      tag,
      runtime: "ollama",
      installed: false,
      ...(entry ? { entry } : {}),
      fit: fit.fit,
      fitWhy: fit.why,
      ...(entry ? { downloadGb: entry.downloadGb } : {}),
      verified: entry?.measured ?? false,
      status: entry ? `~${entry.downloadGb} GB download` : "a download of unknown size, not in the catalog",
    };
  };

  if (opts.pull) {
    chosen = optionFor(opts.pull);
    if (chosen.fit === "over") say(`  Note: ${chosen.tag} ${chosen.fitWhy}: it will be slow or fail to load. Pulling it because --pull named it.`);
  } else if (opts.model) {
    chosen = rec.options.find((o) => o.tag === opts.model && o.installed);
    if (!chosen) {
      step("choose", "not_installed");
      return done(
        SETUP_EXIT.needsConsent,
        `--model ${opts.model}: no running model server lists it. Download it with --pull ${opts.model}, or start the server that has it.`
      );
    }
  } else if (io.interactive) {
    const shown = rec.options.slice(0, 8);
    const fallback = rec.top ? String(shown.indexOf(rec.top) + 1) : "0";
    say(`   0. none — use a cloud model only`);
    for (;;) {
      const a = (await io.ask(`  Choose a number, or type an Ollama tag [Enter = ${fallback}]: `, fallback)).trim();
      if (/^(0|none|cloud)$/i.test(a)) {
        chosen = undefined;
        break;
      }
      if (/^\d+$/.test(a)) {
        const o = shown[Number(a) - 1];
        if (!o) {
          say(`  "${a}" is not on the list.`);
          continue;
        }
        chosen = o;
      } else if (a) {
        chosen = optionFor(a);
      }
      if (chosen && chosen.fit === "over") {
        const go = await io.ask(`  ${chosen.tag} ${chosen.fitWhy}: it will be slow or fail to load. Use it anyway? [y/N] `, "n");
        if (!yes(go)) {
          chosen = undefined;
          continue;
        }
      }
      break;
    }
  } else {
    chosen = rec.bestInstalled;
  }
  step("choose", chosen ? (chosen.installed ? "installed" : "download") : "none");

  // ── 4. The download, only on a yes ──────────────────────────────────────
  if (chosen && !chosen.installed) {
    const command = `ollama pull ${chosen.tag}`;
    report.pull = { tag: chosen.tag, command, ...(chosen.downloadGb !== undefined ? { download_gb: chosen.downloadGb } : {}), status: "declined" };
    const ollama = probe.runtimes.find((r) => r.id === "ollama");
    heading("Download");
    if (ollama?.state !== "serving") {
      report.pull.status = "no_runtime";
      say(`  Ollama is not running on this machine, so ${chosen.tag} cannot be pulled now.`);
      say("    Install it from https://ollama.com/download (or open the Ollama app), then:");
      say(`    ${command}`);
      if (chosen.entry?.llamacpp) say(`  With llama.cpp instead (it manages its own files): ${chosen.entry.llamacpp}`);
      say("  LM Studio and vLLM also manage their own models: load it there. Then run `gnomon setup` again.");
      step("pull", "no_runtime");
      if (!io.interactive || opts.pull) {
        return done(SETUP_EXIT.needsConsent, `Nothing was downloaded or written: ${chosen.tag} needs a running Ollama (or another model server).`);
      }
      chosen = rec.bestInstalled;
      if (chosen) say(`  Using ${chosen.tag} instead: it is already installed.`);
    } else {
      const disk = deps.diskFree();
      const size = chosen.downloadGb !== undefined ? `~${chosen.downloadGb} GB` : "an unknown amount";
      say(`  ${chosen.tag} is ${size} to download through Ollama.`);
      say(
        disk.bytes !== undefined
          ? `  Free disk where Ollama keeps models (${disk.path}): ${bytesGb(disk.bytes)}`
          : "  Free disk where Ollama keeps models: unknown (gnomon could not tell)"
      );
      const short = disk.bytes !== undefined && chosen.downloadGb !== undefined && disk.bytes < chosen.downloadGb * 1.1e9;
      if (short) say(`  That is not enough room for ${size}.`);
      let consent = opts.pull === chosen.tag;
      if (!consent && io.interactive) {
        consent = yes(await io.ask(`  Pull it now? This downloads ${size}. [y/N] `, "n"));
      }
      if (!consent) {
        say(`  Not downloaded. When you want it: ${command}   (then run \`gnomon setup\` again)`);
        step("pull", "declined");
        chosen = rec.bestInstalled;
        if (chosen) say(`  Using ${chosen.tag} instead: it is already installed.`);
        else if (!io.interactive && !opts.cloudEndpoint) {
          return done(SETUP_EXIT.needsConsent, `Nothing was downloaded or written. To download it: gnomon setup --pull ${report.pull.tag}`);
        }
      } else {
        let last = "";
        const result = await deps.pull(chosen.tag, (p) => {
          // Every tenth percent and every new status: a 24 GB pull reports
          // progress thousands of times.
          const pct = p.total ? ` ${Math.floor((10 * (p.completed ?? 0)) / p.total) * 10}%` : "";
          const line = `${p.status}${pct}`;
          if (line !== last) {
            last = line;
            say(`    ${line}`);
          }
        });
        if (!result.ok) {
          report.pull.status = "failed";
          report.pull.error = result.error;
          step("pull", "failed");
          return done(
            result.unreachable ? SETUP_EXIT.runtimeStopped : SETUP_EXIT.needsConsent,
            `The pull of ${chosen.tag} failed: ${result.error}. Nothing was written.`
          );
        }
        report.pull.status = "pulled";
        step("pull", "pulled");
        chosen = { ...chosen, installed: true, status: "installed (Ollama)" };
      }
    }
  }

  const small = chosen ? smallFor(chosen, probe, catalog) : undefined;
  if (chosen) report.local = { tag: chosen.tag, runtime: chosen.runtime, installed: chosen.installed, small: small! };

  // ── 5. Speed check, only on a yes ───────────────────────────────────────
  let speed: SpeedResult | undefined;
  if (chosen && chosen.installed) {
    let run = opts.speedCheck;
    heading("Speed check");
    if (!run && io.interactive) {
      run = !/^n/i.test(
        (await io.ask(`  Run a ~10 s speed check on ${chosen.tag}? It loads the model and sends one short prompt to 127.0.0.1. [Y/n] `, "y")).trim()
      );
    }
    if (run) {
      const system = surfaceTexts["system.md"] ?? scaffoldTexts({ large: chosen.tag, small: small!, detected: [] })["system.md"] ?? "";
      const r = await deps.speedCheck({ runtime: chosen.runtime, chatUrl: chatUrlFor(chosen.runtime).url, model: chosen.tag, system });
      if ("error" in r) {
        report.speed = { error: r.error };
        step("speed", "failed");
        if (r.unreachable) {
          return done(SETUP_EXIT.runtimeStopped, `${chosen.tag} did not answer the speed check (${r.error}): the model server stopped answering. Nothing was written.`);
        }
        say(`  The speed check did not finish: ${r.error}. Carrying on without it.`);
      } else {
        speed = r;
        report.speed = r;
        step("speed", "ok");
        const parts = [
          r.prefillTps !== undefined ? `prompt ${Math.round(r.prefillTps).toLocaleString("en-US")} tok/s` : undefined,
          r.genTps !== undefined ? `generation ${r.genTps.toFixed(1)} tok/s` : undefined,
          r.loadS !== undefined ? `load ${r.loadS.toFixed(1)} s` : undefined,
        ].filter(Boolean);
        say(`  ${parts.join(" · ")}  (${r.source === "server" ? "the server's own timings" : "wall clock, approximate"})`);
      }
    } else {
      report.speed = { skipped: true };
      step("speed", "skipped");
      say(io.interactive ? "  Skipped." : "  Skipped (--speed-check runs it).");
    }
  }

  // ── 6. A cloud model ────────────────────────────────────────────────────
  let cloud: { choice: CloudChoice; model: string } | undefined;
  if (opts.cloudEndpoint) {
    const r = resolveCloudEndpoint(opts.cloudEndpoint, surfaceTexts["config.toml"], opts.cloudKeyEnv);
    if ("error" in r) return done(SETUP_EXIT.usage, r.error);
    const model = opts.cloudModel ?? catalog.cloud.find((c) => c.preset === r.preset)?.model;
    if (!model) return done(SETUP_EXIT.usage, `--cloud-endpoint ${opts.cloudEndpoint} needs --cloud-model NAME (the catalog has no default for it).`);
    cloud = { choice: r, model };
  } else {
    const configured = configuredCloud(surfaceTexts, deps);
    if (io.interactive) {
      heading("A cloud model (optional)");
      say(`  Hybrid: ${catalog.hybrid.evidence}`);
      const presets = Object.entries(ENDPOINT_PRESETS).filter(([k]) => k !== "ollama");
      const rows: Array<{ label: string; pick: () => Promise<{ choice: CloudChoice; model: string } | undefined> }> = [];
      if (configured) {
        rows.push({ label: `${configured.model} @${configured.choice.name} — already in this surface, key held`, pick: async () => configured });
      }
      for (const [key, p] of presets) {
        rows.push({ label: `${p.note}`, pick: () => pickCloudModel(resolveCloudEndpoint(key, surfaceTexts["config.toml"]) as CloudChoice, deps) });
      }
      rows.push({
        label: "Custom: any OpenAI-compatible URL",
        pick: async () => {
          const url = (await io.ask("  URL (…/chat/completions): ", "")).trim();
          if (!url) return undefined;
          const keyEnv = (await io.ask("  Key variable name [CLOUD_API_KEY]: ", "CLOUD_API_KEY")).trim() || "CLOUD_API_KEY";
          const r = resolveCloudEndpoint(url, surfaceTexts["config.toml"], keyEnv);
          if ("error" in r) {
            say(`  ${r.error}`);
            return undefined;
          }
          return pickCloudModel(r, deps);
        },
      });
      rows.forEach((r, i) => say(`   ${i + 1}. ${r.label}`));
      say(`   ${rows.length + 1}. Not now`);
      const fallback = configured ? "1" : String(rows.length + 1);
      const a = (await io.ask(`  Choose [Enter = ${fallback}]: `, fallback)).trim();
      const row = rows[Number(a) - 1];
      if (row) cloud = await row.pick();
    } else if (configured) {
      cloud = configured;
    }
  }

  if (cloud) {
    const keyEnv = cloud.choice.block.api_key_env;
    let held = keyEnv ? deps.keys.held(keyEnv) : true;
    if (keyEnv && !held && io.interactive) {
      const value = await io.askSecret(`  Paste the key for $${keyEnv} (hidden; stored in ${deps.keys.where()}, never in .gnomon/): `);
      if (value) {
        deps.keys.store(keyEnv, value);
        held = true;
        say(`  Stored ${keyEnv} (mode 0600). The surface holds only the name.`);
      } else {
        say(`  No key entered. Set it later with: gnomon key set ${keyEnv}`);
      }
    } else if (keyEnv && !held) {
      say(`  $${keyEnv} is not set. Set it with: gnomon key set ${keyEnv}   (hidden prompt, or from stdin)`);
    }
    let checked: "ok" | "failed" | "skipped" = "skipped";
    let detail: string | undefined;
    // An endpoint the surface chose, at a host that is not a known provider,
    // gets its key only once the surface is trusted -- the rule the session's
    // trust step applies (clampToDefaults). The y/N below names an endpoint,
    // not a host, so a yes there is not a yes to sending a key somewhere new.
    const keyHeldBack =
      Boolean(keyEnv) && cloud.choice.fromSurface === true && !keyHostIsDefault(cloud.choice.block.url) && !deps.surfaceTrusted?.();
    if (held && io.interactive && keyHeldBack) {
      say(`  Not checked: ${withheldWhy({ env: keyEnv!, host: hostName(cloud.choice.block.url) })}.`);
    } else if (held && io.interactive) {
      const go = await io.ask(`  Check it now with one token through ${cloud.choice.name} (a fraction of a cent)? [y/N] `, "n");
      if (yes(go)) {
        const r = await deps.checkCloud(cloud.choice.block, cloud.model);
        checked = r.ok ? "ok" : "failed";
        detail = r.ok ? undefined : `${r.status ?? ""} ${r.detail ?? ""}`.trim();
        say(r.ok ? `  ✓ ${cloud.model} answered.` : `  ✗ ${detail}. It is still written; fix it with \`gnomon endpoint test ${cloud.choice.name}\`.`);
      }
    }
    report.cloud = {
      endpoint: cloud.choice.name,
      url: cloud.choice.block.url,
      model: cloud.model,
      ...(keyEnv ? { key_env: keyEnv } : {}),
      key_held: held,
      checked,
      ...(detail ? { detail } : {}),
    };
    step("cloud", checked === "failed" ? "check_failed" : "ok");
  } else {
    step("cloud", "none");
  }

  // ── 7. The mode ─────────────────────────────────────────────────────────
  if (!chosen && !cloud) {
    step("mode", "no_model");
    const cloudHint = `--cloud-endpoint opencode-go --cloud-model ${catalog.cloud.find((c) => c.preset === "opencode-go")?.model ?? "NAME"}`;
    return done(
      SETUP_EXIT.needsConsent,
      "No model to set up: no local model is installed" + (report.pull ? " and none was downloaded" : "") + ", and no cloud model was given.\n" +
        (rec.top && !rec.top.installed
          ? `  This machine can run ${rec.top.tag} (${rec.top.status}): gnomon setup --pull ${rec.top.tag}   (Ollama must be running)\n`
          : "") +
        `  Or connect a cloud model: gnomon setup ${cloudHint}\n` +
        "Nothing was written."
    );
  }
  const suggestion: ModeSuggestion = suggestMode({ local: chosen, memory: rec.memory, speed, hasCloud: Boolean(cloud) }, catalog);
  let mode: Suggestion = opts.mode ?? suggestion.mode;
  heading("How to use them");
  say(`  Suggested: ${label(suggestion.mode)}. ${suggestion.why}${suggestion.provisional ? " (provisional thresholds)" : ""}`);
  if (!opts.mode && io.interactive) {
    for (;;) {
      const a = (await io.ask(`  Enter to accept, or type local / hybrid / cloud: `, "")).trim().toLowerCase();
      if (!a) break;
      const m = MODE_ALIASES[a];
      if (m) {
        mode = m;
        break;
      }
      say(`  "${a}" is not one of local, hybrid, cloud.`);
    }
  }
  const needsLocal = mode !== "cloud_first";
  const needsCloud = mode !== "local_only";
  if (needsLocal && !chosen) {
    if (opts.mode || !cloud) {
      return done(
        SETUP_EXIT.needsConsent,
        `${label(mode)} needs a local model, and none is installed or was downloaded. ` +
          (rec.top ? `Download one: gnomon setup --pull ${rec.top.tag}` : "Nothing in the catalog fits this machine: use --mode cloud with --cloud-endpoint and --cloud-model.")
      );
    }
    mode = "cloud_first";
  }
  if (needsCloud && !cloud) {
    if (opts.mode || !chosen) {
      return done(
        SETUP_EXIT.needsConsent,
        `${label(mode)} needs a cloud model: pass --cloud-endpoint (opencode-go, openrouter, opencode-zen, a declared endpoint or a URL) and --cloud-model.`
      );
    }
    say(`  ${label(mode)} needs a cloud model and none was added, so: local only. Run \`gnomon setup\` again to add one.`);
    mode = "local_only";
  }
  report.mode = { suggested: suggestion.mode, chosen: mode, role_profile: PROFILE_FOR[mode], why: suggestion.why, provisional: suggestion.provisional };
  if (mode === "hybrid") {
    report.hybrid_control = { value: opts.hybridControl, active: false, note: ESCALATE_NOTE };
    say(`  Hybrid control: ${opts.hybridControl} — ${ESCALATE_NOTE}.`);
  }
  step("mode", mode);

  // ── 8. The change, as a diff ────────────────────────────────────────────
  const fresh = !existsSync(gnomonDir);
  const initChoice = {
    large: chosen?.tag ?? FALLBACK_LARGE,
    small: small ?? FALLBACK_SMALL,
    detected: [],
    note:
      "# Tags written by 'gnomon setup' from its model catalog; the gnomon-setup lines\n" +
      "# at the top of this file say which. Detection ran once, here.",
  };
  const base: SurfaceTexts = fresh ? scaffoldTexts(initChoice) : surfaceTexts;
  const plan = () => {
    const texts = fresh && existsSync(gnomonDir) ? readSurface(gnomonDir) : base;
    const localUrl = chosen ? chatUrlFor(chosen.runtime) : undefined;
    const localEp = chosen && localUrl ? endpointFor(texts["config.toml"], localUrl.url, LOCAL_NAMES[chosen.runtime], { url: localUrl.url, kind: localUrl.kind }) : undefined;
    // A cloud endpoint already declared with the same URL is reused by name,
    // whatever the preset would have called it.
    const cloudEp = cloud
      ? cloud.choice.declared
        ? { name: cloud.choice.name }
        : endpointFor(texts["config.toml"], cloud.choice.block.url, [cloud.choice.name, `${cloud.choice.name}-cloud`], cloud.choice.block)
      : undefined;
    return {
      texts,
      changes: planSurface(texts, {
        mode,
        catalogLabel: catalog.label,
        ...(chosen && localEp ? { local: { tag: chosen.tag, small: small!, endpoint: localEp.name, ...(localEp.block ? { block: localEp.block } : {}) } } : {}),
        ...(cloudEp && cloud ? { cloud: { endpoint: cloudEp.name, model: cloud.model, ...(cloudEp.block ? { block: cloudEp.block } : {}) } } : {}),
      }),
      localEndpoint: localEp?.name,
      cloudEndpoint: cloudEp?.name,
    };
  };
  let planned = plan();
  if (report.local && planned.localEndpoint) report.local.endpoint = planned.localEndpoint;
  if (report.cloud && planned.cloudEndpoint) report.cloud.endpoint = planned.cloudEndpoint;
  const before = fresh ? undefined : safeHash(gnomonDir);
  report.surface_hash = before ? { before } : {};
  const files = planned.changes.map((c) => ({
    path: c.path,
    action: c.before === undefined ? ("create" as const) : ("modify" as const),
    diff: changeDiff(c),
  }));
  report.proposal = {
    fresh,
    files,
    facts_file: SETUP_FACTS_FILE,
    applied: false,
    digest: proposalDigest(before, fresh, files),
  };
  heading("The change");
  if (fresh) say(`  No .gnomon/ in ${root}: it is created with \`gnomon init\`'s scaffold, and then:`);
  if (planned.changes.length === 0) say("  The surface already says this: no change to .gnomon/.");
  for (const c of planned.changes) {
    say(`  ${c.before === undefined ? "+ create" : "~ modify"} .gnomon/${c.path}`);
    for (const l of changeDiff(c)) say(`    ${l}`);
  }
  say(`  + ${SETUP_FACTS_FILE} beside .gnomon/: this machine's facts for \`gnomon doctor\` (gitignored, not part of the surface)`);

  // The change a person reviewed elsewhere (the dashboard, a script that kept
  // an earlier --json) is the only one that may be written under its name. A
  // surface edited since, or a machine that now plans differently, is a new
  // proposal that nobody has seen.
  if (opts.expectProposal !== undefined && opts.expectProposal !== report.proposal.digest) {
    step("write", "proposal_changed");
    return done(
      SETUP_EXIT.surfaceMoved,
      `The change is not the one that was reviewed (proposal ${opts.expectProposal.slice(0, 12)}, now ${report.proposal.digest.slice(0, 12)}): ` +
        ".gnomon/ or this machine changed since. Nothing was written; review the change again."
    );
  }

  let consent = opts.yes;
  if (!consent && io.interactive) consent = yes(await io.ask("  Write this? [y/N] ", "n"));
  if (!consent) {
    step("write", "needs_consent");
    return done(
      SETUP_EXIT.needsConsent,
      io.interactive ? "Nothing was written." : "Nothing was written. This is the proposal; run it again with --yes to apply it."
    );
  }

  // ── 9. Write ────────────────────────────────────────────────────────────
  if (fresh) {
    await initSurface({ dir: root, models: initChoice });
    planned = plan();
  } else {
    const now = readSurface(gnomonDir);
    const moved = planned.changes.filter((c) => (now[c.path] ?? undefined) !== c.before);
    if (moved.length > 0) {
      step("write", "surface_moved");
      return done(
        SETUP_EXIT.surfaceMoved,
        `.gnomon/${moved[0]!.path} changed while setup was running. Nothing was written; run \`gnomon setup\` again.`
      );
    }
  }
  for (const c of planned.changes) {
    const p = join(gnomonDir, ...c.path.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, c.after, "utf-8");
  }
  writeFileSync(join(root, SETUP_FACTS_FILE), JSON.stringify(factsJson(report, deps.now()), null, 2) + "\n", "utf-8");
  const ignored = ignoreFactsFile(root);
  const after = safeHash(gnomonDir);
  report.surface_hash = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
  report.proposal.applied = true;
  step("write", "written");
  say("");
  say(`  ✓ Written${fresh ? " (new .gnomon/)" : ""}: ${planned.changes.map((c) => `.gnomon/${c.path}`).join(", ") || "no surface change"}; ${SETUP_FACTS_FILE}${ignored ? " (added to .gitignore)" : ""}.`);
  if (after) say(`  Surface ${before ? `${before.slice(0, 12)} → ` : ""}${after.slice(0, 12)}. Commit .gnomon/ to carry this to another machine.`);
  say("  The hash moved, so if this surface grants more than gnomon's defaults (a key sent to a host");
  say("  gnomon does not know, say), the next launch asks you to trust it again: `gnomon trust`.");

  // ── 10. Next ────────────────────────────────────────────────────────────
  if (!opts.fromLaunch) report.next.push("gnomon launch — start working in this project");
  if (deps.commands.includes("dashboard")) report.next.push("gnomon dashboard — the same, in a browser");
  report.next.push("gnomon doctor — re-check this machine any time; it never changes anything");
  say("");
  say("Next:");
  for (const n of report.next) say(`  ${n}`);
  return done(SETUP_EXIT.written);
}

/**
 * What `--expect-proposal` compares: the surface hash the plan was made
 * against and every file's diff, in order. Two runs that would write the same
 * bytes over the same surface agree; anything else differs.
 */
export function proposalDigest(
  before: string | undefined,
  fresh: boolean,
  files: ReadonlyArray<{ path: string; action: string; diff: readonly string[] }>
): string {
  const canonical = JSON.stringify({ before: before ?? null, fresh, files: files.map((f) => [f.path, f.action, f.diff]) });
  return createHash("sha256").update(canonical).digest("hex");
}

function label(m: Suggestion): string {
  return m === "local_only" ? "local only" : m === "hybrid" ? "hybrid (cloud plans, local builds)" : "cloud first";
}

function safeHash(gnomonDir: string): string | undefined {
  try {
    return recomputeManifest(gnomonDir).surface_hash;
  } catch {
    return undefined;
  }
}

/** Pick a model on a cloud endpoint: the catalog's default for the preset, or one from its listing. */
async function pickCloudModel(choice: CloudChoice, deps: SetupDeps): Promise<{ choice: CloudChoice; model: string } | undefined> {
  const { io } = deps;
  const known = deps.catalog.cloud.find((c) => c.preset === choice.preset);
  let suggested = known?.model;
  if (!suggested) {
    const listed = await deps.listCloudModels(choice.block).catch(() => [] as string[]);
    suggested = listed[0];
    if (listed.length > 0) io.say(`  It lists ${listed.length} models${listed.length > 12 ? `, e.g. ${listed.slice(0, 12).join(", ")}` : `: ${listed.join(", ")}`}.`);
  }
  const why = known?.note ? ` (${known.note})` : "";
  const model = (await io.ask(`  Model for planning${suggested ? ` [Enter = ${suggested}${why}]` : ""}: `, suggested ?? "")).trim();
  return model ? { choice, model } : undefined;
}

/** What `.gnomon-setup.json` holds: this machine as setup saw it. Machine-local, gitignored. */
export function factsJson(report: SetupReport, now: Date) {
  return {
    schema: "gnomon.setup-facts/1",
    at: now.toISOString(),
    catalog: { as_of: report.catalog.as_of, label: report.catalog.label },
    machine: report.machine,
    memory: report.recommendation?.memory,
    runtimes: report.runtimes?.map((r) => ({ id: r.id, state: r.state, models: r.models.length })),
    local: report.local,
    cloud: report.cloud ? { endpoint: report.cloud.endpoint, model: report.cloud.model } : null,
    speed: report.speed,
    mode: report.mode?.chosen ?? null,
    hybrid_control: report.hybrid_control,
  };
}

export type SetupFacts = ReturnType<typeof factsJson>;

/** The memory figure doctor compares, from a probe: same shape as factsJson's. */
export function memoryFacts(probe: MachineProbe) {
  const m = machineMemory(probe.hardware);
  return { kind: m.kind, gib: m.gib, ram_gib: m.ramGib, label: m.label };
}
