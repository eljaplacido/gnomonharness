/**
 * gnomon-cli: `gnomon doctor`, read-only, on fake machines.
 *
 * Surfaces are made by the real setup flow (with fakes), then the machine is
 * swapped under them. Readiness is a fake: no listing request leaves the test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";
import { runDoctor, formatDoctor, FINDING_KINDS, DOCTOR_EXIT, type DoctorDeps, type DoctorReport } from "./doctor.js";
import { runSetup, type SetupDeps } from "./setup_wizard.js";
import type { Readiness } from "./setup.js";
import { fakeHost, MACHINES, withUrls, ollamaServing, GiB, type FakeMachine } from "./test_support.js";

const catalog = loadCatalog();
const NOW = new Date("2026-11-03T12:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpProject = () => {
  const d = mkdtempSync(join(tmpdir(), "gnomon-doctor-"));
  roots.push(d);
  return d;
};

/** Every file under a directory with its bytes: what "doctor wrote nothing" is checked against. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
}

/** Set a project up with the real flow on `machine`, non-interactively. */
async function setUp(dir: string, machine: FakeMachine, extra: { cloud?: boolean } = {}) {
  const deps: SetupDeps = {
    host: fakeHost(machine),
    io: { interactive: false, say: () => {}, ask: async () => "", askSecret: async () => "" },
    catalog,
    now: () => NOW,
    pull: async () => ({ ok: true }),
    speedCheck: async () => ({ error: "not used", unreachable: false }),
    diskFree: () => ({}),
    keys: { held: () => false, store: () => {}, where: () => "/fake" },
    checkCloud: async () => ({ ok: true }),
    listCloudModels: async () => [],
    commands: [],
  };
  const r = await runSetup(
    { dir, json: true, yes: true, speedCheck: false, hybridControl: "observe", ...(extra.cloud ? { cloudEndpoint: "opencode-go" } : {}) },
    deps
  );
  expect(r.exit, r.why).toBe(0);
}

function doctorDeps(machine: FakeMachine, readiness: (role: string, model: string) => Readiness = () => ({ ready: true }), now = NOW): DoctorDeps {
  return {
    host: fakeHost(machine),
    catalog,
    now: () => now,
    readiness: async (config, role) => {
      const { routeRole } = await import("gnomon-core");
      return readiness(role, routeRole(config, role).target.model);
    },
  };
}

const rtx4090 = () => withUrls(MACHINES.gpu24(), ollamaServing({ "qwen3.6:35b": 23.9e9 }));
/** The same project, cloned onto an 8 GB card in a 16 GB box. */
const small8: FakeMachine = {
  platform: "linux",
  arch: "x64",
  ramBytes: 16 * GiB,
  commands: { "nvidia-smi": { code: 0, stdout: "NVIDIA GeForce RTX 4060, 8188 MiB\n", stderr: "" } },
  urls: ollamaServing({ "qwen3.6:35b": 23.9e9 }),
};

describe("gnomon doctor: drift from what setup saw", () => {
  it("setup saw 24 GB of VRAM, this machine has 8: exit 1, the drift named, not one byte written", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    const before = snapshot(dir);
    const { report, probe } = await runDoctor({ dir }, doctorDeps(small8));
    expect(report.exit).toBe(DOCTOR_EXIT.attention);
    const memory = report.findings.find((f) => f.kind === "memory")!;
    expect(memory.severity).toBe("problem");
    expect(memory.message).toMatch(/^setup saw 24\.0 GiB of GPU memory \(NVIDIA GeForce RTX 4090\); this machine has 8\.0 GiB of GPU memory \(NVIDIA GeForce RTX 4060\)$/);
    const fit = report.findings.find((f) => f.kind === "fit")!;
    expect(fit.message).toMatch(/^qwen3\.6:35b needs 24 GB of GPU memory, 64 GB of unified memory or 64 GB of RAM \(on the CPU\);.*it will not fit$/);
    expect(fit.fix).toMatch(/gnomon setup — recommends qwen3:8b here/);
    expect(report.findings.find((f) => f.kind === "gpu")?.severity).toBe("info");
    expect(snapshot(dir)).toEqual(before);
    const text = formatDoctor(report, probe).join("\n");
    expect(text).toContain("Summary: 2 things need attention.");
    expect(text).toContain("Doctor reads and reports; it never changes anything.");
  });

  it("the same machine as setup, every model answering: exit 0, nothing to do", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    const { report, probe } = await runDoctor({ dir }, doctorDeps(rtx4090()));
    expect(report.findings.filter((f) => f.severity === "problem")).toEqual([]);
    expect(report.exit).toBe(DOCTOR_EXIT.clear);
    expect(report.facts.found).toBe(true);
    expect(report.surface?.setup).toMatchObject({ local: "qwen3.6:35b", catalog: "2026-11" });
    expect(report.surface?.routes.every((r) => r.ready)).toBe(true);
    expect(formatDoctor(report, probe).join("\n")).toContain("Summary: nothing needs attention.");
  });

  it("a surface set up elsewhere, with no facts here: said, not a problem", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    rmSync(join(dir, ".gnomon-setup.json"));
    const { report } = await runDoctor({ dir }, doctorDeps(rtx4090()));
    expect(report.exit).toBe(DOCTOR_EXIT.clear);
    expect(report.findings.find((f) => f.kind === "facts")).toMatchObject({
      severity: "info",
      message: expect.stringContaining("set up elsewhere (catalog 2026-11)"),
    });
  });
});

