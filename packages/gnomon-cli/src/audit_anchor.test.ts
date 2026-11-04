/**
 * `[audit.anchor]` at the command line, end to end: `gnomon task` seals its
 * trail and checkpoint, exits, and a DETACHED `gnomon audit anchor
 * --background` delivers both heads to the witness after it; `gnomon audit
 * verify` then reads them back, and names the re-chain once the trail is
 * rewritten. The witness is a local bare repository and the model a local
 * HTTP stub: nothing here leaves the machine.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordHash, type AuditRecord } from "gnomon-core";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

let server: Server;
let base = "";
let root = "";
let remote = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "stub", message: { role: "assistant", content: "done" }, done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "gnomon-cli-anchor-"));
  remote = join(root, "..", `${root.split(/[\\/]/).pop()}-witness.git`);
  const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf-8" });
  git("init", "--bare", "-q", remote);
  git("--git-dir", remote, "config", "receive.denyNonFastForwards", "true");
  git("--git-dir", remote, "config", "receive.denyDeletes", "true");
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(
    ".gnomon/config.toml",
    `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "${base}/api/chat"\nkind = "ollama"\n\n` +
      `[audit]\nenabled = true\n\n[audit.anchor]\nbackend = "git"\nremote = "${remote.replace(/\\/g, "/")}"\n`
  );
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", "x\n");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

/** The CLI in a child process; async, because the model stub lives in this one. */
function gnomon(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args, "--dir", root], {
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

async function anchoredLines(timeoutMs: number): Promise<string[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = spawnSync("git", ["--git-dir", remote, "log", "--format=%H", "refs/heads/gnomon-anchors"], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout
        .trim()
        .split("\n")
        .flatMap((c) => spawnSync("git", ["--git-dir", remote, "show", `${c}:anchors.jsonl`], { encoding: "utf-8" }).stdout.trim().split("\n"));
    }
    if (Date.now() > until) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("gnomon task → detached delivery → gnomon audit verify", () => {
  it("anchors the task's heads after the task exits, and verify names a later re-chain", async () => {
    const t = await gnomon(["task", "go", "--role", "implement", "--yes", "--trust"]);
    expect(t.code, t.stderr).toBe(0);

    // Delivered by the detached process, after `gnomon task` returned. The
    // task was trusted by --trust, which the child is handed: it could not
    // read it from the store.
    const lines = await anchoredLines(45_000);
    const trails = lines.map((l) => (JSON.parse(l) as { trail: string }).trail);
    expect(trails.some((x) => /^\.gnomon-audit\/task-.*\.jsonl$/.test(x))).toBe(true);
    expect(trails.some((x) => /checkpoints\/checkpoint-/.test(x))).toBe(true);

    // Reaching the witness is a grant: an untrusted surface's verify does not.
    let v = await gnomon(["audit", "verify"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toMatch(/\[audit\.anchor\] is a grant this machine's user has not accepted/);
    expect(v.stdout).not.toMatch(/external anchor:/);

    v = await gnomon(["audit", "verify", "--trust"]);
    expect(v.code, v.stdout + v.stderr).toBe(0);
    expect(v.stdout).toMatch(/external anchor: git, .* read from the remote/);
    expect(v.stdout).toMatch(/external anchor: ANCHORED — matches 1 anchor/);

    // The ninth attack: edit one record and recompute every hash after it.
    const audit = join(root, ".gnomon-audit");
    const name = readdirSync(audit).find((f) => f.startsWith("task-"))!;
    const file = join(audit, name);
    const rs = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    rs[1]!.role = "root";
    let prev: string | null = null;
    for (const r of rs) {
      r.prev = prev;
      delete r.hash;
      r.hash = recordHash(r);
      prev = r.hash;
    }
    writeFileSync(file, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    v = await gnomon(["audit", "verify", name, "--trust"]);
    expect(v.code).toBe(1);
    expect(v.stdout).toMatch(new RegExp(`${name.replace(/\./g, "\\.")}: \\d+ records — chain intact, sealed`));
    expect(v.stderr).toMatch(/external anchor: RE-CHAINED — seq \d+ was anchored as [0-9a-f]{12}…, the trail now holds [0-9a-f]{12}… \(anchored 20\d\d-.*, git [0-9a-f]{12}\)\. The change is in seq 0–\d+ and was made after that anchor/);

    // `gnomon audit anchor` with nothing queued says so.
    const a = await gnomon(["audit", "anchor", "--trust"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(/Nothing queued/);
  }, 120_000);
});
