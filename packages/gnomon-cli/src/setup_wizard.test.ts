/**
 * gnomon-cli: `gnomon setup`, every path, with a fake machine, a fake Ollama
 * that counts pulls, a fake speed check and a scripted person.
 *
 * No test here reaches a network, a model server or the real key store: the
 * pull, the speed check, the cloud check and the keys are all SetupDeps.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, routeRole, recomputeManifest, evaluateTrust } from "gnomon-core";
import { loadCatalog, type SpeedResult } from "./catalog.js";
import { initSurface } from "./init.js";
import {
  runSetup,
  resolveCloudEndpoint,
  SETUP_FACTS_FILE,
  SETUP_EXIT,
  HYBRID_CONTROLS,
  type SetupDeps,
  type SetupOptions,
  type SpeedRequest,
  type SetupReport,
} from "./setup_wizard.js";
import { readProvenance } from "./setup_surface.js";
import { fakeHost, MACHINES, withUrls, ollamaServing, type FakeMachine } from "./test_support.js";

const catalog = loadCatalog();
const NOW = new Date("2026-11-03T12:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpProject = () => {
  const d = mkdtempSync(join(tmpdir(), "gnomon-setup-"));
  roots.push(d);
  return d;
};

const fast = (req: SpeedRequest): SpeedResult => ({
  model: req.model,
  runtime: req.runtime,
  genTps: 180,
  prefillTps: 3900,
  loadS: 4.1,
  promptTokens: 1800,
  outputTokens: 2,
  source: "server",
  wallMs: 5000,
});

/**
 * A run of setup against a fake machine. `answers` scripts the person: each
 * question takes the next answer ("" is Enter); running out fails the test,
 * so an unexpected question is a failure, not a hang.
 */
function harness(machine: FakeMachine, answers?: string[], over: Partial<SetupDeps> = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const pulls: string[] = [];
  const speeds: SpeedRequest[] = [];
  const cloudChecks: string[] = [];
  const stored: Record<string, string> = {};
  const script = [...(answers ?? [])];
  const secrets: string[] = [];
  const deps: SetupDeps = {
    host: fakeHost(machine),
    io: {
      interactive: answers !== undefined,
      say: (l = "") => said.push(l),
      ask: async (q, fallback = "") => {
        asked.push(q);
        const a = script.shift();
        if (a === undefined) throw new Error(`unscripted question: ${q}`);
        return a.trim() || fallback;
      },
      askSecret: async (q) => {
        asked.push(q);
        return secrets.shift() ?? "";
      },
    },
    catalog,
    now: () => NOW,
    pull: async (tag, onProgress) => {
      pulls.push(tag);
      onProgress({ status: "pulling manifest" });
      onProgress({ status: "pulling 4a1b", completed: 5, total: 10 });
      onProgress({ status: "success" });
      return { ok: true };
    },
    speedCheck: async (req) => {
      speeds.push(req);
      return fast(req);
    },
    diskFree: () => ({ path: "/fake/.ollama/models", bytes: 500e9 }),
    keys: {
      held: (v) => v in stored,
      store: (v, value) => {
        stored[v] = value;
      },
      where: () => "/fake/gnomon/credentials.json",
    },
    checkCloud: async (_ep, model) => {
      cloudChecks.push(model);
      return { ok: true };
    },
    listCloudModels: async () => [],
    commands: ["launch", "setup", "doctor"],
    ...over,
  };
  return { deps, said, asked, pulls, speeds, cloudChecks, stored, secrets, script };
}

const opts = (dir: string, o: Partial<SetupOptions> = {}): SetupOptions => ({
  dir,
  json: false,
  yes: false,
  speedCheck: false,
  hybridControl: "observe",
  ...o,
});

const gb10Ollama = (models: Record<string, number> = {}) => withUrls(MACHINES.gb10(), ollamaServing(models));
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

// ---------------------------------------------------------------------------
// Consent: nothing is downloaded, written or spent without a yes
// ---------------------------------------------------------------------------

