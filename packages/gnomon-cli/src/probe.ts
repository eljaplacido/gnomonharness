/**
 * gnomon-cli: What this machine is, and which local model servers it runs.
 *
 * Step 1 of docs/design/SETUP-AND-COMMAND-CENTER.md. A local-first user should
 * not have to know their VRAM, or which port LM Studio listens on, before
 * gnomon can suggest a model. This module answers two questions and nothing
 * more:
 *
 *   - the hardware: OS, architecture, CPU cores, RAM, and each GPU with its
 *     memory, or "unified" when the GPU shares system RAM (Apple Silicon, and
 *     NVIDIA GB10 / DGX Spark, where nvidia-smi prints `[N/A]` for memory);
 *   - the runtimes: Ollama, LM Studio, a llama.cpp server and vLLM, each asked
 *     for its model listing on its usual port on 127.0.0.1.
 *
 * It states facts. It does not size a model or recommend one (step 3), and it
 * writes nothing: not the surface, not a cache, not a file anywhere. Every
 * command it runs is a read-only query with a deadline, started without a
 * shell; every request is a GET to 127.0.0.1. A machine without a given GPU
 * or runtime gets a shorter answer, never an error.
 *
 * Everything goes through a `ProbeHost`, so the tests hand it the exact
 * output of nvidia-smi on a GB10, of sysctl on a Mac and of PowerShell on
 * Windows, and run on any OS.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { causeCode } from "gnomon-core";

// ---------------------------------------------------------------------------
// The host: every way the probe touches the machine
// ---------------------------------------------------------------------------

export interface CommandOutput {
  /** Exit code; null when the process never exited on its own. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** "ENOENT" when the command is not installed; "timeout" when it was killed at the deadline. */
  error?: string;
}

export type HttpResult = { status: number; body: string } | { error: string };

export interface ProbeHost {
  /** `process.platform`: "linux", "darwin", "win32", ... */
  platform: string;
  /** `process.arch`: "x64", "arm64", ... */
  arch: string;
  totalMemBytes: number;
  cpuCount: number;
  /** Empty when the OS does not say (Linux on ARM reports "unknown"). */
  cpuModel: string;
  /** Run a command without a shell; never rejects. */
  run(cmd: string, args: readonly string[], timeoutMs: number): Promise<CommandOutput>;
  /** GET a URL; never rejects. */
  get(url: string, timeoutMs: number): Promise<HttpResult>;
  /** A file's text, or undefined when it cannot be read. */
  readFile(path: string): string | undefined;
  /** A directory's entries, or [] when it cannot be read. */
  listDir(path: string): string[];
}

// ---------------------------------------------------------------------------
// What the probe reports
// ---------------------------------------------------------------------------

export type GpuVendor = "nvidia" | "amd" | "apple" | "intel" | "other";

export interface Gpu {
  vendor: GpuVendor;
  name: string;
  /** The GPU's own memory in bytes; undefined when it has none, or it is unknown. */
  memoryBytes?: number;
  /** Shares system RAM with the CPU: Apple Silicon, NVIDIA GB10. */
  unified: boolean;
  /** Which probe said so. */
  source: "nvidia-smi" | "rocm-smi" | "sysfs" | "sysctl" | "win32_videocontroller";
}

export interface Hardware {
  /** `process.platform` */
  os: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  ramBytes: number;
  gpus: Gpu[];
  /** What a probe could not establish, as phrases a person can act on. */
  notes: string[];
}

export type RuntimeId = "ollama" | "lmstudio" | "llamacpp" | "vllm";

export interface RuntimePort {
  id: RuntimeId;
  label: string;
  port: number;
  /** The listing path. A GET to it lists models and loads none. */
  path: string;
}

/**
 * The servers looked for, each on its default port. 127.0.0.1 only: the probe
 * never reaches past this machine, and a server bound elsewhere is added by
 * hand with `gnomon endpoint add`.
 */
export const RUNTIME_PORTS: readonly RuntimePort[] = [
  { id: "ollama", label: "Ollama", port: 11434, path: "/api/tags" },
  { id: "lmstudio", label: "LM Studio", port: 1234, path: "/v1/models" },
  { id: "llamacpp", label: "llama.cpp", port: 8080, path: "/v1/models" },
  { id: "vllm", label: "vLLM", port: 8000, path: "/v1/models" },
];

