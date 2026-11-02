/**
 * gnomon-cli: hardware probe and runtime discovery tests
 *
 * Every machine here is a fake host fed the exact text the real tool prints,
 * so the GB10, Apple, Windows and no-GPU cases all run on any CI runner. Only
 * the last block touches the real OS, and only to prove the runner's own
 * degradation: a command that does not exist, and one that hangs.
 */

import { describe, it, expect } from "vitest";
import {
  probeHardware,
  discoverRuntimes,
  probeMachine,
  formatProbe,
  parseNvidiaSmi,
  parseRocmSmi,
  parseListing,
  probeAtInit,
  systemHost,
  gib,
  RUNTIME_PORTS,
  type CommandOutput,
  type HttpResult,
  type ProbeHost,
} from "./probe.js";

const GiB = 1024 ** 3;
const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: "" });
const missing: CommandOutput = { code: null, stdout: "", stderr: "", error: "ENOENT" };
const refused: HttpResult = { error: "ECONNREFUSED" };

interface Call {
  cmd: string;
  args: readonly string[];
  timeoutMs: number;
}

/**
 * A host that answers from tables. A command it has no answer for is not
 * installed; a URL it has no answer for refuses the connection. Every call is
 * recorded, so a test can say what the probe did NOT run.
 */
function fakeHost(opts: {
  platform: string;
  arch: string;
  ramBytes?: number;
  cpuCount?: number;
  cpuModel?: string;
  commands?: Record<string, CommandOutput>;
  urls?: Record<string, HttpResult>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}): ProbeHost & { calls: Call[]; gets: string[] } {
  const calls: Call[] = [];
  const gets: string[] = [];
  return {
    platform: opts.platform,
    arch: opts.arch,
    totalMemBytes: opts.ramBytes ?? 16 * GiB,
    cpuCount: opts.cpuCount ?? 8,
    cpuModel: opts.cpuModel ?? "",
    calls,
    gets,
    run: async (cmd, args, timeoutMs) => {
      calls.push({ cmd, args, timeoutMs });
      return opts.commands?.[cmd] ?? missing;
    },
    get: async (url) => {
      gets.push(url);
      return opts.urls?.[url] ?? refused;
    },
    readFile: (path) => opts.files?.[path],
    listDir: (path) => opts.dirs?.[path] ?? [],
  };
}

describe("probeHardware: NVIDIA", () => {
  it("GB10 / DGX Spark: memory [N/A] is unified memory shared with RAM, not a GPU with none", async () => {
    // Verbatim from this repository's gx10 machine, 2026-11-02.
    const host = fakeHost({
      platform: "linux",
      arch: "arm64",
      ramBytes: 130596581376,
      cpuCount: 20,
      cpuModel: "unknown",
      commands: { "nvidia-smi": ok("NVIDIA GB10, [N/A]\n") },
    });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([{ vendor: "nvidia", name: "NVIDIA GB10", unified: true, source: "nvidia-smi" }]);
    expect(hw.gpus[0]!.memoryBytes).toBeUndefined();
    expect(hw.ramBytes).toBe(130596581376);
    // Linux on ARM says "unknown"; that is not a CPU name.
    expect(hw.cpuModel).toBe("");
    expect(hw.notes.join("\n")).toMatch(/NVIDIA GB10.*unified memory shared with system RAM/);
  });

  it("a discrete card reports its own memory, in bytes", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64", commands: { "nvidia-smi": ok("NVIDIA GeForce RTX 4090, 24564 MiB\n") } });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", memoryBytes: 24564 * 1024 * 1024, unified: false, source: "nvidia-smi" },
    ]);
    expect(hw.notes).toEqual([]);
  });

  it("asks nvidia-smi for name and memory only, as CSV without a header", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64" });
    await probeHardware(host);
    const smi = host.calls.find((c) => c.cmd === "nvidia-smi");
    expect(smi?.args).toEqual(["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  });

  it("reads every line of a multi-GPU machine, and a name with a comma in it", () => {
    expect(parseNvidiaSmi("NVIDIA A100-SXM4-80GB, 81920 MiB\r\nNVIDIA A100-SXM4-80GB, 81920 MiB\r\n")).toHaveLength(2);
    expect(parseNvidiaSmi("Some, Odd Name, 8192 MiB")[0]).toMatchObject({ name: "Some, Odd Name", memoryBytes: 8 * GiB });
    expect(parseNvidiaSmi("NVIDIA Jetson, [Not Supported]")[0]).toMatchObject({ unified: true });
    expect(parseNvidiaSmi("\n  \n")).toEqual([]);
  });

  it("a driver that cannot be reached is a note, not a GPU and not an error", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "x64",
      commands: {
        "nvidia-smi": {
          code: 9,
          stdout: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\n",
          stderr: "",
        },
      },
    });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([]);
    expect(hw.notes).toEqual([expect.stringMatching(/^nvidia-smi failed \(exit 9\): NVIDIA-SMI has failed/)]);
  });

  it("a command that hangs is killed at its deadline and noted", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "x64",
      commands: { "nvidia-smi": { code: null, stdout: "", stderr: "", error: "timeout" } },
    });
    const hw = await probeHardware(host, 4000);
    expect(hw.gpus).toEqual([]);
    expect(hw.notes).toEqual(["nvidia-smi did not answer within 4 s"]);
  });

  it("a host whose run() throws still yields an answer", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64" });
    host.run = async () => {
      throw new Error("spawn EPERM");
    };
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([]);
    expect(hw.notes.join("\n")).toMatch(/EPERM/);
  });
});