describe("downloads happen only when a person or --pull names the model", () => {
  it("off a terminal with nothing installed: zero pulls, exit 4, nothing written, the exact command printed", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama());
    const r = await runSetup(opts(dir), h.deps);
    expect(h.pulls).toEqual([]);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(listing(dir)).toEqual([]);
    expect(r.why).toContain("gnomon setup --pull qwen3.6:35b");
  });

  it("--yes alone never downloads", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama());
    const r = await runSetup(opts(dir, { yes: true }), h.deps);
    expect(h.pulls).toEqual([]);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(listing(dir)).toEqual([]);
  });

  it("--pull TAG with --yes: exactly one pull, then the surface is written", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama());
    const r = await runSetup(opts(dir, { pull: "qwen3.6:35b", yes: true }), h.deps);
    expect(h.pulls).toEqual(["qwen3.6:35b"]);
    expect(r.exit, r.why).toBe(SETUP_EXIT.written);
    expect(r.pull).toMatchObject({ tag: "qwen3.6:35b", status: "pulled", command: "ollama pull qwen3.6:35b" });
    expect(routeRole(loadConfig(dir), "implement").target.model).toBe("qwen3.6:35b");
    // No speed check without --speed-check.
    expect(h.speeds).toEqual([]);
    expect(r.speed).toEqual({ skipped: true });
  });

  it("--pull without --yes downloads, then stops at the proposal", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama());
    const r = await runSetup(opts(dir, { pull: "qwen3.6:35b" }), h.deps);
    expect(h.pulls).toEqual(["qwen3.6:35b"]);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(r.proposal?.applied).toBe(false);
    expect(listing(dir)).toEqual([]);
  });

  it("with Ollama not running there is nothing to pull with: zero pulls, exit 4, how to get it", async () => {
    const dir = tmpProject();
    const h = harness(MACHINES.gb10());
    const r = await runSetup(opts(dir, { pull: "qwen3.6:35b", yes: true }), h.deps);
    expect(h.pulls).toEqual([]);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(r.pull?.status).toBe("no_runtime");
    const text = h.said.join("\n");
    expect(text).toContain("https://ollama.com/download");
    expect(text).toContain("ollama pull qwen3.6:35b");
    // llama.cpp manages its own files: the instruction, never a download.
    expect(text).toMatch(/With llama\.cpp instead[^\n]*llama-server -m <file>\.gguf --jinja/);
  });

  it("a pull whose server stops answering exits 12 and writes nothing", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama(), undefined, { pull: async () => ({ ok: false, error: "ECONNREFUSED", unreachable: true }) });
    const r = await runSetup(opts(dir, { pull: "qwen3.6:35b", yes: true }), h.deps);
    expect(r.exit).toBe(SETUP_EXIT.runtimeStopped);
    expect(listing(dir)).toEqual([]);
  });

  it("a person who says no to the download is not downloaded for", async () => {
    const dir = tmpProject();
    // Enter = the recommendation (a download); "n" to the pull; then nothing
    // installed and no cloud model: setup stops before the write.
    const h = harness(gb10Ollama(), ["", "n", ""]);
    const r = await runSetup(opts(dir), h.deps);
    expect(h.pulls).toEqual([]);
    expect(h.asked.find((q) => q.includes("Pull it now?"))).toContain("[y/N]");
    expect(h.asked.find((q) => q.includes("Pull it now?"))).toContain("~23.9 GB");
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(listing(dir)).toEqual([]);
  });
});

