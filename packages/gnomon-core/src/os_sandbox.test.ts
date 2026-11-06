/**
 * `[sandbox] exec = "os"` — the bash tool under a kernel sandbox.
 *
 * Two halves.
 *
 * 1. osSandboxPlan's REFUSALS, with the probe injected, so they run on every
 *    platform: each path where the sandbox cannot be applied must refuse and
 *    must never hand back a plan that would run the command on the host.
 *
 * 2. End to end through executeTool("bash"), with the real gnomon-exec from
 *    target/. Every destructive command targets a directory this file created
 *    under the OS temp dir, and the assertion is on that directory's state
 *    afterwards. Each block is paired with a CONTROL: the same command with
 *    exec = "off", which must do the damage -- so a test that passes is a
 *    test that could have failed, in the same run, on the same machine.
 *
 *    Skipped, with the probe's own reason in the skip line, where the kernel
 *    cannot sandbox (no Landlock, or Windows). CI runners differ; a skip must
 *    say why rather than read as a pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync, copyFileSync, chmodSync, appendFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { osSandbox, _resetOsSandbox, type OsSandbox } from "gnomon-natives";
import { executeTool, osSandboxPlan, gnomonInstallReadRoots, gnomonInstallWritable, packageIndexOf, osSandboxEnv, cleanOsSandboxTmp, type ToolContext } from "./tools.js";
import { pinSandbox, applySandboxPin, describeLoosening } from "./sandbox_pin.js";
import { EXEC_VALUES, auditSurface, resolveExec, type GnomonConfig } from "./config.js";
import { homedir } from "node:os";
import { resolve, parse } from "node:path";

const okProbe = (over: Partial<Extract<OsSandbox, { bin: string }>["probe"]> = {}): (() => OsSandbox) => () => ({
  bin: "/opt/gnomon-exec",
  probe: {
    platform: "linux",
    supported: true,
    network_supported: true,
    mechanism: "landlock+seccomp",
    landlock_abi: 6,
    degraded: [],
    not_enforced: [],
    ...over,
  },
});

describe("exec is a published enumeration", () => {
  it("config.ts accepts exactly the values conformance/enumerations_golden.json publishes", () => {
    // Rule 6. Adding "os" to the resolver without publishing it (or the other
    // way round) would make the contract and the behaviour disagree.
    const golden = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", "conformance", "enumerations_golden.json"), "utf8")
    ) as { exec: string[] };
    expect([...EXEC_VALUES]).toEqual(golden.exec);
  });
});

describe("osSandboxPlan — refuses rather than run unsandboxed", () => {
  const base = { root: "/repo", exec: { network: false } };
  const onWindows = process.platform === "win32";

  it.skipIf(onWindows)("refuses when gnomon-exec cannot be found or is too old", () => {
    const r = osSandboxPlan("ls", base, "/bin/sh", () => ({ error: "gnomon native binary not found" }));
    expect("refusal" in r).toBe(true);
    if (!("refusal" in r)) return;
    expect(r.refusal.content).toContain("NOT run");
    expect(r.refusal.content).toContain("gnomon native binary not found");
    expect(r.refusal.summary).toContain("refused");
  });

  it.skipIf(onWindows)("refuses on a kernel without Landlock, and passes the probe's advice on", () => {
    const r = osSandboxPlan("ls", base, "/bin/sh", okProbe({ supported: false, reason: "this kernel has no Landlock" }));
    expect("refusal" in r && r.refusal.content).toContain("this kernel has no Landlock");
  });

  it.skipIf(onWindows)("refuses network = false where only the filesystem half works", () => {
    const probe = okProbe({ network_supported: false, reason: "no seccomp user notification" });
    const r = osSandboxPlan("ls", base, "/bin/sh", probe);
    expect("refusal" in r && r.refusal.content).toContain("network = false cannot be enforced");
    // ...and runs once the network is granted, because then nothing is
    // declared that cannot be enforced.
    const granted = osSandboxPlan("ls", { ...base, network: true }, "/bin/sh", probe);
    expect("file" in granted).toBe(true);
    if ("tmp" in granted) rmSync(granted.tmp, { recursive: true, force: true });
  });

  it.skipIf(!onWindows)("refuses on Windows, naming WSL2, docker and off as the ways forward", () => {
    const r = osSandboxPlan("ls", base, "C:\\Git\\bin\\bash.exe", okProbe());
    expect("refusal" in r).toBe(true);
    if (!("refusal" in r)) return;
    expect(r.refusal.content).toMatch(/WSL2/);
    expect(r.refusal.content).toMatch(/exec = "docker"/);
  });

  it.skipIf(onWindows)("builds an argv: root, a fresh temp dir, existing extra roots, the network flag", () => {
    const extra = mkdtempSync(join(tmpdir(), "gnomon-extra-"));
    try {
      const r = osSandboxPlan(
        "echo 'a b'",
        { root: "/repo", extraRoots: [extra, join(extra, "missing")], exec: { network: false } },
        "/bin/sh",
        okProbe()
      );
      if (!("file" in r)) throw new Error("expected a plan");
      try {
        expect(r.file).toBe("/opt/gnomon-exec");
        expect(r.args.slice(r.args.indexOf("--"))).toEqual(["--", "/bin/sh", "-c", "echo 'a b'"]);
        expect(r.args).toContain(r.tmp);
        expect(r.args).toContain(extra);
        expect(r.args).not.toContain(join(extra, "missing"));
        expect(r.args[r.args.indexOf("--network") + 1]).toBe("off");
        expect(r.env.TMPDIR).toBe(r.tmp);
        expect(existsSync(r.tmp)).toBe(true);
      } finally {
        rmSync(r.tmp, { recursive: true, force: true });
      }
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it.skipIf(onWindows)("the session's /network grant wins over the declaration, both ways", () => {
    const on = osSandboxPlan("x", { root: "/r", network: true, exec: { network: false } }, "/bin/sh", okProbe());
    const off = osSandboxPlan("x", { root: "/r", network: false, exec: { network: true } }, "/bin/sh", okProbe());
    if (!("file" in on) || !("file" in off)) throw new Error("expected plans");
    expect(on.args[on.args.indexOf("--network") + 1]).toBe("on");
    expect(off.args[off.args.indexOf("--network") + 1]).toBe("off");
    rmSync(on.tmp, { recursive: true, force: true });
    rmSync(off.tmp, { recursive: true, force: true });
  });
});

describe("[sandbox] reads and read_roots on the surface", () => {
  const surface = (sandbox: Record<string, unknown>, roles: Record<string, unknown> = {}) =>
    ({ config: {}, policy: { sandbox }, roles, tools: { tools: [] }, gnomonDir: join(tmpdir(), "none", ".gnomon") }) as unknown as GnomonConfig;
  const problems = (sandbox: Record<string, unknown>, roles: Record<string, unknown> = {}) =>
    auditSurface(surface(sandbox, roles)).map((p) => p.problem).join("\n");

  it("resolveExec carries reads as written and read_roots expanded", () => {
    expect(resolveExec(surface({ exec: "os" }))).toMatchObject({ mode: "os", reads: "all", readRoots: [] });
    const ex = resolveExec(surface({ exec: "os", reads: "scoped", read_roots: ["~/.cache/pip", "/opt/sdk", "vendor/cache", 3] }));
    expect(ex.reads).toBe("scoped");
    expect(ex.readRoots).toEqual([join(homedir(), ".cache/pip"), resolve("/opt/sdk"), resolve(tmpdir(), "none", "vendor/cache")]);
    // A typo is kept as written so osSandboxPlan can refuse it by name.
    expect(resolveExec(surface({ exec: "os", reads: "scopd" })).reads).toBe("scopd");
  });

  it("the audit says what a reads setting will do, and never fatally", () => {
    expect(problems({ exec: "os", reads: "scoped" })).toBe("");
    expect(problems({ exec: "os", reads: "scopd" })).toContain("does not fall back");
    expect(problems({ exec: "off", reads: "scoped" })).toContain('only under exec = "os"');
    expect(problems({ reads: "scoped" }, { r: { exec: "os" } })).not.toContain('only under exec = "os"');
    expect(problems({ exec: "os", reads: "scoped", read_roots: "~/.cache/pip" })).toContain("not an array");
    expect(problems({ exec: "os", read_roots: ["/usr"] })).toContain('only under reads = "scoped"');
    expect(problems({ exec: "os", reads: "scoped", read_roots: ["~"] })).toContain("contains your home directory");
    // The filesystem root above the home directory (C:\\ on Windows, / elsewhere).
    expect(problems({ exec: "os", reads: "scoped", read_roots: [parse(resolve(homedir())).root] })).toContain("contains your home directory");
    expect(problems({ exec: "os", reads: "scoped", read_roots: ["/nonexistent-gnomon-read-root"] })).toContain("does not exist");
    expect(auditSurface(surface({ exec: "os", reads: "scopd", read_roots: ["~"] })).every((p) => !p.fatal)).toBe(true);
  });

  it("allow_package_index is inert under exec = \"os\", as under docker, and the audit says so", () => {
    // No per-host allow in the supervisor: the filter refuses the download up
    // front, with the answer the kernel would give later.
    const exec = (mode: "off" | "os" | "docker") => ({ mode, image: "i", network: false });
    expect(packageIndexOf({ exec: exec("off"), packageIndex: ["pypi.org"] })).toEqual(["pypi.org"]);
    expect(packageIndexOf({ exec: exec("os"), packageIndex: ["pypi.org"] })).toEqual([]);
    expect(packageIndexOf({ exec: exec("docker"), packageIndex: ["pypi.org"] })).toEqual([]);
    expect(problems({ network: false, exec: "os", allow_package_index: ["pypi.org"] })).toContain('does not open exec = "os"');
  });
});

describe("osSandboxPlan — reads = \"scoped\"", () => {
  const onWindows = process.platform === "win32";
  const scopedProbe = okProbe({ reads_scoped_supported: true });
  const install = () => ["/opt/gnomon"];

  it.skipIf(onWindows)("passes --reads scoped, the read_roots that exist and the install's own directories", () => {
    const cache = mkdtempSync(join(tmpdir(), "gnomon-readroot-"));
    try {
      const r = osSandboxPlan(
        "ls",
        { root: "/repo", exec: { network: false, reads: "scoped", readRoots: [cache, join(cache, "missing")] } },
        "/bin/sh",
        scopedProbe,
        install
      );
      if (!("file" in r)) throw new Error("expected a plan");
      try {
        const before = r.args.slice(0, r.args.indexOf("--"));
        expect(before[before.indexOf("--reads") + 1]).toBe("scoped");
        const reads = before.flatMap((a, i) => (a === "--read" ? [before[i + 1]] : []));
        expect(reads).toEqual([cache, "/opt/gnomon"]);
      } finally {
        rmSync(r.tmp, { recursive: true, force: true });
      }
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it.skipIf(onWindows)("reads = \"all\" (and no reads at all) passes no read flags", () => {
    for (const exec of [{ network: true }, { network: true, reads: "all", readRoots: ["/x"] }]) {
      const r = osSandboxPlan("ls", { root: "/repo", exec }, "/bin/sh", scopedProbe, install);
      if (!("file" in r)) throw new Error("expected a plan");
      expect(r.args).not.toContain("--reads");
      expect(r.args).not.toContain("--read");
      rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(onWindows)("refuses a misspelt reads value instead of falling back to \"all\"", () => {
    const r = osSandboxPlan("ls", { root: "/repo", exec: { network: true, reads: "scopd" } }, "/bin/sh", scopedProbe, install);
    expect("refusal" in r).toBe(true);
    if (!("refusal" in r)) return;
    expect(r.refusal.content).toContain('reads = "scopd"');
    expect(r.refusal.content).toContain("NOT run");
  });

  it.skipIf(onWindows)("refuses where the platform cannot scope reads, or gnomon-exec predates it", () => {
    const mac = osSandboxPlan(
      "ls",
      { root: "/repo", exec: { network: true, reads: "scoped" } },
      "/bin/sh",
      okProbe({ platform: "macos", reads_scoped_supported: false }),
      install
    );
    expect("refusal" in mac && mac.refusal.content).toContain("Landlock on Linux only");
    const old = osSandboxPlan("ls", { root: "/repo", exec: { network: true, reads: "scoped" } }, "/bin/sh", okProbe(), install);
    expect("refusal" in old && old.refusal.content).toContain("predates it");
  });

  it.skipIf(onWindows)("the install's read roots never include the home directory or anything above it", () => {
    const home = resolve(homedir());
    const roots = gnomonInstallReadRoots(join(home, "bin", "gnomon-exec"), join(home, "x", "dist", "tools.js"));
    for (const r of roots) {
      expect(r === home || home.startsWith(r.endsWith("/") ? r : r + "/"), r).toBe(false);
    }
    // This source tree is a checkout: its root is granted, so `gnomon` and
    // its natives run inside a scoped bash.
    const here = gnomonInstallReadRoots("/nonexistent/gnomon-exec");
    expect(here).toContain(resolve(__dirname, "..", "..", ".."));
  });
});

// ── End to end ──

_resetOsSandbox();
const real = osSandbox();
const skipWhy =
  process.platform === "win32"
    ? "Windows has no OS sandbox"
    : "error" in real
      ? `gnomon-exec unavailable: ${real.error.split("\n")[0]}`
      : !real.probe.supported
        ? `kernel cannot sandbox: ${real.probe.reason}`
        : "";
const netSkipWhy = skipWhy || ("probe" in real && !real.probe.network_supported ? `network half unavailable: ${real.probe.reason}` : "");
const has = (tool: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const label = (name: string, why: string) => (why ? `${name} [SKIPPED: ${why}]` : name);
const linux = process.platform === "linux";

describe("bash under exec = \"os\" — the kernel, not the rules, holds the line", () => {
  let scratch: string;
  let root: string;
  let outside: string;

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 20_000,
    maxOutputBytes: 32_000,
    // PERMISSIVE on purpose: no allow-list, no deny-list. Whatever is
    // stopped below is stopped by the kernel.
    bashAllow: undefined,
    bashDeny: [],
    // network = false where the network half runs (Linux: the supervised
    // path), network = true where it is not offered (macOS), so the
    // filesystem tests still run there; the network tests skip on their own.
    exec: { mode: "os", image: "unused", network: !!netSkipWhy },
    ...over,
  });
  const off = (over: Partial<ToolContext> = {}) => ctx({ exec: { mode: "off", image: "unused", network: false }, ...over });
  const bash = (command: string, c: ToolContext) => executeTool("bash", { command }, c, new Set(["bash"]));

  /** A fresh directory OUTSIDE the root, holding a file to protect. */
  const victim = (name: string): string => {
    const d = join(outside, name);
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "keep.txt"), "keep");
    writeFileSync(join(d, "sub", "deep.txt"), "deep");
    return d;
  };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "gnomon-os-sandbox-"));
    root = join(scratch, "root");
    outside = join(scratch, "outside");
    mkdirSync(root);
    mkdirSync(outside);
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it.skipIf(!!skipWhy)(label("a write outside the root is refused; the control writes", skipWhy), async () => {
    const out = await bash(`echo x > '${outside}/escaped.txt'`, ctx());
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    expect(out.content).toMatch(/Permission denied|Operation not permitted/);

    await bash(`echo x > '${outside}/control.txt'`, off());
    expect(existsSync(join(outside, "control.txt")), "control: exec = off must write").toBe(true);
  });

  it.skipIf(!!skipWhy)(label("rm -rf of a path outside the root deletes nothing; the control deletes", skipWhy), async () => {
    const v = victim("rm");
    await bash(`rm -rf '${v}'`, ctx());
    expect(readFileSync(join(v, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(v, "sub", "deep.txt"), "utf8")).toBe("deep");

    const c = victim("rm-control");
    await bash(`rm -rf '${c}'`, off());
    expect(existsSync(c), "control: exec = off must delete").toBe(false);
  });

  it.skipIf(!!skipWhy || !has("python3"))(
    label("python -c deleting outside the root deletes nothing; the control deletes", skipWhy || (has("python3") ? "" : "no python3")),
    async () => {
      // The case G2b proved no text rule can see: there is no `rm` to match.
      const py = (d: string) => `python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' '${d}'`;
      const v = victim("py");
      const out = await bash(py(v), ctx());
      expect(existsSync(join(v, "keep.txt"))).toBe(true);
      expect(out.content).toContain("PermissionError");

      const c = victim("py-control");
      await bash(py(c), off());
      expect(existsSync(c), "control: exec = off must delete").toBe(false);
    }
  );

  it.skipIf(!!skipWhy)(label("writing inside the root works, and so does the per-call TMPDIR", skipWhy), async () => {
    const out = await bash(
      `mkdir -p a/b && echo in > a/b/f.txt && mv a/b/f.txt a/g.txt && echo t > "$TMPDIR/scratch" && cat "$TMPDIR/scratch" && echo "$TMPDIR"`,
      ctx()
    );
    expect(out.shell_exit, out.content).toBe(0);
    expect(readFileSync(join(root, "a", "g.txt"), "utf8")).toBe("in\n");
    const tmp = /gnomon-sbx-[A-Za-z0-9]+/.exec(out.content)?.[0];
    expect(tmp, out.content).toBeTruthy();
    // Gone once the call returns.
    expect(existsSync(join(tmpdir(), tmp!))).toBe(false);
  });

  describe("network = false", () => {
    let server: Server;
    let port: number;
    beforeEach(async () => {
      server = createServer((_q, r) => r.end("local\n"));
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      port = (server.address() as { port: number }).port;
    });
    afterEach(async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
    });

    const curlWhy = netSkipWhy || (has("curl") ? "" : "no curl");

    it.skipIf(!!curlWhy)(label("curl to an external host fails in the kernel", curlWhy), async () => {
      // A literal address: no DNS, so only the connect itself can refuse. And
      // TEST-NET-1 (RFC 5737), so even an unsandboxed control reaches nobody.
      // --max-time 3 inside a 20 s test: an unrefused connect must fail the
      // ASSERTION below, with curl's own message, not the test runner's clock.
      const out = await bash("curl -sS --max-time 3 http://192.0.2.1/", ctx());
      expect(out.shell_exit).not.toBe(0);
      if (linux) {
        // The supervisor's own line. An offline machine also fails this
        // connect, but never prints this -- so this cannot pass by accident.
        expect(out.content).toContain("blocked connect to 192.0.2.1:80");
      } else {
        expect(out.content).toMatch(/Operation not permitted|Permission denied/);
      }
    }, 20_000);

    it.skipIf(!!curlWhy)(label("curl to a local server succeeds", curlWhy), async () => {
      for (const host of ["127.0.0.1", "localhost"]) {
        const out = await bash(`curl -sS --max-time 5 http://${host}:${port}/`, ctx());
        expect(out.shell_exit, `${host}: ${out.content}`).toBe(0);
        expect(out.content).toContain("local");
      }
    });

    it.skipIf(!!curlWhy)(label("the session's /network on lifts the block", curlWhy), async () => {
      // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so no test run --
      // control or not -- sends a packet to a real host. The request cannot
      // succeed; what is asserted is that the SANDBOX did not refuse it.
      const out = await bash("curl -sS --max-time 1 -o /dev/null http://192.0.2.1/ || true", ctx({ network: true }));
      expect(out.content).not.toContain("blocked connect");
      expect(out.content).not.toMatch(/Operation not permitted/);
    });
  });
});

