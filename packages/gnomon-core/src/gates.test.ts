/**
 * Every gate must be able to FAIL.
 *
 * Six of the defects found on 2026-09-01 were the same shape: a mechanism
 * reporting success while doing nothing. `pnpm -r typecheck` exited 0 with no
 * checker installed. The surface audit's executor warning was silenced on every
 * scaffolded surface by that surface's own deny rule. A declared MCP server was
 * absent from one entry point. A ref guard aborted every trial and read as
 * capability failure. Each was found by accident -- a build error, credits that
 * did not move, an experiment breaking -- and none by a test.
 *
 * A gate nobody has watched fail is a gate that probably cannot. These are the
 * negative controls: inject a fault, require the gate to catch it. They are
 * deliberately about the FAILING direction only; the passing direction is
 * covered by the suites beside this one.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditSurface, loadConfig, recomputeManifest, resolveChain } from "./config.js";
import { resolveInRoot, executeTool } from "./tools.js";

const surface = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-gate-"));
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, ".gnomon", name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
};

describe("gate: the surface audit", () => {
  it("is FATAL on a chain stage naming a role that does not exist", () => {
    const dir = surface({
      "config.toml": '[chain]\nstages = ["plan", "nosuchrole"]\n',
      "roles.toml": "[roles.plan]\ntools = [\"read\"]\n",
    });
    const fatal = auditSurface(loadConfig(dir)).filter((p) => p.fatal);
    expect(fatal.length).toBeGreaterThan(0);
    expect(fatal.map((f) => f.problem).join(" ")).toContain("nosuchrole");
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches an unknown role key rather than ignoring it", () => {
    const dir = surface({ "roles.toml": '[roles.a]\ntools = ["read"]\nbash_alow = ["x"]\n' });
    const problems = auditSurface(loadConfig(dir));
    expect(problems.some((p) => /bash_alow/.test(p.problem))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: the manifest hash", () => {
  it("MOVES when a hashed file changes", () => {
    const dir = surface({ "config.toml": "[defaults]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    appendFileSync(join(dir, ".gnomon", "config.toml"), "\n# a change\n");
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("MOVES when a hashed file is removed — absence counts", () => {
    const dir = surface({ "config.toml": "[defaults]\n", "roles.toml": "[roles.a]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    rmSync(join(dir, ".gnomon", "roles.toml"));
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: sandbox confinement", () => {
  it("REFUSES a path outside the root", () => {
    expect(resolveInRoot("/repo", "/etc/passwd", "confined")).toBeNull();
    expect(resolveInRoot("/repo", "../../etc/passwd", "confined")).toBeNull();
  });
  it("REFUSES a sibling of a granted extra root", () => {
    expect(resolveInRoot("/repo", "/other/../elsewhere/x", "confined", ["/other"])).toBeNull();
  });
});

describe("gate: bash_deny and task_allow", () => {
  const ctx = (extra: Record<string, unknown>) =>
    ({ root: tmpdir(), sandbox: "confined", gate: "never", approve: async () => true,
       timeoutMs: 5000, maxOutputBytes: 4096, ...extra }) as never;

  it("REFUSES a denied command", async () => {
    const r = await executeTool("bash", { command: "git push --force origin main" },
      ctx({ bashDeny: ["\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b"] }), new Set(["bash"]));
    expect(r.code).toBe(2);
  });

  it("REFUSES a delegation target outside task_allow", async () => {
    const r = await executeTool("task", { role: "implement", instruction: "x" },
      ctx({ taskAllow: ["verifier"],
            delegate: { depth: 0, roles: () => ["implement", "verifier"],
                        run: async () => ({ answer: "", code: 0 }) } }), new Set(["task"]));
    expect(r.code).toBe(2);
  });
});

describe("gate: the repository's own CI gates can fail", () => {
  // The one that actually bit: `pnpm -r typecheck` exited 0 for months while
  // no package defined the script, so every "typecheck clean" was vacuous.
  it("every TypeScript package defines a real typecheck script", () => {
    for (const pkg of ["gnomon-core", "gnomon-cli", "gnomon-tui", "gnomon-natives"]) {
      const json = JSON.parse(
        readFileSync(join(__dirname, "..", "..", pkg, "package.json"), "utf8")
      ) as { scripts?: Record<string, string> };
      expect(json.scripts?.typecheck, `${pkg} has no typecheck script`).toBeTruthy();
      expect(json.scripts?.typecheck).toContain("tsc");
    }
  });

  it("tsc actually rejects a type error", () => {
    // Proves the checker is wired, not merely named. A gate that cannot fail
    // is not a gate, and this is the cheapest possible proof that it can.
    const dir = mkdtempSync(join(tmpdir(), "gnomon-tsc-"));
    writeFileSync(join(dir, "bad.ts"), "const n: number = 'not a number';\n");
    let failed = false;
    try {
      execFileSync("npx", ["tsc", "--noEmit", "--strict", join(dir, "bad.ts")], {
        stdio: "pipe", cwd: join(__dirname, "..", ".."),
      });
    } catch {
      failed = true;
    }
    expect(failed, "tsc accepted a string assigned to a number").toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: the auditor reports each problem once", () => {
  it("does not multiply surface-level findings by the number of roles", () => {
    // Three checks -- [chain] stages, task_allow, extra_roots -- are about the
    // SURFACE, not one role, and sat inside the per-role loop. Each ran once
    // per role: two genuine warnings appeared seven times each on this
    // repository's own seven-role surface. Fifteen lines for three problems,
    // and a fatal chain stage would have printed seven fatal errors.
    const dir = surface({
      "config.toml": '[chain]\nstages = ["a", "nosuch"]\n',
      "roles.toml": ["a", "b", "c", "d", "e"]
        .map((r) => `[roles.${r}]\ntools = ["read"]\n`)
        .join(""),
    });
    const problems = auditSurface(loadConfig(dir));
    const chainProblems = problems.filter((p) => /\[chain\]/.test(p.where));
    expect(chainProblems.length, "one bad stage, one report").toBe(1);
    expect(chainProblems[0].problem).toContain("nosuch");
    const keyed = problems.map((p) => `${p.where}|${p.problem}`);
    expect(new Set(keyed).size, "no problem reported twice").toBe(keyed.length);
    rmSync(dir, { recursive: true, force: true });
  });
});