describe("the speed check runs only on a yes", () => {
  it("off a terminal without --speed-check: no request", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    await runSetup(opts(tmpProject()), h.deps);
    expect(h.speeds).toEqual([]);
  });

  it("a person who answers n: no request", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), ["", "n", "", "", "n"]);
    await runSetup(opts(tmpProject()), h.deps);
    expect(h.speeds).toEqual([]);
  });

  it("--speed-check sends one request with the project's system prompt, and its rates are reported", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    const r = await runSetup(opts(tmpProject(), { speedCheck: true }), h.deps);
    expect(h.speeds).toHaveLength(1);
    expect(h.speeds[0]).toMatchObject({ runtime: "ollama", chatUrl: "http://127.0.0.1:11434/api/chat", model: "qwen3.6:35b" });
    expect(h.speeds[0]!.system).toContain("deterministic coding agent");
    expect(r.speed).toMatchObject({ genTps: 180, prefillTps: 3900, source: "server" });
    expect(h.said.join("\n")).toContain("generation 180.0 tok/s");
  });

  it("fast: local only; usable but slow: hybrid; too slow: cloud first (suggested, not forced)", async () => {
    const at = async (genTps: number, prefillTps: number) => {
      const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), undefined, {
        speedCheck: async (req) => ({ ...fast(req), genTps, prefillTps }),
      });
      return (await runSetup(opts(tmpProject(), { speedCheck: true }), h.deps)).mode!;
    };
    expect((await at(180, 3900)).suggested).toBe("local_only");
    const slow = await at(20, 3000);
    expect(slow.suggested).toBe("hybrid");
    expect(slow.provisional).toBe(true);
    // Hybrid and cloud first need a cloud model; with none given, setup says
    // so and keeps the machine local rather than writing a dead route.
    expect(slow.chosen).toBe("local_only");
    expect((await at(5, 200)).suggested).toBe("cloud_first");
  });

  it("a speed check whose server stops answering exits 12, nothing written", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), undefined, {
      speedCheck: async () => ({ error: "ECONNREFUSED", unreachable: true }),
    });
    const r = await runSetup(opts(dir, { speedCheck: true, yes: true }), h.deps);
    expect(r.exit).toBe(SETUP_EXIT.runtimeStopped);
    expect(listing(dir)).toEqual([]);
  });
});

describe("the surface is written only after a yes, as a diff", () => {
  it("off a terminal without --yes: the proposal and exit 4; the surface bytes do not move", async () => {
    const dir = tmpProject();
    await initSurface({ dir, models: { large: "placeholder:1b", small: "placeholder:1b", detected: [] } });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    const r = await runSetup(opts(dir), h.deps);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(r.proposal?.applied).toBe(false);
    expect(r.proposal?.files.map((f) => f.path).sort()).toEqual(["profiles/local_first.toml", "roles.toml"]);
    expect(r.proposal?.files.find((f) => f.path === "roles.toml")!.diff).toContain('+ model = "qwen3.6:35b"');
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).toBe(before);
    expect(existsSync(join(dir, SETUP_FACTS_FILE))).toBe(false);
  });

  it("with --yes: written, the hash moves, and the facts file is gitignored", async () => {
    const dir = tmpProject();
    await initSurface({ dir, models: { large: "placeholder:1b", small: "placeholder:1b", detected: [] } });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    const r = await runSetup(opts(dir, { yes: true }), h.deps);
    expect(r.exit, r.why).toBe(SETUP_EXIT.written);
    expect(r.surface_hash).toEqual({ before, after: recomputeManifest(join(dir, ".gnomon")).surface_hash });
    expect(r.surface_hash?.after).not.toBe(before);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toMatch(/^\.gnomon-setup\.json$/m);
    const config = loadConfig(dir);
    expect(routeRole(config, "implementor").target.model).toBe("qwen3.6:35b");
  });

  it("hardware facts go to the gitignored file, never into the committed surface", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    await runSetup(opts(dir, { yes: true }), h.deps);
    const facts = JSON.parse(readFileSync(join(dir, SETUP_FACTS_FILE), "utf-8"));
    expect(facts.schema).toBe("gnomon.setup-facts/1");
    expect(facts.machine.gpus[0].name).toBe("NVIDIA GB10");
    expect(facts.memory.kind).toBe("unified");
    const roles = readFileSync(join(dir, ".gnomon", "roles.toml"), "utf-8");
    expect(roles).not.toMatch(/GB10|GiB|arm64/);
    expect(readProvenance(roles)).toMatchObject({ catalog: "2026-11", local: "qwen3.6:35b", mode: "local_only" });
  });

  it("a person who declines the write gets nothing written", async () => {
    const dir = tmpProject();
    // choose Enter (installed), speed n, cloud Enter (not now), mode Enter, write n
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), ["", "n", "", "", "n"]);
    const r = await runSetup(opts(dir), h.deps);
    expect(h.asked.at(-1)).toContain("Write this? [y/N]");
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(listing(dir)).toEqual([]);
  });

  it("a surface edited while setup was waiting is not overwritten (exit 3)", async () => {
    const dir = tmpProject();
    await initSurface({ dir, models: { large: "placeholder:1b", small: "placeholder:1b", detected: [] } });
    const rolesPath = join(dir, ".gnomon", "roles.toml");
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), ["", "n", "", ""]);
    const ask = h.deps.io.ask;
    h.deps.io.ask = async (q, f) => {
      if (q.includes("Write this?")) {
        writeFileSync(rolesPath, readFileSync(rolesPath, "utf-8") + "\n# edited meanwhile\n");
        return "y";
      }
      return ask(q, f);
    };
    const r = await runSetup(opts(dir), h.deps);
    expect(r.exit).toBe(SETUP_EXIT.surfaceMoved);
    expect(readFileSync(rolesPath, "utf-8")).toContain("# edited meanwhile");
    expect(readFileSync(rolesPath, "utf-8")).not.toContain("qwen3.6:35b");
  });
});

