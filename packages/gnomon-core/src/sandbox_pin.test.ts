/**
 * Third review, finding 1 (exec = "docker"): the session pins the sandbox it
 * started with, per role, and a reload may only tighten it.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSandbox, applySandboxPin, describeLoosening } from "./sandbox_pin.js";
import type { GnomonConfig } from "./config.js";

const surfaceOf = (sandbox: Record<string, unknown>, roles: Record<string, Record<string, unknown>> = {}): GnomonConfig =>
  ({
    gnomonDir: "/p/.gnomon",
    config: {},
    policy: { sandbox },
    roles: { implement: { model: "m" }, verifier: { model: "m" }, ...roles },
  }) as unknown as GnomonConfig;

describe("sandbox_pin — exec = docker", () => {
  it("exec = off, another image, network = true, a looser level: none applied, each named", () => {
    const pin = pinSandbox(surfaceOf({ exec: "docker", image: "img:1", network: false, level: "confined" }));
    const loose = surfaceOf({ exec: "off", network: true, level: "off" });
    const got = applySandboxPin(pin, loose, "implement");
    expect(got.exec).toMatchObject({ mode: "docker", image: "img:1", network: false });
    expect(got.level).toBe("confined");
    expect(got.network).toBe(false);
    const said = describeLoosening(pin, loose).join("\n");
    expect(said).toContain('exec = "off"');
    expect(said).toContain('level = "off"');
    // Another image for a docker role: kept.
    expect(applySandboxPin(pin, surfaceOf({ exec: "docker", image: "evil:latest" }), "implement").exec.image).toBe("img:1");
    // A role that sets its own exec = "off" is held the same way, and so is a
    // role the session did not start with.
    expect(applySandboxPin(pin, surfaceOf({ exec: "docker", image: "img:1" }, { verifier: { exec: "off" } }), "verifier").exec.mode).toBe("docker");
    expect(applySandboxPin(pin, surfaceOf({ exec: "docker", image: "img:1" }, { fresh: { exec: "off" } }), "fresh").exec.mode).toBe("docker");
  });

  it("tightening applies at once and ratchets: off -> docker cannot go back to off", () => {
    const pin = pinSandbox(surfaceOf({}));
    expect(applySandboxPin(pin, surfaceOf({ exec: "docker" }), "implement").exec.mode).toBe("docker");
    expect(applySandboxPin(pin, surfaceOf({}), "implement").exec.mode).toBe("docker");
    // Another role was never tightened: it keeps what it started with.
    expect(applySandboxPin(pin, surfaceOf({}), "verifier").exec.mode).toBe("off");
  });

  it.skipIf(process.platform === "win32")("an extra root re-pointed after the session started keeps granting its pinned real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-pin-roots-"));
    try {
      const [X, Y] = ["x", "y"].map((n) => {
        mkdirSync(join(dir, n));
        return realpathSync(join(dir, n));
      }) as [string, string];
      const link = join(dir, "link");
      symlinkSync(X, link);
      const s0 = surfaceOf({ exec: "docker", extra_roots: [link] });
      const pin = pinSandbox(s0);
      rmSync(link);
      symlinkSync(Y, link);
      expect(applySandboxPin(pin, s0, "implement").extraRoots).toEqual([X]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
