/**
 * gnomon-cli: the dated model catalog, and what it recommends for a machine.
 *
 * Step 3 of docs/design/SETUP-AND-COMMAND-CENTER.md. `probe.ts` states what a
 * machine is; this module reads `catalog/models.toml` and answers "which local
 * model should this machine run, and why?". Pure functions over the probe and
 * the catalog: nothing here touches the network, a model or a file other than
 * the catalog it is asked to read.
 *
 * The catalog decides only what `gnomon setup` PROPOSES. What a project runs
 * is the tags its `.gnomon/` names, written once at setup and hashed with the
 * rest of the surface (Rule 1).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseToml } from "gnomon-core";
import { looksLikeChatModel } from "./detect.js";
import { gib, type Hardware, type MachineProbe, type RuntimeId } from "./probe.js";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type Tier = "large" | "medium" | "small" | "tiny";
export type MemoryKind = "vram" | "unified" | "cpu";
/** What setup suggests. Published in docs/CONTRACTS.md §16. */
export type Suggestion = "local_only" | "hybrid" | "cloud_first";

export const TIERS: readonly Tier[] = ["large", "medium", "small", "tiny"];
export const SUGGESTIONS: readonly Suggestion[] = ["local_only", "hybrid", "cloud_first"];

/** The role_profile each suggestion is written as. All three are published enumerations already. */
export const PROFILE_FOR: Record<Suggestion, "local_first" | "frontier_plan" | "all_remote"> = {
  local_only: "local_first",
  hybrid: "frontier_plan",
  cloud_first: "all_remote",
};

export interface CatalogModel {
  /** The Ollama tag: what `ollama pull` takes. */
  tag: string;
  name: string;
  runtime: "ollama";
  /** Other Ollama names for the same weights, e.g. `qwen3:latest`. */
  aliases: string[];
  /** How OpenAI-style listings (llama.cpp, LM Studio, vLLM) name it, matched loosely. */
  servedAs: string[];
  paramsB: number;
  activeB?: number;
  quant?: string;
  downloadGb: number;
  memGb: number;
  minVramGb?: number;
  minUnifiedGb?: number;
  minCpuRamGb?: number;
  tier: Tier;
  tools: boolean;
  /** Whether gnomon has measured it; false prints "not measured by gnomon". */
  measured: boolean;
  note?: string;
  /** Shown only on a machine with a discrete GPU. */
  noteVram?: string;
  /** What to tell a llama.cpp user, who manages their own model files. */
  llamacpp?: string;
}

export interface Measurement {
  tag: string;
  machine: string;
  memory: MemoryKind;
  memoryGb: number;
  engine: string;
  solved: number;
  of: number;
  genTps?: number;
  prefillTps?: number;
  run: string;
}

export interface CloudDefault {
  preset: string;
  model: string;
  note?: string;
}

export interface Catalog {
  /** Where it was read from. */
  path: string;
  asOf: string;
  label: string;
  staleAfterDays: number;
  source: string;
  budget: {
    vramFraction: number;
    unifiedFraction: number;
    cpuFraction: number;
    overhead: number;
    nominalTolerance: number;
  };
  speed: {
    provisional: boolean;
    localOnlyMinGenTps: number;
    localOnlyMinPrefillTps: number;
    cloudFirstBelowGenTps: number;
  };
  hybrid: { evidence: string; evidenceUnified?: string; run: string };
  models: CatalogModel[];
  measured: Measurement[];
  cloud: CloudDefault[];
}

/** The catalog this release ships. Resolved beside the module, as in dist/ and src/ alike. */
export function defaultCatalogPath(): string {
  return fileURLToPath(new URL("../catalog/models.toml", import.meta.url));
}

/**
 * Parse and check a catalog. Throws an error naming the file and the entry:
 * a catalog that is wrong must not quietly recommend something.
 */