describe("probeHardware: no GPU", () => {
  it("a plain Linux box: no GPU, no notes, nothing thrown", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64", ramBytes: 32 * GiB, cpuCount: 12, cpuModel: "AMD Ryzen 9 7900" });
    const hw = await probeHardware(host);
    expect(hw).toEqual({
      os: "linux",
      arch: "x64",
      cpuModel: "AMD Ryzen 9 7900",
      cpuCount: 12,
      ramBytes: 32 * GiB,
      gpus: [],
      notes: [],
    });
  });

  it("every command it runs has a deadline, and none is a shell", async () => {
    for (const platform of ["linux", "win32", "darwin"]) {
      const host = fakeHost({ platform, arch: platform === "darwin" ? "arm64" : "x64" });
      await probeHardware(host);
      expect(host.calls.length).toBeGreaterThan(0);
      for (const c of host.calls) {
        expect(c.timeoutMs).toBeGreaterThan(0);
        expect(["nvidia-smi", "rocm-smi", "sysctl", "powershell.exe"]).toContain(c.cmd);
        expect(c.cmd).not.toMatch(/^(sh|bash|cmd(\.exe)?)$/);
      }
    }
  });
});

describe("probeHardware: AMD", () => {
  it("reads rocm-smi's JSON", async () => {
    const rocm = JSON.stringify({
      card0: {
        "Card series": "Radeon RX 7900 XTX",
        "Card model": "0x744c",
        "VRAM Total Memory (B)": "25753026560",
        "VRAM Total Used Memory (B)": "1069056",
      },
      system: { "Driver version": "6.8.5" },
    });
    const host = fakeHost({ platform: "linux", arch: "x64", commands: { "rocm-smi": ok(rocm) } });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "amd", name: "Radeon RX 7900 XTX", memoryBytes: 25753026560, unified: false, source: "rocm-smi" },
    ]);
    expect(hw.notes).toEqual([]);
  });

  it("falls back to sysfs when ROCm is not installed (Radeon on Vulkan)", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "x64",
      dirs: { "/sys/class/drm": ["card1-DP-1", "card1", "renderD128", "version", "card0"] },
      files: {
        "/sys/class/drm/card0/device/vendor": "0x8086\n", // Intel iGPU: not ours to report
        "/sys/class/drm/card1/device/vendor": "0x1002\n",
        "/sys/class/drm/card1/device/mem_info_vram_total": "17163091968\n",
      },
    });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "amd", name: "AMD GPU (card1)", memoryBytes: 17163091968, unified: false, source: "sysfs" },
    ]);
    expect(hw.notes).toEqual([]);
  });

  it("ignores rocm-smi output it cannot read rather than inventing a card", () => {
    expect(parseRocmSmi("WARNING: AMD GPU device(s) is/are in a low-power state")).toEqual([]);
    expect(parseRocmSmi(JSON.stringify({ system: {} }))).toEqual([]);
  });
});

describe("probeHardware: macOS", () => {
  it("Apple Silicon: unified memory, sized by sysctl hw.memsize", async () => {
    const host = fakeHost({
      platform: "darwin",
      arch: "arm64",
      ramBytes: 1, // os.totalmem() is not what is trusted here
      commands: {
        sysctl: ok("68719476736\n"),
      },
    });
    // Two sysctl calls, distinguished by argument.
    host.run = async (cmd, args, timeoutMs) => {
      host.calls.push({ cmd, args, timeoutMs });
      if (cmd === "sysctl" && args.includes("hw.memsize")) return ok("68719476736\n");
      if (cmd === "sysctl" && args.includes("machdep.cpu.brand_string")) return ok("Apple M2 Max\n");
      return missing;
    };
    const hw = await probeHardware(host);
    expect(hw.ramBytes).toBe(64 * GiB);
    expect(hw.cpuModel).toBe("Apple M2 Max");
    expect(hw.gpus).toEqual([{ vendor: "apple", name: "Apple M2 Max GPU", unified: true, source: "sysctl" }]);
    // No NVIDIA or ROCm tooling exists on a Mac; do not spend a spawn on it.
    expect(host.calls.map((c) => c.cmd)).toEqual(["sysctl", "sysctl"]);
  });

  it("an Intel Mac: RAM, no GPU claim, and a note saying why", async () => {
    const host = fakeHost({ platform: "darwin", arch: "x64", commands: { sysctl: ok("17179869184\n") } });
    const hw = await probeHardware(host);
    expect(hw.ramBytes).toBe(16 * GiB);
    expect(hw.gpus).toEqual([]);
    expect(hw.notes).toEqual(["an Intel Mac: its GPU memory is not probed"]);
  });
});

