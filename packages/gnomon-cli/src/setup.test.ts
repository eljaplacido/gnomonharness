/**
 * gnomon-cli: first-run model setup
 *
 * `gnomon launch` with nothing reachable used to start a session that could
 * not answer, and `endpoint add --preset ollama` answered a stopped Ollama
 * with "no list available… Pass --model". These pin the pieces that decide
 * what a first run is told: whether a model answers, which Ollama model is
 * offered first, and what the add flow says when nothing is listening.
 *
 * Every server here is a real one on 127.0.0.1 with a port the kernel picked,
 * and every "nothing is listening" is a port that was just closed -- nothing
 * depends on whether this machine happens to run Ollama.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "gnomon-core";
import { checkReadiness, parseSetupPick, parseModelPick, SETUP_CHOICES, hostPort } from "./setup.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TAGS = {
  models: [
    { name: "bge-m3:latest", details: { parameter_size: "566.70M", family: "bert" } },
    { name: "gemma3:4b", details: { parameter_size: "4.3B", family: "gemma3" } },
    { name: "qwen3.6:35b", details: { parameter_size: "36.0B", family: "qwen3moe" } },
    { name: "qwen3:8b", details: { parameter_size: "8.2B", family: "qwen3" } },
  ],
};

/** A fake Ollama: lists TAGS, answers any chat. Returns its base URL. */
async function fakeOllama(tags: unknown = TAGS): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify(tags));
      if (req.url === "/api/chat") return res.end(JSON.stringify({ message: { content: "ok" }, done: true }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A loopback port with nothing on it: bound, then released. */
async function deadPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** A minimal surface whose `implement` role points at `url` with `model`. */
function project(url: string, model: string): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-setup-"));
  dirs.push(root);
  mkdirSync(join(root, ".gnomon"));
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[endpoints.local]\nurl = "${url}/api/chat"\nkind = "ollama"\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.implement]\nmodel = "${model}"\nendpoint = "local"\n\n[roles.smol]\nmodel = "${model}"\nendpoint = "local"\n`
  );
  return root;
}

describe("checkReadiness — does launch's role have a model that answers?", () => {
  it("is not ready when nothing is listening, and says so with the port", async () => {
    const url = await deadPort();
    const r = await checkReadiness(loadConfig(project(url, "qwen3:8b")), "implement");
    expect(r.ready).toBe(false);
    expect(r.why).toBe(`nothing is listening on ${hostPort(url)}`);
  });

  it("is not ready when only a different tag of the same model is served", async () => {
    // init's placeholder `qwen2.5:14b-instruct` against an Ollama with
    // `qwen2.5:7b` pulled is the same shape: a bare-prefix match would call
    // it served and skip the picker.
    const url = await fakeOllama();
    const r = await checkReadiness(loadConfig(project(url, "qwen3:32b")), "implement");
    expect(r.ready).toBe(false);
    expect(r.why).toContain(`does not serve "qwen3:32b"`);
  });

  it("is not ready when the endpoint answers but does not serve the role's model", async () => {
    // The fresh-repo case with a running Ollama that lacks the starter tag.
    const url = await fakeOllama();
    const r = await checkReadiness(loadConfig(project(url, "qwen2.5:14b-instruct")), "implement");
    expect(r.ready).toBe(false);
    expect(r.why).toContain(`does not serve "qwen2.5:14b-instruct"`);
  });

  it("is not ready when Ollama runs but serves nothing", async () => {
    const url = await fakeOllama({ models: [] });
    const r = await checkReadiness(loadConfig(project(url, "qwen3:8b")), "implement");
    expect(r.ready).toBe(false);
    expect(r.why).toContain("serves no models");
  });

  it("is ready when the model is served, by exact tag or by bare name", async () => {
    const url = await fakeOllama();
    expect((await checkReadiness(loadConfig(project(url, "qwen3.6:35b")), "implement")).ready).toBe(true);
    // `qwen3` is served as `qwen3:8b`; calling that missing would be a false alarm.
    expect((await checkReadiness(loadConfig(project(url, "qwen3")), "implement")).ready).toBe(true);
  });
});

describe("the picker's answers", () => {
  it("takes a number, a name, a prefix, or Enter for the first choice", () => {
    expect(parseSetupPick("")).toBe("ollama");
    expect(parseSetupPick("2")).toBe("openrouter");
    expect(parseSetupPick("OpenRouter")).toBe("openrouter");
    expect(parseSetupPick("open")).toBe("openrouter");
    expect(parseSetupPick("opencode-zen")).toBe("opencode-zen");
    expect(parseSetupPick(String(SETUP_CHOICES.length))).toBe("skip");
    expect(parseSetupPick("skip")).toBe("skip");
  });

  it("says when an answer is not one of them, rather than guessing", () => {
    expect(parseSetupPick("9")).toBeUndefined();
    expect(parseSetupPick("banana")).toBeUndefined();
  });

  it("offers local first and always offers a way out", () => {
    expect(SETUP_CHOICES[0]!.preset).toBe("ollama");
    expect(SETUP_CHOICES.at(-1)!.preset).toBe("skip");
  });

  it("reads a model answer as a list number, a typed tag, or the default", () => {
    const offered = ["qwen3.6:35b", "qwen3:8b"];
    expect(parseModelPick("", offered, "qwen3.6:35b")).toBe("qwen3.6:35b");
    expect(parseModelPick("2", offered, "qwen3.6:35b")).toBe("qwen3:8b");
    expect(parseModelPick("llama3.3:70b", offered, "qwen3.6:35b")).toBe("llama3.3:70b");
  });
});

// ---------------------------------------------------------------------------
// `gnomon endpoint add --preset ollama`, the real CLI, off a terminal.
// ---------------------------------------------------------------------------

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function runCli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    // Async spawn, not spawnSync: the fake Ollama lives in THIS process, and
    // spawnSync would block the event loop it needs to answer on.
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, out }));
  });
}

describe("gnomon endpoint add --preset ollama", () => {
  it("picks from what Ollama serves — init's choice, not the first tag", async () => {
    const url = await fakeOllama();
    const root = project(url, "placeholder:1b");
    const { code, out } = await runCli([
      "endpoint", "add", "--preset", "ollama", "--url", `${url}/api/chat`, "--role", "implement", "--dir", root,
    ]);
    expect(out).not.toContain("no list available");
    expect(code, out).toBe(0);
    // The largest chat model under the ceiling -- what `gnomon init` writes --
    // never bge-m3, which sorts first and cannot chat.
    expect(out).toContain("qwen3.6:35b");
    const roles = readFileSync(join(root, ".gnomon", "roles.toml"), "utf-8");
    expect(roles).toMatch(/\[roles\.implement\][\s\S]*model = "qwen3\.6:35b"/);
  }, 60_000);

  it("says plainly that nothing is listening, and how to start it", async () => {
    const url = await deadPort();
    const root = project(url, "placeholder:1b");
    const before = readFileSync(join(root, ".gnomon", "config.toml"), "utf-8");
    const { code, out } = await runCli([
      "endpoint", "add", "--preset", "ollama", "--url", `${url}/api/chat`, "--dir", root,
    ]);
    expect(code).toBe(1);
    expect(out).toContain(`Nothing is listening on ${hostPort(url)}`);
    expect(out).toContain("ollama serve");
    expect(out).not.toContain("no list available");
    // And nothing was written on the way to failing.
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toBe(before);
  }, 60_000);
});
