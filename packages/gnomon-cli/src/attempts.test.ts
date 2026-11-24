/**
 * gnomon-cli: `gnomon task --attempts <k>` (attempts_run.ts, CONTRACTS §60)
 *
 * Real `gnomon task` children against a scripted fake OpenAI endpoint. The
 * attempt is told apart by the model name its role declares ([attempts] roles
 * = a, b, c -> m1, m2, m3), so the script says which attempt passes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { initSurface } from "./init.js";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });

const GNOMON = join(dirname(fileURLToPath(import.meta.url)), "..", "gnomon.js");

interface Script {
  /** What each model writes to out.txt */
  writes: Record<string, string>;
  /** Completion tokens of the first reply, by model */
  tokens: Record<string, number>;
  /** Models whose second request is held this long (ms): the slow attempts */
  hold: Record<string, number>;
  /** Run this when a model's second request arrives (a side effect on the operator's tree) */
  onSecond?: (model: string) => void;
}

let server: Server;
let base = "";
let script: Script;
const seen: Array<{ model: string; seed?: number; second: boolean }> = [];
const made: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}") as { model: string; seed?: number; messages: Array<{ role: string }> };
      const second = j.messages.some((m) => m.role === "tool");
      seen.push({ model: j.model, seed: j.seed, second });
      const reply = (message: object, finish: string, completion: number) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: completion } }));
      };
      if (!second) {
        const content = script.writes[j.model] ?? "bad\n";
        reply(
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content }) } }] },
          "tool_calls",
          script.tokens[j.model] ?? 20
        );
        return;
      }
      script.onSecond?.(j.model);
      const hold = script.hold[j.model] ?? 0;
      const timer = setTimeout(() => reply({ role: "assistant", content: "done" }, "stop", 5), hold);
      res.on("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf-8" });

