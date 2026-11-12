/**
 * gnomon-cli: a model's `pkill -f <a word from the task>` must not reach
 * gnomon (proc_title.ts).
 *
 * Three benchmark cells (2026-11) lost their run this way: gnomon was started
 * as `gnomon task "<task text>"`, the text named the model's own background
 * program (anon.py), and `pkill -f anon.py` matched gnomon's /proc cmdline.
 * These spawn the real CLI against a fake model and read that cmdline while
 * the run is in flight; and they pin `--task-file`, which keeps the text off
 * a wrapper's command line too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processTitleFor, TITLED_COMMANDS } from "./proc_title.js";
import { isGnomonAncestor } from "../../gnomon-core/src/agent_context.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
/** The repo-root convenience shim the published bin tells checkout users to run. */
const ROOT_SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "gnomon");

const made: string[] = [];
let server: Server;
let base = "";
/** Request bodies per mode; `hang` never answers, `answer` says "done". */
const seen = new Map<string, string[]>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const mode = (req.url ?? "").split("/")[1] ?? "";
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.set(mode, [...(seen.get(mode) ?? []), raw]);
      if (mode === "hang") return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function surface(mode: "hang" | "answer"): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-title-"));
  made.push(root);
  mkdirSync(join(root, ".gnomon"));
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[endpoints.target]\nurl = "${base}/${mode}/v1/chat/completions"\nkind = "openai"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\nrequest_timeout_ms = 60000\n`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 2\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  return root;
}

function gnomon(
  args: string[],
  stdin?: string,
  entry: string[] = ["--import", "tsx", CLI]
): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, [...entry, ...args], {
    env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (stdin !== undefined) child.stdin!.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c) => (stdout += c));
  child.stderr!.on("data", (c) => (stderr += c));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) =>
    child.on("close", (code) => r({ code, stdout, stderr }))
  );
  return { child, done };
}

describe("processTitleFor", () => {
  it("names the long-running commands and leaves every other command line alone", () => {
    expect(processTitleFor(["task", "fix anon.py", "--yes"])).toBe("gnomon task");
    expect(processTitleFor(["prompt"])).toBe("gnomon prompt");
    for (const c of TITLED_COMMANDS) expect(processTitleFor([c])).toBe(`gnomon ${c}`);
    expect(processTitleFor(["audit", "verify"])).toBeNull();
    expect(processTitleFor(["--json", "task"])).toBeNull(); // parseArgs reads no command there either
    expect(processTitleFor([])).toBeNull();
  });
});

describe("a running gnomon task's command line", () => {
  // /proc is Linux's; libuv rewrites argv on macOS too, but there is no file to read.
  it.skipIf(process.platform !== "linux")(
    "is \"gnomon task\": the task text is not in /proc/<pid>/cmdline, so pkill -f on a word of it cannot match",
    async () => {
      const root = surface("hang");
      const marker = `anon_${process.pid}_${Date.now().toString(36)}.py`;
      const run = gnomon(["task", `stop the job: pkill -f ${marker} when done`, "--role", "smol", "--dir", root]);
      try {
        for (let i = 0; i < 1200 && (seen.get("hang")?.length ?? 0) === 0 && run.child.exitCode === null; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(run.child.exitCode, "the run ended before its model call").toBeNull();
        const body = seen.get("hang")!.at(-1)!;
        expect(body).toContain(marker); // the model still gets the task
        const cmdline = readFileSync(`/proc/${run.child.pid}/cmdline`, "utf-8");
        expect(cmdline).not.toContain(marker);
        expect(cmdline.replace(/\0+$/, "")).toBe("gnomon task");
        expect(readFileSync(`/proc/${run.child.pid}/comm`, "utf-8").trim()).toBe("gnomon task");
        // And the decision commands still see the harness above them under
        // its title (agent_context.ts check 3): a skill accept from its bash
        // must not read as a person's.
        expect(isGnomonAncestor(cmdline.split("\0").filter(Boolean))).toBe(true);
      } finally {
        run.child.kill("SIGKILL");
        await run.done;
      }
    },
    60_000
  );

  // The repo-root ./gnomon once ran the launcher as a child and waited with
  // the task text in its own argv: `pkill -f` on a word of it then killed the
  // process its caller waits on. What pgrep -f would list is checked here:
  // every process on the box whose cmdline holds the marker.
  it.skipIf(process.platform !== "linux")(
    "through the repo-root ./gnomon, no process carries the task text",
    async () => {
      const root = surface("hang");
      const marker = `anon_shim_${process.pid}_${Date.now().toString(36)}.py`;
      const before = seen.get("hang")?.length ?? 0;
      const run = gnomon(["task", `stop the job: pkill -f ${marker} when done`, "--role", "smol", "--dir", root], undefined, [ROOT_SHIM]);
      try {
        for (let i = 0; i < 2400 && (seen.get("hang")?.length ?? 0) === before && run.child.exitCode === null; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(run.child.exitCode, "the run ended before its model call").toBeNull();
        expect(seen.get("hang")!.at(-1)).toContain(marker);
        const holders = readdirSync("/proc")
          .filter((p) => /^\d+$/.test(p))
          .filter((p) => {
            try {
              return readFileSync(`/proc/${p}/cmdline`, "utf-8").includes(marker);
            } catch {
              return false; // gone, or not ours to read
            }
          });
        expect(holders, `processes whose cmdline holds the task text: ${holders.join(", ")}`).toEqual([]);
        expect(readFileSync(`/proc/${run.child.pid}/cmdline`, "utf-8").replace(/\0+$/, "")).toBe("gnomon task");
      } finally {
        run.child.kill("SIGKILL");
        await run.done;
      }
    },
    120_000
  );
});

describe("gnomon task --task-file", () => {
  it("reads the task from a file, or from stdin with -, and the model gets it verbatim", async () => {
    const root = surface("answer");
    const text = "summarise anon.py's \"--dry-run\" flag & what $HOME means\nsecond line";
    const file = join(root, "task.txt");
    writeFileSync(file, `${text}\n`);
    const fromFile = await gnomon(["task", "--task-file", file, "--role", "smol", "--json", "--dir", root]).done;
    expect(fromFile.code, fromFile.stderr).toBe(0);
    expect(JSON.parse(fromFile.stdout)).toMatchObject({ input: text, stop_reason: "answered" });
    const fromStdin = await gnomon(["task", "--task-file", "-", "--role", "smol", "--json", "--dir", root], text).done;
    expect(fromStdin.code, fromStdin.stderr).toBe(0);
    expect(JSON.parse(fromStdin.stdout)).toMatchObject({ input: text });
    expect(seen.get("answer")!.at(-1)).toContain(JSON.stringify(text).slice(1, -1));
  }, 60_000);

  it("refuses text and a file together, a missing path, and a file it cannot read, with exit 10", async () => {
    const root = surface("answer");
    const both = await gnomon(["task", "do it", "--task-file", join(root, "x.txt"), "--dir", root]).done;
    expect(both.code).toBe(10);
    expect(both.stderr).toMatch(/as text or with --task-file, not both/);
    const bare = await gnomon(["task", "--task-file"]).done;
    expect(bare.code).toBe(10);
    expect(bare.stderr).toMatch(/--task-file needs a path/);
    const missing = await gnomon(["task", "--task-file", join(root, "nope.txt"), "--dir", root]).done;
    expect(missing.code).toBe(10);
    expect(missing.stderr).toMatch(/--task-file .*nope\.txt: ENOENT/);
  }, 60_000);
});