export function parseCatalog(text: string, path = "<catalog>"): Catalog {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new Error(`catalog ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fail = (where: string, what: string): never => {
    throw new Error(`catalog ${path}: ${where}: ${what}`);
  };
  const table = (v: unknown, where: string): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(where, "missing table");
  const str = (t: Record<string, unknown>, k: string, where: string, optional = false): string | undefined => {
    const v = t[k];
    if (v === undefined && optional) return undefined;
    return typeof v === "string" && v.trim() ? v : fail(where, `${k} must be a non-empty string`);
  };
  const num = (t: Record<string, unknown>, k: string, where: string, optional = false): number | undefined => {
    const v = t[k];
    if (v === undefined && optional) return undefined;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fail(where, `${k} must be a number`);
  };
  const bool = (t: Record<string, unknown>, k: string, where: string): boolean =>
    typeof t[k] === "boolean" ? (t[k] as boolean) : fail(where, `${k} must be true or false`);
  const strs = (t: Record<string, unknown>, k: string, where: string): string[] => {
    const v = t[k];
    if (v === undefined) return [];
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fail(where, `${k} must be a list of strings`);
  };
  const list = (k: string): Record<string, unknown>[] => {
    const v = raw[k];
    if (v === undefined) return [];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : fail(`[[${k}]]`, "must be an array of tables");
  };

  const asOf = str(raw, "as_of", "as_of")!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) fail("as_of", "must be a date, YYYY-MM-DD");
  const budget = table(raw.budget, "[budget]");
  const speed = table(raw.speed, "[speed]");
  const hybrid = table(raw.hybrid, "[hybrid]");

  const models = list("model").map((m, i): CatalogModel => {
    const where = `[[model]] ${i + 1}${typeof m.tag === "string" ? ` (${m.tag})` : ""}`;
    const tier = str(m, "tier", where)! as Tier;
    if (!TIERS.includes(tier)) fail(where, `tier must be one of ${TIERS.join(", ")}`);
    const runtime = str(m, "runtime", where)!;
    if (runtime !== "ollama") fail(where, `runtime must be "ollama" (other runtimes manage their own models)`);
    const entry: CatalogModel = {
      tag: str(m, "tag", where)!,
      name: str(m, "name", where)!,
      runtime: "ollama",
      aliases: strs(m, "aliases", where),
      servedAs: strs(m, "served_as", where),
      paramsB: num(m, "params_b", where)!,
      activeB: num(m, "active_b", where, true),
      quant: str(m, "quant", where, true),
      downloadGb: num(m, "download_gb", where)!,
      memGb: num(m, "mem_gb", where)!,
      minVramGb: num(m, "min_vram_gb", where, true),
      minUnifiedGb: num(m, "min_unified_gb", where, true),
      minCpuRamGb: num(m, "min_cpu_ram_gb", where, true),
      tier,
      tools: bool(m, "tools", where),
      measured: bool(m, "measured", where),
      note: str(m, "note", where, true),
      noteVram: str(m, "note_vram", where, true),
      llamacpp: str(m, "llamacpp", where, true),
    };
    if (entry.minVramGb === undefined && entry.minUnifiedGb === undefined && entry.minCpuRamGb === undefined) {
      fail(where, "needs at least one of min_vram_gb, min_unified_gb, min_cpu_ram_gb");
    }
    return entry;
  });
  if (models.length === 0) fail("[[model]]", "the catalog lists no models");
  const tags = new Set<string>();
  for (const m of models) {
    if (tags.has(m.tag)) fail(`[[model]] ${m.tag}`, "listed twice");
    tags.add(m.tag);
  }

  const measured = list("measured").map((r, i): Measurement => {
    const where = `[[measured]] ${i + 1}`;
    const memory = str(r, "memory", where)! as MemoryKind;
    if (!["vram", "unified", "cpu"].includes(memory)) fail(where, "memory must be vram, unified or cpu");
    const row: Measurement = {
      tag: str(r, "tag", where)!,
      machine: str(r, "machine", where)!,
      memory,
      memoryGb: num(r, "memory_gb", where)!,
      engine: str(r, "engine", where)!,
      solved: num(r, "solved", where)!,
      of: num(r, "of", where)!,
      genTps: num(r, "gen_tps", where, true),
      prefillTps: num(r, "prefill_tps", where, true),
      run: str(r, "run", where)!,
    };
    if (!tags.has(row.tag)) fail(where, `measures "${row.tag}", which is not a [[model]]`);
    if (row.of <= 0 || row.solved > row.of) fail(where, "solved must be between 0 and of");
    return row;
  });
  // "measured = true" with no row is a claim with nothing behind it.
  for (const m of models) {
    const rows = measured.filter((r) => r.tag === m.tag).length;
    if (m.measured && rows === 0) fail(`[[model]] ${m.tag}`, "measured = true but no [[measured]] row names it");
    if (!m.measured && rows > 0) fail(`[[model]] ${m.tag}`, "has [[measured]] rows but says measured = false");
  }

  const cloud = list("cloud").map((c, i): CloudDefault => {
    const where = `[[cloud]] ${i + 1}`;
    return { preset: str(c, "preset", where)!, model: str(c, "model", where)!, note: str(c, "note", where, true) };
  });

  return {
    path,
    asOf,
    label: str(raw, "label", "label")!,
    staleAfterDays: num(raw, "stale_after_days", "stale_after_days")!,
    source: str(raw, "source", "source")!,
    budget: {
      vramFraction: num(budget, "vram_fraction", "[budget]")!,
      unifiedFraction: num(budget, "unified_fraction", "[budget]")!,
      cpuFraction: num(budget, "cpu_fraction", "[budget]")!,
      overhead: num(budget, "overhead", "[budget]")!,
      nominalTolerance: num(budget, "nominal_tolerance", "[budget]")!,
    },
    speed: {
      provisional: bool(speed, "provisional", "[speed]"),
      localOnlyMinGenTps: num(speed, "local_only_min_gen_tps", "[speed]")!,
      localOnlyMinPrefillTps: num(speed, "local_only_min_prefill_tps", "[speed]")!,
      cloudFirstBelowGenTps: num(speed, "cloud_first_below_gen_tps", "[speed]")!,
    },
    hybrid: {
      evidence: str(hybrid, "evidence", "[hybrid]")!,
      evidenceUnified: str(hybrid, "evidence_unified", "[hybrid]", true),
      run: str(hybrid, "run", "[hybrid]")!,
    },
    models,
    measured,
    cloud,
  };
}

/** Read a catalog: the shipped one, or `--catalog FILE`. */
export function loadCatalog(path: string = defaultCatalogPath()): Catalog {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`catalog ${path}: cannot be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
  }
  return parseCatalog(text, path);
}

