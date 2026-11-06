/**
 * The fifth review's reproductions, one per finding, against the public API
 * that existed when they were found -- so each fails on the code it was found
 * in (e87158d3) and passes after.
 *
 * The threat (exec = "docker", and exec = "os" after it): the model's bash
 * writes the project root, and the model is hostile. Every finding was the
 * host gnomon process trusting, following or running something in that root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, resolveExec } from "./config.js";
import { appendHistory } from "./prompt_loop.js";
import { AuditTrail, resolveAudit } from "./audit.js";
import { writeState } from "./loops.js";
import { saveSession, resolveSessionStore } from "./session_store.js";
import { sandboxCommand } from "./tools.js";
import { tightenExec } from "./sandbox_pin.js";
import { recordExecFloor, settleTrustHeadless, trustPath } from "./trust.js";
import { safeGit, _resetGitSafety } from "./git_safe.js";

const REPO_SURFACE = resolve(process.cwd(), "..", "..", ".gnomon");
const POLICY = (exec: string, image = "img:1") =>
  `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "${exec}"\nimage = "${image}"\n`;
const AUDIT_ON = `\n[audit]\nenabled = true\n`;

const made: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

function project(exec = "docker"): string {
  const root = tmp("gnomon-r5-");
  cpSync(REPO_SURFACE, join(root, ".gnomon"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "policy.toml"), POLICY(exec));
  return root;
}

/** A file outside every root, standing in for ~/.bashrc or trust.json. */
function victim(text: string): string {
  const f = join(tmp("gnomon-r5-victim-"), "target");
  writeFileSync(f, text);
  return f;
}