export interface Runtime {
  /** The server that usually holds this port. */
  id: RuntimeId;
  /** Who answered: the port's usual server, or the one its listing names. */
  label: string;
  port: number;
  url: string;
  /**
   * serving: it answered with a model listing (possibly empty).
   * absent: nothing listens on the port.
   * no_listing: something holds the port, but did not answer with a listing.
   */
  state: "serving" | "absent" | "no_listing";
  models: string[];
  why?: string;
}

export interface MachineProbe {
  hardware: Hardware;
  runtimes: Runtime[];
  tookMs: number;
}

/** A command's deadline. nvidia-smi can take a second or two to wake a driver. */
export const COMMAND_TIMEOUT_MS = 4000;
/** A listing's deadline. Refused connections answer at once; this bounds a port that hangs. */
export const LISTING_TIMEOUT_MS = 1500;

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

/** Run, never throwing: a host whose `run` rejects is a probe that failed. */
async function runSafe(host: ProbeHost, cmd: string, args: readonly string[], timeoutMs: number): Promise<CommandOutput> {
  try {
    return await host.run(cmd, args, timeoutMs);
  } catch (err) {
    return { code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** First non-blank line of what a failed command printed, for a note. */
function firstLine(out: CommandOutput): string {
  return (out.stdout + "\n" + out.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * A note for a probe that ran and failed. A command that is not installed is
 * not a failure: no nvidia-smi is how most machines say "no NVIDIA GPU".
 */
function failureNote(cmd: string, out: CommandOutput, timeoutMs: number): string | undefined {
  if (out.error === "ENOENT") return undefined;
  if (out.error === "timeout") return `${cmd} did not answer within ${timeoutMs / 1000} s`;
  const line = firstLine(out);
  const how = out.code !== null ? `exit ${out.code}` : out.error ?? "no exit code";
  return `${cmd} failed (${how})${line ? `: ${line.slice(0, 160)}` : ""}`;
}

function vendorOf(name: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return "nvidia";
  if (/\bamd\b|radeon|instinct/i.test(name)) return "amd";
  if (/intel/i.test(name)) return "intel";
  return "other";
}

/**
 * `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`, one line
 * per GPU: `NVIDIA GeForce RTX 4090, 24564 MiB`. On a GB10 (DGX Spark) the
 * memory column is `[N/A]`: the GPU has no memory of its own and shares the
 * system's LPDDR5X with the CPU, so it is reported as unified.
 */
export function parseNvidiaSmi(stdout: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.lastIndexOf(",");
    const name = (comma >= 0 ? line.slice(0, comma) : line).trim();
    const mem = comma >= 0 ? line.slice(comma + 1).trim() : "";
    if (!name) continue;
    const mib = mem.match(/^(\d+(?:\.\d+)?)\s*MiB$/i);
    gpus.push(
      mib
        ? { vendor: "nvidia", name, memoryBytes: Math.round(Number(mib[1]) * MIB), unified: false, source: "nvidia-smi" }
        : { vendor: "nvidia", name, unified: true, source: "nvidia-smi" }
    );
  }
  return gpus;
}

/**
 * `rocm-smi --showproductname --showmeminfo vram --json`: one object per card,
 * `{"card0": {"Card series": "...", "VRAM Total Memory (B)": "..."}}`. Key
 * names have moved between ROCm releases, so they are matched loosely.
 */
export function parseRocmSmi(stdout: string): Gpu[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!json || typeof json !== "object") return [];
  const gpus: Gpu[] = [];
  for (const [card, value] of Object.entries(json as Record<string, unknown>)) {
    if (!/^card\d+$/i.test(card) || !value || typeof value !== "object") continue;
    const fields = value as Record<string, unknown>;
    const pick = (re: RegExp) => {
      const key = Object.keys(fields).find((k) => re.test(k));
      const v = key ? fields[key] : undefined;
      return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    };
    const name = pick(/^card series$/i) || pick(/^device name$/i) || pick(/^card model$/i) || pick(/^card sku$/i) || card;
    const bytes = Number(pick(/vram total memory \(b\)/i));
    gpus.push({
      vendor: "amd",
      name,
      ...(Number.isFinite(bytes) && bytes > 0 ? { memoryBytes: bytes } : {}),
      unified: false,
      source: "rocm-smi",
    });
  }
  return gpus;
}

/**
 * AMD GPUs from sysfs, for a machine with the amdgpu driver and no ROCm: the
 * usual case for a Radeon card running llama.cpp on Vulkan. Two small files
 * per card, both world-readable.
 */
export function readAmdSysfs(host: ProbeHost): Gpu[] {
  const gpus: Gpu[] = [];
  for (const entry of host.listDir("/sys/class/drm").filter((e) => /^card\d+$/.test(e)).sort()) {
    const device = `/sys/class/drm/${entry}/device`;
    if (host.readFile(`${device}/vendor`)?.trim().toLowerCase() !== "0x1002") continue;
    const bytes = Number(host.readFile(`${device}/mem_info_vram_total`)?.trim());
    const name = host.readFile(`${device}/product_name`)?.trim() || `AMD GPU (${entry})`;
    gpus.push({
      vendor: "amd",
      name,
      ...(Number.isFinite(bytes) && bytes > 0 ? { memoryBytes: bytes } : {}),
      unified: false,
      source: "sysfs",
    });
  }
  return gpus;
}

/**
 * The value Win32_VideoController reports for any card with 4 GB or more.
 * AdapterRAM is a 32-bit field, so above that it is a ceiling, not a size.
 */
const WIN32_ADAPTER_RAM_CAP = 0xfff00000;

/** PowerShell's `ConvertTo-Json` of Win32_VideoController: one object, or an array. */
export function parseWin32VideoControllers(stdout: string, notes: string[]): Gpu[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim() || "null");
  } catch {
    return [];
  }
  const rows = (Array.isArray(json) ? json : json ? [json] : []) as Array<{ Name?: unknown; AdapterRAM?: unknown }>;
  const gpus: Gpu[] = [];
  for (const row of rows) {
    const name = typeof row.Name === "string" ? row.Name.trim() : "";
    // Not hardware a model can run on.
    if (!name || /basic display|basic render|remote display|virtual display|parsec|citrix/i.test(name)) continue;
    const ram = typeof row.AdapterRAM === "number" ? row.AdapterRAM : NaN;
    const known = Number.isFinite(ram) && ram > 0 && ram < WIN32_ADAPTER_RAM_CAP;
    if (!known && Number.isFinite(ram) && ram >= WIN32_ADAPTER_RAM_CAP) {
      notes.push(`Windows reports at most 4 GB for ${name}; its real memory is unknown`);
    }
    gpus.push({
      vendor: vendorOf(name),
      name,
      ...(known ? { memoryBytes: ram } : {}),
      unified: false,
      source: "win32_videocontroller",
    });
  }
  return gpus;
}

/** Linux on ARM, and some VMs, report the CPU model as "unknown". */
function cleanCpuModel(model: string): string {
  const m = model.trim();
  return /^(unknown|)$/i.test(m) ? "" : m.replace(/\s+/g, " ");
}

/**
 * The hardware, from read-only queries. Commands that are not installed are
 * skipped silently; ones that fail or hang leave a note and no GPU.
 */
export async function probeHardware(host: ProbeHost, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Hardware> {
  const notes: string[] = [];
  const gpus: Gpu[] = [];
  let ramBytes = host.totalMemBytes;
  let cpuModel = cleanCpuModel(host.cpuModel);

  if (host.platform === "darwin") {
    // Apple Silicon has no VRAM: the GPU uses the same memory as the CPU, so
    // the number that bounds a model is hw.memsize.
    const mem = await runSafe(host, "sysctl", ["-n", "hw.memsize"], timeoutMs);
    const bytes = Number(mem.stdout.trim());
    if (mem.code === 0 && Number.isFinite(bytes) && bytes > 0) ramBytes = bytes;
    else if (mem.error !== "ENOENT") notes.push(failureNote("sysctl hw.memsize", mem, timeoutMs) ?? "sysctl hw.memsize gave no number");
    if (host.arch === "arm64") {
      const brand = await runSafe(host, "sysctl", ["-n", "machdep.cpu.brand_string"], timeoutMs);
      const chip = (brand.code === 0 ? brand.stdout.trim() : "") || cpuModel || "Apple Silicon";
      if (!cpuModel) cpuModel = chip;
      gpus.push({ vendor: "apple", name: `${chip} GPU`, unified: true, source: "sysctl" });
    } else {
      notes.push("an Intel Mac: its GPU memory is not probed");
    }
    return { os: host.platform, arch: host.arch, cpuModel, cpuCount: host.cpuCount, ramBytes, gpus, notes };
  }

  const nvidiaArgs = ["--query-gpu=name,memory.total", "--format=csv,noheader"];
  const [nvidia, rocm] = await Promise.all([
    runSafe(host, "nvidia-smi", nvidiaArgs, timeoutMs),
    host.platform === "linux"
      ? runSafe(host, "rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"], timeoutMs)
      : Promise.resolve(undefined),
  ]);

  if (nvidia.code === 0) {
    const found = parseNvidiaSmi(nvidia.stdout);
    for (const g of found.filter((g) => g.unified)) {
      notes.push(`nvidia-smi reports no memory of its own for ${g.name}: treated as unified memory shared with system RAM`);
    }
    gpus.push(...found);
  } else {
    const note = failureNote("nvidia-smi", nvidia, timeoutMs);
    if (note) notes.push(note);
  }

  if (rocm) {
    const amd = rocm.code === 0 ? parseRocmSmi(rocm.stdout) : [];
    if (amd.length > 0) {
      gpus.push(...amd);
    } else {
      const fromSysfs = readAmdSysfs(host);
      gpus.push(...fromSysfs);
      // rocm-smi failing beside a card sysfs found is worth a word; failing
      // on a machine with no AMD card is just the machine.
      const note = fromSysfs.length > 0 ? undefined : failureNote("rocm-smi", rocm, timeoutMs);
      if (note && rocm.code !== 0) notes.push(note);
    }
  }

  if (host.platform === "win32" && !gpus.some((g) => g.vendor === "nvidia")) {
    const ps = await runSafe(
      host,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
      ],
      timeoutMs
    );
    if (ps.code === 0) gpus.push(...parseWin32VideoControllers(ps.stdout, notes));
    else {
      const note = failureNote("Win32_VideoController", ps, timeoutMs);
      if (note) notes.push(note);
    }
  }

  return { os: host.platform, arch: host.arch, cpuModel, cpuCount: host.cpuCount, ramBytes, gpus, notes };
}

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