describe("--expect-proposal: only the change that was reviewed is written", () => {
  const surface = async () => {
    const dir = tmpProject();
    await initSurface({ dir, models: { large: "placeholder:1b", small: "placeholder:1b", detected: [] } });
    return dir;
  };

  it("the digest a preview printed writes exactly that preview", async () => {
    const dir = await surface();
    const machine = gb10Ollama({ "qwen3.6:35b": 23.9e9 });
    const seen = await runSetup(opts(dir, { json: true }), harness(machine).deps);
    expect(seen.exit).toBe(SETUP_EXIT.needsConsent);
    expect(seen.proposal?.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same plan again has the same digest: it is a name for the change.
    expect((await runSetup(opts(dir, { json: true }), harness(machine).deps)).proposal?.digest).toBe(seen.proposal?.digest);

    const w = await runSetup(opts(dir, { json: true, yes: true, expectProposal: seen.proposal!.digest }), harness(machine).deps);
    expect(w.exit, w.why).toBe(SETUP_EXIT.written);
    expect(w.proposal?.files).toEqual(seen.proposal?.files);
    expect(w.surface_hash?.before).toBe(seen.surface_hash?.before);
  });

  it("a surface edited after the preview: exit 3, nothing written", async () => {
    const dir = await surface();
    const machine = gb10Ollama({ "qwen3.6:35b": 23.9e9 });
    const seen = await runSetup(opts(dir, { json: true }), harness(machine).deps);
    const rolesPath = join(dir, ".gnomon", "roles.toml");
    writeFileSync(rolesPath, readFileSync(rolesPath, "utf-8") + "\n# edited after the review\n");
    const edited = recomputeManifest(join(dir, ".gnomon")).surface_hash;

    const w = await runSetup(opts(dir, { json: true, yes: true, expectProposal: seen.proposal!.digest }), harness(machine).deps);
    expect(w.exit).toBe(SETUP_EXIT.surfaceMoved);
    expect(w.steps.at(-1)).toEqual({ id: "write", status: "proposal_changed" });
    expect(w.proposal?.applied).toBe(false);
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).toBe(edited);
    expect(existsSync(join(dir, SETUP_FACTS_FILE))).toBe(false);
  });

  it("a machine that now plans differently (a small model installed since): exit 3, nothing written", async () => {
    const dir = await surface();
    const seen = await runSetup(opts(dir, { json: true }), harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 })).deps);
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    const later = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9, "qwen3:8b": 5.2e9 }));
    const w = await runSetup(opts(dir, { json: true, yes: true, expectProposal: seen.proposal!.digest }), later.deps);
    expect(w.exit).toBe(SETUP_EXIT.surfaceMoved);
    expect(w.proposal?.digest).not.toBe(seen.proposal?.digest);
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The whole interactive path: scan, plug in a local model, connect a cloud one
// ---------------------------------------------------------------------------

