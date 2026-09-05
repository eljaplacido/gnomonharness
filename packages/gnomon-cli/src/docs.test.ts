/**
 * gnomon-cli: Documentation coherence
 *
 * The README makes checkable claims — commands that exist, defaults that hold,
 * files that are present. A claim nobody verifies drifts from the code the
 * moment either changes, and this repository's history is largely a record of
 * documented behaviour that was not the behaviour.
 */

import { describe, it, expect } from "vitest";
import { CLI_COMMANDS } from "./index.js";
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync} from "node:fs";
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

/** First match for a bare filename under a tree, ignoring build output. */
function findFile(dir: string, name: string): string | null {
  let found: string | null = null;
  const walk = (d: string) => {
    if (found) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      if (e.isDirectory()) {
        if (["node_modules", "dist", "target", ".git"].includes(e.name)) continue;
        walk(join(d, e.name));
      } else if (e.name === name) {
        found = join(d, e.name);
      }
    }
  };
  walk(dir);
  return found;
}

describe("documented defaults are the actual defaults", () => {
  it("a scaffolded surface matches what the README says it ships", async () => {
    await scaffold((root) => {
      const config = loadConfig(root);

      // "Approval is on_write: reads are free, writes show a diff first."
      expect(config.config.defaults?.approval).toBe("on_write");
      // "sandbox = confined"
      expect(config.config.defaults?.sandbox).toBe("confined");
      // "compaction = summary … is the default" — changed 2026-09-04; `discard`
      // measured 0/9 on context retention against 9/9 for `summary`.
      expect(resolveContext(config).compaction).toBe("summary");
      // And the role that default needs must exist in the surface that ships
      // it. `summary` without its summary_role degrades to `discard` with a
      // warning -- honest, but it would mean the documented default silently
      // does nothing on a freshly scaffolded project, which is worse than
      // having left `discard` in place.
      const ctx = resolveContext(config);
      expect(config.roles[ctx.summary_role]).toBeTruthy();
      // It must also be reachable without a key, because the shipped profile
      // is local_first: "No key, no bill, no network."
      expect(config.roles[ctx.summary_role]?.endpoint).toBe("local");
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
        "read", "glob", "grep", "compute", "todo", "note", "task", "write", "skill",
      ]);
      // | `implementor` | read, glob, grep, write, edit, bash |
      expect(config.roles.implementor?.tools).toEqual([
        "read", "glob", "grep", "compute", "todo", "note", "write", "edit", "bash",
      ]);
      // | `verifier` | read, glob, grep, bash (allow-listed) |
      expect(config.roles.verifier?.tools).toEqual([
        "read", "glob", "grep", "compute", "todo", "note", "bash",
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
        ["bash", "compute", "edit", "glob", "grep", "note", "read", "skill", "task", "todo", "write"]
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
    // Was `expect(readme).toContain("No role chain")` — and [chain] SHIPPED:
    // init scaffolds it, the auditor validates it, the loop runs the stages,
    // and the trail writes one chain_stage record per stage. So this assertion
    // made correcting the README a CI failure: a test pinning a false claim,
    // which is the same shape as the six defects this project spent a week
    // removing. The limit that IS true is that the chain gates on nothing —
    // no stage's outcome stops the next — and that is what must be stated.
    expect(readme).toMatch(/role chain runs in order and gates on nothing/i);
    expect(readme, "the false limit must not come back").not.toContain("No role chain.");
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

  it("the stop_reason enumeration, its fixture and its documentation are one set", () => {
    // Rule 6 is about published enumerations, and stop_reason is one: it appears
    // on every TaskRecord and every `turn` audit record, and a consumer switches
    // on it. It was not published anywhere until the values had already drifted
    // once -- `apparatus` had to be added because every failure of that kind was
    // borrowing `answered`, recording a run that never started as a turn that
    // concluded.
    //
    // This check used to hold its own hand-kept `expected` array and assert only
    // that CONTRACTS.md contained each of them. That is one direction of three:
    // a value the code emits and nobody documented passed, a value documented
    // and never emitted passed, and the array itself was a fourth copy of the
    // truth kept in step by hand. Now the union in the source, the table in
    // CONTRACTS.md and conformance/stop_reason.json must be the SAME SET, so
    // adding a value means touching all three deliberately -- the same shape as
    // conformance/exit_codes.json.
    const root = join(__dirname, "../../..");
    const fixture = JSON.parse(
      readFileSync(join(root, "conformance/stop_reason.json"), "utf-8")
    ) as { stop_reason: Record<string, string>; expected_count: number };
    const pinned = Object.keys(fixture.stop_reason).sort();

    // The union as the code declares it, read out of the source rather than
    // imported: importing the type gives nothing at runtime.
    const src = readFileSync(
      join(root, "packages/gnomon-core/src/prompt_loop.ts"),
      "utf-8"
    );
    const union = src.slice(src.indexOf("export type StopReason ="));
    // Only the union arms: `  | "value"` on a line of its own. A bare
    // /"([a-z_]+)"/ over the block also matches the value names quoted inside
    // the comments that explain them, which is how the first version of this
    // read `answered` four times.
    const emitted = [
      ...union.slice(0, union.indexOf(";")).matchAll(/^\s*\|\s*"([a-z_]+)"\s*$/gm),
    ]
      .map((m) => m[1])
      .sort();

    const contracts = readFileSync(join(root, "docs/CONTRACTS.md"), "utf-8");
    const documented = [...contracts.matchAll(/^\| `([a-z_]+)` \| /gm)].map((m) => m[1]);

    expect(pinned.length, "expected_count must match the fixture's own keys").toBe(
      fixture.expected_count
    );
    expect(emitted, "the code's StopReason union != conformance/stop_reason.json").toEqual(
      pinned
    );
    for (const value of pinned) {
      expect(documented, `stop_reason "${value}" is not in CONTRACTS.md`).toContain(value);
    }
  });

  it("every file:line the docs cite still resolves", () => {
    // Documentation rots by pointing at code that moved. This is the cheap,
    // checkable half of that problem: a citation naming a file that no longer
    // exists, or a line past the end of it, is definitely stale.
    //
    // It does NOT catch the expensive half -- prose that is simply no longer
    // true. HARNESS-RESEARCH-RECONCILIATION.md asserted "TaskRecord carries no
    // stop_reason" for days after it gained one, and nothing mechanical could
    // have known. That kind of drift is found by reading, which is why the
    // reconciliation pass is a task and not a test.
    const root = join(__dirname, "../../..");
    const docs = [
      ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => join(root, "docs", f)),
      join(root, "README.md"),
    ];
    const cite = /\b([a-z_]+\.(?:ts|rs)):(\d+)/g;
    const stale: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(doc, "utf-8");
      for (const m of text.matchAll(cite)) {
        const [, file, lineNo] = m;
        const found = findFile(join(root, "packages"), file!) ?? findFile(join(root, "crates"), file!);
        if (!found) {
          stale.push(`${doc.split("/").pop()}: ${m[0]} — no such file`);
          continue;
        }
        const lines = readFileSync(found, "utf-8").split("\n").length;
        if (Number(lineNo) > lines) {
          stale.push(`${doc.split("/").pop()}: ${m[0]} — file has ${lines} lines`);
        }
      }
    }
    expect(stale, `stale citations:\n${stale.join("\n")}`).toEqual([]);
  });
});

describe("the CLI command surface agrees with itself, both directions", () => {
  // The asymmetry that let three commands diverge: this file checked
  // documented -> dispatched and never dispatched -> documented, so a command
  // that existed and was undocumented was invisible to the only mechanism
  // watching for exactly that.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const dispatched = new Set([...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
  const registry = CLI_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

  it("every dispatched command is in the registry", () => {
    const missing = [...dispatched].filter((c) => !registry.includes(c));
    expect(missing, `dispatched but not registered: ${missing.join(", ")}`).toEqual([]);
  });

  it("every registered command is actually dispatched", () => {
    const dead = registry.filter((c) => !dispatched.has(c));
    expect(dead, `registered but not dispatched: ${dead.join(", ")}`).toEqual([]);
  });

  it("every primary command appears in --help", () => {
    const help = readFileSync(join(__dirname, "index.ts"), "utf8");
    const body = help.slice(help.indexOf("Commands:"));
    const absent = CLI_COMMANDS.map((c) => c.name).filter(
      (n) => !new RegExp(`\\n  ${n}[ \\[\\n]`).test(body)
    );
    expect(absent, `dispatched but absent from --help: ${absent.join(", ")}`).toEqual([]);
  });
});
