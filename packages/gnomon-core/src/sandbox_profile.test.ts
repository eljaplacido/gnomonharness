/**
 * `[sandbox] profile = "container"`, docs/CONTRACTS.md §40,
 * conformance/sandbox_profile.json.
 *
 * - The fixture and the code agree; the key is known to the surface audit;
 *   CONTRACTS §40 names it. A value outside the enumeration is fatal.
 * - In a run: the network filter, the /tmp refusal of the file tools and the
 *   /bin/sh shell are gone, the command env carries PAGER/TQDM/PIP, the soft
 *   shell is on -- and the surface, the trail and outside-root writes
 *   elsewhere are still refused. Undeclared, the same script is refused as on
 *   master. session_start.resolved.sandbox_profile names what was relaxed.
 * - A timed-out command may be re-run, and is still killed with its whole
 *   process group.
 * - The pin: turned on by a reload mid-session, it is a loosening, not applied.
 *
 * Every server here is a fake on 127.0.0.1; no model is called.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "./prompt_loop.js";
import { BLOCK_KEYS, auditSurface, loadConfig, type GnomonConfig } from "./config.js";
import {
  CONTAINER_ENV,
  CONTAINER_KEEPS,
  CONTAINER_RELAXES,
  CONTAINER_BASH_SENTENCE,
  SANDBOX_PROFILES,
  SCAFFOLD_SH_SENTENCE,
  containerBashDescription,
  containerShell,
  resolveSandboxProfile,
  sandboxProfileRecord,
} from "./sandbox_profile.js";
import { resolveSoftTimeout } from "./soft_shell.js";
import { buildToolSet, commandEnv, executeTool, type ToolContext } from "./tools.js";
import { applySandboxPin, pinSandbox } from "./sandbox_pin.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/sandbox_profile.json"), "utf-8"));
const posix = process.platform !== "win32";

let servers: Server[] = [];
const cleanup: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of cleanup.splice(0)) rmSync(r, { recursive: true, force: true });
});

const surface = (sandbox: Record<string, unknown>, tools: Array<Record<string, unknown>> = []) =>
  ({
    gnomonDir: "/x/.gnomon",
    config: { endpoints: { e: { url: "https://x.example/v1/chat/completions", kind: "openai" } } },
    policy: { sandbox },
    roles: { r: { model: "m", endpoint: "e" } },
    tools: { tools },
    system: { content: "be brief\n" },
  }) as unknown as GnomonConfig;

describe("conformance/sandbox_profile.json", () => {
  it("the code's values, relaxations, keeps, env and record keys are the fixture's", () => {
    expect([...SANDBOX_PROFILES]).toEqual(FIXTURE.values);
    expect(resolveSandboxProfile(surface({}))).toBe(FIXTURE.default);
    expect([...CONTAINER_RELAXES]).toEqual(FIXTURE.relaxes);
    expect([...CONTAINER_KEEPS]).toEqual(FIXTURE.keeps);
    expect({ ...CONTAINER_ENV }).toEqual(FIXTURE.env);
    const rec = sandboxProfileRecord(surface({ profile: "container" }))!;
    expect(Object.keys(rec)).toEqual(FIXTURE.session_start.keys);
    expect(BLOCK_KEYS.find(([f, b]) => f === "policy.toml" && b === "sandbox")![2]).toContain("profile");
  });

  it("CONTRACTS §40 names the key, values, relaxations, keeps, env and the fixture", () => {
    const contracts = readFileSync(join(REPO, "docs/CONTRACTS.md"), "utf-8");
    const s40 = contracts.split("\n## 40.")[1]!.split("\n## 41.")[0]!;
    for (const w of [
      "[sandbox] profile",
      ...FIXTURE.values,
      ...FIXTURE.relaxes,
      ...FIXTURE.keeps,
      ...Object.keys(FIXTURE.env),
      ...FIXTURE.session_start.keys,
      "sandbox_profile",
      "conformance/sandbox_profile.json",
    ]) {
      expect(s40, w).toContain(w);
    }
  });
});

describe("resolution and the surface audit", () => {
  const problems = (sandbox: Record<string, unknown>, tools: Array<Record<string, unknown>> = []) =>
    auditSurface(surface(sandbox, tools)).filter((p) => /\[sandbox\] profile|soft_timeout/.test(p.where));

  it("undeclared or default is the default; a value outside the enumeration is fatal", () => {
    expect(resolveSandboxProfile(surface({}))).toBe("default");
    expect(resolveSandboxProfile(surface({ profile: "default" }))).toBe("default");
    expect(resolveSandboxProfile(surface({ profile: "container" }))).toBe("container");
    expect(problems({ profile: "default" })).toEqual([]);
    expect(problems({ profile: "container" })).toEqual([]);
    expect(problems({ profile: "docker" }).map((p) => p.fatal)).toEqual([true]);
  });

  it("beside exec = docker, and beside a declared soft_timeout = kill, it is said, not fatal", () => {
    expect(problems({ profile: "container", exec: "docker" }).map((p) => p.fatal)).toEqual([false]);
    const kill = [{ name: "bash", description: "b", enabled: true, soft_timeout: "kill" }];
    expect(problems({ profile: "container" }, kill).map((p) => p.fatal)).toEqual([false]);
  });

  it("the soft shell is on unless bash declares soft_timeout; the record lists it only when it applied", () => {
    const bash = [{ name: "bash", description: "b", enabled: true }];
    expect(resolveSoftTimeout(surface({}, bash))).toBe("kill");
    expect(resolveSoftTimeout(surface({ profile: "container" }, bash))).toBe("handle");
    const kill = [{ ...bash[0], soft_timeout: "kill" }];
    expect(resolveSoftTimeout(surface({ profile: "container" }, kill))).toBe("kill");
    expect(sandboxProfileRecord(surface({ profile: "container" }, bash))!.relaxed).toContain("soft_shell");
    expect(sandboxProfileRecord(surface({ profile: "container" }, kill))!.relaxed).not.toContain("soft_shell");
    expect(sandboxProfileRecord(surface({}, bash))).toBeUndefined();
  });

  it("the shell: /bin/bash when present, else /bin/sh; the scaffold sentence follows it", () => {
    if (posix) {
      expect(containerShell(() => true)).toBe("/bin/bash");
      expect(containerShell(() => false)).toBe("/bin/sh");
    } else {
      expect(containerShell(() => true)).toBeNull();
    }
    const scaffold = `${SCAFFOLD_SH_SENTENCE} Runs in the project root every time.`;
    expect(containerBashDescription(scaffold, "/bin/bash")).toBe(`${CONTAINER_BASH_SENTENCE} Runs in the project root every time.`);
    expect(containerBashDescription(scaffold, "/bin/sh")).toBe(scaffold);
    expect(containerBashDescription("my own words", "/bin/bash")).toBe("my own words");
  });

  it("buildToolSet: job beside bash and the bash description only under the profile; default is master's", () => {
    const tools = [{ name: "bash", description: `${SCAFFOLD_SH_SENTENCE} x`, enabled: true }];
    const plain = buildToolSet(surface({}, tools)).schemas;
    expect(plain.map((s) => s.function.name)).toEqual(["bash"]);
    expect(plain[0]!.function.description).toBe(`${SCAFFOLD_SH_SENTENCE} x`);
    const cn = buildToolSet(surface({ profile: "container" }, tools)).schemas;
    expect(cn.map((s) => s.function.name)).toEqual(["bash", "job"]);
    expect(cn[0]!.function.description).toBe(
      containerShell() === "/bin/bash" ? `${CONTAINER_BASH_SENTENCE} x` : `${SCAFFOLD_SH_SENTENCE} x`
    );
  });

  it("commandEnv: PAGER, TQDM_DISABLE and PIP_PROGRESS_BAR only under the profile", () => {
    const base = { PATH: "/usr/bin", PAGER: "less" };
    expect(commandEnv({ agentSession: "s" }, base)).toMatchObject({ PAGER: "less" });
    expect(commandEnv({ agentSession: "s" }, base).TQDM_DISABLE).toBeUndefined();
    expect(commandEnv({ agentSession: "s", containerNative: true }, base)).toMatchObject({
      PAGER: "cat",
      TQDM_DISABLE: "1",
      PIP_PROGRESS_BAR: "off",
      PATH: "/usr/bin",
    });
  });
});

describe("the pin", () => {
  it("turned on by a reload is a loosening and is not applied; turned off is applied", () => {
    const off = surface({ network: false });
    const on = surface({ network: false, profile: "container" });
    const pinOff = pinSandbox(off);
    const a = applySandboxPin(pinOff, on, "r");
    expect(a.container).toBe(false);
    expect(a.loosened).toContain('profile = "container" (pinned: "default")');
    const pinOn = pinSandbox(on);
    expect(applySandboxPin(pinOn, on, "r").container).toBe(true);
    const b = applySandboxPin(pinOn, off, "r");
    expect(b.container).toBe(false);
    expect(b.loosened).toEqual([]);
    // and stays off: the ratchet
    expect(applySandboxPin(pinOn, on, "r").container).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------

type Step = [string, Record<string, unknown>];

async function run(policy: string, steps: Step[]) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const n = raws.length;
      const step = steps[n - 1];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          step
            ? {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [{ id: `c${n}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }
            : { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
        )
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-cn-run-"));
  cleanup.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[turn]\nnudge_after_idle = 0\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["bash", "write", "read"]\nmax_steps = 40\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[approval]\ngate = "never"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\n${policy}`);
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "bash"\ndescription = "${SCAFFOLD_SH_SENTENCE.replace(/"/g, '\\"')}"\nenabled = true\n\n` +
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "write"\ndescription = "Write a file."\nenabled = true\n`
  );
  const rec = await runTask(loadConfig(root), "probe the container", { role: "smol", yes: true, stderr: { write() {} } });
  /** The tool result the model was given for step i (0-based). */
  const result = (i: number): string => {
    const msgs = JSON.parse(raws[i + 1]!).messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    return msgs.find((m) => m.role === "tool" && m.tool_call_id === `c${i + 1}`)!.content;
  };
  const dir = join(root, ".gnomon-audit");
  const audit = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];
  return { raws, rec, result, audit, root, tools: JSON.parse(raws[0]!).tools as Array<{ function: { name: string; description: string } }> };
}