describe("the guided path, start to finish", () => {
  it("pull on yes, speed check, a cloud planner with its key hidden, hybrid on observe, the diff accepted", async () => {
    const dir = tmpProject();
    const h = harness(withUrls(MACHINES.gpu32(), ollamaServing({})), [
      "", // the recommendation: qwen3.6:35b
      "y", // pull it
      "", // speed check: Enter = yes
      "1", // cloud: OpenCode Go
      "", // its model: the catalog's default
      "", // one-token check: Enter = no
      "", // the suggested mode
      "y", // write
    ]);
    h.secrets.push("sk-test-not-a-real-key");
    const r = await runSetup(opts(dir), h.deps);
    expect(r.exit, r.why).toBe(SETUP_EXIT.written);
    expect(h.pulls).toEqual(["qwen3.6:35b"]);
    expect(h.speeds).toHaveLength(1);
    // The key went to the store, and nowhere else: not said, not in the report,
    // not in any file under the project.
    expect(h.stored).toEqual({ OPENCODE_API_KEY: "sk-test-not-a-real-key" });
    expect(h.said.join("\n")).not.toContain("sk-test");
    expect(JSON.stringify(r)).not.toContain("sk-test");
    for (const f of [".gnomon/config.toml", ".gnomon/roles.toml", SETUP_FACTS_FILE]) {
      expect(readFileSync(join(dir, f), "utf-8")).not.toContain("sk-test");
    }
    // No spending without a yes: the one-token check was declined.
    expect(h.cloudChecks).toEqual([]);
    expect(r.cloud).toMatchObject({ endpoint: "go", model: "deepseek-v4.1-flash", key_env: "OPENCODE_API_KEY", key_held: true, checked: "skipped" });
    // Hybrid, citing the measurement, with control recorded but not active.
    expect(r.mode).toMatchObject({ suggested: "hybrid", chosen: "hybrid", role_profile: "frontier_plan" });
    expect(r.mode!.why).toContain("showed no measured advantage over cloud-only");
    expect(r.mode!.why).not.toContain("87%");
    expect(r.hybrid_control).toMatchObject({ value: "observe", active: false });
    expect(r.hybrid_control!.note).toContain("PR #102");
    const config = loadConfig(dir);
    expect(routeRole(config, "coordinator").target).toMatchObject({ model: "deepseek-v4.1-flash", endpoint: "go" });
    expect(routeRole(config, "implementor").target).toMatchObject({ model: "qwen3.6:35b", endpoint: "local" });
    expect(JSON.parse(readFileSync(join(dir, SETUP_FACTS_FILE), "utf-8")).hybrid_control.value).toBe("observe");
    // It ends by offering what comes next.
    expect(r.next[0]).toMatch(/^gnomon launch/);
    expect(r.next.some((n) => n.startsWith("gnomon dashboard"))).toBe(false);
  });

  it("a one-token check runs only after the person says yes", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), ["", "n", "1", "", "y", "", "n"]);
    h.secrets.push("sk-test-not-a-real-key");
    const r = await runSetup(opts(tmpProject()), h.deps);
    expect(h.cloudChecks).toEqual(["deepseek-v4.1-flash"]);
    expect(r.cloud?.checked).toBe("ok");
    expect(h.asked.find((q) => q.includes("one token"))).toContain("[y/N]");
  });

  it("offers `gnomon dashboard` when this build has it, and not `launch` when launch asked", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }), undefined, { commands: ["launch", "setup", "doctor", "dashboard"] });
    const r = await runSetup(opts(tmpProject(), { yes: true, fromLaunch: true }), h.deps);
    expect(r.next.map((n) => n.split(" —")[0])).toEqual(["gnomon dashboard", "gnomon doctor"]);
  });
});