/** Who a listing says served it, from OpenAI-style `owned_by`. */
const OWNED_BY: Record<string, string> = { vllm: "vLLM", llamacpp: "llama.cpp" };

/** Model names from an Ollama `/api/tags` or an OpenAI-style `/v1/models` body. */
export function parseListing(body: string): { models: string[]; ownedBy?: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const j = json as {
    models?: Array<{ name?: unknown; model?: unknown }>;
    data?: Array<{ id?: unknown; owned_by?: unknown }>;
  };
  if (!Array.isArray(j.models) && !Array.isArray(j.data)) return undefined;
  const names = new Set<string>();
  for (const d of Array.isArray(j.data) ? j.data : []) if (typeof d?.id === "string" && d.id) names.add(d.id);
  for (const m of Array.isArray(j.models) ? j.models : []) {
    const n = typeof m?.name === "string" ? m.name : typeof m?.model === "string" ? m.model : "";
    if (n) names.add(n);
  }
  const owner = (Array.isArray(j.data) ? j.data : []).map((d) => d?.owned_by).find((o) => typeof o === "string");
  return { models: [...names], ownedBy: typeof owner === "string" ? owner : undefined };
}

/**
 * Ask each runtime's usual port on 127.0.0.1 for its model listing, all at
 * once. A listing is a GET that loads nothing: no model is woken, no token is
 * generated.
 */