describe("probeHardware: Windows", () => {
  it("nvidia-smi answers: no PowerShell is started", async () => {
    const host = fakeHost({
      platform: "win32",
      arch: "x64",
      commands: { "nvidia-smi": ok("NVIDIA GeForce RTX 5090, 32607 MiB\r\n") },
    });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 5090", memoryBytes: 32607 * 1024 * 1024, unified: false, source: "nvidia-smi" },
    ]);
    expect(host.calls.map((c) => c.cmd)).toEqual(["nvidia-smi"]);
  });

  it("no nvidia-smi: Win32_VideoController, where 4 GB is a ceiling and not a size", async () => {
    const wmi = JSON.stringify([
      { Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720 },
      { Name: "Intel(R) UHD Graphics 770", AdapterRAM: 1073741824 },
      { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
    ]);
    const host = fakeHost({ platform: "win32", arch: "x64", commands: { "powershell.exe": ok(wmi) } });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "amd", name: "AMD Radeon RX 7900 XTX", unified: false, source: "win32_videocontroller" },
      { vendor: "intel", name: "Intel(R) UHD Graphics 770", memoryBytes: GiB, unified: false, source: "win32_videocontroller" },
    ]);
    expect(hw.notes).toEqual(["Windows reports at most 4 GB for AMD Radeon RX 7900 XTX; its real memory is unknown"]);
    const ps = host.calls.find((c) => c.cmd === "powershell.exe")!;
    expect(ps.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    // Windows has no rocm-smi.
    expect(host.calls.map((c) => c.cmd)).not.toContain("rocm-smi");
  });

  it("one adapter is one JSON object, not an array", async () => {
    const host = fakeHost({
      platform: "win32",
      arch: "arm64",
      commands: { "powershell.exe": ok('{"Name":"Qualcomm(R) Adreno(TM) X1-85 GPU","AdapterRAM":536870912}') },
    });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([
      { vendor: "other", name: "Qualcomm(R) Adreno(TM) X1-85 GPU", memoryBytes: 512 * 1024 * 1024, unified: false, source: "win32_videocontroller" },
    ]);
  });

  it("no GPU tooling at all: an answer with no GPU and no notes", async () => {
    const host = fakeHost({ platform: "win32", arch: "x64" });
    const hw = await probeHardware(host);
    expect(hw.gpus).toEqual([]);
    expect(hw.notes).toEqual([]);
  });
});

describe("discoverRuntimes", () => {
  const ollamaTags = JSON.stringify({
    models: [
      { name: "qwen3.6:35b", details: { parameter_size: "36.0B", family: "qwen35moe" } },
      { name: "bge-m3:latest", details: { parameter_size: "566.70M", family: "bert" } },
    ],
  });
  const llamacppModels = JSON.stringify({
    object: "list",
    data: [{ id: "qwen3-coder", object: "model", owned_by: "llamacpp" }],
  });

  it("GETs only 127.0.0.1, only the four listing URLs", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64" });
    await discoverRuntimes(host);
    expect([...host.gets].sort()).toEqual(
      [
        "http://127.0.0.1:11434/api/tags",
        "http://127.0.0.1:1234/v1/models",
        "http://127.0.0.1:8080/v1/models",
        "http://127.0.0.1:8000/v1/models",
      ].sort()
    );
    expect(RUNTIME_PORTS.map((r) => r.port)).toEqual([11434, 1234, 8080, 8000]);
  });

  it("tells serving, absent and something-else-on-the-port apart", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "x64",
      urls: {
        "http://127.0.0.1:11434/api/tags": { status: 200, body: ollamaTags },
        "http://127.0.0.1:8080/v1/models": { status: 200, body: llamacppModels },
        "http://127.0.0.1:8000/v1/models": { status: 404, body: "<h1>Not Found</h1>" },
        "http://127.0.0.1:1234/v1/models": { error: "timeout" },
      },
    });
    const rts = await discoverRuntimes(host, 1500);
    const by = Object.fromEntries(rts.map((r) => [r.id, r]));
    expect(by.ollama).toMatchObject({ state: "serving", label: "Ollama", models: ["qwen3.6:35b", "bge-m3:latest"] });
    expect(by.llamacpp).toMatchObject({ state: "serving", label: "llama.cpp", models: ["qwen3-coder"] });
    expect(by.vllm).toMatchObject({ state: "no_listing", why: "answered 404" });
    expect(by.lmstudio).toMatchObject({ state: "no_listing", why: "no answer within 1.5 s" });
  });

  it("names the server a listing says served it, whatever port it is on", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "x64",
      urls: {
        "http://127.0.0.1:8080/v1/models": {
          status: 200,
          body: JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-32B", owned_by: "vllm" }] }),
        },
      },
    });
    const rt = (await discoverRuntimes(host)).find((r) => r.port === 8080)!;
    expect(rt).toMatchObject({ id: "llamacpp", label: "vLLM", state: "serving" });
  });

  it("an empty listing is a running server with no models, and a non-listing body is not a server", async () => {
    expect(parseListing('{"models":[]}')).toEqual({ models: [], ownedBy: undefined });
    expect(parseListing('{"object":"list","data":[]}')).toEqual({ models: [], ownedBy: undefined });
    expect(parseListing('{"status":"ok"}')).toBeUndefined();
    expect(parseListing("<html></html>")).toBeUndefined();
    // Newer llama.cpp sends both shapes for the same model; it is one model.
    expect(parseListing(JSON.stringify({ models: [{ name: "m", model: "m" }], data: [{ id: "m" }] }))?.models).toEqual(["m"]);
  });

  it("a get() that throws is a port that did not answer", async () => {
    const host = fakeHost({ platform: "linux", arch: "x64" });
    host.get = async () => {
      throw new Error("socket hang up");
    };
    const rts = await discoverRuntimes(host);
    expect(rts.every((r) => r.state === "no_listing")).toBe(true);
  });
});

