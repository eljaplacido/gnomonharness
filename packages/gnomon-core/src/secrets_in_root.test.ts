/**
 * A declared secret inside the root, read through an interpreter (issue #227):
 *
 *     python3 -c "print(open('.env'+'.matrix').read())"
 *
 * The word check sees no secret path in that command. Under exec = "docker" the
 * secret is hidden by an empty read-only mount; under exec = "os" (which grants
 * the whole root) a session at [governance] level = "prevent" does not start
 * while one sits in the root, unless the surface says secrets_in_root = "allow".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { osSandbox } from "gnomon-natives";
import { auditSecretsInRoot, exposedSecretFiles, secretsInRootRecord } from "./secrets_in_root.js";
import { resolveLevels, resolveProtectedPaths } from "./governance.js";
import { executeTool, sandboxCommand, secretFilesInRoot, type ToolContext } from "./tools.js";

let root: string;
const put = (rel: string, text: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-secroot-")));
  put(".env.matrix", "TOKEN=hunter2\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function surface(opts: { exec?: string; governance?: Record<string, unknown>; roleExec?: string } = {}) {
  return {
    gnomonDir: join(root, ".gnomon"),
    policy: {
      ...(opts.exec ? { sandbox: { exec: opts.exec } } : {}),
      ...(opts.governance ? { governance: opts.governance } : {}),
    },
    roles: { implement: opts.roleExec ? { exec: opts.roleExec } : {} },
    config: {},
  } as any;
}
const PATHS = { paths: { secrets: [".env.matrix", ".env"] } };

describe("exec = os: refuses to start with a declared secret in the root", () => {
  it("is fatal at level prevent, naming the file and the fix", () => {
    const p = auditSecretsInRoot(surface({ exec: "os", governance: { level: "prevent", ...PATHS } }));
    expect(p).toHaveLength(1);
    expect(p[0]!.fatal).toBe(true);
    expect(p[0]!.problem).toContain(".env.matrix");
    expect(p[0]!.fix).toContain("Move the file out of the repository");
    expect(p[0]!.fix).toContain('secrets_in_root = "allow"');
  });

  it("is fatal at the default level when governance is declared (prevent is the default), with the default lists", () => {
    put(".env", "A=1\n");
    const p = auditSecretsInRoot(surface({ exec: "os", governance: { bash: "prevent" } }));
    expect(p[0]?.fatal).toBe(true);
    expect(p[0]?.problem).toContain(".env");
  });

  it("is a recorded, non-fatal finding with secrets_in_root = allow", () => {
    const cfg = surface({ exec: "os", governance: { level: "prevent", secrets_in_root: "allow", ...PATHS } });
    const p = auditSecretsInRoot(cfg);
    expect(p[0]!.fatal).toBe(false);
    expect(secretsInRootRecord(cfg)).toEqual({ accepted: true, files: [".env.matrix"] });
  });

  it("applies to a role that sets exec = os on its own", () => {
    expect(auditSecretsInRoot(surface({ roleExec: "os", governance: { level: "prevent", ...PATHS } }))[0]?.fatal).toBe(true);
  });

  it("changes nothing below prevent, without exec = os, without governance, or with no secret in the root", () => {
    expect(auditSecretsInRoot(surface({ exec: "os", governance: { level: "advise", ...PATHS } }))).toEqual([]);
    expect(auditSecretsInRoot(surface({ exec: "os", governance: { level: "observe", ...PATHS } }))).toEqual([]);
    expect(auditSecretsInRoot(surface({ governance: { level: "prevent", ...PATHS } }))).toEqual([]);
    expect(auditSecretsInRoot(surface({ exec: "docker", governance: { level: "prevent", ...PATHS } }))).toEqual([]);
    expect(auditSecretsInRoot(surface({ exec: "os" }))).toEqual([]);
    rmSync(join(root, ".env.matrix"));
    expect(auditSecretsInRoot(surface({ exec: "os", governance: { level: "prevent", ...PATHS } }))).toEqual([]);
    expect(secretsInRootRecord(surface({ exec: "os", governance: { secrets_in_root: "allow" } }))).toBeUndefined();
  });

  it("a committed template or a vendored tree is not a secret in the root", () => {
    rmSync(join(root, ".env.matrix"));
    put(".env.example", "A=\n");
    put("node_modules/pkg/.env", "A=1\n");
    expect(exposedSecretFiles(surface({ exec: "os", governance: { level: "prevent" } }))).toEqual([]);
  });
});

describe("exec = docker: an empty read-only file is mounted over each declared secret", () => {
  const ctxFor = (governance?: Record<string, unknown>): ToolContext => {
    const config = surface({ exec: "docker", governance });
    const levels = resolveLevels(config, "implement");
    const protectedPaths = resolveProtectedPaths(config, levels);
    return {
      root,
      config,
      exec: { mode: "docker", image: "debian:stable-slim", network: false },
      ...(levels ? { governance: levels } : {}),
      ...(protectedPaths ? { protectedPaths } : {}),
    } as unknown as ToolContext;
  };

  it("finds the file by the declared globs only", () => {
    expect(secretFilesInRoot(root, [".env.matrix"])).toEqual([join(root, ".env.matrix")]);
    expect(secretFilesInRoot(root, ["*.nothing"])).toEqual([]);
  });

  it("the docker line carries the mount at level prevent, and not below or without governance", () => {
    const line = sandboxCommand("ls", ctxFor({ level: "prevent", ...PATHS }), "n");
    expect(line).toMatch(new RegExp(`-v '[^']*gnomon-empty-[^']*/empty':'${join(root, ".env.matrix")}':ro`));
    expect(sandboxCommand("ls", ctxFor({ level: "advise", ...PATHS }), "n")).not.toContain("gnomon-empty-");
    expect(sandboxCommand("ls", ctxFor(), "n")).not.toContain("gnomon-empty-");
  });

  const dockerReady = (() => {
    const info = spawnSync("docker", ["image", "inspect", "debian:stable-slim"], { stdio: "ignore", timeout: 10_000 });
    return info.status === 0;
  })();
  it.skipIf(!dockerReady)("the interpreter probe reads an empty file inside the container", async () => {
    const out = await executeTool(
      "bash",
      { command: `sh -c 'p=$(printf "\\056en"); cat "\${p}v.matrix"; echo END'` },
      { ...ctxFor({ level: "prevent", ...PATHS }), sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 60_000, maxOutputBytes: 32_000, bashDeny: [] } as ToolContext,
      new Set(["bash"])
    );
    expect(out.content).not.toContain("hunter2");
    expect(out.content).toContain("END");
  });
});

describe("exec = os: the probe is stopped before it can run (the session never starts)", () => {
  const os = osSandbox();
  const supported = !("error" in os) && os.probe.supported;
  it.skipIf(!supported || spawnSync("python3", ["--version"]).status !== 0)(
    "without the refusal, python3 does read the secret: the control the refusal answers",
    async () => {
      const out = await executeTool(
        "bash",
        { command: `python3 -c "print(open('.env'+'.matrix').read())"` },
        {
          root,
          sandbox: "confined",
          gate: "never",
          approve: async () => true,
          timeoutMs: 20_000,
          maxOutputBytes: 32_000,
          bashDeny: [],
          // network = true: the control is about the filesystem grant, and macOS
          // refuses exec = "os" with network = false (Seatbelt cannot enforce it).
          exec: { mode: "os", image: "x", network: true },
        } as ToolContext,
        new Set(["bash"])
      );
      // Landlock grants the root: this is why the surface audit refuses to start.
      expect(out.content).toContain("hunter2");
      expect(auditSecretsInRoot(surface({ exec: "os", governance: { level: "prevent", ...PATHS } }))[0]?.fatal).toBe(true);
    }
  );
});
