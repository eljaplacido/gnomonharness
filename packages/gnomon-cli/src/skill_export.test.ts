/**
 * `gnomon skill export` through the real binary: a dry run by default, --write
 * writes the shared Agent Skills layout, a SKILL.md gnomon did not write is
 * never overwritten (exit 2).
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LAUNCHER = join(REPO, "gnomon");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const cli = (root: string, args: string[]) => {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], { cwd: root, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", GNOMON_NO_UPDATE_CHECK: "1" } });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

async function project(): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), "gnomon-skill-export-cli-")), "p");
  made.push(root);
  mkdirSync(root, { recursive: true });
  await initSurface({ dir: root });
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "skills", "tidy-commits.md"), '+++\nname = "tidy commits"\ndescription = "Keep commits small"\n+++\n\nOne change per commit.\n');
  return root;
}

describe("gnomon skill export", () => {
  it("is a dry run by default, --write writes <name>/SKILL.md, and a re-run is unchanged", async () => {
    const root = await project();
    const dry = cli(root, ["skill", "export"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/Would export \d+ gnomon skill\(s\) as skill-md/);
    expect(dry.stdout).toContain("create    tidy-commits/SKILL.md");
    expect(dry.stdout).toContain("Nothing written");
    expect(existsSync(join(root, ".claude"))).toBe(false);

    const wrote = cli(root, ["skill", "export", "--write"]);
    expect(wrote.code).toBe(0);
    const md = readFileSync(join(root, ".claude/skills/tidy-commits/SKILL.md"), "utf-8");
    expect(md).toMatch(/^---\nname: tidy-commits\ndescription: "Keep commits small"\n---\n/);
    expect(md).toContain("One change per commit.");
    expect(md).toMatch(/<!-- gnomon-skill-export: from \.gnomon\/skills\/tidy-commits\.md; surface [0-9a-f]{64}/);

    expect(cli(root, ["skill", "export", "--write"]).stdout).toContain("unchanged tidy-commits/SKILL.md");
    const json = JSON.parse(cli(root, ["skill", "export", "--to", ".agents/skills", "--json"]).stdout);
    expect(json).toMatchObject({ written: false, format: "skill-md" });
    expect(json.dir).toBe(join(root, ".agents/skills"));
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  it("refuses (exit 2) a SKILL.md that is not gnomon's, and an unknown format (exit 1)", async () => {
    const root = await project();
    mkdirSync(join(root, ".claude/skills/tidy-commits"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/tidy-commits/SKILL.md"), "---\nname: tidy-commits\ndescription: mine\n---\nmine\n");
    const r = cli(root, ["skill", "export", "--write"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("REFUSED");
    expect(readFileSync(join(root, ".claude/skills/tidy-commits/SKILL.md"), "utf-8")).toContain("mine\n");
    expect(cli(root, ["skill", "export", "--format", "toml"]).code).toBe(1);
  });
});