describe("off a terminal, the cloud model comes from flags and nothing is spent", () => {
  it("--cloud-endpoint preset + --cloud-model: hybrid; no prompt, no check, the missing key named", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    const r = await runSetup(opts(dir, { cloudEndpoint: "opencode-go", cloudModel: "deepseek-v4.1-flash", yes: true }), h.deps);
    expect(r.exit, r.why).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.cloudChecks).toEqual([]);
    expect(r.cloud).toMatchObject({ endpoint: "go", key_held: false, checked: "skipped" });
    expect(h.said.join("\n")).toContain("gnomon key set OPENCODE_API_KEY");
    expect(r.mode?.chosen).toBe("hybrid");
  });

  it("a cloud URL gnomon does not know is declared, and the next launch asks for trust again", async () => {
    const dir = tmpProject();
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 }));
    const r = await runSetup(
      opts(dir, { cloudEndpoint: "https://llm.example.com/v1/chat/completions", cloudModel: "big-model", yes: true }),
      h.deps
    );
    expect(r.exit, r.why).toBe(0);
    const ev = evaluateTrust(loadConfig(dir), {});
    // Setup never grants trust itself: the key going to a new host is a grant
    // the person accepts at the next launch, as for any other surface change.
    expect(ev.status).toBe("untrusted");
    expect(ev.grants.map((g) => g.key)).toContain("key:cloud:CLOUD_API_KEY@llm.example.com");
  });

  it("--mode hybrid with no cloud model is refused, nothing written", async () => {
    const dir = tmpProject();
    const r = await runSetup(opts(dir, { mode: "hybrid", yes: true }), harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 })).deps);
    expect(r.exit).toBe(SETUP_EXIT.needsConsent);
    expect(r.why).toMatch(/needs a cloud model/);
    expect(listing(dir)).toEqual([]);
  });

  it("--mode cloud with a cloud model and no local one writes all_remote", async () => {
    const dir = tmpProject();
    const r = await runSetup(
      opts(dir, { mode: "cloud_first", cloudEndpoint: "opencode-go", yes: true }),
      harness(MACHINES.tiny4()).deps
    );
    expect(r.exit, r.why).toBe(0);
    expect(r.local).toBeNull();
    const config = loadConfig(dir);
    expect(config.profile?.name).toBe("all_remote");
    expect(routeRole(config, "smol").target.model).toBe("deepseek-v4.1-flash");
  });

  it("--model names an installed model; one that is not installed is refused", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9, "qwen3:8b": 5.2e9 }));
    const r = await runSetup(opts(tmpProject(), { model: "qwen3:8b", yes: true }), h.deps);
    expect(r.local).toMatchObject({ tag: "qwen3:8b", small: "qwen3:8b" });
    const missing = await runSetup(opts(tmpProject(), { model: "llama9:400b" }), harness(gb10Ollama()).deps);
    expect(missing.exit).toBe(SETUP_EXIT.needsConsent);
    expect(missing.why).toContain("--pull llama9:400b");
  });

  it("a small installed model becomes smol; setup never downloads a second one", async () => {
    const h = harness(gb10Ollama({ "qwen3.6:35b": 23.9e9, "qwen3:8b": 5.2e9 }));
    const r = await runSetup(opts(tmpProject(), { yes: true }), h.deps);
    expect(r.local).toMatchObject({ tag: "qwen3.6:35b", small: "qwen3:8b" });
    expect(h.pulls).toEqual([]);
  });
});

describe("resolving --cloud-endpoint", () => {
  it("takes a preset, its URL, a declared name, or a URL; refuses loopback and nonsense", () => {
    expect(resolveCloudEndpoint("openrouter", undefined)).toMatchObject({ name: "openrouter", block: { api_key_env: "OPENROUTER_API_KEY" } });
    expect(resolveCloudEndpoint("https://opencode.ai/zen/go/v1/chat/completions", undefined)).toMatchObject({ name: "go", preset: "opencode-go" });
    const config = '[endpoints.mine]\nurl = "https://x.example/v1/chat/completions"\nkind = "openai"\napi_key_env = "MINE_KEY"\n';
    expect(resolveCloudEndpoint("mine", config)).toMatchObject({ name: "mine", declared: true, block: { api_key_env: "MINE_KEY" } });
    expect(resolveCloudEndpoint("https://y.example/v1/chat/completions", undefined, "Y_KEY")).toMatchObject({ name: "cloud", block: { api_key_env: "Y_KEY" } });
    expect(resolveCloudEndpoint("http://127.0.0.1:8080/v1/chat/completions", undefined)).toMatchObject({ error: expect.stringContaining("on this machine") });
    expect(resolveCloudEndpoint("bogus", undefined)).toMatchObject({ error: expect.stringContaining("not a declared endpoint") });
  });
});