afterEach(() => {
  _resetGitSafety();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const posix = process.platform !== "win32";

describe("fifth review — host writes under the root never follow what the container left there", () => {
  it.skipIf(!posix)("finding 1: a symlink at .gnomon-sessions/history does not carry the prompt history into the trust store", () => {
    const root = project();
    const target = victim('{"v":1,"entries":[]}\n');
    mkdirSync(join(root, ".gnomon-sessions"), { recursive: true });
    symlinkSync(target, join(root, ".gnomon-sessions", "history"));
    appendHistory(loadConfig(root), "fix the login bug");
    expect(readFileSync(target, "utf-8")).toBe('{"v":1,"entries":[]}\n');
  });

  it.skipIf(!posix)("finding 2: a symlink where the audit trail goes does not take the recorded command line", () => {
    const root = project();
    writeFileSync(join(root, ".gnomon", "config.toml"), readFileSync(join(root, ".gnomon", "config.toml"), "utf-8") + AUDIT_ON);
    const target = victim("# bashrc\n");
    mkdirSync(join(root, ".gnomon-audit"), { recursive: true });
    symlinkSync(target, join(root, ".gnomon-audit", "s-1.jsonl"));
    const trail = new AuditTrail(resolveAudit(loadConfig(root)), "s-1");
    try {
      trail.write("session_start", { cwd: root, command: "$(touch /tmp/x)" });
    } catch {
      /* refused: what we want */
    }
    expect(readFileSync(target, "utf-8")).toBe("# bashrc\n");
  });

  it.skipIf(!posix)("finding 2, same class: loop state and session snapshots are not written through symlinks", () => {
    const root = project();
    const a = victim("A\n");
    const b = victim("B\n");
    mkdirSync(join(root, ".gnomon-loops"), { recursive: true });
    symlinkSync(a, join(root, ".gnomon-loops", "nightly.json"));
    try {
      writeState(root, "nightly", { consecutive_failures: 0, action_times: [], tripped: false });
    } catch {
      /* refused */
    }
    expect(readFileSync(a, "utf-8")).toBe("A\n");
    const store = resolveSessionStore(loadConfig(root));
    mkdirSync(store.dir, { recursive: true });
    symlinkSync(b, join(store.dir, "s-9.json"));
    try {
      saveSession({ ...store, persist: true }, { id: "s-9" } as never);
    } catch {
      /* refused */
    }
    expect(readFileSync(b, "utf-8")).toBe("B\n");
  });
});

describe("fifth review — the container cannot write gnomon's state or git's control files (A)", () => {
  it.skipIf(!posix)("mounts .gnomon/, the records and .git/config, hooks/, info/ read-only, and labels the container with its root", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    const line = sandboxCommand("ls", { root, exec: { mode: "docker", image: "img:1", network: false } }, "n");
    const argv = execFileSync("/bin/sh", ["-c", `docker() { printf '%s\\n' "$@"; }\n${line}`], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    for (const p of [".gnomon", ".gnomon-audit", ".gnomon-sessions", ".git/config", ".git/hooks", ".git/info"]) {
      const abs = join(root, p);
      expect(argv, p).toContain(`${abs}:${abs}:ro`);
    }
    // The record dirs exist now, made by gnomon: there is something to mount.
    expect(existsSync(join(root, ".gnomon-audit"))).toBe(true);
    expect(argv).toContain(`gnomon.root=${root}`);
  });
});

describe("fifth review — finding 3: a container another process started is seen", () => {
  let bin: string;
  let path: string | undefined;
  beforeEach(() => {
    path = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  it.skipIf(!posix)("host git in a root a running container is labelled with is refused, from any process", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    // A session ran here contained: the floor records it.
    recordExecFloor(loadConfig(root));
    // A docker that says a container labelled with this root is running.
    bin = tmp("gnomon-r5-bin-");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' '${root}'\n`);
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const r = safeGit(["status", "--porcelain"], { cwd: root });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/container/);
  });

  it.skipIf(!posix)("and when docker cannot be asked for a floored root, that is a refusal", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    recordExecFloor(loadConfig(root));
    bin = tmp("gnomon-r5-bin-");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n`);
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    expect(safeGit(["status", "--porcelain"], { cwd: root }).status).not.toBe(0);
  });
});

describe("fifth review — finding 4: a .gnomon/ made below a floored root", () => {
  it("is held to the floor of the root above it", () => {
    const root = project("docker");
    recordExecFloor(loadConfig(root));
    const nested = join(root, "src");
    cpSync(join(root, ".gnomon"), join(nested, ".gnomon"), { recursive: true });
    writeFileSync(join(nested, ".gnomon", "policy.toml"), POLICY("off"));
    const s = settleTrustHeadless(loadConfig(nested), { warn: () => {} });
    expect(resolveExec(s.config, "implement")).toMatchObject({ mode: "docker", image: "img:1" });
  });
});

describe("fifth review — finding 5: the image", () => {
  it.skipIf(!posix)("is never more of the host's shell line, nor a docker flag", () => {
    const marker = join(tmp("gnomon-r5-img-"), "PWNED");
    for (const image of [`x; touch ${marker}`, "--privileged", "img:1 --privileged", "$(touch " + marker + ")"]) {
      let line: string | null = null;
      try {
        line = sandboxCommand("ls", { root: tmp("gnomon-r5-root-"), exec: { mode: "docker", image, network: false } }, "n");
      } catch {
        line = null;
      }
      if (line !== null) execFileSync("/bin/sh", ["-c", `docker() { :; }\n${line}`]);
      expect(existsSync(marker), image).toBe(false);
      expect(line, image).toBeNull();
    }
  });

  it("off -> docker mid-session keeps the image the session started with", () => {
    const { exec, loosened } = tightenExec(
      { mode: "off", image: "debian:stable-slim", network: false },
      { mode: "docker", image: "evil:latest", network: false }
    );
    expect(exec).toMatchObject({ mode: "docker", image: "debian:stable-slim" });
    expect(loosened.join(" ")).toMatch(/evil:latest/);
  });
});

describe("fifth review — C: the trust store fails closed", () => {
  it("a corrupt trust.json is not an empty one: floors hold and bash stays contained", () => {
    const root = project("docker");
    recordExecFloor(loadConfig(root));
    writeFileSync(join(root, ".gnomon", "policy.toml"), POLICY("off"));
    // What finding 1 did: the history appended to the trust store.
    mkdirSync(resolve(trustPath(), ".."), { recursive: true });
    writeFileSync(trustPath(), "fix the login bug\n", { flag: "a" });
    const s = settleTrustHeadless(loadConfig(root), { warn: () => {} });
    expect(resolveExec(s.config, "implement").mode).toBe("docker");
  });
});
