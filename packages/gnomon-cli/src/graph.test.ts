/**
 * gnomon-cli: `gnomon task --graph <file>` (graph_run.ts, CONTRACTS §64)
 *
 * Real `gnomon task` children against a scripted fake OpenAI endpoint. Each
 * node's instruction carries "NODE:<id>", so the script says what that node
 * writes on its first try and on its retry (a retry's instruction says the
 * previous attempt "did not pass").
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });

const GNOMON = join(dirname(fileURLToPath(import.meta.url)), "..", "gnomon.js");

interface Write { path: string; content: string }
/** Per node: what it writes on its first try, and on its retry (default: the same). */
let script: Record<string, { first: Write; retry?: Write }>;
const seen: Array<{ node: string; retry: boolean; text: string }> = [];
/** Called when a node's tool result comes back (its file is written): a side effect on the operator's repository. */
let onWritten: ((node: string) => void) | undefined;
let server: Server;
let base = "";
const made: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}") as { messages: Array<{ role: string; content: unknown }> };
      const user = JSON.stringify(j.messages.filter((m) => m.role === "user").map((m) => m.content));
      const node = /NODE:([A-Za-z0-9_-]+)/.exec(user)?.[1] ?? "?";
      const retry = user.includes("did not pass");
      const reply = (message: object, finish: string) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      };
      if (j.messages.some((m) => m.role === "tool")) {
        onWritten?.(node);
        return reply({ role: "assistant", content: "done" }, "stop");
      }
      seen.push({ node, retry, text: user });
      const s = script[node];
      const w = (retry ? s?.retry : undefined) ?? s?.first ?? { path: "junk.txt", content: "x\n" };
      reply(
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify(w) } }] },
        "tool_calls"
      );
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

