/**
 * gnomon-cli: the surface change setup proposes, over the real scaffold.
 *
 * Each plan is applied to a scaffold `gnomon init` writes, then loaded by the
 * real config loader: the routing must be what the mode says, and no start
 * after setup may print "is ignored: role_profile ...".
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, routeRole, auditSurface, listRoles } from "gnomon-core";
import { scaffoldTexts } from "./init.js";
import {
  planSurface,
  provenanceBlock,
  readProvenance,
  setDefaultsKey,
  endpointFor,
  changeDiff,
  HYBRID_CLOUD_ROLES,
  type PlanInput,
  type SurfaceTexts,
} from "./setup_surface.js";

const scaffold = (): SurfaceTexts => scaffoldTexts({ large: "qwen2.5:14b-instruct", small: "qwen2.5:7b-instruct", detected: [] });
const LOCAL = { tag: "qwen3.6:35b", small: "qwen3:8b", endpoint: "local" };
const CLOUD = { endpoint: "go", model: "deepseek-v4.1-flash" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Apply a plan to a scaffold on disk and load it as a run would. */
function applied(input: PlanInput, base = scaffold()) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-setup-plan-"));
  dirs.push(root);
  const texts: SurfaceTexts = { ...base };
  for (const c of planSurface(base, input)) texts[c.path] = c.after;
  for (const [rel, text] of Object.entries(texts)) {
    if (text === undefined) continue;
    const p = join(root, ".gnomon", ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  const config = loadConfig(root);
  const ignored = auditSurface(config).filter((p) => p.problem.includes("is ignored: role_profile"));
  return { config, texts, ignored };
}

describe("local only", () => {
  it("routes every role to the local model and smol to the small one", () => {
    const { config, ignored } = applied({ mode: "local_only", local: LOCAL, catalogLabel: "2026-11" });
    expect(config.profile?.name).toBe("local_first");
    for (const role of listRoles(config)) {
      const t = routeRole(config, role).target;
      expect([role, t.model, t.endpoint]).toEqual([role, role === "smol" ? "qwen3:8b" : "qwen3.6:35b", "local"]);
    }
    expect(ignored).toEqual([]);
  });

  it("the scaffold already selects local_first, so config.toml is not touched", () => {
    const changes = planSurface(scaffold(), { mode: "local_only", local: LOCAL, catalogLabel: "2026-11" });
    expect(changes.map((c) => c.path).sort()).toEqual(["profiles/local_first.toml", "roles.toml"]);
  });
});

describe("hybrid: a cloud model plans, the local model builds", () => {
  it("coordinator and plan go to the cloud; everything else stays local; nothing is shadowed", () => {
    const { config, texts, ignored } = applied({ mode: "hybrid", local: LOCAL, cloud: CLOUD, catalogLabel: "2026-11" });
    expect(config.profile?.name).toBe("frontier_plan");
    for (const role of listRoles(config)) {
      const t = routeRole(config, role).target;
      const cloud = (HYBRID_CLOUD_ROLES as readonly string[]).includes(role);
      expect([role, t.model, t.endpoint]).toEqual(
        cloud ? [role, "deepseek-v4.1-flash", "go"] : [role, role === "smol" ? "qwen3:8b" : "qwen3.6:35b", "local"]
      );
    }
    expect(ignored).toEqual([]);
    expect(texts["profiles/frontier_plan.toml"]).toContain("Written by `gnomon setup`");
  });

  it("an existing frontier_plan profile is edited in place, its comments kept", () => {
    const base = scaffold();
    base["profiles/frontier_plan.toml"] =
      '# my own notes\nname = "frontier_plan"\n\n[roles.plan]\nmodel = "glm-5.3"\nendpoint = "go"\n\n[roles.implement]\nmodel = "old:1b"\nendpoint = "local"\n';
    const { config, texts, ignored } = applied({ mode: "hybrid", local: LOCAL, cloud: CLOUD, catalogLabel: "2026-11" }, base);
    expect(texts["profiles/frontier_plan.toml"]).toMatch(/^# my own notes/);
    expect(routeRole(config, "implement").target.model).toBe("qwen3.6:35b");
    expect(routeRole(config, "coordinator").target.model).toBe("deepseek-v4.1-flash");
    expect(ignored).toEqual([]);
  });
});

describe("cloud first", () => {
  it("every role goes to the cloud model, with no local model at all", () => {
    const { config, ignored } = applied({ mode: "cloud_first", cloud: CLOUD, catalogLabel: "2026-11" });
    expect(config.profile?.name).toBe("all_remote");
    for (const role of listRoles(config)) expect(routeRole(config, role).target.model).toBe("deepseek-v4.1-flash");
    expect(ignored).toEqual([]);
  });

  it("a mode without the model it needs is refused", () => {
    expect(() => planSurface(scaffold(), { mode: "hybrid", local: LOCAL, catalogLabel: "x" })).toThrow(/needs a cloud model/);
    expect(() => planSurface(scaffold(), { mode: "local_only", cloud: CLOUD, catalogLabel: "x" })).toThrow(/needs a local model/);
  });
});

describe("endpoints", () => {
  it("a llama.cpp server gets its own endpoint, OpenAI-shaped, on its port", () => {
    const base = scaffold();
    const ep = endpointFor(base["config.toml"], "http://127.0.0.1:8080/v1/chat/completions", ["llamacpp"], {
      url: "http://127.0.0.1:8080/v1/chat/completions",
      kind: "openai",
    });
    expect(ep).toEqual({ name: "llamacpp", block: { url: "http://127.0.0.1:8080/v1/chat/completions", kind: "openai" } });
    const { config } = applied({ mode: "local_only", local: { tag: "qwen3.6-35b", small: "qwen3.6-35b", endpoint: ep.name, block: ep.block }, catalogLabel: "2026-11" }, base);
    const t = routeRole(config, "implement").target;
    expect([t.url, t.kind, t.model]).toEqual(["http://127.0.0.1:8080/v1/chat/completions", "openai", "qwen3.6-35b"]);
  });

  it("Ollama on its usual port is the scaffold's own `local`: nothing is declared", () => {
    const ep = endpointFor(scaffold()["config.toml"], "http://127.0.0.1:11434/api/chat", ["local"], { url: "x", kind: "ollama" });
    expect(ep).toEqual({ name: "local" });
  });

  it("a new cloud endpoint is declared with the key's NAME, never a value", () => {
    const { texts } = applied({
      mode: "hybrid",
      local: LOCAL,
      cloud: { endpoint: "cloud", model: "m", block: { url: "https://llm.example.com/v1/chat/completions", kind: "openai", api_key_env: "CLOUD_API_KEY" } },
      catalogLabel: "2026-11",
    });
    expect(texts["config.toml"]).toMatch(/\[endpoints\.cloud\]\nurl = "https:\/\/llm\.example\.com\/v1\/chat\/completions"\nkind = "openai"\napi_key_env = "CLOUD_API_KEY"/);
  });
});

describe("provenance: tags and the catalog date, nothing about the machine", () => {
  const input: PlanInput = { mode: "hybrid", local: LOCAL, cloud: CLOUD, catalogLabel: "2026-11" };

  it("is written at the top of roles.toml and reads back", () => {
    const roles = planSurface(scaffold(), input).find((c) => c.path === "roles.toml")!.after;
    expect(roles.split("\n").slice(0, 3)).toEqual(provenanceBlock(input));
    expect(readProvenance(roles)).toEqual({ v: 1, catalog: "2026-11", local: "qwen3.6:35b", small: "qwen3:8b", cloud: "deepseek-v4.1-flash@go", mode: "hybrid" });
  });

  it("names no hardware, host or date of its own, so two machines write the same bytes", () => {
    const block = provenanceBlock(input).join("\n");
    expect(block).not.toMatch(/GiB|GB10|RTX|linux|darwin|win32|\d{4}-\d{2}-\d{2}/);
    expect(planSurface(scaffold(), input)).toEqual(planSurface(scaffold(), input));
  });

  it("is replaced, not stacked, when setup runs again", () => {
    const once: SurfaceTexts = { ...scaffold() };
    for (const c of planSurface(once, input)) once[c.path] = c.after;
    const twice = planSurface(once, { ...input, mode: "local_only" });
    const roles = twice.find((c) => c.path === "roles.toml")!.after;
    expect(roles.split("\n").filter((l) => l.startsWith("# gnomon-setup: "))).toHaveLength(1);
    expect(readProvenance(roles)?.mode).toBe("local_only");
  });

  it("planning the same thing twice proposes nothing the second time", () => {
    const once: SurfaceTexts = { ...scaffold() };
    for (const c of planSurface(once, input)) once[c.path] = c.after;
    expect(planSurface(once, input)).toEqual([]);
  });
});

describe("line edits keep what a person wrote", () => {
  it("setDefaultsKey keeps the trailing comment", () => {
    const t = '[defaults]\nrole_profile = "local_first"      # local_first | frontier_plan | all_remote\n';
    expect(setDefaultsKey(t, "role_profile", "frontier_plan")).toBe(
      '[defaults]\nrole_profile = "frontier_plan"      # local_first | frontier_plan | all_remote\n'
    );
    expect(setDefaultsKey("[other]\nx = 1\n", "role_profile", "all_remote")).toMatch(/^\[defaults\]\nrole_profile = "all_remote"/);
  });

  it("a diff shows only the lines that change, with context", () => {
    const change = planSurface(scaffold(), { mode: "local_only", local: LOCAL, catalogLabel: "2026-11" }).find((c) => c.path === "profiles/local_first.toml")!;
    const diff = changeDiff(change);
    expect(diff.filter((l) => l.startsWith("+ "))).toContain('+ model = "qwen3.6:35b"');
    expect(diff.filter((l) => l.startsWith("- "))).toContain('- model = "qwen2.5:14b-instruct"');
  });
});