// ── reads = "scoped", end to end ──
//
// The credential is a FAKE, planted in a fake HOME inside this test's scratch
// directory; no test here touches the real HOME's credentials.

const scopedSkipWhy =
  skipWhy || ("probe" in real && real.probe.reads_scoped_supported !== true ? `reads = scoped unsupported here (${real.probe.platform})` : "");

describe("bash under exec = \"os\", reads = \"scoped\" — credentials stay unreadable, tools keep working", () => {
  let scratch: string;
  let root: string;
  let home: string;
  let cache: string;

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 30_000,
    maxOutputBytes: 32_000,
    bashAllow: undefined,
    bashDeny: [],
    exec: { mode: "os", image: "unused", network: true, reads: "scoped", readRoots: [cache] },
    ...over,
  });
  const off = () => ctx({ exec: { mode: "off", image: "unused", network: true } });
  const all = () => ctx({ exec: { mode: "os", image: "unused", network: true, reads: "all" } });
  const bash = (command: string, c: ToolContext) => executeTool("bash", { command }, c, new Set(["bash"]));
  const inHome = (cmd: string) => `HOME='${home}' sh -c '${cmd}'`;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "gnomon-os-reads-"));
    root = join(scratch, "root");
    home = join(scratch, "home");
    cache = join(scratch, "cache");
    mkdirSync(root);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(cache);
    writeFileSync(join(home, ".ssh", "id_x"), "FAKE-SSH-KEY-gnomon-test\n");
    writeFileSync(join(cache, "pkg.txt"), "cached-package\n");
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it.skipIf(!!scopedSkipWhy)(label("cat ~/.ssh/id_x in a fake HOME is refused; exec = off and reads = all read it", scopedSkipWhy), async () => {
    const out = await bash(inHome("cat ~/.ssh/id_x"), ctx());
    expect(out.content).not.toContain("FAKE-SSH-KEY");
    expect(out.content).toContain("Permission denied");
    for (const control of [off(), all()]) {
      const c = await bash(inHome("cat ~/.ssh/id_x"), control);
      expect(c.content, "control must read the fake key").toContain("FAKE-SSH-KEY");
    }
  });

  it.skipIf(!!scopedSkipWhy || !has("python3"))(
    label("python3 -c open(...) of the fake key is refused; the control reads it", scopedSkipWhy || (has("python3") ? "" : "no python3")),
    async () => {
      const py = `python3 -c "import os; print(open(os.path.join('${home}', '.ssh', 'id_x')).read())"`;
      const out = await bash(py, ctx());
      expect(out.content).not.toContain("FAKE-SSH-KEY");
      expect(out.content).toContain("PermissionError");
      const c = await bash(py, off());
      expect(c.content).toContain("FAKE-SSH-KEY");
    }
  );

  it.skipIf(!!scopedSkipWhy)(label("python, node, git, pip and a compiler still work; a declared read_root is readable", scopedSkipWhy), async () => {
    const steps: [string, string, boolean][] = [
      ["read_roots", `cat '${cache}/pkg.txt'`, true],
      ["git", "git init -q r && cd r && echo x > a && git add a && git -c user.email=t@e.invalid -c user.name=t commit -qm m && git log --oneline | wc -l", has("git")],
      ["python3", "python3 -c 'import json, ssl, sqlite3; print(\"py-ok\")'", has("python3")],
      ["pip", "python3 -m pip --version", has("python3") && (() => { try { execFileSync("python3", ["-m", "pip", "--version"], { stdio: "ignore" }); return true; } catch { return false; } })()],
      ["node", "node -e 'console.log(\"node-ok\")'", has("node")],
      ["cc", 'printf "int main(void){return 0;}" > "$TMPDIR/a.c" && cc "$TMPDIR/a.c" -o "$TMPDIR/a" && "$TMPDIR/a" && echo cc-ok', has("cc")],
    ];
    for (const [name, cmd, present] of steps) {
      if (!present) continue;
      const out = await bash(cmd, ctx());
      expect(out.shell_exit, `${name}: ${out.content}`).toBe(0);
    }
  });
});

