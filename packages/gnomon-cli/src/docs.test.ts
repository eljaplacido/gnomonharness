/**
 * gnomon-cli: Documentation coherence
 *
 * The README makes checkable claims — commands that exist, defaults that hold,
 * files that are present. A claim nobody verifies drifts from the code the
 * moment either changes, and this repository's history is largely a record of
 * documented behaviour that was not the behaviour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initSurface } from "./init.js";
import { loadConfig, resolveContext, resolveUi, resolveRouting, resolveAudit, resolveSessionStore, listRoles, buildToolSet } from "gnomon-core";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
const help = readFileSync(join(repoRoot, "packages/gnomon-cli/src/index.ts"), "utf-8");

const scaffold = async <T>(run: (root: string) => T | Promise<T>): Promise<T> => {
  const root = mkdtempSync(join(tmpdir(), "gnomon-docs-"));
  try {
    await initSurface({ dir: root });
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("every CLI command the README lists exists", () => {
  // Rows look like: | `gnomon launch` | … |
  const documented = [...readme.matchAll(/\|\s*`gnomon ([a-z]+)[^`]*`\s*\|/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);

  it("finds commands to check", () => {
    expect(documented.length).toBeGreaterThan(8);
  });

  for (const cmd of ["launch", "init", "prompt", "task", "sessions", "skill", "audit", "surface", "key", "enumerations"]) {
    it(`\`gnomon ${cmd}\` is dispatched`, () => {
      expect(documented, "README should list it").toContain(cmd);
      expect(help, "index.ts should dispatch it").toContain(`case "${cmd}"`);
    });
  }
});

describe("every interactive command the README lists is implemented", () => {
  const documented = [...readme.matchAll(/\|\s*`(\/[a-z]+)[^`]*`/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);

  it("finds slash commands to check", () => {
    expect(documented.length).toBeGreaterThan(8);
  });

  it("all of them are in the command registry", async () => {
    const { COMMANDS } = await import("gnomon-core");
    const registered = new Set(COMMANDS.map((c) => c.name));
    // Role prefixes are turns, not commands.
    const roles = new Set(["/plan", "/implement", "/critique", "/smol"]);
    const missing = documented.filter((d) => !registered.has(d) && !roles.has(d));
    expect(missing).toEqual([]);
  });

  it("and every registered command is discoverable via Tab", async () => {
    const { COMMANDS, completeInput } = await import("gnomon-core");
    const [offered] = completeInput("/", listRoles(loadConfig(repoRoot)));
    expect(offered.sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });
});

describe("documented defaults are the actual defaults", () => {
  it("a scaffolded surface matches what the README says it ships", async () => {
    await scaffold((root) => {
      const config = loadConfig(root);

      // "Approval is on_write: reads are free, writes show a diff first."
      expect(config.config.defaults?.approval).toBe("on_write");
      // "sandbox = confined"
      expect(config.config.defaults?.sandbox).toBe("confined");
      // "compaction = discard … is the default"
      expect(resolveContext(config).compaction).toBe("discard");
      // "mode = manual … suggest is where to start" — shipped manual
      expect(resolveRouting(config).mode).toBe("manual");
      // "Off by default" — audit
      expect(resolveAudit(config).enabled).toBe(false);
      // "persist = true  # on by default"
      expect(resolveSessionStore(config).persist).toBe(true);
      // "think = collapse"
      expect(resolveUi(config).think).toBe("collapse");
    });
  });

  it("the role table in the README matches the scaffolded roles", async () => {
    await scaffold((root) => {
      const config = loadConfig(root);
      // | `coordinator` | `read`, `glob`, `grep`, `write`, `skill` |
      expect(config.roles.coordinator?.tools).toEqual([
        "read", "glob", "grep", "compute", "todo", "task", "write", "skill",
      ]);
      // | `implementor` | read, glob, grep, write, edit, bash |
      expect(config.roles.implementor?.tools).toEqual([
        "read", "glob", "grep", "compute", "todo", "write", "edit", "bash",
      ]);
      // | `verifier` | read, glob, grep, bash (allow-listed) |
      expect(config.roles.verifier?.tools).toEqual([
        "read", "glob", "grep", "compute", "todo", "bash",
      ]);
      // Search is read-only, so giving it to the verifier widens nothing: it
      // still cannot write, and it no longer needs bash to find a file.
      expect(config.roles.verifier?.tools).not.toContain("write");
      expect(config.roles.verifier?.tools).not.toContain("edit");
      expect(config.roles.verifier?.bash_allow?.length).toBeGreaterThan(0);
    });
  });

  it("a read-only role cannot delegate its way to a write", async () => {
    // `task` runs a sub-turn under another role, with that role's tools. Give
    // it to the verifier and "cannot alter what it judges" stops being true by
    // one indirection: it delegates to the implementor and the code changes.
    // A generated template did exactly that. The separation is the product, so
    // it is asserted rather than assumed.
    await scaffold((root) => {
      const config = loadConfig(root);
      for (const role of ["verifier", "critique", "smol"]) {
        expect(config.roles[role]?.tools, role).not.toContain("task");
        expect(config.roles[role]?.tools, role).not.toContain("write");
        expect(config.roles[role]?.tools, role).not.toContain("edit");
      }
      // The roles that coordinate are the ones that may delegate.
      expect(config.roles.coordinator?.tools).toContain("task");
      expect(config.roles.plan?.tools).toContain("task");
    });
  });

  it("no scaffolded role relies on the invisible max_steps default", async () => {
    // The README says a role that omits max_steps gets 12. Every shipped role
    // states its own so a reader never has to know that.
    await scaffold((root) => {
      const config = loadConfig(root);
      for (const role of listRoles(config)) {
        expect(typeof config.roles[role].max_steps, role).toBe("number");
        expect(typeof config.roles[role].max_steps_total, role).toBe("number");
      }
    });
  });

  it("implemented tools are exactly what tools.toml declares", async () => {
    await scaffold((root) => {
      const config = loadConfig(root);
      const set = buildToolSet(config);
      // The README's tool table, minus `webfetch`: it is declared with
      // enabled = false, because reaching the network is opt-in.
      expect(set.schemas.map((t) => t.function.name).sort()).toEqual(
        ["bash", "compute", "edit", "glob", "grep", "read", "skill", "task", "todo", "write"]
      );
      // Declared-but-disabled is reported, never silently dropped.
      expect(set.disabled).toContain("webfetch");
      expect(set.unimplemented).toEqual([]);
    });
  });
});

describe("files the README points at exist", () => {
  for (const path of ["LICENSE", "CONTRIBUTING.md", "docs/CONTRACTS.md", "conformance/manifest_golden.json", "conformance/exit_codes.json", ".gnomon/ci.sh"]) {
    it(path, () => {
      expect(existsSync(join(repoRoot, path)), `${path} is referenced by the README`).toBe(true);
    });
  }
});

describe("the README does not promise what is not built", () => {
  it("states the known limits it must state", () => {
    // These gaps are real; a reader finding them undocumented would be worse
    // than the gaps themselves.
    expect(readme).toContain("MCP is stdio-only");
    expect(readme).toContain("No role chain");
    // Qualified from "No cloud or background execution" once `loops` shipped:
    // cron-scheduled loops ARE an unattended path, so the blanket claim was
    // false. The limits that remain true are stated exactly.
    expect(readme).toContain("No cloud execution, and no long-running daemon");
    // `network = false` is enforced for `webfetch` and is not process
    // isolation. Both halves have to be stated: claiming enforcement without
    // the bash caveat would promise isolation that no allow-list over shell
    // text can deliver.
    expect(readme).toMatch(/network = false.*webfetch/s);
    expect(readme).toMatch(/not process\s+isolation/s);
    expect(readme).toMatch(/`bash`[^.]*reaches the network|curl/s);
  });
});

describe("a session states which project it is operating on", () => {
  const src = readFileSync(join(repoRoot, "packages/gnomon-core/src/prompt_loop.ts"), "utf-8");
  const cli = readFileSync(join(repoRoot, "packages/gnomon-cli/src/index.ts"), "utf-8");

  it("the banner names the project root", () => {
    // `.gnomon/` resolves by walking up, so running from the wrong directory
    // looked identical to running from the right one. A session was spent
    // working on the harness while its operator believed it was working on
    // their project.
    expect(src).toContain("Project: ${projectRoot}");
  });

  it("and says so when the root came from walking up", () => {
    expect(src).toContain("found by walking up from");
  });

  it("launch reports reusing a surface, not only creating one", () => {
    expect(cli).toContain("Using the existing .gnomon/ in");
  });
});

describe("the README outcome table matches the tool result codes", () => {
  // The row for write_allow was written against the wrong code minutes after
  // the feature landed. A table of numbers copied by hand is exactly the kind
  // of claim this file exists to hold down.
  const tools = readFileSync(
    join(repoRoot, "packages/gnomon-core/src/tools.ts"),
    "utf-8"
  );
  const constants = new Map(
    [...tools.matchAll(/export const (TOOL_[A-Z_]+) = (\d+);/g)].map(
      (m) => [m[1], Number(m[2])]
    )
  );

  it("documents every code the tools can return, and no invented ones", () => {
    const table = readme.slice(readme.indexOf("| Code | Bucket | When |"));
    const documented = new Set(
      [...table.slice(0, table.indexOf("\n\n")).matchAll(/`(\d+)`/g)].map((m) =>
        Number(m[1])
      )
    );
    const real = new Set(constants.values());
    for (const code of real) {
      expect(documented, `code ${code} is returned but undocumented`).toContain(code);
    }
    for (const code of documented) {
      expect(real, `code ${code} is documented but never returned`).toContain(code);
    }
  });

  it("puts the allow-list refusals on the code the guards actually return", () => {
    const denied = constants.get("TOOL_DENIED");
    // Scoped to the outcome table: the role reference also has a write_allow
    // row, and matching that one made this assert against the wrong table.
    const table = readme.slice(readme.indexOf("| Code | Bucket | When |"));
    const row = table
      .slice(0, table.indexOf("\n\n"))
      .split("\n")
      .find((l) => l.includes("write_allow"));
    expect(row, "no outcome row mentions write_allow").toBeTruthy();
    expect(row).toContain(`\`${denied}\``);
  });

  it("the guards do return it", () => {
    expect(tools).toContain("summary: `write ${path} — not permitted for this role`");
    expect(tools).toContain("summary: `edit ${path} — not permitted for this role`");
  });
});