export async function discoverRuntimes(host: ProbeHost, timeoutMs = LISTING_TIMEOUT_MS): Promise<Runtime[]> {
  return Promise.all(
    RUNTIME_PORTS.map(async (rt): Promise<Runtime> => {
      const url = `http://127.0.0.1:${rt.port}${rt.path}`;
      const base = { id: rt.id, label: rt.label, port: rt.port, url, models: [] as string[] };
      let res: HttpResult;
      try {
        res = await host.get(url, timeoutMs);
      } catch (err) {
        res = { error: err instanceof Error ? err.message : String(err) };
      }
      if ("error" in res) {
        if (res.error === "ECONNREFUSED") return { ...base, state: "absent", why: "nothing listens" };
        if (res.error === "timeout") return { ...base, state: "no_listing", why: `no answer within ${timeoutMs / 1000} s` };
        return { ...base, state: "no_listing", why: res.error };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ...base, state: "no_listing", why: `answered ${res.status}` };
      }
      const listing = parseListing(res.body);
      if (!listing) return { ...base, state: "no_listing", why: "answered, but not with a model listing" };
      const named = listing.ownedBy ? OWNED_BY[listing.ownedBy.toLowerCase()] : undefined;
      return { ...base, label: named ?? rt.label, state: "serving", models: listing.models };
    })
  );
}