describe.skipIf(!posix)("in a run: the container profile relaxes the environment, never integrity", () => {
  const scratch = () => {
    const d = mkdtempSync(join("/tmp", "gnomon-cn-scratch-"));
    cleanup.push(d);
    return d;
  };
  const steps = (tmp: string): Step[] => [
    ["bash", { command: "curl -s --max-time 1 http://example.invalid/ ; echo net-ran" }],
    ["write", { path: join(tmp, "checker.py"), content: "print(1)\n" }],
    ["bash", { command: 'echo "env=$PAGER,$TQDM_DISABLE,$PIP_PROGRESS_BAR shell=${BASH_VERSION:+bash}"' }],
    ["write", { path: ".gnomon/policy.toml", content: "[sandbox]\nlevel = \"off\"\n" }],
    ["write", { path: "/var/lib/gnomon-cn-outside-not-tmp.txt", content: "x" }],
  ];

  it("container: curl runs, /tmp is writable by the file tools, bash and the env are the container's", async () => {
    const tmp = scratch();
    const r = await run('profile = "container"\n', steps(tmp));
    expect(r.result(0)).not.toMatch(/^Refused/);
    expect(r.result(0)).toContain("net-ran");
    expect(r.result(1)).not.toMatch(/Refused/);
    expect(readFileSync(join(tmp, "checker.py"), "utf-8")).toBe("print(1)\n");
    const shell = containerShell();
    expect(r.result(2)).toContain(`env=cat,1,off shell=${shell === "/bin/bash" ? "bash" : ""}`);
    // Integrity stays: the surface and a path outside the root that is not scratch.
    expect(r.result(3)).toMatch(/Refused/);
    expect(readFileSync(join(r.root, ".gnomon", "policy.toml"), "utf-8")).toContain('profile = "container"');
    expect(r.result(4)).toMatch(/Refused|outside/);
    // The schemas: job offered beside bash, bash described as bash where it is.
    expect(r.tools.map((t) => t.function.name)).toContain("job");
    const desc = r.tools.find((t) => t.function.name === "bash")!.function.description;
    expect(desc).toBe(shell === "/bin/bash" ? CONTAINER_BASH_SENTENCE : SCAFFOLD_SH_SENTENCE);
    // The record names the profile, what it relaxed and what it kept.
    const start = r.audit.find((a) => a.kind === "session_start")!;
    expect(start.resolved.sandbox_profile).toEqual({
      name: "container",
      relaxed: [...CONTAINER_RELAXES],
      kept: [...CONTAINER_KEEPS],
      shell,
    });
  });

  it("default: the same script is refused as before, /bin/sh runs it, and the record has no profile", async () => {
    const tmp = scratch();
    const r = await run("", steps(tmp));
    expect(r.result(0)).toMatch(/^Refused: .*reaches the network/);
    expect(r.result(1)).toMatch(/Refused|outside/);
    expect(existsSync(join(tmp, "checker.py"))).toBe(false);
    expect(r.result(2)).not.toContain("env=cat,1,off");
    expect(r.result(2)).toContain("shell=\n");
    expect(r.tools.map((t) => t.function.name)).not.toContain("job");
    expect(r.tools.find((t) => t.function.name === "bash")!.function.description).toBe(SCAFFOLD_SH_SENTENCE);
    const start = r.audit.find((a) => a.kind === "session_start")!;
    expect(start.resolved.sandbox_profile).toBeUndefined();
  });

  it("the profile moves the surface hash", async () => {
    const a = await run("", []);
    const b = await run('profile = "container"\n', []);
    expect(a.rec.surface_hash).toBeTruthy();
    expect(a.rec.surface_hash).not.toBe(b.rec.surface_hash);
  });
});