async function project(policyExtra = ""): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-graph-test-")));
  made.push(root);
  await initSurface({ dir: root, noVerify: true });
  const g = join(root, ".gnomon");
  writeFileSync(
    join(g, "config.toml"),
    `[routing]\nmode = "manual"\ndefault = "a"\n\n[defaults]\nstream = false\n\n[resilience]\nattempts = 1\nrequest_timeout_ms = 60000\n\n` +
      `[endpoints.local]\nurl = "${base}/v1/chat/completions"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(join(g, "roles.toml"), `[roles.a]\nmodel = "m1"\nendpoint = "local"\ntools = ["write"]\nmax_steps = 4\n`);
  writeFileSync(join(g, "policy.toml"), `[approval]\ngate = "on_write"\n\n${policyExtra}`);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/** A graph file outside the repository (it is not part of the change). */
function graphFile(text: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-graph-file-")));
  made.push(d);
  const p = join(d, "graph.toml");
  writeFileSync(p, text);
  return p;
}

const node = (id: string, check: string, extra = "") =>
  `[nodes.${id}]\ninstruction = "NODE:${id} write ${id}.txt"\nfiles = ["${id}.txt"]\ncheck = "${check}"\n${extra}\n`;

interface Run { code: number | null; out: string; err: string; json: any }
function gnomon(root: string, args: string[]): Promise<Run> {
  return new Promise((done) => {
    const c = spawn(process.execPath, [GNOMON, "task", ...args, "--json", "--dir", root], {
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

function events(root: string): any[] {
  const dir = join(root, ".gnomon-audit");
  const f = readdirSync(dir).find((x) => x.startsWith("graph-"))!;
  return readFileSync(join(dir, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "attempt_event");
}

const status = (r: Run) => Object.fromEntries(r.json.nodes.map((n: any) => [n.id, n.status]));

beforeEach(() => {
  seen.length = 0;
  script = {};
  onWritten = undefined;
});

/** A check that sleeps only on the merged tree (the coordinator clone is <run>/integrate). */
// 120 s, far above every bound below: a run that waited for it cannot pass by being merely slow
// (Windows runners take ~40 s for the rest of the run).
const SLOW_ON_MERGE = `case \\"$PWD\\" in */integrate) sleep 120;; esac; true`;
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe("gnomon task --graph", () => {
  it("runs two independent nodes in parallel, starts the dependent from their merged work, integrates and applies", async () => {
    const root = await project();
    script = {
      a: { first: { path: "a.txt", content: "A\n" } },
      b: { first: { path: "b.txt", content: "B\n" } },
      // c's check passes only if its clone already holds a's and b's work.
      c: { first: { path: "c.txt", content: "C\n" } },
    };
    const g = graphFile(
      node("a", "grep -q A a.txt") + node("b", "grep -q B b.txt") + node("c", "grep -q A a.txt && grep -q B b.txt && grep -q C c.txt", `deps = ["a", "b"]`)
    );
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.schema).toBe("gnomon.graph/1");
    expect(status(r)).toEqual({ a: "done", b: "done", c: "done" });
    expect(r.json.nodes.every((n: any) => n.tries === 1)).toBe(true);
    expect(r.json.integration.merged).toEqual(["a", "b", "c"]);
    expect(r.json.integration.failed).toEqual([]);
    expect(r.json.integration.checks.map((c: any) => c.node)).toEqual(["a", "b", "c"]);
    expect(r.json.verified).toBe(true);
    expect(r.json.applied).toBe(true);
    for (const [f, v] of [["a.txt", "A\n"], ["b.txt", "B\n"], ["c.txt", "C\n"]]) {
      expect(readFileSync(join(root, f!), "utf-8").replace(/\r\n/g, "\n")).toBe(v);
    }
    // Applied as an ordinary, uncommitted change.
    expect(git(root, "status", "--porcelain", "--", ".", ":(exclude).gnomon-*").stdout).toContain("c.txt");
    // a and b both started before either was judged; c only after both.
    const ev = events(root);
    const at = (e: string, n: string) => ev.findIndex((x) => x.event === e && x.node === n);
    expect(at("spawn", "a")).toBeLessThan(at("check", "a"));
    expect(at("spawn", "b")).toBeLessThan(Math.min(at("check", "a"), at("check", "b")));
    expect(at("spawn", "c")).toBeGreaterThan(Math.max(at("check", "a"), at("check", "b")));
    expect(ev.map((x) => x.event)).toEqual(expect.arrayContaining(["plan", "merge", "integrate", "apply"]));
    // Every field the run writes is one the published audit schema declares for attempt_event.
    const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "audit_record_schema.json"), "utf-8"));
    const k = schema.kinds.attempt_event;
    const known = new Set([...Object.keys(schema.envelope.required), ...Object.keys(schema.envelope.optional), ...Object.keys(k.required), ...Object.keys(k.optional)]);
    for (const x of ev) for (const f of Object.keys(x)) expect(known.has(f), `${x.event}.${f}`).toBe(true);
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "graph.json"), "utf-8"));
    for (const x of ev) expect(fixture.audit.events).toContain(x.event);
  }, 180_000);

  it("a node whose check fails gets one retry told what the check printed, then passes", async () => {
    const root = await project();
    script = { a: { first: { path: "a.txt", content: "wrong\n" }, retry: { path: "a.txt", content: "A\n" } } };
    const g = graphFile(node("a", "grep -q A a.txt || { echo MISSING-A-MARKER; exit 1; }"));
    const r = await gnomon(root, ["--graph", g, "--yes"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.nodes[0]).toMatchObject({ id: "a", status: "done", tries: 2, check_exit: 0 });
    const retry = seen.find((s) => s.node === "a" && s.retry)!;
    expect(retry.text).toContain("MISSING-A-MARKER");
    expect(events(root).map((x) => x.event)).toContain("retry");
    // Verified but not applied without --apply.
    expect(r.json.verified).toBe(true);
    expect(r.json.applied).toBe(false);
    expect(r.json.not_applied).toContain("without --apply");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  }, 120_000);

  it("rejects a node that changes files outside its allow-list, even when its check passes", async () => {
    const root = await project();
    script = { a: { first: { path: "z.txt", content: "A\n" } } };
    const g = graphFile(node("a", "true"));
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.nodes[0]).toMatchObject({ status: "rejected", tries: 2, outside: ["z.txt"], check_exit: 0 });
    const retry = seen.find((s) => s.retry)!;
    expect(retry.text).toContain("z.txt");
    expect(r.json.verified).toBe(false);
    expect(r.json.applied).toBe(false);
    expect(existsSync(join(root, "z.txt"))).toBe(false);
    const rej = events(root).find((x) => x.event === "reject");
    expect(rej).toMatchObject({ node: "a", paths: ["z.txt"] });
  }, 120_000);

  it("a node that still fails after its retry skips its dependents; independent nodes carry on and are never applied as a partial graph", async () => {
    const root = await project();
    script = {
      a: { first: { path: "a.txt", content: "wrong\n" } },
      b: { first: { path: "b.txt", content: "B\n" } },
    };
    const g = graphFile(node("a", "grep -q A a.txt") + node("b", "grep -q B b.txt") + node("c", "true", `deps = ["a"]`));
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(status(r)).toEqual({ a: "failed", b: "done", c: "skipped" });
    expect(r.json.nodes[2].reason).toContain("dependency a");
    expect(r.json.nodes[2].tries).toBe(0);
    expect(seen.some((s) => s.node === "c")).toBe(false);
    expect(r.json.integration.merged).toEqual(["b"]);
    expect(r.json.verified).toBe(false);
    expect(r.json.applied).toBe(false);
    expect(existsSync(r.json.patch)).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(events(root).find((x) => x.event === "skip")).toMatchObject({ node: "c" });
  }, 120_000);

  it("reports a merge conflict between two nodes by name and resolves nothing", async () => {
    const root = await project();
    script = {
      a: { first: { path: "shared.txt", content: "from a\n" } },
      b: { first: { path: "shared.txt", content: "from b\n" } },
    };
    const g = graphFile(
      `[nodes.a]\ninstruction = "NODE:a"\nfiles = ["shared.txt"]\ncheck = "test -f shared.txt"\n\n[nodes.b]\ninstruction = "NODE:b"\nfiles = ["shared.txt"]\ncheck = "test -f shared.txt"\n`
    );
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(status(r)).toEqual({ a: "done", b: "done" });
    expect(r.json.integration.conflict).toEqual({ node: "b", with: ["a"], paths: ["shared.txt"] });
    expect(r.json.patch).toBeNull();
    expect(r.json.applied).toBe(false);
    expect(existsSync(join(root, "shared.txt"))).toBe(false);
  }, 120_000);

  it("judges a non-ASCII path by its real name (git -z), not git's quoted form", async () => {
    const root = await project();
    script = { a: { first: { path: "\u00e4.txt", content: "A\n" } } };
    const g = graphFile(`[nodes.a]\ninstruction = "NODE:a"\nfiles = ["\u00e4.txt"]\ncheck = "true"\n`);
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.nodes[0]).toMatchObject({ status: "done", tries: 1, outside: [], changed: ["\u00e4.txt"] });
    expect(r.json.applied).toBe(true);
    expect(existsSync(join(root, "\u00e4.txt"))).toBe(true);
  }, 120_000);

  it("does not apply when the operator's HEAD moved during the run", async () => {
    const root = await project();
    script = { a: { first: { path: "a.txt", content: "A\n" } } };
    onWritten = () => {
      if (existsSync(join(root, "other.txt"))) return;
      writeFileSync(join(root, "other.txt"), "o\n");
      git(root, "add", "other.txt");
      git(root, "commit", "-q", "-m", "meanwhile");
    };
    const g = graphFile(node("a", "grep -q A a.txt"));
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.verified).toBe(true);
    expect(r.json.applied).toBe(false);
    expect(r.json.not_applied).toContain("HEAD moved");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  }, 120_000);

  it("skips transitive dependents to a fixpoint, each naming the dep that will not finish", async () => {
    const root = await project();
    script = { a: { first: { path: "a.txt", content: "wrong\n" } } };
    // d is declared before c, its dep: one pass in file order would leave d for the end-of-run sweep.
    const g = graphFile(node("a", "grep -q A a.txt") + node("d", "true", `deps = ["c"]`) + node("c", "true", `deps = ["a"]`));
    const r = await gnomon(root, ["--graph", g, "--yes"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(status(r)).toEqual({ a: "failed", d: "skipped", c: "skipped" });
    expect(r.json.nodes.find((n: any) => n.id === "c").reason).toBe("dependency a ended failed");
    expect(r.json.nodes.find((n: any) => n.id === "d").reason).toBe("dependency c was skipped");
  }, 120_000);

  it("the wall-clock budget also stops a check running on the merged tree", async () => {
    const root = await project(`[attempts]\nmax_wall_seconds = 4\n`);
    script = { a: { first: { path: "a.txt", content: "A\n" } } };
    const g = graphFile(node("a", SLOW_ON_MERGE));
    const t0 = Date.now();
    const r = await gnomon(root, ["--graph", g, "--yes", "--apply"]);
    expect(Date.now() - t0).toBeLessThan(90_000);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.budget_stop).toContain("max_wall_seconds = 4");
    expect(r.json.verified).toBe(false);
    expect(r.json.applied).toBe(false);
    expect(r.json.integration.error).toContain("budget");
  }, 180_000);

  it.skipIf(process.platform === "win32")("Ctrl-C during integration stops its checks, reports (exit 1) and cleans the run dir", async () => {
    const root = await project();
    script = { a: { first: { path: "a.txt", content: "A\n" } } };
    const g = graphFile(node("a", SLOW_ON_MERGE));
    const c = spawn(process.execPath, [GNOMON, "task", "--graph", g, "--yes", "--apply", "--json", "--dir", root], {
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    const until = Date.now() + 30_000;
    const merged = () => {
      try {
        const dir = join(root, ".gnomon-audit");
        const f = readdirSync(dir).find((x) => x.startsWith("graph-"));
        return f ? readFileSync(join(dir, f), "utf-8").includes('"event":"merge"') : false;
      } catch {
        return false;
      }
    };
    while (!merged() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    c.kill("SIGINT");
    const code = await new Promise((r) => c.on("close", r));
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(code).toBe(1);
    const rep = JSON.parse(out);
    expect(rep.reason).toBe("interrupted");
    expect(rep.applied).toBe(false);
    expect(existsSync(join(rep.run_dir, "integrate"))).toBe(false);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  }, 90_000);

  it("refuses a graph with a node that has no check, before anything runs", async () => {
    const root = await project();
    const g = graphFile(node("a", "true") + `[nodes.b]\ninstruction = "NODE:b"\nfiles = ["b.txt"]\n`);
    const r = await gnomon(root, ["--graph", g, "--yes"]);
    expect(r.code).toBe(10);
    expect(r.json.reason).toContain("[nodes.b]: needs a check");
    expect(r.json.nodes).toEqual([]);
    expect(seen).toHaveLength(0);
  }, 60_000);

  it("refuses --graph together with task text", async () => {
    const root = await project();
    const g = graphFile(node("a", "true"));
    const r = await gnomon(root, ["do something", "--graph", g]);
    expect(r.code).toBe(10);
    expect(r.err).toContain("--graph takes its instructions from the graph file");
    expect(seen).toHaveLength(0);
  }, 60_000);
});
