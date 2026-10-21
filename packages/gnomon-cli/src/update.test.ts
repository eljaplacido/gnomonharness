import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  detectInstall,
  noticeAllowed,
  noticePlan,
  fetchLatest,
  readUpdateCache,
  writeUpdateCache,
  updateCachePath,
  uninstallSteps,
  currentVersion,
  type NoticeContext,
} from "./update.js";

const DAY = 24 * 60 * 60 * 1000;

describe("compareVersions", () => {
  it.each([
    ["0.2.4", "0.2.3", 1],
    ["0.10.0", "0.9.9", 1],
    ["v0.2.3", "0.2.3", 0],
    ["0.3.0-rc.1", "0.3.0", -1],
    ["0.3.0", "0.3.0-rc.1", 1],
    ["1.0", "1.0.0", 0],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

// POSIX paths, so POSIX hosts: path.resolve on Windows would prefix a drive.
describe.skipIf(process.platform === "win32")("detectInstall — how this copy got here decides how it updates", () => {
  const file = (...p: string[]) => join(...p, "gnomon-harness", "dist", "update.js");
  const nothing = () => false;

  it("npm -g under the system prefix (POSIX layout: <prefix>/lib/node_modules)", () => {
    const m = detectInstall(file("/usr", "lib", "node_modules"), ["/usr/lib/node_modules"], nothing, "linux");
    expect(m).toEqual({ kind: "npm-global", nodeModules: "/usr/lib/node_modules", prefix: "/usr" });
  });

  it("npm -g under the installer's no-sudo prefix, ~/.local", () => {
    const m = detectInstall(
      file("/home/u/.local/lib/node_modules"),
      ["/usr/lib/node_modules", "/home/u/.local/lib/node_modules"],
      nothing,
      "linux"
    );
    expect(m.kind).toBe("npm-global");
    if (m.kind === "npm-global") expect(m.prefix).toBe("/home/u/.local");
  });

  it("a project dependency is not a global install", () => {
    const m = detectInstall(file("/work/app/node_modules"), ["/usr/lib/node_modules"], nothing, "linux");
    expect(m).toEqual({ kind: "npm-local", project: "/work/app" });
  });

  it("a pnpm store is named, not guessed at", () => {
    const m = detectInstall(
      join("/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/gnomon-harness@0.2.3/node_modules/gnomon-harness/dist/update.js"),
      ["/usr/lib/node_modules"],
      nothing,
      "linux"
    );
    expect(m.kind).toBe("other");
  });

  it("a checkout is found by its .git and workspace file, not by node_modules", () => {
    const root = "/src/gnomon";
    const has = new Set([join(root, ".git"), join(root, "pnpm-workspace.yaml")]);
    const m = detectInstall(join(root, "packages", "gnomon-cli", "src", "update.ts"), [], (p) => has.has(p), "linux");
    expect(m).toEqual({ kind: "checkout", root });
  });

});

describe.runIf(process.platform === "win32")("detectInstall on Windows", () => {
  const nothing = () => false;
  it("<prefix>\\node_modules, compared case-insensitively", () => {
    const m = detectInstall(
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\gnomon-harness\\dist\\update.js",
      ["c:\\users\\u\\appdata\\roaming\\npm\\node_modules"],
      nothing,
      "win32"
    );
    expect(m.kind).toBe("npm-global");
    if (m.kind === "npm-global") expect(m.prefix.toLowerCase()).toBe("c:\\users\\u\\appdata\\roaming\\npm");
  });
});

describe("the update notice is shown only to a person starting a session", () => {
  const base: NoticeContext = {
    command: "launch",
    json: false,
    env: {},
    stdinTTY: true,
    stdoutTTY: true,
    method: "npm-global",
    cache: {},
  };

  it("an interactive launch or prompt may", () => {
    expect(noticeAllowed(base)).toBe(true);
    expect(noticeAllowed({ ...base, command: "prompt" })).toBe(true);
    expect(noticeAllowed({ ...base, command: "run" })).toBe(true);
  });

  it.each<[string, Partial<NoticeContext>]>([
    ["task", { command: "task" }],
    ["any other command", { command: "surface" }],
    ["--json", { json: true }],
    ["CI", { env: { CI: "true" } }],
    ["GNOMON_NO_UPDATE_CHECK=1", { env: { GNOMON_NO_UPDATE_CHECK: "1" } }],
    ["stdout piped", { stdoutTTY: false }],
    ["stdin piped", { stdinTTY: false }],
    ["`update --notice off`", { cache: { disabled: true } }],
    ["a checkout", { method: "checkout" }],
  ])("never under %s", (_name, over) => {
    expect(noticeAllowed({ ...base, ...over })).toBe(false);
  });

  it("CI=false and GNOMON_NO_UPDATE_CHECK=0 do not count as set", () => {
    expect(noticeAllowed({ ...base, env: { CI: "false", GNOMON_NO_UPDATE_CHECK: "0" } })).toBe(true);
  });
});

describe("noticePlan — at most once a day, and never waiting on the network", () => {
  const now = 1_800_000_000_000;

  it("first run: nothing to say yet, start a check", () => {
    expect(noticePlan({}, "0.2.3", now)).toEqual({ message: null, startCheck: true });
  });

  it("a newer release in the cache is reported, with the changelog", () => {
    const p = noticePlan({ checkedAt: now - 1000, latest: "0.2.4" }, "0.2.3", now);
    expect(p.message).toContain("0.2.4");
    expect(p.message).toContain("gnomon update");
    expect(p.message).toContain("/blob/v0.2.4/CHANGELOG.md");
    expect(p.startCheck).toBe(false);
  });

  it("not again within 24h of the last notice", () => {
    const p = noticePlan({ checkedAt: now, latest: "0.2.4", notifiedAt: now - DAY + 60_000 }, "0.2.3", now);
    expect(p.message).toBeNull();
  });

  it("again after 24h, and a stale check is restarted", () => {
    const p = noticePlan({ checkedAt: now - DAY, latest: "0.2.4", notifiedAt: now - DAY }, "0.2.3", now);
    expect(p.message).not.toBeNull();
    expect(p.startCheck).toBe(true);
  });

  it("nothing when the cache is not newer than what runs", () => {
    expect(noticePlan({ checkedAt: now, latest: "0.2.3" }, "0.2.3", now).message).toBeNull();
    expect(noticePlan({ checkedAt: now, latest: "0.2.2" }, "0.2.3", now).message).toBeNull();
  });

  it("a clock that went backwards does not suppress checks forever", () => {
    expect(noticePlan({ checkedAt: now + DAY }, "0.2.3", now).startCheck).toBe(true);
  });
});

describe("the cache is machine-local, never in the surface", () => {
  it("lives under the machine data dir and round-trips", () => {
    const saved = process.env.XDG_DATA_HOME;
    const data = mkdtempSync(join(tmpdir(), "gnomon-upd-"));
    process.env.XDG_DATA_HOME = data;
    try {
      expect(updateCachePath()).toBe(join(data, "gnomon", "update-check.json"));
      expect(updateCachePath()).not.toContain(".gnomon");
      expect(readUpdateCache()).toEqual({});
      writeUpdateCache({ checkedAt: 1, latest: "9.9.9" });
      expect(readUpdateCache()).toEqual({ checkedAt: 1, latest: "9.9.9" });
    } finally {
      rmSync(data, { recursive: true, force: true });
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  });
});

describe("fetchLatest", () => {
  const fake =
    (answers: Record<string, unknown | number>): typeof fetch =>
    async (input) => {
      const url = String(input);
      const key = Object.keys(answers).find((k) => url.includes(k));
      const a = key === undefined ? 404 : answers[key];
      if (typeof a === "number") return new Response("{}", { status: a });
      return new Response(JSON.stringify(a), { status: 200 });
    };

  it("not on the registry: the GitHub release, marked as not resolvable by name", async () => {
    const l = await fetchLatest(1000, fake({ "api.github.com": { tag_name: "v0.2.3" } }));
    expect(l).toEqual({ version: "0.2.3", onRegistry: false });
  });

  it("on the registry and current: the registry wins the tie", async () => {
    const l = await fetchLatest(
      1000,
      fake({ "registry.npmjs.org": { version: "0.2.4" }, "api.github.com": { tag_name: "v0.2.4" } })
    );
    expect(l).toEqual({ version: "0.2.4", onRegistry: true });
  });

  it("a tag ahead of the publish is still reported as the latest", async () => {
    const l = await fetchLatest(
      1000,
      fake({ "registry.npmjs.org": { version: "0.2.4" }, "api.github.com": { tag_name: "v0.2.5" } })
    );
    expect(l).toEqual({ version: "0.2.5", onRegistry: false });
  });

  it("neither reachable: null, not a throw", async () => {
    const offline: typeof fetch = async () => {
      throw new Error("offline");
    };
    expect(await fetchLatest(1000, offline)).toBeNull();
  });
});

describe("uninstall names all four packages", () => {
  // A release-tarball install makes gnomon-core, -natives and -tui separate
  // globals; `npm rm -g gnomon-harness` alone left them behind.
  it("for a global install, with the prefix it lives under", () => {
    const steps = uninstallSteps(
      { kind: "npm-global", nodeModules: "/home/u/.local/lib/node_modules", prefix: "/home/u/.local" },
      "linux"
    );
    expect(steps[0]).toBe(
      'npm rm -g --prefix "/home/u/.local" gnomon-harness gnomon-core gnomon-natives gnomon-tui'
    );
    expect(steps[1]).toMatch(/^rm -rf .*bin.*update-check\.json/);
  });
});

it("currentVersion reads gnomon-harness's own package.json", () => {
  expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  expect(currentVersion()).not.toBe("0.0.0");
});