describe.skipIf(!posix)("a timed-out command under the container profile (kill mode)", () => {
  const ctx = (root: string, over: Partial<ToolContext> = {}): ToolContext => ({
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 400,
    maxOutputBytes: 32_000,
    timedOutCommands: new Set<string>(),
    ...over,
  });

  it("may be run again, where the default refuses it; the whole process group is killed each time", async () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-cn-timeout-"));
    cleanup.push(root);
    const offered = new Set(["bash"]);
    const cmd = "sleep 30 & echo $! > child.pid; wait";
    const childAlive = (): boolean => {
      const pid = Number(readFileSync(join(root, "child.pid"), "utf-8").trim());
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const dflt = ctx(root);
    const d1 = await executeTool("bash", { command: cmd }, dflt, offered);
    expect(d1.content).toContain("timed out");
    const d2 = await executeTool("bash", { command: cmd }, dflt, offered);
    expect(d2.content).toMatch(/^Refused: this exact command already timed out/);

    const cn = ctx(root, { containerNative: true });
    const c1 = await executeTool("bash", { command: cmd }, cn, offered);
    expect(c1.content).toContain("timed out");
    await new Promise((r) => setTimeout(r, 100));
    expect(childAlive()).toBe(false);
    const c2 = await executeTool("bash", { command: cmd }, cn, offered);
    expect(c2.content).not.toMatch(/^Refused/);
    expect(c2.content).toContain("timed out");
    await new Promise((r) => setTimeout(r, 100));
    expect(childAlive()).toBe(false);
  });
});