// ---------------------------------------------------------------------------
// --json: the document the dashboard's Setup screen reads
// ---------------------------------------------------------------------------

describe("the --json document (schema gnomon.setup/1)", () => {
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "setup_report.json"), "utf-8")) as {
    report_keys: { required: string[]; optional: string[] };
    proposal_keys: string[];
    suggestions: string[];
    hybrid_controls: string[];
    exit_codes: Record<string, string>;
    step_ids: string[];
  };

  const check = (r: SetupReport) => {
    const keys = Object.keys(r);
    for (const k of fixture.report_keys.required) expect(keys, k).toContain(k);
    for (const k of keys) expect([...fixture.report_keys.required, ...fixture.report_keys.optional], k).toContain(k);
    for (const s of r.steps) expect(fixture.step_ids).toContain(s.id);
    expect(Object.keys(fixture.exit_codes)).toContain(String(r.exit));
    if (r.proposal) expect(Object.keys(r.proposal).sort()).toEqual([...fixture.proposal_keys].sort());
  };

  it("a proposal, a write and a refusal all match the published keys", async () => {
    check(await runSetup(opts(tmpProject(), { json: true }), harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 })).deps));
    check(await runSetup(opts(tmpProject(), { json: true, yes: true, speedCheck: true }), harness(gb10Ollama({ "qwen3.6:35b": 23.9e9 })).deps));
    check(await runSetup(opts(tmpProject(), { json: true }), harness(gb10Ollama()).deps));
  });

  it("the published value sets are the code's", () => {
    expect(fixture.suggestions).toEqual(["local_only", "hybrid", "cloud_first"]);
    expect(fixture.hybrid_controls).toEqual([...HYBRID_CONTROLS]);
    expect(Object.keys(fixture.exit_codes).map(Number).sort((a, b) => a - b)).toEqual(
      [...new Set(Object.values(SETUP_EXIT))].sort((a, b) => a - b)
    );
  });

});

// ---------------------------------------------------------------------------
// The command line: argument errors answer before anything is probed
// ---------------------------------------------------------------------------

describe("gnomon setup / doctor on the command line", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("an unknown --mode is a usage error, as JSON under --json", () => {
    const r = run(["setup", "--mode", "turbo", "--json", "--dir", tmpProject()]);
    expect(r.code).toBe(SETUP_EXIT.usage);
    expect(JSON.parse(r.out)).toEqual({ schema: "gnomon.setup/1", error: "--mode turbo: use local, hybrid or cloud.", exit: 1 });
  }, 60_000);

  it("--expect-proposal takes a digest and nothing else", () => {
    const r = run(["setup", "--expect-proposal", "HEAD", "--yes", "--json", "--dir", tmpProject()]);
    expect(r.code).toBe(SETUP_EXIT.usage);
    expect(JSON.parse(r.out).error).toMatch(/--expect-proposal takes the 64-hex/);
  }, 60_000);

  it("--pull with no tag is refused: a download must be named", () => {
    const r = run(["setup", "--pull", "--yes", "--dir", tmpProject()]);
    expect(r.code).toBe(SETUP_EXIT.usage);
    expect(r.err).toContain("--pull needs a value.");
  }, 60_000);

  it("a catalog that cannot be read: setup exits 10, doctor exits 10", () => {
    const s = run(["setup", "--catalog", "/nonexistent/models.toml", "--json", "--dir", tmpProject()]);
    expect(s.code).toBe(SETUP_EXIT.catalog);
    expect(JSON.parse(s.out).error).toMatch(/cannot be read/);
    const d = run(["doctor", "--catalog", "/nonexistent/models.toml", "--json", "--dir", tmpProject()]);
    expect(d.code).toBe(10);
    expect(JSON.parse(d.out)).toMatchObject({ schema: "gnomon.doctor/1", exit: 10 });
  }, 60_000);
});