/** A committed project whose three roles are three models of the fake endpoint. */
async function project(policyExtra: string): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-attempts-")));
  made.push(root);
  await initSurface({ dir: root, noVerify: true });
  const g = join(root, ".gnomon");
  writeFileSync(
    join(g, "config.toml"),
    `[routing]\nmode = "manual"\ndefault = "a"\n\n[defaults]\nstream = false\n\n[resilience]\nattempts = 1\nrequest_timeout_ms = 60000\n\n` +
      `[endpoints.local]\nurl = "${base}/v1/chat/completions"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(g, "roles.toml"),
    ["a", "b", "c"]
      .map((r, i) => `[roles.${r}]\nmodel = "m${i + 1}"\nendpoint = "local"\ntools = ["write"]\nmax_steps = 4\n`)
      .join("\n")
  );
  writeFileSync(
    join(g, "policy.toml"),
    `[approval]\ngate = "on_write"\n\n` + policyExtra
  );
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

interface Run { code: number | null; out: string; err: string; json: any }
function gnomon(root: string, args: string[]): Promise<Run> {
  return new Promise((done) => {
    const c = spawn(process.execPath, [GNOMON, "task", "write out.txt", ...args, "--json", "--dir", root], {
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => {
      let json: any = null;
      try { json = JSON.parse(out); } catch { /* asserted on */ }
      done({ code, out, err, json });
    });
  });
}

beforeEach(() => {
  seen.length = 0;
  script = { writes: {}, tokens: {}, hold: {} };
});
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const CHECK = `check = "grep -q ok out.txt"\n`;
const ROLES = `[attempts]\nmax = 3\nroles = ["a", "b", "c"]\n${CHECK}`;

describe("gnomon task --attempts", () => {
  it("the first attempt to pass the check wins; the other two are cancelled, never results", async () => {
    const root = await project(ROLES);
    // Attempt 2 (model m2) writes the answer and finishes at once; 1 and 3 write wrong files and are held.
    script.writes = { m1: "bad\n", m2: "ok\n", m3: "bad\n" };
    script.hold = { m1: 60_000, m3: 60_000 };
    script.tokens = { m1: 20, m2: 20, m3: 20 };
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(0);
    const rep = r.json;
    expect(rep.schema).toBe("gnomon.attempts/1");
    expect(rep.chosen).toBe(2);
    expect(rep.verified).toBe(true);
    expect(rep.attempts.map((a: any) => a.status)).toEqual(["cancelled", "passed", "cancelled"]);
    expect(rep.attempts[0].bucket).toBeNull();
    // Cancelled attempts spent tokens before they were stopped, and the report says what early stop saved.
    expect(rep.attempts[0].tokens).toBeGreaterThan(0);
    expect(rep.early_stop.cancelled).toBe(2);
    expect(rep.tokens_total).toBe(rep.attempts.reduce((s: number, a: any) => s + a.tokens, 0));
    // One surface hash, recorded once; every attempt got a seed of its own.
    expect(rep.surface_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(seen.map((s) => s.seed)).size).toBe(3);
    // Applied as an ordinary change to the operator's tree, reviewable with git.
    expect(rep.applied).toBe(true);
    expect(readFileSync(join(root, "out.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe("ok\n");
    expect(git(root, "status", "--porcelain", "--", ".", ":(exclude).gnomon-*").stdout).toContain("out.txt");
    expect(existsSync(rep.patch)).toBe(true);
    // The run's own trail: spawn x3, check, cancel x2, select, apply.
    const trailDir = join(root, ".gnomon-audit");
    const trail = readdirSync(trailDir).find((f) => f.startsWith("attempts-"))!;
    const events = readFileSync(join(trailDir, trail), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "attempt_event").map((x) => x.event);
    expect(events.filter((e: string) => e === "spawn")).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(["check", "cancel", "select", "apply"]));
    expect(events.filter((e: string) => e === "cancel")).toHaveLength(2);
  }, 120_000);

  it("none passing: the evidence selector offers one, flagged unverified, and an unverified change is never applied", async () => {
    const root = await project(ROLES);
    script.writes = { m1: "bad\n", m2: "bad\n", m3: "bad\n" };
    script.tokens = { m1: 50, m2: 30, m3: 40 };
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.verified).toBe(false);
    expect(r.json.chosen).toBe(2);
    expect(r.json.reason).toContain("unverified");
    expect(r.json.attempts.every((a: any) => a.status === "failed")).toBe(true);
    expect(r.json.applied).toBe(false);
    expect(r.json.not_applied).toContain("unverified");
    expect(existsSync(join(root, "out.txt"))).toBe(false);
    expect(existsSync(r.json.patch)).toBe(true);
  }, 120_000);

  it("refuses k > 1 with no check declared, before anything runs", async () => {
    const root = await project(`[attempts]\nmax = 3\n`);
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.code).toBe(10);
    expect(r.err + r.out).toContain("needs an external check");
    expect(seen).toHaveLength(0);
  }, 60_000);

  it("refuses k above [attempts] max", async () => {
    const root = await project(`[attempts]\nmax = 2\n${CHECK}`);
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.code).toBe(10);
    expect(r.err + r.out).toContain("[attempts] max = 2");
    expect(seen).toHaveLength(0);
  }, 60_000);

  it("refuses a working tree with uncommitted changes, and never overwrites one that appears mid-run", async () => {
    const root = await project(ROLES);
    writeFileSync(join(root, "README.md"), "edited\n");
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.code).toBe(10);
    expect(r.err + r.out).toContain("uncommitted changes");
    expect(seen).toHaveLength(0);
    expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("edited\n");

    // Clean again; this time the operator edits out.txt while the attempts run.
    writeFileSync(join(root, "README.md"), "x\n");
    script.writes = { m1: "bad\n", m2: "ok\n", m3: "bad\n" };
    script.hold = { m1: 60_000, m3: 60_000 };
    script.onSecond = (model) => {
      if (model === "m2") writeFileSync(join(root, "out.txt"), "mine\n");
    };
    const r2 = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r2.code, r2.out + r2.err).toBe(0);
    expect(r2.json.applied).toBe(false);
    expect(r2.json.not_applied).toContain("changed in your tree");
    expect(readFileSync(join(root, "out.txt"), "utf-8")).toBe("mine\n");
    expect(existsSync(r2.json.patch)).toBe(true);
  }, 180_000);

  it("stops on the token budget: no attempt starts past it", async () => {
    const root = await project(`[attempts]\nmax = 3\nmax_tokens = 100\nmax_parallel = 1\nroles = ["a", "b", "c"]\n${CHECK}`);
    script.writes = { m1: "ok\n", m2: "ok\n", m3: "ok\n" };
    // Attempt 1's first reply alone is 120 tokens (> 100) and its second is held,
    // so it is always still running when the budget trips: cancelled, deterministically.
    script.hold = { m1: 60_000 };
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(r.json.budget_stop).toContain("max_tokens = 100");
    expect(r.json.attempts[0].status).toBe("cancelled");
    expect(r.json.attempts[0].tokens).toBeGreaterThanOrEqual(100);
    expect(r.json.attempts[1].tokens).toBe(0);
    expect(r.json.attempts[2].tokens).toBe(0);
    expect(new Set(seen.map((s) => s.model))).toEqual(new Set(["m1"]));
    expect(r.json.chosen).toBeNull();
    expect(r.json.applied).toBe(false);
  }, 120_000);

  it("--attempts 1 is the plain task: the same record, no clones, no run directory", async () => {
    const root = await project(ROLES);
    script.writes = { m1: "ok\n" };
    const plain = await gnomon(root, ["--yes"]);
    rmSync(join(root, "out.txt"), { force: true });
    git(root, "checkout", "--", ".");
    const one = await gnomon(root, ["--attempts", "1", "--yes"]);
    const strip = (rec: any) => {
      const { volatile: _v, ...rest } = rec;
      return rest;
    };
    expect(plain.json?.schema).toBeUndefined();
    expect(strip(one.json)).toEqual(strip(plain.json));
    expect(one.code).toBe(plain.code);
    expect(readdirSync(root).filter((f) => f.includes("gnomon-attempts"))).toEqual([]);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf-8")).not.toContain("attempts");
    // The wire is the plain task's: no seed was sent.
    expect(seen.every((s) => s.seed === undefined)).toBe(true);
  }, 120_000);

  it("--attempts needs a whole number", async () => {
    const root = await project(ROLES);
    const r = await gnomon(root, ["--attempts", "two"]);
    expect(r.code).toBe(10);
    expect(r.err).toContain("--attempts needs a whole number");
  }, 60_000);

  it("a wall-clock stop kills in-flight checks: it does not wait for them", async () => {
    const root = await project(`[attempts]\nmax = 3\nmax_wall_seconds = 3\nroles = ["a", "b", "c"]\ncheck = "sleep 40; grep -q ok out.txt"\n`);
    script.writes = { m1: "ok\n", m2: "ok\n", m3: "ok\n" };
    const t0 = Date.now();
    const r = await gnomon(root, ["--attempts", "3", "--yes", "--apply"]);
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.json.budget_stop).toContain("max_wall_seconds = 3");
    expect(r.json.verified).toBe(false);
    expect(r.json.applied).toBe(false);
  }, 60_000);

  it("max_tokens is enforced while attempts run, without [audit], and cancelled attempts keep their tokens", async () => {
    // Each attempt's first reply is 120 tokens, so 300 is reached only once all three have
    // reported: a slow-starting child cannot be cancelled before it has spent anything.
    const root = await project(`[attempts]\nmax = 3\nmax_tokens = 300\nroles = ["a", "b", "c"]\n${CHECK}`);
    script.writes = { m1: "bad\n", m2: "bad\n", m3: "bad\n" };
    script.hold = { m1: 60_000, m2: 60_000, m3: 60_000 };
    const t0 = Date.now();
    const r = await gnomon(root, ["--attempts", "3", "--yes"]);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.json.budget_stop).toContain("max_tokens = 300");
    expect(r.json.attempts.every((a: any) => a.status === "cancelled" && a.tokens >= 100)).toBe(true);
    expect(r.json.tokens_total).toBeGreaterThanOrEqual(300);
  }, 60_000);

  // Windows has no signal to deliver: kill("SIGINT") ends the process outright.
  it.skipIf(process.platform === "win32")("Ctrl-C cancels every attempt; none is selectable or applied", async () => {
    const root = await project(ROLES);
    script.writes = { m1: "ok\n", m2: "ok\n", m3: "ok\n" };
    script.hold = { m1: 60_000, m2: 60_000, m3: 60_000 };
    const c = spawn(process.execPath, [GNOMON, "task", "write out.txt", "--attempts", "3", "--yes", "--apply", "--json", "--dir", root], {
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    const until = Date.now() + 30_000;
    while (seen.filter((x) => x.second).length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    c.kill("SIGINT");
    await new Promise((r) => c.on("close", r));
    const rep = JSON.parse(out);
    expect(rep.attempts.every((a: any) => a.status === "cancelled")).toBe(true);
    expect(rep.chosen).toBeNull();
    expect(existsSync(join(root, "out.txt"))).toBe(false);
  }, 90_000);
});
