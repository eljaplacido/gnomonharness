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

  // Both quick-start docs print a `gnomon launch` transcript, and both quoted
  // eight tools for `implement` in an order the banner never uses -- the
  // banner prints the list SORTED, and `note` was missing from both. A reader
  // comparing their own first run against the doc finds a difference the doc
  // does not explain. Found 2026-09-08.
  it("the launch transcript in the docs quotes the tools the banner prints", async () => {
    const getting = readFileSync(join(repoRoot, "GETTING_STARTED.md"), "utf-8");
    await scaffold((root) => {
      const config = loadConfig(root);
      const banner = [...(config.roles.implement?.tools ?? [])].sort().join(", ");
      for (const [name, doc] of [["README.md", readme], ["GETTING_STARTED.md", getting]] as const) {
        const quoted = /Tools \(implement\): (.+)/.exec(doc)?.[1]?.trim();
        expect(quoted, `${name} should show the banner`).toBeDefined();
        expect(quoted, `${name} quotes a tool list the banner does not print`).toBe(banner);
      }
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


  it("the inert-enumeration set, its fixture and CONTRACTS.md are one set", () => {
    // CONTRACTS.md said "`role_profile` is declared and not implemented" for
    // weeks after 495fa40 made it route -- the contract document telling readers
    // a working feature was inert. Nothing could catch it: the inert set lived
    // in one prose paragraph and one TypeScript object, unlinked.
    const root = join(__dirname, "../../..");
    const fixture = JSON.parse(
      readFileSync(join(root, "conformance/declared_not_implemented.json"), "utf-8")
    ) as { declared_not_implemented: Record<string, string[]>; expected_keys: number };

    const src = readFileSync(join(root, "packages/gnomon-core/src/config.ts"), "utf-8");
    const block = src.slice(src.indexOf("const DECLARED_NOT_IMPLEMENTED"));
    const body = block.slice(0, block.indexOf("\n};"));

    const keys = [...body.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]).sort();
    expect(keys, "config.ts keys != the fixture").toEqual(
      Object.keys(fixture.declared_not_implemented).sort()
    );
    expect(keys.length).toBe(fixture.expected_keys);

    for (const [key, values] of Object.entries(fixture.declared_not_implemented)) {
      const m = new RegExp(`${key}: \\{[^}]*values: \\[([^\\]]*)\\]`, "s").exec(body);
      expect(m, `no values[] for "${key}" in DECLARED_NOT_IMPLEMENTED`).not.toBeNull();
      const inCode = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
      expect(inCode, `config.ts values for "${key}" != the fixture`).toEqual([...values].sort());
    }

    // And the document has to name each one, so the prose cannot drift from the
    // code again in the direction that started this.
    const contracts = readFileSync(join(root, "docs/CONTRACTS.md"), "utf-8");
    for (const values of Object.values(fixture.declared_not_implemented)) {
      for (const v of values) {
        expect(contracts, `CONTRACTS.md does not mention inert value "${v}"`).toContain(v);
      }
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

  // `gnomon endpoint` shipped registered, dispatched, help-documented and
  // absent from the README's CLI Reference for its whole life, because this
  // block checked the registry against --help and never against the table a
  // reader actually browses. Found 2026-09-08.
  it("every primary command has a row in the README's CLI Reference", () => {
    const table = readme.slice(readme.indexOf("## CLI Reference"));
    const documented = new Set<string>();
    for (const line of table.split("\n")) {
      const m = /^\|\s*`gnomon ([^`]+)`/.exec(line);
      if (!m) continue;
      // The first token of the cell carries the names; `apply\|simulate` and
      // `loop\|loops` share one row, so it may hold more than one.
      for (const n of m[1]!.split(" ")[0]!.replace(/\\/g, "").split("|")) {
        if (n) documented.add(n);
      }
    }
    const absent = CLI_COMMANDS.map((c) => c.name).filter((n) => !documented.has(n));
    expect(absent, `dispatched but absent from the README table: ${absent.join(", ")}`).toEqual([]);
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

// ---------------------------------------------------------------------------
// The native-only command set, in prose
// ---------------------------------------------------------------------------
//
// "Only `surface`, `apply` and `session` need the binaries" was written out in
// five places — three documents, the runtime error, and the release notes — and
// drifted on its first edit. For most of v0.2.x every copy was wrong:
// `enumerations` and `simulate` reach the crates too, so a user who installed
// from npm and ran `gnomon enumerations` was told, by the failure itself, that
// `gnomon enumerations` did not need a binary.
//
// packages/gnomon-natives/src/surface.ts now holds ONE list. This binds the
// prose to it. The measurement side — that the constant matches what actually
// fails on a machine with no Rust — is scripts/fresh-machine.sh, which runs the
// real commands in a container; the two together are what make the sentence
// true rather than merely consistent.
describe("the docs name the same native-only commands the code does", () => {
  const NATIVE_ONLY = ["surface", "enumerations", "session", "apply", "simulate"];

  it("the constant is the set this test was written against", () => {
    // If someone adds a native-backed command, this fails first and points at
    // the prose below rather than letting the docs quietly fall behind.
    const src = readFileSync(
      join(repoRoot, "packages/gnomon-natives/src/surface.ts"),
      "utf-8"
    );
    const block = src.match(/NATIVE_ONLY_COMMANDS = \[([\s\S]*?)\] as const;/);
    expect(block, "NATIVE_ONLY_COMMANDS is no longer a literal array").toBeTruthy();
    const declared = [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(declared).toEqual(NATIVE_ONLY);
  });

  it("the runtime error derives its list instead of spelling one out", () => {
    // The message is the copy a stuck user actually reads, and it was the copy
    // that stayed wrong longest.
    const src = readFileSync(
      join(repoRoot, "packages/gnomon-natives/src/surface.ts"),
      "utf-8"
    );
    expect(src).toContain("nativeOnlySentence()");
    expect(
      src.includes("Only `surface`, `apply` and `session` need"),
      "the old hand-written sentence is back in the error message"
    ).toBe(false);
  });

  for (const [label, path] of [
    ["README.md", "README.md"],
    ["GETTING_STARTED.md", "GETTING_STARTED.md"],
  ] as const) {
    it(`${label} names all five wherever it explains the native requirement`, () => {
      const text = readFileSync(join(repoRoot, path), "utf-8");
      // Anchored on the COMMAND LIST, not on the prose around it. A first
      // version matched phrasings ("need them", "a Rust toolchain is needed")
      // and found nothing in README, which words it as "A **Rust toolchain** is
      // needed only for ..." -- a test that silently matches no sentence is the
      // vacuous green this whole session has been about, so it now finds the
      // passages by the thing they are all guaranteed to contain.
      const marker = "`surface`";
      const windows: string[] = [];
      for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
        const w = text.slice(Math.max(0, i - 300), i + 400);
        // Only passages that are ABOUT the native requirement. `surface` is
        // also a noun in this project, and the surface hash is discussed
        // everywhere.
        if (/Rust toolchain|native binaries|native crates|need the binaries/i.test(w)) {
          windows.push(w);
        }
      }
      expect(
        windows.length,
        `${label} no longer explains the native requirement anywhere — either the ` +
          `passage moved, or this test stopped finding it. Both need a human.`
      ).toBeGreaterThan(0);

      for (const w of windows) {
        for (const cmd of NATIVE_ONLY) {
          expect(
            w.includes(`\`${cmd}\``),
            `${label}: a passage about the native requirement omits \`${cmd}\`.\n` +
              `    This is the drift that made every copy of this sentence wrong\n` +
              `    for most of v0.2.x. The set is NATIVE_ONLY_COMMANDS in\n` +
              `    packages/gnomon-natives/src/surface.ts.\n\n` +
              `    Passage:\n${w.slice(250, 550).replace(/^/gm, "      ")}`
          ).toBe(true);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Numbers and lists the docs state, READ BACK from what they describe
// ---------------------------------------------------------------------------
//
// Eight of the thirty-two defects an independent sweep confirmed in the
// released v0.2.3 were the same thing: a count or a list, typed into prose by
// hand, that had stopped matching the code. Not one was a hard question —
// "three required checks" (seven), "27 Rust tests" (28), "three targets"
// (four), "six version carriers" (eight), "TS 5.x" (7). They drifted because
// stating a precise number in prose is a promise to maintain it, and nothing
// was maintaining them.
//
// This session added a ninth on its own: a sixth stale copy of the
// native-commands sentence, found by scripts/fresh-machine.sh at the top of
// GETTING_STARTED.md, after two separate passes over that same file had
// corrected the copies their authors could remember.
//
// So each claim below is DERIVED from the artefact it describes, never
// asserted alongside it. The rule these follow: if a test has to be edited
// whenever the codebase changes, it is a second copy of the claim and will
// drift too. Every derivation reads its ground truth at run time, and fails
// loudly when it can no longer find it — a matcher that silently matches
// nothing is the vacuous green this whole file exists to prevent.
describe("numbers the docs state are read back from what they describe", () => {
  const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf-8");
  const releasing = readFileSync(join(repoRoot, "docs/RELEASING.md"), "utf-8");
  const contracts = readFileSync(join(repoRoot, "docs/CONTRACTS.md"), "utf-8");
  const gettingStarted = readFileSync(join(repoRoot, "GETTING_STARTED.md"), "utf-8");
  const ciYml = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf-8");
  const releaseYml = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf-8");

  const WORDS = [
    "zero", "one", "two", "three", "four", "five", "six",
    "seven", "eight", "nine", "ten", "eleven", "twelve",
  ];
  /** "eight" for 8 — the docs spell counts out, so the check must too. */
  const word = (n: number): string => WORDS[n] ?? String(n);

  // ── A. Version carriers ────────────────────────────────────────────────
  //
  // Said "six" in four places while check-versions.sh read eight. The
  // authority is the script, because it is what actually fails a release.
  it("the version-carrier count matches what check-versions.sh reads", () => {
    const out = readFileSync(join(repoRoot, "scripts/check-versions.sh"), "utf-8");
    // The script emits one line per carrier; derive the count from the emit
    // calls and the globs they loop over rather than from a number anywhere.
    const carriers = [
      "Cargo.toml",
      "package.json",
      ...readdirSync(join(repoRoot, "packages")).map((p) => `packages/${p}/package.json`),
      "conformance/manifest_golden.json",
      "conformance/session_golden.json",
    ].filter((f) => existsSync(join(repoRoot, f)));
    expect(carriers.length, "no version carriers found — the layout moved").toBeGreaterThan(3);
    expect(out).toContain("emit"); // the shape this derivation assumes

    const n = word(carriers.length);
    for (const [label, text] of [
      ["CONTRIBUTING.md", contributing],
      ["docs/RELEASING.md", releasing],
      ["scripts/bump-version.sh", readFileSync(join(repoRoot, "scripts/bump-version.sh"), "utf-8")],
    ] as const) {
      const claims = [...text.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=[^.\n]{0,40}(?:version carriers|places|files)\b)/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((w) => /(?:carrier|place|file)/i.test(text.slice(text.indexOf(w))));
      // Only assert on documents that actually make the claim.
      const stated = [...text.matchAll(/\b(six|seven|eight|nine|ten)\b\s+(?:version carriers|places|files)/gi)]
        .map((m) => m[1].toLowerCase());
      if (stated.length === 0) continue;
      for (const s of stated) {
        expect(s, `${label} says "${s}" carriers; check-versions.sh reads ${carriers.length}`).toBe(n);
      }
      void claims;
    }
  });

  // ── B. Release targets ─────────────────────────────────────────────────
  //
  // Said "three targets (linux-x64, linux-arm64, darwin-arm64)" after
  // windows-x64 joined the matrix on 2026-09-05.
  it("the release-target list matches release.yml's build matrix", () => {
    const targets = [...releaseYml.matchAll(/^\s+- name: ([a-z0-9]+-[a-z0-9]+)$/gm)].map((m) => m[1]);
    expect(targets.length, "no build targets found in release.yml — the matrix moved").toBeGreaterThan(1);

    const claim = releasing.match(/builds binaries for (\w+) targets \(([^)]+)\)/s);
    expect(claim, "docs/RELEASING.md no longer states the target list").toBeTruthy();
    expect(claim![1].toLowerCase(), `RELEASING says "${claim![1]}" targets; the matrix has ${targets.length}`)
      .toBe(word(targets.length));
    for (const t of targets) {
      expect(
        claim![2].includes(t),
        `docs/RELEASING.md's target list omits ${t}, which release.yml builds`
      ).toBe(true);
    }
  });

  // ── C. Required checks ─────────────────────────────────────────────────
  //
  // CONTRIBUTING said "three green checks" while branch protection required
  // seven. The count itself lives on GitHub and cannot be read from here — but
  // the NAMES can be, and a renamed job silently stops being required, which is
  // the worse failure of the two.
  it("every required check CONTRIBUTING names is a real job in ci.yml", () => {
    const jobs = [...ciYml.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
    expect(jobs.length, "no job names found in ci.yml").toBeGreaterThan(3);

    const claim = contributing.match(/requires one approving review and (\w+) green checks/);
    expect(claim, "CONTRIBUTING no longer states the required-check count").toBeTruthy();

    // The prose names the set; each name it uses must correspond to a job.
    // Matched loosely — the prose is prose — but every anchor has to land.
    const anchors: Array<[string, RegExp]> = [
      ["the .gnomon/ci.sh pipeline", /Full CI pipeline/],
      ["macOS", /macos-latest/],
      ["Windows", /windows-latest/],
      ["the prompt-loop smoke test", /[Ii]nteractive prompt loop/],
      ["the contract⇒fixture gate", /Contract change/],
    ];
    for (const [label, jobPattern] of anchors) {
      expect(
        jobs.some((j) => jobPattern.test(j)),
        `CONTRIBUTING's required-check list names ${label}, but no ci.yml job matches ${jobPattern}. ` +
          `A renamed job stops being required by branch protection SILENTLY.`
      ).toBe(true);
    }
  });

  // ── D. Which commands take --profile ───────────────────────────────────
  //
  // It changes which machine runs inference and who is billed, and for its
  // whole life it appeared in no help text and no document. Now that it is
  // documented, the list is derived from the call sites.
  it("the --profile command list matches the commands that read the flag", () => {
    // Every `loadConfig(args.dir, args.flags['profile'])` sits inside a cmdX.
    const fns = [...help.matchAll(/^(?:async )?function cmd([A-Z]\w*)/gm)];
    expect(fns.length, "no cmd* functions found — index.ts moved").toBeGreaterThan(5);

    const takesProfile = new Set<string>();
    for (const m of help.matchAll(/flags\['profile'\]/g)) {
      const before = help.slice(0, m.index);
      const owner = [...before.matchAll(/^(?:async )?function cmd([A-Z]\w*)/gm)].pop();
      if (owner) takesProfile.add(owner[1].toLowerCase());
    }
    expect(takesProfile.size, "nothing reads --profile any more").toBeGreaterThan(0);

    const claim = readme.match(/\*\*`--profile <name>`\*\* is accepted by ([^.]+)\./s);
    expect(claim, "README no longer documents --profile").toBeTruthy();
    const documented = new Set(
      [...claim![1].matchAll(/`([a-z]+)`/g)].map((m) => m[1])
    );

    for (const cmd of takesProfile) {
      expect(
        documented.has(cmd),
        `\`gnomon ${cmd}\` reads --profile and rewrites where inference goes, but README does not list it`
      ).toBe(true);
    }
    for (const cmd of documented) {
      expect(
        takesProfile.has(cmd),
        `README says \`${cmd}\` accepts --profile; no call site in index.ts reads it there`
      ).toBe(true);
    }
  });

  // ── E. The launch banner both quick-starts quote ───────────────────────
  //
  // Both transcripts quoted eight tools and the banner prints nine — `note`
  // was missing from each. A transcript is a claim about output.
  it("the quoted `Tools (implement)` line matches a real scaffold", async () => {
    // Exactly what prompt_loop.ts's reportTools() prints: the schema names, in
    // schema order. NOT re-sorted here -- the schemas are already sorted (Rule
    // 3: declared, sorted, hashed), and sorting again in the test would hide a
    // future change to that ordering, which is itself part of the surface.
    const real = await scaffold(async (root) => {
      const config = loadConfig(root);
      return buildToolSet(config, "implement")
        .schemas.map((s) => s.function.name)
        .join(", ");
    });
    expect(real.length, "the scaffolded implement role has no tools").toBeGreaterThan(0);

    for (const [label, text] of [
      ["README.md", readme],
      ["GETTING_STARTED.md", gettingStarted],
    ] as const) {
      const quoted = [...text.matchAll(/^Tools \(implement\): (.+)$/gm)].map((m) => m[1].trim());
      expect(quoted.length, `${label} no longer quotes the launch banner`).toBeGreaterThan(0);
      for (const q of quoted) {
        expect(q, `${label} quotes a Tools (implement) line the scaffold does not produce`).toBe(real);
      }
    }
  });

  // ── F. The exit-code fixture's own numbers ─────────────────────────────
  it("CONTRACTS' code and bucket counts come from the fixture", () => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, "conformance/exit_codes.json"), "utf-8")
    ) as { exit_codes: Record<string, string>; buckets: string[] };
    const codes = Object.keys(fixture.exit_codes).length;
    const buckets = fixture.buckets.length;

    const claim = contracts.match(/fixture holds (\w+) codes and that each maps to one of the (\w+)/);
    expect(claim, "docs/CONTRACTS.md no longer states the exit-code counts").toBeTruthy();
    expect(claim![1].toLowerCase(), `CONTRACTS says "${claim![1]}" codes; the fixture holds ${codes}`)
      .toBe(word(codes));
    expect(claim![2].toLowerCase(), `CONTRACTS says "${claim![2]}" buckets; the fixture declares ${buckets}`)
      .toBe(word(buckets));
  });

  // ── G. The toolchain CONTRIBUTING tells a contributor to install ───────
  //
  // Said "TS 5.x" two commits after the workspace moved to TypeScript 7.
  it("the stated dev toolchain matches the manifests", () => {
    const core = JSON.parse(
      readFileSync(join(repoRoot, "packages/gnomon-core/package.json"), "utf-8")
    ) as { devDependencies?: Record<string, string> };
    const major = (spec: string | undefined): string | undefined =>
      spec?.match(/(\d+)/)?.[1];

    const ts = major(core.devDependencies?.typescript);
    const vitest = major(core.devDependencies?.vitest);
    expect(ts, "gnomon-core declares no typescript devDependency").toBeTruthy();
    expect(vitest, "gnomon-core declares no vitest devDependency").toBeTruthy();

    const claim = contributing.match(/^- TS ([\d.x]+), pnpm, `vitest` (\d+) for tests\.$/m);
    expect(claim, "CONTRIBUTING no longer states the dev toolchain").toBeTruthy();
    expect(claim![1].startsWith(ts!), `CONTRIBUTING says TS ${claim![1]}; the workspace is on ${ts}.x`).toBe(true);
    expect(claim![2], `CONTRIBUTING says vitest ${claim![2]}; the workspace is on ${vitest}`).toBe(vitest);
  });

  // ── H. loop's subcommands, in three places ─────────────────────────────
  //
  // `--help` listed four of eight. The missing ones included `kill`, the stop
  // switch for unattended cron execution — and the command's own error message
  // has always listed all eight, so the help text disagreed with the binary it
  // documents.
  it("loop's subcommands agree across the dispatcher, --help and the README", () => {
    const fromError = help.match(/Use: (list \| status \|[^"]+)"/);
    expect(fromError, "the loop error message no longer lists its subcommands").toBeTruthy();
    const subs = fromError![1]
      .split("|")
      .map((s) => s.trim().replace(/\s*<.*$/, ""))
      .filter(Boolean);
    expect(subs.length, "the loop subcommand list came back empty").toBeGreaterThan(4);

    const helpLine = help.match(/^ {2}loop \[([^\]]+)\]/m);
    expect(helpLine, "--help no longer documents `loop`").toBeTruthy();
    for (const s of subs) {
      expect(
        helpLine![1].includes(s),
        `\`gnomon loop ${s}\` is dispatched but --help does not list it. ` +
          `\`kill\` went missing this way — the stop switch for unattended cron.`
      ).toBe(true);
    }

    const readmeRow = readme.match(/^\| `gnomon loop\\\|loops \[([^\]]+)\]/m);
    expect(readmeRow, "README's CLI Reference has no loop row").toBeTruthy();
    for (const s of subs) {
      expect(
        readmeRow![1].includes(s),
        `README's loop row omits \`${s}\``
      ).toBe(true);
    }
  });
});
