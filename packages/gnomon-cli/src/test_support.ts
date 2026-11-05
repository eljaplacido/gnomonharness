/**
 * Fake machines for the setup, catalog and doctor tests. Not shipped:
 * excluded from tsconfig's build, as gnomon-core's test_support.ts is.
 *
 * Each machine is a ProbeHost answering from tables with the exact text the
 * real tools print, so a GB10, a Mac, a Windows box and an 8 GB laptop all run
 * on any CI runner, and no test reaches a network or a real model server.
 */

import type { CommandOutput, HttpResult, ProbeHost } from "./probe.js";

export const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
export const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: "" });
const missing: CommandOutput = { code: null, stdout: "", stderr: "", error: "ENOENT" };
const refused: HttpResult = { error: "ECONNREFUSED" };

export interface FakeMachine {
  platform: string;
  arch: string;
  ramBytes: number;
  cpuCount?: number;
  cpuModel?: string;
  commands?: Record<string, CommandOutput>;
  urls?: Record<string, HttpResult>;
}

/** A host that answers from tables; records every command and GET. */
export function fakeHost(m: FakeMachine): ProbeHost & { calls: string[]; gets: string[] } {
  const calls: string[] = [];
  const gets: string[] = [];
  return {
    platform: m.platform,
    arch: m.arch,
    totalMemBytes: m.ramBytes,
    cpuCount: m.cpuCount ?? 8,
    cpuModel: m.cpuModel ?? "",
    calls,
    gets,
    run: async (cmd, args) => {
      calls.push(cmd);
      // A command line wins over a bare command, so `sysctl -n hw.memsize`
      // and `sysctl -n machdep.cpu.brand_string` can answer differently.
      return m.commands?.[`${cmd} ${args.join(" ")}`] ?? m.commands?.[cmd] ?? missing;
    },
    get: async (url) => {
      gets.push(url);
      return m.urls?.[url] ?? refused;
    },
    readFile: () => undefined,
    listDir: () => [],
  };
}

export const OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags";
export const LLAMACPP_MODELS = "http://127.0.0.1:8080/v1/models";

/** Ollama's /api/tags body for these models (name → bytes on disk). */
export function ollamaServing(models: Record<string, number> = {}): Record<string, HttpResult> {
  return {
    [OLLAMA_TAGS]: {
      status: 200,
      body: JSON.stringify({ models: Object.entries(models).map(([name, size]) => ({ name, model: name, size })) }),
    },
  };
}

const nvidia = (name: string, mib: number | "[N/A]") => ok(`${name}, ${mib === "[N/A]" ? mib : `${mib} MiB`}\n`);

/** The machines the recommendation is specified against. */
export const MACHINES = {
  /** An 8 GB laptop with no usable GPU: Linux reports a little under 8 GiB. */
  laptop8: (): FakeMachine => ({ platform: "linux", arch: "x64", ramBytes: 7.6 * GiB }),
  /** A 16 GB Apple Silicon Mac: unified memory. */
  mac16: (): FakeMachine => ({
    platform: "darwin",
    arch: "arm64",
    ramBytes: 16 * GiB,
    commands: { "sysctl -n hw.memsize": ok(String(16 * GiB)), "sysctl -n machdep.cpu.brand_string": ok("Apple M3") },
  }),
  /** An RTX 4090: nvidia-smi says 24564 MiB, which is 23.99 GiB. */
  gpu24: (platform = "linux"): FakeMachine => ({
    platform,
    arch: "x64",
    ramBytes: 64 * GiB,
    commands: { "nvidia-smi": nvidia("NVIDIA GeForce RTX 4090", 24564) },
  }),
  /** An RTX 5090, as on the hub. */
  gpu32: (platform = "linux"): FakeMachine => ({
    platform,
    arch: "x64",
    ramBytes: 64 * GiB,
    commands: { "nvidia-smi": nvidia("NVIDIA GeForce RTX 5090", 32607) },
  }),
  /** An 8 GB card in a 64 GB desktop: a big MoE spills into RAM. */
  gpu8ram64: (): FakeMachine => ({
    platform: "linux",
    arch: "x64",
    ramBytes: 64 * GiB,
    commands: { "nvidia-smi": nvidia("NVIDIA GeForce RTX 3070", 8192) },
  }),
  /** NVIDIA GB10 / DGX Spark: 128 GB unified, 121.6 GiB visible. */
  gb10: (): FakeMachine => ({
    platform: "linux",
    arch: "arm64",
    ramBytes: 130596581376,
    cpuCount: 20,
    commands: { "nvidia-smi": nvidia("NVIDIA GB10", "[N/A]") },
  }),
  /** Too small for anything in the catalog. */
  tiny4: (): FakeMachine => ({ platform: "linux", arch: "x64", ramBytes: 4 * GiB }),
};

/** Add model servers to a machine. */
export function withUrls(m: FakeMachine, urls: Record<string, HttpResult>): FakeMachine {
  return { ...m, urls: { ...(m.urls ?? {}), ...urls } };
}

export { MiB };