// ---------------------------------------------------------------------------
// Both, and how to show them
// ---------------------------------------------------------------------------

/** The hardware and the runtimes, probed together. Never throws. */
export async function probeMachine(host: ProbeHost = systemHost()): Promise<MachineProbe> {
  const started = Date.now();
  const [hardware, runtimes] = await Promise.all([probeHardware(host), discoverRuntimes(host)]);
  return { hardware, runtimes, tookMs: Date.now() - started };
}

/**
 * Whether `gnomon init` probes. Not with `--from`, which copies a surface
 * that already chose its models, and not with `--no-verify`, which benchmark
 * harnesses pass to get the scaffold exactly as it was: a run that suddenly
 * sends GETs to :8080 is a second variable, and that port may be the very
 * llama.cpp server under test.
 */
export function probeAtInit(opts: { from?: string; noVerify?: boolean }): boolean {
  return !opts.from && !opts.noVerify;
}

const OS_LABEL: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** Bytes as GiB, one decimal place: 25769803776 → "24.0 GiB". */
export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** The probe as the lines init and setup print. */
export function formatProbe(probe: MachineProbe): string[] {
  const hw = probe.hardware;
  const lines: string[] = [];
  const cores = hw.cpuCount > 0 ? `, ${hw.cpuCount} CPU cores` : "";
  const cpu = hw.cpuModel ? ` (${hw.cpuModel})` : "";
  lines.push(`This machine: ${OS_LABEL[hw.os] ?? hw.os} ${hw.arch}${cores}${cpu}, ${gib(hw.ramBytes)} RAM`);
  if (hw.gpus.length === 0) {
    lines.push("  GPU: none found; local models would run on the CPU");
  }
  for (const g of hw.gpus) {
    const mem = g.unified
      ? `unified memory, shares the ${gib(hw.ramBytes)} of RAM`
      : g.memoryBytes !== undefined
        ? `${gib(g.memoryBytes)} of its own`
        : "memory unknown";
    lines.push(`  GPU: ${g.name}, ${mem}`);
  }
  const serving = probe.runtimes.filter((r) => r.state === "serving");
  const held = probe.runtimes.filter((r) => r.state === "no_listing");
  const absent = probe.runtimes.filter((r) => r.state === "absent");
  if (serving.length > 0) {
    lines.push(
      "  Model servers: " +
        serving
          .map((r) => `${r.label} :${r.port} (${r.models.length} model${r.models.length === 1 ? "" : "s"})`)
          .join(", ")
    );
  } else {
    lines.push("  Model servers: none running on this machine");
  }
  for (const r of held) {
    lines.push(`  :${r.port} is in use, but not by a model server gnomon recognises (${r.why})`);
  }
  if (absent.length > 0 && serving.length > 0) {
    lines.push(`  Not running: ${absent.map((r) => `${r.label} :${r.port}`).join(", ")}`);
  }
  for (const n of hw.notes) lines.push(`  Note: ${n}`);
  lines.push(`  (read-only probe, ${probe.tookMs} ms; nothing was written)`);
  return lines;
}

// ---------------------------------------------------------------------------
// The real host
// ---------------------------------------------------------------------------

/**
 * This machine. Commands run through execFile (no shell, so no quoting and
 * no expansion), hidden on Windows, killed at their deadline, output capped
 * at 1 MiB.
 */
export function systemHost(): ProbeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemBytes: totalmem(),
    cpuCount: availableParallelism(),
    cpuModel: cpus()[0]?.model ?? "",
    run: (cmd, args, timeoutMs) =>
      new Promise((resolve) => {
        try {
          execFile(
            cmd,
            [...args],
            { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: MIB, encoding: "utf8" },
            (err, stdout, stderr) => {
              if (!err) return resolve({ code: 0, stdout, stderr });
              const e = err as { code?: unknown; killed?: boolean; signal?: unknown };
              if (e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", error: "ENOENT" });
              if (e.killed || e.signal) return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", error: "timeout" });
              resolve({
                code: typeof e.code === "number" ? e.code : null,
                stdout: stdout ?? "",
                stderr: stderr ?? "",
                ...(typeof e.code === "string" ? { error: e.code } : {}),
              });
            }
          );
        } catch (err) {
          resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
        }
      }),
    get: async (url, timeoutMs) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { error: "timeout" };
        return { error: causeCode(err) ?? (err instanceof Error ? err.message : String(err)) };
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}