// ── Review of PR #156: the findings, each with the test that failed before its fix ──

const surfaceOf = (sandbox: Record<string, unknown>, roles: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ config: {}, policy: { sandbox }, roles, tools: { tools: [] }, gnomonDir: join(tmpdir(), "none", ".gnomon"), ...extra }) as unknown as GnomonConfig;

const bashCtx = (root: string, exec: ToolContext["exec"], over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  sandbox: "confined",
  gate: "never",
  approve: async () => true,
  timeoutMs: 20_000,
  maxOutputBytes: 32_000,
  bashAllow: undefined,
  bashDeny: [],
  exec,
  ...over,
});

describe("finding 1 — the per-call temp dir is cleaned without following a link out of it", () => {
  const why = skipWhy || (has("python3") ? "" : "no python3");

  it.skipIf(!!why)(
    label("a background job swapping a directory for a symlink to a victim deletes nothing outside", why),
    async () => {
      // The PoC: the command backgrounds a racer that RENAME_EXCHANGEs a full
      // directory in $TMPDIR with a symlink to a victim directory OUTSIDE the
      // root, then returns at once. The cleanup that followed (an unsandboxed
      // rmSync) descended into the victim: hundreds of files per run.
      const scratch = mkdtempSync(join(tmpdir(), "gnomon-os-clean-"));
      const root = join(scratch, "root");
      const victim = join(scratch, "victim");
      mkdirSync(root);
      const racer = join(scratch, "racer.py");
      writeFileSync(
        racer,
        [
          "import os, sys, ctypes, time",
          "tmp, victim = sys.argv[1], sys.argv[2]",
          "libc = ctypes.CDLL(None, use_errno=True)",
          "os.chdir(tmp)",
          "os.mkdir('d')",
          "for i in range(200): open(f'd/f{i}', 'w').close()",
          "os.symlink(victim, 's')",
          "end = time.time() + 1.5",
          "while time.time() < end:",
          "    libc.renameat2(-100, b'd', -100, b's', 2)",
        ].join("\n")
      );
      try {
        let lost = 0;
        for (let round = 0; round < 6; round++) {
          mkdirSync(victim, { recursive: true });
          for (let i = 0; i < 200; i++) writeFileSync(join(victim, `f${i}`), "v");
          const out = await executeTool(
            "bash",
            // The sleep lets the racer get going before the call returns; an
            // attacker would wait the same way.
            { command: `python3 '${racer}' "$TMPDIR" '${victim}' >/dev/null 2>&1 & sleep 0.4` },
            bashCtx(root, { mode: "os", image: "unused", network: true }),
            new Set(["bash"])
          );
          expect(out.shell_exit, out.content).toBe(0);
          lost += 200 - readdirSync(victim).length;
          // Let the racer finish before the next round.
          await new Promise((ok) => setTimeout(ok, 1700));
        }
        expect(lost, "files deleted outside the root by gnomon's own cleanup").toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    60_000
  );

  it.skipIf(!!skipWhy)(label("cleanOsSandboxTmp removes the dir and unlinks, never follows, a symlink", skipWhy), () => {
    const scratch = mkdtempSync(join(tmpdir(), "gnomon-os-clean-"));
    try {
      const outside = join(scratch, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      const tmp = join(scratch, "call");
      mkdirSync(join(tmp, "d", "e"), { recursive: true });
      writeFileSync(join(tmp, "d", "e", "f"), "x");
      symlinkSync(outside, join(tmp, "link"));
      symlinkSync(outside, join(tmp, "d", "link"));
      expect(cleanOsSandboxTmp((real as { bin: string }).bin, tmp)).toBe(true);
      expect(existsSync(tmp)).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("finding 2 — gnomon-exec is never taken from a tree the command can write, and is pinned", () => {
  const prior = process.env.GNOMON_BIN_OVERRIDE;
  afterEach(() => {
    if (prior === undefined) delete process.env.GNOMON_BIN_OVERRIDE;
    else process.env.GNOMON_BIN_OVERRIDE = prior;
    _resetOsSandbox();
  });

  it.skipIf(!!skipWhy)(label("a gnomon-exec inside the root is skipped, never run", skipWhy), () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-os-pin-"));
    try {
      // A copy planted in the root -- where a sandboxed command could have
      // written it -- and pointed at as the first candidate.
      mkdirSync(join(root, "bin"));
      copyFileSync((real as { bin: string }).bin, join(root, "bin", "gnomon-exec"));
      chmodSync(join(root, "bin", "gnomon-exec"), 0o755);
      process.env.GNOMON_BIN_OVERRIDE = join(root, "bin");
      _resetOsSandbox();
      const got = osSandbox([root]);
      if ("bin" in got) {
        expect(got.bin.startsWith(realpathSync(root)), got.bin).toBe(false);
      } else {
        expect(got.error).toContain("beneath");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!!skipWhy)(label("a pinned gnomon-exec that changes mid-session is refused", skipWhy), () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-os-pin-"));
    try {
      const bin = join(dir, "gnomon-exec");
      copyFileSync((real as { bin: string }).bin, bin);
      chmodSync(bin, 0o755);
      process.env.GNOMON_BIN_OVERRIDE = dir;
      _resetOsSandbox();
      const first = osSandbox(["/nonexistent-root"]);
      expect("bin" in first && first.bin).toBe(realpathSync(bin));
      appendFileSync(bin, "replaced");
      const second = osSandbox(["/nonexistent-root"]);
      expect("error" in second && second.error).toContain("has changed since this session started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finding 3 — a reload may tighten the pinned sandbox, never loosen it", () => {
  // Real directories: a granted root is pinned by its real path (second
  // review, I), and one that does not exist grants nothing.
  const rootsDir = mkdtempSync(join(tmpdir(), "gnomon-pin-roots-"));
  const [X, Y] = ["x", "y"].map((n) => {
    mkdirSync(join(rootsDir, n));
    return realpathSync(join(rootsDir, n));
  }) as [string, string];
  const start = surfaceOf({ exec: "os", reads: "scoped", read_roots: ["/opt/a"], network: false, level: "confined", extra_roots: [X] });

  it("exec = off, reads = all, network = true, wider roots, level off: none applied, each named", () => {
    const pin = pinSandbox(start);
    const loose = surfaceOf({ exec: "off", reads: "all", read_roots: ["/opt/a", "/opt/b"], network: true, level: "off", extra_roots: [X, Y] });
    const got = applySandboxPin(pin, loose, "implement");
    expect(got.exec).toMatchObject({ mode: "os", reads: "scoped", network: false });
    expect(got.level).toBe("confined");
    expect(got.network).toBe(false);
    expect(got.extraRoots).toEqual([X]);
    expect(got.loosened.join("\n")).toMatch(/exec = "off"[\s\S]*level = "off"|level = "off"[\s\S]*exec = "off"/);
    expect(describeLoosening(pin, loose).length).toBeGreaterThan(0);
    // A role that sets its own exec = "off" is held the same way.
    expect(applySandboxPin(pin, surfaceOf({ exec: "os" }, { r: { exec: "off" } }), "r").exec.mode).toBe("os");
  });

  it("second review, I: a root re-pointed after the session started keeps granting its pinned real path", () => {
    const link = join(rootsDir, "link");
    symlinkSync(X, link);
    const s0 = surfaceOf({ exec: "os", extra_roots: [link], read_roots: [link], reads: "scoped" });
    const pin = pinSandbox(s0);
    // The command re-points the link at something else it would like granted.
    rmSync(link);
    symlinkSync(Y, link);
    const got = applySandboxPin(pin, s0, "implement");
    expect(got.extraRoots).toEqual([X]);
    expect(got.exec.readRoots).toEqual([X]);
    // CONTROL: unpinned, the same surface now names Y.
    expect(realpathSync(link)).toBe(Y);
  });

  it("tightening applies at once and ratchets: off -> os cannot go back to off", () => {
    const pin = pinSandbox(surfaceOf({}));
    expect(applySandboxPin(pin, surfaceOf({ exec: "os" }), "implement").exec.mode).toBe("os");
    expect(applySandboxPin(pin, surfaceOf({}), "implement").exec.mode).toBe("os");
    // A typo refuses bash: tighter than anything, so it applies.
    expect(applySandboxPin(pin, surfaceOf({ exec: "OS" }), "implement").exec.invalid).toBe("OS");
  });
});

describe("finding 5 / 4 — bash's environment under exec = \"os\"", () => {
  it("drops bus/agent/multiplexer sockets and the credentials gnomon supplied or the surface declares", () => {
    const cfg = surfaceOf({}, {}, { config: { endpoints: { cloud: { api_key_env: "FAKE_PROVIDER_KEY" } } } });
    const env = osSandboxEnv(
      {
        PATH: "/usr/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
        SSH_AUTH_SOCK: "/tmp/a",
        TMUX: "/tmp/tmux-1/default,1,0",
        XDG_RUNTIME_DIR: "/run/user/1",
        FAKE_PROVIDER_KEY: "fake-secret",
        FROM_STORE: "fake-stored-secret",
      },
      cfg,
      ["FROM_STORE"]
    );
    expect(Object.keys(env).sort()).toEqual(["PATH"]);
  });

  it.skipIf(process.platform === "win32")("the plan carries that environment", () => {
    const prev = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1/bus";
    try {
      const r = osSandboxPlan("ls", { root: "/repo", exec: { network: true } }, "/bin/sh", okProbe(), () => []);
      if (!("file" in r)) throw new Error("expected a plan");
      expect(r.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
      rmSync(r.tmp, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prev;
    }
  });
});

describe("finding 6 — an unknown exec value refuses bash instead of running it on the host", () => {
  it("resolveExec keeps the value; bash refuses and runs nothing; the audit says it refuses", async () => {
    for (const v of ["OS", "landlock", "os "]) {
      expect(resolveExec(surfaceOf({ exec: v })).invalid).toBe(v);
      expect(resolveExec(surfaceOf({}, { r: { exec: v } }), "r").invalid).toBe(v);
    }
    expect(resolveExec(surfaceOf({})).invalid).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "gnomon-os-invalid-"));
    try {
      const out = await executeTool(
        "bash",
        { command: "echo ran > ran.txt" },
        bashCtx(root, resolveExec(surfaceOf({ exec: "landlock" }))),
        new Set(["bash"])
      );
      expect(out.content).toContain("NOT run");
      expect(existsSync(join(root, "ran.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const audit = auditSurface({ ...surfaceOf({ exec: "landlock" }) } as GnomonConfig).map((p) => p.problem).join("\n");
    expect(audit).not.toMatch(/exec = "landlock"[^\n]*silently falls back/);
  });
});

// ── PR #156 second review ──

describe("second review, D — the per-call temp dir's parent is never a writable root", () => {
  it.skipIf(process.platform === "win32")("refuses an extra root (or a root) that contains tmpdir(), and runs nothing", () => {
    const t = realpathSync(tmpdir());
    for (const c of [
      { root: "/repo", extraRoots: [parse(t).dir === t ? t : resolve(t, "..")], exec: { network: true } },
      { root: t, exec: { network: true } },
    ]) {
      const r = osSandboxPlan("touch ran", c, "/bin/sh", okProbe(), () => []);
      expect("refusal" in r, JSON.stringify(c)).toBe(true);
      if ("refusal" in r) expect(r.refusal.content).toContain("contains the temp directory");
    }
  });

  it.skipIf(process.platform === "win32")("records the temp dir's identity and asks gnomon-exec for the supervisor's pid", () => {
    const r = osSandboxPlan("ls", { root: "/repo", exec: { network: true } }, "/bin/sh", okProbe(), () => []);
    if (!("file" in r)) throw new Error("expected a plan");
    try {
      expect(r.args.slice(r.args.indexOf("--report-fd"), r.args.indexOf("--report-fd") + 2)).toEqual(["--report-fd", "3"]);
      const st = statSync(r.tmp, { bigint: true });
      expect(r.tmpId).toEqual({ dev: st.dev.toString(), ino: st.ino.toString() });
      expect(r.tmp).toBe(realpathSync(r.tmp));
    } finally {
      rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!!skipWhy)(label("cleanOsSandboxTmp leaves alone a directory that is not the one gnomon made", skipWhy), () => {
    const scratch = mkdtempSync(join(tmpdir(), "gnomon-os-clean-id-"));
    try {
      const tmp = join(scratch, "call");
      mkdirSync(tmp);
      const st = statSync(tmp, { bigint: true });
      const id = { dev: st.dev.toString(), ino: st.ino.toString() };
      // Swapped: the made dir moves aside, a link to a victim takes its name.
      const victim = join(scratch, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep.txt"), "keep");
      execFileSync("mv", [tmp, join(scratch, "aside")]);
      symlinkSync(victim, tmp);
      expect(cleanOsSandboxTmp((real as { bin: string }).bin, tmp, id)).toBe(false);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(tmp)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("second review, B — bash's environment drops every secret it can name", () => {
  it("drops names matching secret conventions, and every key variable ANY surface in this process named", () => {
    // An earlier surface named this variable; a later one points api_key_env elsewhere.
    osSandboxEnv({}, surfaceOf({}, {}, { config: { endpoints: { e: { api_key_env: "PINTEST_FIRST_NAME" } } } }), []);
    const later = surfaceOf({}, {}, { config: { endpoints: { e: { api_key_env: "PINTEST_DECOY" } } } });
    const env = osSandboxEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        GIT_AUTHOR_NAME: "t",
        TOKENIZERS_PARALLELISM: "false",
        PINTEST_FIRST_NAME: "dummy-1",
        GITHUB_TOKEN: "dummy-2",
        AWS_SECRET_ACCESS_KEY: "dummy-3",
        OPENAI_API_KEY: "dummy-4",
        DB_PASSWORD: "dummy-5",
        NPM_CONFIG__AUTH: "dummy-6",
      },
      later,
      []
    );
    expect(Object.keys(env).sort()).toEqual(["GIT_AUTHOR_NAME", "HOME", "PATH", "TOKENIZERS_PARALLELISM"]);
  });
});

describe("second review, G — gnomon inside a writable tree is named", () => {
  it("lists the install roots under the root or an extra root, and nothing else", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-install-")));
    try {
      const proj = join(scratch, "proj");
      mkdirSync(join(proj, "node_modules"), { recursive: true });
      mkdirSync(join(scratch, "elsewhere"));
      expect(gnomonInstallWritable([proj], [join(proj, "node_modules"), join(scratch, "elsewhere")])).toEqual([join(proj, "node_modules")]);
      expect(gnomonInstallWritable([join(scratch, "elsewhere2")], [join(proj, "node_modules")])).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("second review — signals: a later call stops an earlier call's job only through sandbox-kill", () => {
  const why = netSkipWhy || (linux ? "" : "Linux only");

  const pidIn = (out: { content: string }, key: string): number => {
    const m = new RegExp(`${key}=(\\d+)`).exec(out.content);
    if (!m) throw new Error(`no ${key} in ${out.content}`);
    return Number(m[1]);
  };
  const aliveP = (pid: number): boolean => {
    try {
      const st = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !st.slice(st.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number) => {
    for (let i = 0; i < 150 && aliveP(pid); i++) await new Promise((ok) => setTimeout(ok, 20));
  };

  it.skipIf(!!why)(label("kill from a later call fails and says how; sandbox-kill stops the job; an unrelated pid is refused", why), async () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-os-kill-"));
    const ex = { mode: "os" as const, image: "unused", network: false };
    const victim = execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim();
    try {
      const started = await executeTool("bash", { command: "sleep 30 >/dev/null 2>&1 & echo JOB=$!" }, bashCtx(root, ex), new Set(["bash"]));
      const job = pidIn(started, "JOB");
      expect(aliveP(job)).toBe(true);
      if ((real as { probe: { landlock_abi?: number } }).probe.landlock_abi! >= 6) {
        const tried = await executeTool("bash", { command: `kill ${job}` }, bashCtx(root, ex), new Set(["bash"]));
        expect(aliveP(job), tried.content).toBe(true);
        expect(tried.content).toContain("sandbox-kill <pid>");
      }
      const refused = await executeTool("bash", { command: `sandbox-kill ${victim}` }, bashCtx(root, ex), new Set(["bash"]));
      expect(refused.content).toMatch(/refused/);
      expect(aliveP(Number(victim)), "an unrelated process was signalled").toBe(true);
      const killed = await executeTool("bash", { command: `sandbox-kill ${job} TERM` }, bashCtx(root, ex), new Set(["bash"]));
      expect(killed.shell_exit, killed.content).toBe(0);
      await waitDead(job);
      expect(aliveP(job), "the job survived sandbox-kill").toBe(false);
    } finally {
      try {
        process.kill(Number(victim), "SIGKILL");
      } catch {
        // gone
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!!why || !has("setsid"))(label("a timeout kills the call's whole subtree, a setsid'd job included", why), async () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-os-timeout-"));
    const ex = { mode: "os" as const, image: "unused", network: false };
    let job = 0;
    try {
      const out = await executeTool(
        "bash",
        { command: "setsid sleep 30 >/dev/null 2>&1 < /dev/null & echo $! > job.pid; sleep 20" },
        bashCtx(root, ex, { timeoutMs: 1500 }),
        new Set(["bash"])
      );
      expect(out.content).toContain("timed out");
      job = Number(readFileSync(join(root, "job.pid"), "utf8").trim());
      await waitDead(job);
      expect(aliveP(job), "a setsid'd job outlived the call's timeout").toBe(false);
    } finally {
      if (job > 0) {
        try {
          process.kill(job, "SIGKILL");
        } catch {
          // gone
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