describe("gnomon doctor: readiness, with the command that fixes each", () => {
  it("a model the server does not serve: ollama pull", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    const { report } = await runDoctor(
      { dir },
      doctorDeps(rtx4090(), (_role, model) => ({ ready: false, why: `"local" (127.0.0.1:11434) does not serve "${model}"` }))
    );
    expect(report.exit).toBe(DOCTOR_EXIT.attention);
    const f = report.findings.find((x) => x.kind === "readiness")!;
    expect(f.message).toContain("qwen3.6:35b");
    expect(f.fix).toMatch(/^ollama pull qwen3\.6:35b/);
    expect(report.next[0]).toMatch(/^ollama pull qwen3\.6:35b/);
  });

  it("nothing listening: start Ollama", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    const { report } = await runDoctor({ dir }, doctorDeps(rtx4090(), () => ({ ready: false, why: "nothing is listening on 127.0.0.1:11434" })));
    expect(report.findings.find((x) => x.kind === "readiness")?.fix).toMatch(/ollama serve/);
  });

  it("a cloud key that is not set: gnomon key set <endpoint>", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090(), { cloud: true });
    const { report } = await runDoctor(
      { dir },
      doctorDeps(rtx4090(), (role) =>
        role === "coordinator" || role === "plan" ? { ready: false, why: `"go" (opencode.ai:443) needs $OPENCODE_API_KEY, and it is not set` } : { ready: true }
      )
    );
    const f = report.findings.find((x) => x.kind === "readiness")!;
    expect(f.message).toMatch(/^(coordinator, plan|plan, coordinator) → deepseek-v4\.1-flash/);
    expect(f.fix).toBe("gnomon key set go");
    expect(report.surface?.routes.find((r) => r.model === "deepseek-v4.1-flash")?.local).toBe(false);
  });
});

describe("gnomon doctor: no surface, and a stale catalog", () => {
  it("no .gnomon/: exit 1, setup suggested, nothing created", async () => {
    const dir = tmpProject();
    const { report } = await runDoctor({ dir }, doctorDeps(rtx4090()));
    expect(report.exit).toBe(DOCTOR_EXIT.attention);
    expect(report.surface).toBeNull();
    expect(report.next[0]).toMatch(/^gnomon setup/);
    expect(report.recommended).toBe("qwen3.6:35b");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a catalog past its 180 days is noted, and is not a problem", async () => {
    const dir = tmpProject();
    await setUp(dir, rtx4090());
    const late = new Date(Date.parse("2026-11-03T00:00:00Z") + 200 * 86_400_000);
    const { report } = await runDoctor({ dir }, doctorDeps(rtx4090(), () => ({ ready: true }), late));
    expect(report.findings.find((f) => f.kind === "catalog")?.message).toMatch(/newer models likely exist/);
    expect(report.exit).toBe(DOCTOR_EXIT.clear);
  });
});

describe("the --json document (schema gnomon.doctor/1)", () => {
  const fixture = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "doctor_report.json"), "utf-8")
  ) as {
    report_keys: { required: string[]; optional: string[] };
    finding_keys: { required: string[]; optional: string[] };
    finding_kinds: string[];
    severities: string[];
    exit_codes: Record<string, string>;
  };
  const check = (r: DoctorReport) => {
    const keys = Object.keys(r).sort();
    expect(keys).toEqual([...fixture.report_keys.required, ...fixture.report_keys.optional].sort());
    for (const f of r.findings) {
      for (const k of fixture.finding_keys.required) expect(Object.keys(f)).toContain(k);
      for (const k of Object.keys(f)) expect([...fixture.finding_keys.required, ...fixture.finding_keys.optional]).toContain(k);
      expect(fixture.finding_kinds).toContain(f.kind);
      expect(fixture.severities).toContain(f.severity);
    }
    expect(Object.keys(fixture.exit_codes)).toContain(String(r.exit));
    JSON.parse(JSON.stringify(r));
  };

  it("drift, clear and no-surface reports all match the published keys", async () => {
    const a = tmpProject();
    await setUp(a, rtx4090());
    check((await runDoctor({ dir: a }, doctorDeps(small8))).report);
    check((await runDoctor({ dir: a }, doctorDeps(rtx4090()))).report);
    check((await runDoctor({ dir: tmpProject() }, doctorDeps(rtx4090()))).report);
  });

  it("the published value sets are the code's", () => {
    expect(fixture.finding_kinds).toEqual([...FINDING_KINDS]);
    expect(Object.keys(fixture.exit_codes).map(Number)).toEqual(Object.values(DOCTOR_EXIT));
  });
});