describe("formatProbe", () => {
  it("the GB10 machine, as init prints it", async () => {
    const host = fakeHost({
      platform: "linux",
      arch: "arm64",
      ramBytes: 130596581376,
      cpuCount: 20,
      cpuModel: "unknown",
      commands: { "nvidia-smi": ok("NVIDIA GB10, [N/A]\n") },
      urls: {
        "http://127.0.0.1:11434/api/tags": { status: 200, body: JSON.stringify({ models: [{ name: "a" }, { name: "b" }] }) },
      },
    });
    const lines = formatProbe({ ...(await probeMachine(host)), tookMs: 120 });
    expect(lines).toEqual([
      "This machine: Linux arm64, 20 CPU cores, 121.6 GiB RAM",
      "  GPU: NVIDIA GB10, unified memory, shares the 121.6 GiB of RAM",
      "  Model servers: Ollama :11434 (2 models)",
      "  Not running: LM Studio :1234, llama.cpp :8080, vLLM :8000",
      "  Note: nvidia-smi reports no memory of its own for NVIDIA GB10: treated as unified memory shared with system RAM",
      "  (read-only probe, 120 ms; nothing was written)",
    ]);
  });

  it("a machine with nothing: says so plainly", async () => {
    const host = fakeHost({ platform: "win32", arch: "x64", ramBytes: 16 * GiB, cpuCount: 8, cpuModel: "Intel(R) Core(TM) i7-1165G7" });
    const lines = formatProbe({ ...(await probeMachine(host)), tookMs: 5 });
    expect(lines).toEqual([
      "This machine: Windows x64, 8 CPU cores (Intel(R) Core(TM) i7-1165G7), 16.0 GiB RAM",
      "  GPU: none found; local models would run on the CPU",
      "  Model servers: none running on this machine",
      "  (read-only probe, 5 ms; nothing was written)",
    ]);
  });

  it("formats bytes as GiB", () => {
    expect(gib(24 * GiB)).toBe("24.0 GiB");
    expect(gib(512 * 1024 * 1024)).toBe("0.5 GiB");
  });
});

describe("probeAtInit", () => {
  it("probes a fresh scaffold, not a copied surface and not a benchmark's --no-verify", () => {
    expect(probeAtInit({})).toBe(true);
    expect(probeAtInit({ from: "../other" })).toBe(false);
    expect(probeAtInit({ noVerify: true })).toBe(false);
  });
});

describe("systemHost: the real runner degrades instead of throwing", () => {
  it("a command that is not installed is ENOENT", async () => {
    const out = await systemHost().run("gnomon-probe-no-such-command", [], 2000);
    expect(out).toMatchObject({ code: null, error: "ENOENT" });
  });

  it("a command that hangs is killed at its deadline", async () => {
    const started = Date.now();
    const out = await systemHost().run(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 300);
    expect(out.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("a non-zero exit keeps its code and output", async () => {
    const out = await systemHost().run(process.execPath, ["-e", "process.stdout.write('no'); process.exit(3)"], 5000);
    expect(out).toMatchObject({ code: 3, stdout: "no" });
  });
});
