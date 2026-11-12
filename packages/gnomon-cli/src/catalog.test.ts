/**
 * gnomon-cli: the model catalog and the recommendation, over synthetic machines.
 *
 * Every machine is a fake host (test_support.ts) fed what the real tools
 * print. Pure functions: no network, no model, no file but the catalog.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  loadCatalog,
  parseCatalog,
  defaultCatalogPath,
  machineMemory,
  recommend,
  suggestMode,
  formatRecommendation,
  catalogEntryFor,
  staleLine,
  starterModels,
  PROFILE_FOR,
  SUGGESTIONS,
} from "./catalog.js";
import { probeMachine, probeHardware } from "./probe.js";
import { fakeHost, MACHINES, withUrls, ollamaServing, LLAMACPP_MODELS, GiB, type FakeMachine } from "./test_support.js";

const catalog = loadCatalog();
const NOW = new Date("2026-11-03T12:00:00Z");
const probeOf = (m: FakeMachine) => probeMachine(fakeHost(m));
const recFor = async (m: FakeMachine, now = NOW) => recommend(await probeOf(m), catalog, { now });

describe("the shipped catalog", () => {
  it("parses, is dated 2026-11, and lists its models best first", () => {
    expect(catalog.asOf).toBe("2026-11-03");
    expect(catalog.label).toBe("2026-11");
    expect(catalog.models[0]!.tag).toBe("qwen3.6:35b");
    expect(catalog.models.map((m) => m.tier)).toEqual(["large", "medium", "medium", "small", "tiny"]);
  });

  it("the default is Qwen3.6-35B-A3B at Q4 for 24 GB of VRAM or 64 GB of unified memory", () => {
    const q = catalog.models[0]!;
    expect(q.name).toBe("Qwen3.6-35B-A3B");
    expect(q.quant).toBe("Q4");
    expect(q.minVramGb).toBe(24);
    expect(q.minUnifiedGb).toBe(64);
  });

  it("only gnomon's own measurements are called measured, and each names its run", () => {
    const measured = catalog.models.filter((m) => m.measured).map((m) => m.tag);
    expect(measured).toEqual(["qwen3.6:35b"]);
    // R1H on the RTX 5090 and R1 on the GB10 (benchmarks/results/{r1h,r1}-2026-11/summary.txt).
    const rows = catalog.measured.map((r) => [r.machine, r.solved, r.of, r.genTps]);
    expect(rows).toEqual([
      ["RTX 5090", 24, 32, 375],
      ["NVIDIA GB10 (DGX Spark)", 18, 32, 66],
    ]);
    for (const r of catalog.measured) expect(r.run).toMatch(/^R1H?, 2026-11/);
  });

  it("says when a model was not measured by gnomon", async () => {
    const lines = formatRecommendation(await recFor(MACHINES.mac16()));
    expect(lines.find((l) => l.includes("qwen3:8b"))).toContain("not measured by gnomon");
    expect(lines.join("\n")).not.toMatch(/qwen3\.6:35b[^\n]*not measured/);
  });

  it("labels its speed thresholds provisional, and cites hybrid as HYBRID.md does", () => {
    expect(catalog.speed.provisional).toBe(true);
    // R1H's RTX 5090 lead (87% vs 84%, 26% cheaper) did not reproduce (R3R, R4H):
    // the catalog must not quote it as current.
    expect(catalog.hybrid.evidence).toContain("no measured advantage over cloud-only");
    expect(catalog.hybrid.evidence).toContain("did not reproduce");
    expect(catalog.hybrid.evidence).not.toMatch(/87%|84%|26% lower cost/);
    expect(catalog.hybrid.evidenceUnified).toContain("22/32 vs 16/31 local-only");
    // The file says so in words, where a reviewer reads it.
    expect(readFileSync(defaultCatalogPath(), "utf-8")).toMatch(/PROVISIONAL/);
  });

  it("maps every suggestion onto a role_profile that is already a published enumeration", () => {
    expect(SUGGESTIONS.map((s) => PROFILE_FOR[s])).toEqual(["local_first", "frontier_plan", "all_remote"]);
  });
});

describe("a catalog that is wrong is refused, by name", () => {
  const base = readFileSync(defaultCatalogPath(), "utf-8");
  it("a model with no memory threshold", () => {
    const bad = base.replace(/min_vram_gb = 4\nmin_unified_gb = 8\nmin_cpu_ram_gb = 8\n/, "");
    expect(() => parseCatalog(bad, "x.toml")).toThrow(/qwen3:4b.*needs at least one of min_vram_gb/);
  });
  it("measured = true with no measurement behind it", () => {
    const bad = base.replace(/tag = "qwen3:8b"([\s\S]*?)measured = false/, 'tag = "qwen3:8b"$1measured = true');
    expect(() => parseCatalog(bad, "x.toml")).toThrow(/qwen3:8b: measured = true but no \[\[measured\]\] row/);
  });
  it("an unknown tier, a missing date, a model listed twice", () => {
    expect(() => parseCatalog(base.replace('tier = "tiny"', 'tier = "huge"'), "x.toml")).toThrow(/tier must be one of/);
    expect(() => parseCatalog(base.replace('as_of = "2026-11-03"', 'as_of = "soon"'), "x.toml")).toThrow(/as_of: must be a date/);
    expect(() => parseCatalog(base.replace('tag = "qwen3:14b"', 'tag = "qwen3:8b"'), "x.toml")).toThrow(/listed twice/);
  });
  it("a file that cannot be read names the file", () => {
    expect(() => loadCatalog("/nonexistent/models.toml")).toThrow(/catalog \/nonexistent\/models\.toml: cannot be read/);
  });
});

describe("what bounds a model on each machine", () => {
  it("GB10: unified, the whole RAM", async () => {
    const m = machineMemory((await probeOf(MACHINES.gb10())).hardware);
    expect(m.kind).toBe("unified");
    expect(m.gib).toBeCloseTo(121.6, 1);
  });
  it("Apple Silicon: unified", async () => {
    const m = machineMemory((await probeOf(MACHINES.mac16())).hardware);
    expect(m).toMatchObject({ kind: "unified", gib: 16 });
  });
  it("discrete GPUs add up, and system RAM is kept for the spill", async () => {
    const two: FakeMachine = {
      platform: "linux",
      arch: "x64",
      ramBytes: 128 * GiB,
      commands: { "nvidia-smi": { code: 0, stdout: "NVIDIA GeForce RTX 3090, 24576 MiB\nNVIDIA GeForce RTX 3090, 24576 MiB\n", stderr: "" } },
    };
    const m = machineMemory((await probeOf(two)).hardware);
    expect(m).toMatchObject({ kind: "vram", gib: 48, ramGib: 128 });
    expect(m.label).toContain("2 GPUs");
  });
  it("a GPU whose memory Windows will not say is sized as the CPU, and says why", async () => {
    const win: FakeMachine = {
      platform: "win32",
      arch: "x64",
      ramBytes: 32 * GiB,
      commands: {
        "powershell.exe": { code: 0, stdout: JSON.stringify({ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720 }), stderr: "" },
      },
    };
    const m = machineMemory((await probeOf(win)).hardware);
    expect(m.kind).toBe("cpu");
    expect(m.notes.join(" ")).toMatch(/AMD Radeon RX 7900 XTX's memory is unknown/);
  });
  it("no GPU: the CPU", async () => {
    expect(machineMemory((await probeOf(MACHINES.laptop8())).hardware).kind).toBe("cpu");
  });
});

describe("the recommendation, per machine", () => {
  it("an 8 GB laptop gets the 4B model, on the CPU, and cloud first", async () => {
    const rec = await recFor(MACHINES.laptop8());
    expect(rec.top?.tag).toBe("qwen3:4b");
    expect(rec.top?.installed).toBe(false);
    expect(rec.why.join(" ")).toMatch(/on the CPU: slow/);
    const mode = suggestMode({ local: rec.top, memory: rec.memory, hasCloud: false }, catalog);
    expect(mode.mode).toBe("cloud_first");
  });

  it("a 16 GB Mac gets an 8B model, and hybrid is suggested", async () => {
    const rec = await recFor(MACHINES.mac16());
    expect(rec.top?.tag).toBe("qwen3:8b");
    expect(rec.top?.fit).toBe("fits");
    expect(rec.options.some((o) => o.tag === "qwen3.6:35b")).toBe(false);
    const mode = suggestMode({ local: rec.top, memory: rec.memory, hasCloud: false }, catalog);
    expect(mode).toMatchObject({ mode: "hybrid", needsCloud: true });
  });

  it("a 24 GB GPU gets qwen3.6:35b, and is told a few layers may spill", async () => {
    const rec = await recFor(MACHINES.gpu24());
    expect(rec.top?.tag).toBe("qwen3.6:35b");
    expect(rec.top?.fit).toBe("fits");
    expect(rec.top?.downloadGb).toBe(23.9);
    expect(rec.why.join(" ")).toMatch(/24 GB card a few layers may spill/);
  });

  it("a 32 GB GPU gets qwen3.6:35b, with the RTX 5090 measurement as the reason", async () => {
    const rec = await recFor(MACHINES.gpu32());
    expect(rec.top?.tag).toBe("qwen3.6:35b");
    const why = rec.why.join(" ");
    expect(why).toContain("RTX 5090");
    expect(why).toContain("solved 24 of 32 tasks working alone (75%)");
    expect(why).toContain("~375 tok/s");
  });

  it("128 GB of unified memory gets qwen3.6:35b, with the GB10 measurement and no GPU-card note", async () => {
    const rec = await recFor(MACHINES.gb10());
    expect(rec.top?.tag).toBe("qwen3.6:35b");
    const why = rec.why.join(" ");
    expect(why).toContain("NVIDIA GB10");
    expect(why).toContain("solved 18 of 32");
    expect(why).not.toContain("24 GB card");
  });

  it("GB10 with qwen3.6:35b installed: the installed model, no pull", async () => {
    const rec = await recFor(withUrls(MACHINES.gb10(), ollamaServing({ "qwen3.6:35b": 23.9e9, "bge-m3:latest": 1.2e9 })));
    expect(rec.top).toMatchObject({ tag: "qwen3.6:35b", installed: true, runtime: "ollama" });
    expect(rec.top?.downloadGb).toBeUndefined();
    expect(rec.bestInstalled?.tag).toBe("qwen3.6:35b");
    // An embedding model is never offered.
    expect(rec.options.some((o) => o.tag.startsWith("bge-m3"))).toBe(false);
  });

  it("a small installed model does not displace the best one; it is the no-download alternative", async () => {
    const rec = await recFor(withUrls(MACHINES.gpu32(), ollamaServing({ "qwen3:8b": 5.2e9, "qwen2.5:14b-instruct": 9e9 })));
    expect(rec.top).toMatchObject({ tag: "qwen3.6:35b", installed: false });
    expect(rec.bestInstalled?.tag).toBe("qwen3:8b");
    const unknown = rec.options.find((o) => o.tag === "qwen2.5:14b-instruct")!;
    expect(unknown).toMatchObject({ installed: true, verified: false, fit: "fits" });
    expect(unknown.status).toContain("not verified by gnomon");
  });

  it("recognises the catalog model on llama.cpp by the name its server lists", async () => {
    const llama = { [LLAMACPP_MODELS]: { status: 200, body: JSON.stringify({ data: [{ id: "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf", owned_by: "llamacpp" }] }) } };
    const rec = await recFor(withUrls(MACHINES.gpu32(), llama));
    expect(rec.top).toMatchObject({ tag: "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf", runtime: "llamacpp", installed: true });
    expect(rec.top?.entry?.tag).toBe("qwen3.6:35b");
    expect(catalogEntryFor("qwen3.6-35b", "vllm", catalog)?.tag).toBe("qwen3.6:35b");
    expect(catalogEntryFor("qwen3:latest", "ollama", catalog)?.tag).toBe("qwen3:8b");
  });

  it("an 8 GB card in a 64 GB desktop: the 8B fits, the 35B runs partly on the CPU", async () => {
    const rec = await recFor(MACHINES.gpu8ram64());
    expect(rec.top?.tag).toBe("qwen3:8b");
    const big = rec.options.find((o) => o.tag === "qwen3.6:35b")!;
    expect(big.fit).toBe("tight");
    expect(big.fitWhy).toMatch(/partly on the CPU, slower/);
  });

  it("a machine nothing fits: no recommendation, and cloud first", async () => {
    const rec = await recFor(MACHINES.tiny4());
    expect(rec.top).toBeUndefined();
    expect(rec.notes.join(" ")).toMatch(/start with a cloud model/);
    expect(suggestMode({ memory: rec.memory, hasCloud: false }, catalog).mode).toBe("cloud_first");
  });
});

describe("what `gnomon init` writes when no model server answered", () => {
  // Not the generic qwen2.5 placeholders, which nothing on the machine serves
  // and `gnomon doctor` flags: the tag `gnomon setup` would recommend, so one
  // `gnomon setup --pull <tag>` makes every role answer.
  it("the catalog's pick for the machine, for every role, with its provenance", async () => {
    const s = starterModels(await probeOf(MACHINES.gb10()), catalog, { now: NOW })!;
    expect(s).toMatchObject({ large: "qwen3.6:35b", small: "qwen3.6:35b", catalogLabel: catalog.label, downloadGb: 23.9 });
    expect(s.note.split("\n").every((l) => l.startsWith("# "))).toBe(true);
    expect(s.note).toContain("gnomon setup");
    expect(s.note).toContain("not yet");
    expect(starterModels(await probeOf(MACHINES.mac16()), catalog, { now: NOW })?.large).toBe("qwen3:8b");
  });

  it("nothing when nothing in the catalog runs here: the placeholders stay", async () => {
    expect(starterModels(await probeOf(MACHINES.tiny4()), catalog, { now: NOW })).toBeUndefined();
  });

  it("nothing when the pick is already installed: detection, not a starter tag, decides that case", async () => {
    const probe = await probeOf(withUrls(MACHINES.gb10(), ollamaServing({ "qwen3.6:35b": 23.9e9 })));
    expect(starterModels(probe, catalog, { now: NOW })).toBeUndefined();
  });
});

describe("staleness is said, never fetched", () => {
  it("a catalog more than 180 days old says newer models likely exist", async () => {
    const late = new Date(Date.parse("2026-11-03T00:00:00Z") + 181 * 86_400_000);
    const rec = await recFor(MACHINES.gpu32(), late);
    expect(rec.catalog.stale).toMatch(/catalog from 2026-11-03 \(181 days old\) — newer models likely exist/);
    expect(rec.notes.join(" ")).toContain("--catalog FILE");
    expect(staleLine(catalog, new Date(Date.parse("2026-11-03T00:00:00Z") + 180 * 86_400_000))).toBeUndefined();
  });
});

describe("the mode it suggests", () => {
  const speed = (genTps: number, prefillTps: number) => ({ model: "m", runtime: "ollama" as const, genTps, prefillTps, source: "server" as const, wallMs: 1000 });
  const local = async () => (await recFor(withUrls(MACHINES.gpu32(), ollamaServing({ "qwen3.6:35b": 23.9e9 })))).top!;
  const mem = async () => (await recFor(MACHINES.gpu32())).memory;

  it("fast and no cloud model: local only", async () => {
    const s = suggestMode({ local: await local(), memory: await mem(), speed: speed(375, 4000), hasCloud: false }, catalog);
    expect(s).toMatchObject({ mode: "local_only", needsCloud: false, provisional: true });
  });
  it("a cloud model configured: hybrid, citing the measured result", async () => {
    const s = suggestMode({ local: await local(), memory: await mem(), speed: speed(375, 4000), hasCloud: true }, catalog);
    expect(s.mode).toBe("hybrid");
    expect(s.why).toContain("showed no measured advantage over cloud-only");
    expect(s.why).not.toContain("87%");
  });
  it("on unified memory, the GB10 result is cited beside it", async () => {
    const rec = await recFor(withUrls(MACHINES.gb10(), ollamaServing({ "qwen3.6:35b": 23.9e9 })));
    const s = suggestMode({ local: rec.top, memory: rec.memory, hasCloud: true }, catalog);
    expect(s.why).toContain("NVIDIA GB10");
  });
  it("usable but slow: hybrid, on the provisional threshold", async () => {
    const s = suggestMode({ local: await local(), memory: await mem(), speed: speed(20, 3000), hasCloud: false }, catalog);
    expect(s).toMatchObject({ mode: "hybrid", provisional: true, needsCloud: true });
  });
  it("too slow for a task: cloud first", async () => {
    const s = suggestMode({ local: await local(), memory: await mem(), speed: speed(5, 200), hasCloud: false }, catalog);
    expect(s.mode).toBe("cloud_first");
    expect(s.why).toMatch(/below the provisional 10 tok\/s floor/);
  });
});

describe("parity: the same hardware is the same recommendation on every OS", () => {
  it("an RTX 5090 on Linux and on Windows", async () => {
    const linux = await recFor(MACHINES.gpu32("linux"));
    const windows = await recFor(MACHINES.gpu32("win32"));
    const shape = (r: typeof linux) => r.options.map((o) => [o.tag, o.fit, o.status]);
    expect(shape(windows)).toEqual(shape(linux));
    expect(windows.memory.gib).toBe(linux.memory.gib);
  });
  it("64 GB of unified memory on a Mac and on a GB10-class Linux box agree", async () => {
    const mac = recommend({ hardware: await probeHardware(fakeHost({ ...MACHINES.mac16(), ramBytes: 64 * GiB, commands: { "sysctl -n hw.memsize": { code: 0, stdout: String(64 * GiB), stderr: "" } } })), runtimes: [], tookMs: 0 }, catalog, { now: NOW });
    const spark = recommend({ hardware: await probeHardware(fakeHost({ ...MACHINES.gb10(), ramBytes: 64 * GiB })), runtimes: [], tookMs: 0 }, catalog, { now: NOW });
    expect(mac.options.map((o) => o.tag)).toEqual(spark.options.map((o) => o.tag));
    expect(mac.top?.tag).toBe("qwen3.6:35b");
  });
});
