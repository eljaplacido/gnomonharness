/**
 * `gnomon eval --ablate` the command (docs/CONTRACTS.md section 60): a dry run
 * by default, flags checked, the refusals, and the text and JSON output.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "gnomon-core";
import { setDecisionContextProbe } from "../../gnomon-core/src/agent_context.js";
import { initSurface } from "./init.js";
import { ABLATE_EXIT, runAblateCmd } from "./ablate_cmd.js";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
let marker: string | undefined;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  marker = process.env.GNOMON_AGENT_SESSION;
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  if (marker === undefined) delete process.env.GNOMON_AGENT_SESSION;
  else process.env.GNOMON_AGENT_SESSION = marker;
});

async function project(): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), "gnomon-ablate-cli-")), "proj");
  made.push(join(root, ".."));
  mkdirSync(root);
  await initSurface({ dir: root });
  return root;
}

async function run(root: string, flags: Record<string, string> = {}, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  let cells = 0;
  const code = await runAblateCmd(loadConfig(root), { flags, json }, { runCell: async () => (cells++, { code: 0 } as never) }, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n"), cells };
}

describe("gnomon eval --ablate", () => {
  it("is a dry run by default: the plan, no cell, no file", async () => {
    const root = await project();
    const r = await run(root, { ablate: "true" });
    expect(r.code).toBe(ABLATE_EXIT.ok);
    expect(r.out).toMatch(/dry run\): nothing is written and no model is called/);
    expect(r.out).toMatch(/Never ablated: policy deny rules, sandbox, guard, audit/);
    expect(r.out).toMatch(/Estimated \d+ cell/);
    expect(r.cells).toBe(0);
    expect(existsSync(join(root, ".gnomon-trials", "_ablate"))).toBe(false);
    expect(readdirSync(root).includes(".gnomon-proposals")).toBe(false);
  });

  it("prints JSON with the schema", async () => {
    const root = await project();
    const r = await run(root, { ablate: "skills" }, true);
    const j = JSON.parse(r.out);
    expect(j.schema).toBe("gnomon.ablate/1");
    expect(j.mode).toBe("dry-run");
  });

  it("refuses to ablate governance (exit 3), by any name", async () => {
    const root = await project();
    for (const w of ["sandbox", "guard", "audit", "policy"]) {
      const r = await run(root, { ablate: w });
      expect(r.code, w).toBe(ABLATE_EXIT.refused);
      expect(r.err).toMatch(/governance is never ablated/);
    }
  });

  it("checks its flags", async () => {
    const root = await project();
    expect((await run(root, { ablate: "true", bogus: "1" })).code).toBe(ABLATE_EXIT.usage);
    expect((await run(root, { ablate: "true", k: "0" })).code).toBe(ABLATE_EXIT.usage);
    expect((await run(root, { ablate: "true", "budget-usd": "x" })).code).toBe(ABLATE_EXIT.usage);
    expect((await run(root, { ablate: "true", "max-requests": "0" })).code).toBe(ABLATE_EXIT.usage);
    expect((await run(root, { ablate: "true", run: "true", "dry-run": "true" })).code).toBe(ABLATE_EXIT.usage);
    const p = await run(root, { ablate: "true", propose: "true" });
    expect(p.code).toBe(ABLATE_EXIT.usage);
    expect(p.err).toMatch(/needs --run/);
  });

  it("--run is refused inside an agent session, before anything is spent", async () => {
    const root = await project();
    setDecisionContextProbe(() => ({ agent: "claude-code", interactive: false }));
    const r = await run(root, { ablate: "true", run: "true", "allow-host-probes": "true" });
    expect(r.code).toBe(ABLATE_EXIT.refused);
    expect(r.err).toMatch(/agent session/);
    expect(r.cells).toBe(0);
  });
});