/** Whole days from the catalog's date to `now`. */
export function catalogAgeDays(catalog: Catalog, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(catalog.asOf + "T00:00:00Z")) / 86_400_000);
}

/** The line every recommendation prints once the catalog is old. Never fetched: said. */
export function staleLine(catalog: Catalog, now: Date): string | undefined {
  const age = catalogAgeDays(catalog, now);
  if (age <= catalog.staleAfterDays) return undefined;
  return (
    `catalog from ${catalog.asOf} (${age} days old) — newer models likely exist; see ollama.com/library, ` +
    `or pass --catalog FILE with a newer one`
  );
}

// ---------------------------------------------------------------------------
// The machine's memory, as a model sees it
// ---------------------------------------------------------------------------

export interface MachineMemory {
  kind: MemoryKind;
  /** The memory that bounds a model, in GiB. */
  gib: number;
  /** System RAM in GiB: what a model spills into past the GPU. */
  ramGib: number;
  /** "31.8 GiB of GPU memory (NVIDIA GeForce RTX 5090)" */
  label: string;
  notes: string[];
}

const GIB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What bounds a local model on this hardware.
 *
 * Unified memory (Apple Silicon, NVIDIA GB10) is system RAM the GPU shares.
 * Discrete NVIDIA and AMD memory adds up across cards, which is how Ollama and
 * llama.cpp split a model. Everything else (no GPU, an integrated or unknown
 * one) is the CPU and system RAM.
 */
