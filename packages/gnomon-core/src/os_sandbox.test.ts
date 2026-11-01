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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { osSandbox, _resetOsSandbox, type OsSandbox } from "gnomon-natives";
import { executeTool, osSandboxPlan, type ToolContext } from "./tools.js";
import { EXEC_VALUES } from "./config.js";

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
    exec: { mode: "os", image: "unused", network: false },
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
      const out = await bash("curl -sS --max-time 5 http://192.0.2.1/", ctx());
      expect(out.shell_exit).not.toBe(0);
      if (linux) {
        // The supervisor's own line. An offline machine also fails this
        // connect, but never prints this -- so this cannot pass by accident.
        expect(out.content).toContain("blocked connect to 192.0.2.1:80");
      } else {
        expect(out.content).toMatch(/Operation not permitted|Permission denied/);
      }
    });

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