export function machineMemory(hw: Hardware): MachineMemory {
  const ramGib = round1(hw.ramBytes / GIB);
  const notes: string[] = [];
  const unified = hw.gpus.find((g) => g.unified);
  if (unified) {
    return { kind: "unified", gib: ramGib, ramGib, label: `${gib(hw.ramBytes)} of unified memory (${unified.name})`, notes };
  }
  const discrete = hw.gpus.filter((g) => !g.unified && (g.vendor === "nvidia" || g.vendor === "amd"));
  const known = discrete.filter((g) => g.memoryBytes !== undefined && g.memoryBytes > 0);
  if (known.length > 0) {
    const bytes = known.reduce((s, g) => s + g.memoryBytes!, 0);
    const names = [...new Set(known.map((g) => g.name))];
    const count = known.length > 1 ? `${known.length} GPUs: ` : "";
    return {
      kind: "vram",
      gib: round1(bytes / GIB),
      ramGib,
      label: `${gib(bytes)} of GPU memory (${count}${names.join(", ")})`,
      notes,
    };
  }
  if (discrete.length > 0) {
    notes.push(
      `${discrete[0]!.name}'s memory is unknown, so models are sized for the CPU; the speed check shows what the GPU adds`
    );
  }
  return { kind: "cpu", gib: ramGib, ramGib, label: `${gib(hw.ramBytes)} of RAM, no usable GPU`, notes };
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/**
 * fits: runs in the memory that bounds it.
 * tight: a discrete GPU is too small, but GPU plus RAM carries it: partly on the CPU, slower.
 * over: too big for this machine.
 * unknown: an installed model whose size its runtime did not say.
 */
export type Fit = "fits" | "tight" | "over" | "unknown";

const KIND_WORDS: Record<MemoryKind, string> = {
  vram: "of GPU memory",
  unified: "of unified memory",
  cpu: "of RAM (on the CPU)",
};

/** "24 GB of GPU memory or 64 GB of unified memory" */
export function describeNeeds(m: CatalogModel): string {
  const parts: string[] = [];
  if (m.minVramGb !== undefined) parts.push(`${m.minVramGb} GB ${KIND_WORDS.vram}`);
  if (m.minUnifiedGb !== undefined) parts.push(`${m.minUnifiedGb} GB ${KIND_WORDS.unified}`);
  if (m.minCpuRamGb !== undefined) parts.push(`${m.minCpuRamGb} GB ${KIND_WORDS.cpu}`);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " or " + parts[parts.length - 1] : parts[0] ?? "";
}

/** Does a catalog model run on this machine? With the reason, in words. */
export function fitOf(m: CatalogModel, mem: MachineMemory, catalog: Catalog): { fit: Fit; why: string } {
  const tol = catalog.budget.nominalTolerance;
  const need = mem.kind === "vram" ? m.minVramGb : mem.kind === "unified" ? m.minUnifiedGb : m.minCpuRamGb;
  if (need !== undefined && mem.gib >= need * tol) {
    return { fit: "fits", why: `${mem.gib.toFixed(1)} GiB ${KIND_WORDS[mem.kind]} clears its ${need} GB` };
  }
  if (mem.kind === "vram" && m.minCpuRamGb !== undefined && mem.ramGib >= m.minCpuRamGb * tol) {
    return {
      fit: "tight",
      why: `needs ${m.minVramGb ?? "more"} GB of GPU memory and this machine has ${mem.gib.toFixed(1)} GiB; ` +
        `the rest runs from ${mem.ramGib.toFixed(1)} GiB of RAM: partly on the CPU, slower`,
    };
  }
  return { fit: "over", why: `needs ${describeNeeds(m)}; this machine has ${mem.label}` };
}

/** An installed model the catalog does not know, sized from what its runtime reported. */
export function fitBySize(sizeBytes: number | undefined, mem: MachineMemory, catalog: Catalog): { fit: Fit; why: string } {
  if (sizeBytes === undefined || !(sizeBytes > 0)) return { fit: "unknown", why: "its runtime does not report a size" };
  const needGib = (sizeBytes / GIB) * catalog.budget.overhead;
  const b = catalog.budget;
  const cap = mem.gib * (mem.kind === "vram" ? b.vramFraction : mem.kind === "unified" ? b.unifiedFraction : b.cpuFraction);
  const size = `${(sizeBytes / GIB).toFixed(1)} GiB`;
  if (needGib <= cap) return { fit: "fits", why: `${size} on disk fits in ${mem.gib.toFixed(1)} GiB ${KIND_WORDS[mem.kind]}` };
  if (mem.kind === "vram" && needGib <= cap + mem.ramGib * b.cpuFraction) {
    return { fit: "tight", why: `${size} on disk is more than the GPU holds: partly on the CPU, slower` };
  }
  return { fit: "over", why: `${size} on disk is too big for ${mem.label}` };
}

// ---------------------------------------------------------------------------
// Which installed name is which catalog model
// ---------------------------------------------------------------------------

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The catalog entry an installed model is, if any. Ollama names are matched
 * exactly (tag or alias). An OpenAI-style listing names models however its
 * server was started -- an alias, a GGUF file name -- so those are matched
 * loosely on the squashed name.
 */
export function catalogEntryFor(name: string, runtime: RuntimeId, catalog: Catalog): CatalogModel | undefined {
  const n = name.trim().toLowerCase();
  if (runtime === "ollama") {
    return catalog.models.find((m) => m.tag.toLowerCase() === n || m.aliases.some((a) => a.toLowerCase() === n));
  }
  const s = squash(name);
  return catalog.models.find((m) =>
    [...m.servedAs, m.tag].map(squash).some((k) => k.length >= 5 && s.includes(k))
  );
}

// ---------------------------------------------------------------------------
// The recommendation
// ---------------------------------------------------------------------------

export interface ModelOption {
  /** What roles.toml names: the served id, or the Ollama tag to pull. */
  tag: string;
  runtime: RuntimeId;
  /** The runtime's listing URL on 127.0.0.1, for an installed model. */
  runtimeUrl?: string;
  installed: boolean;
  entry?: CatalogModel;
  fit: Fit;
  fitWhy: string;
  /** Present when choosing it means a download. */
  downloadGb?: number;
  /** What the runtime reported, for an installed model. */
  sizeBytes?: number;
  /** Measured by gnomon (a catalog entry with measured = true). */
  verified: boolean;
  /** One short status for a list: "installed", "~23.9 GB download", ... */
  status: string;
}

export interface Recommendation {
  catalog: { asOf: string; label: string; path: string; stale?: string };
  memory: MachineMemory;
  /** Ranked, best first. Models too big for the machine come last, marked. */
  options: ModelOption[];
  /** The recommendation: the first option that can run. Absent when nothing can. */
  top?: ModelOption;
  /** The best option that needs no download, for a run that may not download. */
  bestInstalled?: ModelOption;
  /** Why `top`, as lines. */
  why: string[];
  notes: string[];
}

const FIT_RANK: Record<Fit, number> = { fits: 0, tight: 1, unknown: 2, over: 3 };
const runs = (o: ModelOption | undefined) => o !== undefined && o.fit !== "over";

/** "measured by gnomon on an RTX 5090 (...): solved 24 of 32 tasks working alone (75%), ~375 tok/s generation" */
export function measuredLine(m: Measurement): string {
  const pct = Math.round((100 * m.solved) / m.of);
  const speed = m.genTps !== undefined ? `, ~${m.genTps} tok/s generation` : "";
  const run = m.run.split(" (")[0];
  return `measured by gnomon on an ${m.machine}: solved ${m.solved} of ${m.of} tasks working alone (${pct}%)${speed} (${run})`;
}

/** The measurement closest to this machine: the same kind of memory first, then the nearest size. */
export function closestMeasurement(tag: string, mem: MachineMemory, catalog: Catalog): Measurement | undefined {
  const rows = catalog.measured.filter((r) => r.tag === tag);
  return rows.sort(
    (a, b) =>
      Number(a.memory !== mem.kind) - Number(b.memory !== mem.kind) ||
      Math.abs(a.memoryGb - mem.gib) - Math.abs(b.memoryGb - mem.gib)
  )[0];
}

/**
 * Rank what this machine can run.
 *
 * 1. Catalog models that fit, best first (catalog order). One already
 *    installed is offered as installed, on the runtime that serves it; one
 *    that is not is offered as an Ollama pull, with its size.
 * 2. Installed models the catalog does not know, that fit: "not verified".
 * 3. Catalog models that fit only partly on the CPU.
 * 4. Installed models whose size is unknown, then ones too big.
 *
 * The top option is the best model for the machine, even when that means a
 * download; `bestInstalled` is what a run that may not download takes. The
 * design's "installed beats new" holds within the catalog's order (an
 * installed catalog model is never displaced by pulling the same one), and an
 * installed model the catalog does not know is offered as the no-download
 * alternative rather than above a measured one.
 */
export function recommend(probe: MachineProbe, catalog: Catalog, opts: { now?: Date } = {}): Recommendation {
  const now = opts.now ?? new Date();
  const memory = machineMemory(probe.hardware);
  const options: ModelOption[] = [];
  const serving = probe.runtimes.filter((r) => r.state === "serving");

  catalog.models.forEach((entry) => {
    const { fit, why } = fitOf(entry, memory, catalog);
    const installedOn = serving.flatMap((rt) =>
      rt.models
        .filter((name) => catalogEntryFor(name, rt.id, catalog) === entry)
        .map((name) => ({ rt, name }))
    );
    for (const { rt, name } of installedOn) {
      options.push({
        tag: name,
        runtime: rt.id,
        runtimeUrl: rt.url,
        installed: true,
        entry,
        fit,
        fitWhy: why,
        sizeBytes: rt.sizes?.[name],
        verified: entry.measured,
        status: `installed (${rt.label})`,
      });
    }
    if (installedOn.length === 0 && fit !== "over") {
      options.push({
        tag: entry.tag,
        runtime: "ollama",
        installed: false,
        entry,
        fit,
        fitWhy: why,
        downloadGb: entry.downloadGb,
        verified: entry.measured,
        status: `~${entry.downloadGb} GB download`,
      });
    }
  });

  for (const rt of serving) {
    for (const name of rt.models) {
      if (!looksLikeChatModel(name) || catalogEntryFor(name, rt.id, catalog)) continue;
      const sizeBytes = rt.sizes?.[name];
      const { fit, why } = fitBySize(sizeBytes, memory, catalog);
      options.push({
        tag: name,
        runtime: rt.id,
        runtimeUrl: rt.url,
        installed: true,
        fit,
        fitWhy: why,
        sizeBytes,
        verified: false,
        status: `installed (${rt.label}), not in the catalog: not verified by gnomon`,
      });
    }
  }

  const catalogIndex = (o: ModelOption) => (o.entry ? catalog.models.indexOf(o.entry) : catalog.models.length);
  const ranked = options
    .map((o, i) => ({ o, i }))
    .sort(
      (a, b) =>
        FIT_RANK[a.o.fit] - FIT_RANK[b.o.fit] ||
        catalogIndex(a.o) - catalogIndex(b.o) ||
        Number(b.o.installed) - Number(a.o.installed) ||
        (b.o.sizeBytes ?? 0) - (a.o.sizeBytes ?? 0) ||
        a.i - b.i
    )
    .map((x) => x.o);

  const top = runs(ranked[0]) ? ranked[0] : undefined;
  const bestInstalled = ranked.find((o) => o.installed && runs(o));

  const why: string[] = [];
  const notes: string[] = [...memory.notes];
  if (top) {
    why.push(`${top.fitWhy}.`);
    if (top.entry) {
      const m = closestMeasurement(top.entry.tag, memory, catalog);
      why.push(m ? `${capital(measuredLine(m))}.` : "Not measured by gnomon; sizes from ollama.com/library.");
      if (top.entry.tier === "small" || top.entry.tier === "medium") {
        why.push("A smaller model: for real tasks, let a cloud model plan (hybrid).");
      }
      if (top.entry.note) why.push(top.entry.note);
      if (top.entry.noteVram && memory.kind === "vram") why.push(top.entry.noteVram);
    } else {
      why.push("Not in the catalog, so not verified by gnomon: the speed check is worth running.");
    }
    if (memory.kind === "cpu") why.push("It would run on the CPU: slow. The speed check decides whether it is usable.");
  } else {
    notes.push("Nothing in the catalog runs on this machine: start with a cloud model (cloud first).");
  }
  const stale = staleLine(catalog, now);
  if (stale) notes.push(stale);

  return {
    catalog: { asOf: catalog.asOf, label: catalog.label, path: catalog.path, ...(stale ? { stale } : {}) },
    memory,
    options: ranked,
    ...(top ? { top } : {}),
    ...(bestInstalled ? { bestInstalled } : {}),
    why,
    notes,
  };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The tags `gnomon init` writes when no model server answered, and why. */
export interface StarterModels {
  large: string;
  small: string;
  /** The provenance comment for roles.toml, `# `-led lines. */
  note: string;
  catalogLabel: string;
  downloadGb?: number;
}

/**
 * What `gnomon init` writes when nothing answered at detection time: the tag
 * `gnomon setup` would recommend for this machine, rather than a generic
 * placeholder that `gnomon doctor` then flags and nothing will ever serve.
 *
 * Only an Ollama pull the machine can run (the scaffold's `local` endpoint is
 * Ollama on 127.0.0.1:11434), and the same tag for smol: setup never
 * downloads a second model, so one `gnomon setup --pull <tag>` makes every
 * role answer. Undefined when the catalog has nothing this machine runs, or
 * when its pick is already installed somewhere (then detection, or setup,
 * knows better than a starter tag); the caller keeps the placeholders.
 */
export function starterModels(probe: MachineProbe, catalog: Catalog, opts: { now?: Date } = {}): StarterModels | undefined {
  const rec = recommend(probe, catalog, opts);
  const top = rec.top;
  if (!top || top.installed || top.runtime !== "ollama" || !top.entry) return undefined;
  return {
    large: top.tag,
    small: top.tag,
    catalogLabel: catalog.label,
    downloadGb: top.downloadGb,
    note:
      `# No model server answered at 'gnomon init' time, so these are the model\n` +
      `# catalog's recommendation for this machine (catalog ${catalog.label}), not yet\n` +
      `# installed. \`gnomon setup\` downloads it on your yes (or points the roles\n` +
      `# at a model you have); \`gnomon doctor\` says whether every role answers.`,
  };
}

/** The recommendation as the lines setup and doctor print. */
export function formatRecommendation(rec: Recommendation, opts: { max?: number } = {}): string[] {
  const lines: string[] = [];
  const max = opts.max ?? 6;
  lines.push(`For this machine (${rec.memory.label}; catalog ${rec.catalog.label}):`);
  const shown = rec.options.slice(0, max);
  shown.forEach((o, i) => {
    const mark = o === rec.top ? "  ← recommended" : "";
    const name = o.entry && o.entry.tag !== o.tag ? `${o.tag} (${o.entry.name})` : o.entry ? `${o.tag} (${o.entry.name})` : o.tag;
    const fit = o.fit === "tight" ? " · partly on the CPU: slower" : o.fit === "over" ? " · too big for this machine" : o.fit === "unknown" ? " · size unknown" : "";
    const measured = o.entry && !o.entry.measured ? " · not measured by gnomon" : "";
    lines.push(`  ${String(i + 1).padStart(2)}. ${name} — ${o.status}${fit}${measured}${mark}`);
  });
  if (rec.options.length > shown.length) lines.push(`      …and ${rec.options.length - shown.length} more`);
  if (rec.options.length === 0) lines.push("  (no local model fits, and none is installed)");
  for (const w of rec.why) lines.push(`  ${w}`);
  for (const n of rec.notes) lines.push(`  Note: ${n}`);
  return lines;
}

// ---------------------------------------------------------------------------
// The mode it suggests
// ---------------------------------------------------------------------------

/** What a speed check measured. Rates from the server's own timings where it gave them. */
export interface SpeedResult {
  model: string;
  runtime: RuntimeId;
  genTps?: number;
  prefillTps?: number;
  loadS?: number;
  promptTokens?: number;
  outputTokens?: number;
  /** "server": the server's own timings. "wall_clock": approximate. */
  source: "server" | "wall_clock";
  wallMs: number;
}

export interface ModeSuggestion {
  mode: Suggestion;
  /** One sentence: why this mode. */
  why: string;
  /** The suggestion rests on the catalog's provisional speed thresholds. */
  provisional: boolean;
  /** Hybrid and cloud first need a cloud model to do anything. */
  needsCloud: boolean;
}

/**
 * Suggest a mode. It suggests; the person decides, and `--mode` overrides.
 *
 *  - no local model, generation below the floor, or a tiny model: cloud first;
 *  - a cloud model is configured: hybrid, citing the measured result;
 *  - slow, a small or medium model, or on the CPU: hybrid (needs a cloud model);
 *  - otherwise: local only.
 */
export function suggestMode(
  input: { local?: ModelOption; memory: MachineMemory; speed?: SpeedResult; hasCloud: boolean },
  catalog: Catalog
): ModeSuggestion {
  const s = catalog.speed;
  const tier = input.local?.entry?.tier;
  const gen = input.speed?.genTps;
  const prefill = input.speed?.prefillTps;
  const cite = input.memory.kind === "unified" && catalog.hybrid.evidenceUnified
    ? `${catalog.hybrid.evidence} ${catalog.hybrid.evidenceUnified}`
    : catalog.hybrid.evidence;
  if (!input.local) {
    return { mode: "cloud_first", why: "No local model was chosen, so a cloud model does the work.", provisional: false, needsCloud: true };
  }
  if (gen !== undefined && gen < s.cloudFirstBelowGenTps) {
    return {
      mode: "cloud_first",
      why: `${input.local.tag} generated ${gen.toFixed(1)} tok/s, below the provisional ${s.cloudFirstBelowGenTps} tok/s floor: too slow for a task.`,
      provisional: s.provisional,
      needsCloud: true,
    };
  }
  if (tier === "tiny") {
    return { mode: "cloud_first", why: `${input.local.tag} is a small helper, not a coder: a cloud model should do the work.`, provisional: false, needsCloud: true };
  }
  if (input.hasCloud) {
    return { mode: "hybrid", why: `A cloud model plans, ${input.local.tag} builds. ${cite}`, provisional: false, needsCloud: true };
  }
  const slow =
    (gen !== undefined && gen < s.localOnlyMinGenTps) || (prefill !== undefined && prefill < s.localOnlyMinPrefillTps);
  if (slow) {
    return {
      mode: "hybrid",
      why: `${input.local.tag} is usable but slow (below the provisional ${s.localOnlyMinGenTps} tok/s generation / ${s.localOnlyMinPrefillTps} tok/s prompt): let a cloud model plan. ${cite}`,
      provisional: s.provisional,
      needsCloud: true,
    };
  }
  if (tier === "small" || tier === "medium" || input.memory.kind === "cpu") {
    return {
      mode: "hybrid",
      why: `${input.local.tag} can build, and a cloud model planning makes it stronger. ${cite}`,
      provisional: false,
      needsCloud: true,
    };
  }
  return {
    mode: "local_only",
    why: gen !== undefined
      ? `${input.local.tag} is fast enough to run every role here (${gen.toFixed(0)} tok/s generation; provisional threshold ${s.localOnlyMinGenTps}).`
      : `${input.local.tag} can run every role here. A speed check would confirm it.`,
    provisional: gen !== undefined && s.provisional,
    needsCloud: false,
  };
}
