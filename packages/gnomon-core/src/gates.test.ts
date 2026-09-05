/**
 * Every gate must be able to FAIL.
 *
 * Six of the defects found on 2026-09-01 were the same shape: a mechanism
 * reporting success while doing nothing. `pnpm -r typecheck` exited 0 with no
 * checker installed. The surface audit's executor warning was silenced on every
 * scaffolded surface by that surface's own deny rule. A declared MCP server was
 * absent from one entry point. A ref guard aborted every trial and read as
 * capability failure. Each was found by accident -- a build error, credits that
 * did not move, an experiment breaking -- and none by a test.
 *
 * A gate nobody has watched fail is a gate that probably cannot. These are the
 * negative controls: inject a fault, require the gate to catch it. They are
 * deliberately about the FAILING direction only; the passing direction is
 * covered by the suites beside this one.
 */
import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditSurface, loadConfig, recomputeManifest, resolveChain } from "./config.js";
import { resolveInRoot, executeTool } from "./tools.js";

const surface = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-gate-"));
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, ".gnomon", name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
};

describe("gate: the surface audit", () => {
  it("is FATAL on a chain stage naming a role that does not exist", () => {
    const dir = surface({
      "config.toml": '[chain]\nstages = ["plan", "nosuchrole"]\n',
      "roles.toml": "[roles.plan]\ntools = [\"read\"]\n",
    });
    const fatal = auditSurface(loadConfig(dir)).filter((p) => p.fatal);
    expect(fatal.length).toBeGreaterThan(0);
    expect(fatal.map((f) => f.problem).join(" ")).toContain("nosuchrole");
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches an unknown role key rather than ignoring it", () => {
    const dir = surface({ "roles.toml": '[roles.a]\ntools = ["read"]\nbash_alow = ["x"]\n' });
    const problems = auditSurface(loadConfig(dir));
    expect(problems.some((p) => /bash_alow/.test(p.problem))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: the manifest hash", () => {
  it("MOVES when a hashed file changes", () => {
    const dir = surface({ "config.toml": "[defaults]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    appendFileSync(join(dir, ".gnomon", "config.toml"), "\n# a change\n");
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("MOVES when a hashed file is removed — absence counts", () => {
    const dir = surface({ "config.toml": "[defaults]\n", "roles.toml": "[roles.a]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    rmSync(join(dir, ".gnomon", "roles.toml"));
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: sandbox confinement", () => {
  it("REFUSES a path outside the root", () => {
    expect(resolveInRoot("/repo", "/etc/passwd", "confined")).toBeNull();
    expect(resolveInRoot("/repo", "../../etc/passwd", "confined")).toBeNull();
  });
  it("REFUSES a sibling of a granted extra root", () => {
    expect(resolveInRoot("/repo", "/other/../elsewhere/x", "confined", ["/other"])).toBeNull();
  });
});

describe("gate: bash_deny and task_allow", () => {
  const ctx = (extra: Record<string, unknown>) =>
    ({ root: tmpdir(), sandbox: "confined", gate: "never", approve: async () => true,
       timeoutMs: 5000, maxOutputBytes: 4096, ...extra }) as never;

  it("REFUSES a denied command", async () => {
    const r = await executeTool("bash", { command: "git push --force origin main" },
      ctx({ bashDeny: ["\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b"] }), new Set(["bash"]));
    expect(r.code).toBe(2);
  });

  it("REFUSES a delegation target outside task_allow", async () => {
    const r = await executeTool("task", { role: "implement", instruction: "x" },
      ctx({ taskAllow: ["verifier"],
            delegate: { depth: 0, roles: () => ["implement", "verifier"],
                        run: async () => ({ answer: "", code: 0 }) } }), new Set(["task"]));
    expect(r.code).toBe(2);
  });
});

describe("gate: the repository's own CI gates can fail", () => {
  // The one that actually bit: `pnpm -r typecheck` exited 0 for months while
  // no package defined the script, so every "typecheck clean" was vacuous.
  it("every TypeScript package defines a real typecheck script", () => {
    for (const pkg of ["gnomon-core", "gnomon-cli", "gnomon-tui", "gnomon-natives"]) {
      const json = JSON.parse(
        readFileSync(join(__dirname, "..", "..", pkg, "package.json"), "utf8")
      ) as { scripts?: Record<string, string> };
      expect(json.scripts?.typecheck, `${pkg} has no typecheck script`).toBeTruthy();
      expect(json.scripts?.typecheck).toContain("tsc");
    }
  });

  it("tsc actually rejects a type error, and accepts a correct one", () => {
    // This test is the reason the file exists, and until now it could not fail.
    //
    // It ran `npx tsc` with cwd = packages/, which has no node_modules. npx then
    // resolved the npm DECOY package named `tsc` ("This is not the tsc command
    // you are looking for"), which exits 1 unconditionally. Measured from that
    // directory: a string assigned to a number -> exit 1, and `const n: number =
    // 42` -> exit 1 as well. The assertion held for both, so a green result said
    // nothing about TypeScript at all.
    //
    // Two changes make it a control. It runs from a package that HAS the real
    // compiler, and it asserts BOTH directions -- a checker that rejects
    // everything is exactly as useless as one that accepts everything, and only
    // the second assertion can tell them apart.
    const cwd = join(__dirname, "..");
    const check = (src: string): boolean => {
      const dir = mkdtempSync(join(tmpdir(), "gnomon-tsc-"));
      writeFileSync(join(dir, "x.ts"), src);
      try {
        // npx.cmd on Windows. execFileSync resolves .exe from PATH but not
        // .cmd, so plain "npx" throws ENOENT there -- and this check returns
        // false for BOTH inputs, which reads as "tsc rejected correct code"
        // when tsc never ran at all. The same failure the comment above
        // describes for the npm decoy package, from the other direction.
        execFileSync(process.platform === "win32" ? "npx.cmd" : "npx",
          ["tsc", "--noEmit", "--strict", join(dir, "x.ts")], {
          stdio: "pipe",
          cwd,
        });
        return true;
      } catch {
        return false;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(check("const n: number = 'not a number';\n"), "tsc accepted a type error").toBe(false);
    expect(check("const n: number = 42;\n"), "tsc rejected correct code — it is not really running").toBe(true);
  });
});

describe("gate: the auditor reports each problem once", () => {
  it("does not multiply surface-level findings by the number of roles", () => {
    // Three checks -- [chain] stages, task_allow, extra_roots -- are about the
    // SURFACE, not one role, and sat inside the per-role loop. Each ran once
    // per role: two genuine warnings appeared seven times each on this
    // repository's own seven-role surface. Fifteen lines for three problems,
    // and a fatal chain stage would have printed seven fatal errors.
    const dir = surface({
      "config.toml": '[chain]\nstages = ["a", "nosuch"]\n',
      "roles.toml": ["a", "b", "c", "d", "e"]
        .map((r) => `[roles.${r}]\ntools = ["read"]\n`)
        .join(""),
    });
    const problems = auditSurface(loadConfig(dir));
    const chainProblems = problems.filter((p) => /\[chain\]/.test(p.where));
    expect(chainProblems.length, "one bad stage, one report").toBe(1);
    expect(chainProblems[0].problem).toContain("nosuch");
    const keyed = problems.map((p) => `${p.where}|${p.problem}`);
    expect(new Set(keyed).size, "no problem reported twice").toBe(keyed.length);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: a record names the harness that produced it", () => {
  it("carries a build identifier, not just a surface hash", async () => {
    // An independent audit put this first of thirteen findings and the only
    // one touching the thesis: the surface hash says what RULES a run was
    // under, and nothing said what CODE read them. Two people on identical
    // surfaces with different builds get different behaviour, because loop
    // constants and the loop itself live outside the surface.
    const { harnessBuild } = await import("./build.js");
    const b = harnessBuild();
    expect(b).toMatch(/^gnomon\/\d+\.\d+\.\d+\+/);
    // Never silently claims a commit it is not on.
    expect(b.endsWith("+")).toBe(false);
  });

  it("says -dirty for an edited tree, and does not for a committed one", async () => {
    // What this replaced, and why: the old assertion was
    // `expect(clean || dirty || unknown).toBe(true)` -- a disjunction over
    // EVERY string harnessBuild() can return. Measured against the real
    // build.ts: hardcoding `const dirty = ""` (deleting the suffix outright)
    // and inverting the porcelain test to `.length === 0` BOTH left it green.
    // It could not fail, so it was not evidence that a build from an edited
    // tree stops claiming to be its last commit.
    //
    // harnessBuild() runs git with cwd = its own source directory, so the tree
    // under test is selected the way git itself selects one: GIT_DIR and
    // GIT_WORK_TREE. That drives the real execFileSync calls against a
    // throwaway repository whose clean/dirty state this test owns, instead of
    // asserting against whatever the checkout happens to look like -- which is
    // the other reason the old test had to be a disjunction.
    //
    // vi.resetModules() is required, not decorative: harnessBuild() caches its
    // answer in a module-level `cached`, so without a fresh module instance the
    // second call would return the first call's string and the two halves would
    // agree for the wrong reason.
    const repo = mkdtempSync(join(tmpdir(), "gnomon-build-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const saved = {
      dir: process.env.GIT_DIR,
      work: process.env.GIT_WORK_TREE,
      build: process.env.GNOMON_BUILD,
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "committed\n");
      git("add", "a.txt");
      git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "one");

      process.env.GIT_DIR = join(repo, ".git");
      process.env.GIT_WORK_TREE = repo;
      // GNOMON_BUILD short-circuits git entirely; a stamped environment would
      // make every assertion below pass without git being consulted at all.
      delete process.env.GNOMON_BUILD;

      vi.resetModules();
      const clean = (await import("./build.js")).harnessBuild();
      expect(clean, `expected a committed sha, got: ${clean}`).toMatch(/\+[0-9a-f]{7,}$/);
      expect(clean.endsWith("-dirty"), `a committed tree must not say dirty: ${clean}`).toBe(false);

      appendFileSync(join(repo, "a.txt"), "an uncommitted edit\n");

      vi.resetModules();
      const dirty = (await import("./build.js")).harnessBuild();
      expect(dirty, `an edited tree must say dirty, got: ${dirty}`).toMatch(/\+[0-9a-f]{7,}-dirty$/);
      // The commit did not move; only the tree did. Asserting the exact pair
      // rules out a build string that changed for some other reason.
      expect(dirty).toBe(`${clean}-dirty`);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.work === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.work;
      if (saved.build !== undefined) process.env.GNOMON_BUILD = saved.build;
      vi.resetModules();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("says +unknown, never a guess, when there is no repository to ask", async () => {
    // The third branch of the resolution order, and the one a stranger who
    // installed from a tarball actually gets. "unknown" is the honest answer;
    // a build string that silently reported the last commit of some UNRELATED
    // repository -- whichever one git found by walking up from the install
    // directory -- would be a wrong provenance string, which build.ts's own
    // header calls worse than an absent one.
    const empty = mkdtempSync(join(tmpdir(), "gnomon-norepo-"));
    const saved = {
      dir: process.env.GIT_DIR,
      work: process.env.GIT_WORK_TREE,
      build: process.env.GNOMON_BUILD,
    };
    try {
      // A GIT_DIR that is not a repository: git fails, and the catch runs.
      process.env.GIT_DIR = join(empty, "not-a-repo");
      process.env.GIT_WORK_TREE = empty;
      delete process.env.GNOMON_BUILD;
      vi.resetModules();
      const b = (await import("./build.js")).harnessBuild();
      expect(b).toMatch(/\+unknown$/);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.work === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.work;
      if (saved.build !== undefined) process.env.GNOMON_BUILD = saved.build;
      vi.resetModules();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("gate: the turn limits are surface-declared and stay in one place", () => {
  it("defaults resolve to LOOP_DEFAULTS when no [turn] block is declared", async () => {
    const { resolveLoop, LOOP_DEFAULTS, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[defaults]\n" });
    expect(resolveLoop(loadConfig(dir))).toEqual(LOOP_DEFAULTS);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a declared [turn] block actually changes the resolved value", async () => {
    // Without this the block could be inert and nothing would notice, which is
    // the failure mode the whole finding is about.
    const { resolveLoop, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[turn]\nmax_steps = 40\nstall_repeats = 9\n" });
    const r = resolveLoop(loadConfig(dir));
    expect(r.max_steps).toBe(40);
    expect(r.stall_repeats).toBe(9);
    rmSync(dir, { recursive: true, force: true });
  });

  it('"turn" is a known block, so the auditor does not disown what the code reads', async () => {
    // Deleting this entry passed all 718 tests when the block was added --
    // exactly the [chain] regression the KNOWN_BLOCKS comment cites as the
    // reason the line exists. It can silently revert; now it cannot.
    const { auditSurface, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[turn]\nmax_steps = 12\n" });
    const disowned = auditSurface(loadConfig(dir)).filter((p) =>
      /\[turn\] is not a block|not a block this harness reads/.test(p.problem)
    );
    expect(disowned, "the auditor disowns a block the code reads").toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("[turn] does not collide with the [loop] header used by .gnomon/loops/", async () => {
    // Two schemas behind one name in two files is how an operator writes
    // [loop] name = "nightly" into config.toml and gets silence.
    const src = readFileSync(join(__dirname, "config.ts"), "utf8");
    const start = src.indexOf("const KNOWN_BLOCKS");
    const region = src.slice(start, src.indexOf("];", start));
    // Entries only. The comment above them names [loop] on purpose, to say why
    // this block is NOT called that, so matching the raw text would match prose.
    const entries = region
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .flatMap((l) => [...l.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    expect(entries).toContain("turn");
    expect(entries, "[loop] is the loops/ declaration header, not this").not.toContain("loop");
  });
});

describe("gate: a credential cannot be configuration in disguise", () => {
  it("refuses a stored name the surface does not declare as a key variable", async () => {
    // The store accepted ANY shell identifier and injected every entry into
    // process.env unconditionally -- while GNOMON_MODEL_URL,
    // GNOMON_MODEL_TIMEOUT_MS and GNOMON_BIN_OVERRIDE are all read from that
    // same environment. Measured: storing GNOMON_MODEL_URL rerouted inference
    // to another host with the SURFACE HASH UNCHANGED. A key must select
    // credentials, never a model, a timeout or a binary.
    const { applyCredentials, refusedCredentials } = await import("./credentials.js");
    const dir = mkdtempSync(join(tmpdir(), "gnomon-cred-"));
    const store = join(dir, "credentials.json");
    writeFileSync(
      store,
      JSON.stringify({ OPENROUTER_API_KEY: "sk-real", GNOMON_MODEL_URL: "http://elsewhere.invalid" })
    );
    const before = process.env.GNOMON_MODEL_URL;
    delete process.env.GNOMON_MODEL_URL;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const supplied = applyCredentials(store, ["OPENROUTER_API_KEY"]);
      expect(supplied).toEqual(["OPENROUTER_API_KEY"]);
      expect(process.env.OPENROUTER_API_KEY).toBe("sk-real");
      // the behaviour-deciding one never reaches the environment
      expect(process.env.GNOMON_MODEL_URL).toBeUndefined();
      // and it is NAMED rather than silently dropped
      expect(refusedCredentials()).toContain("GNOMON_MODEL_URL");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      if (before !== undefined) process.env.GNOMON_MODEL_URL = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only names the surface declares as api_key_env count as declared", async () => {
    const { declaredKeyVars, loadConfig } = await import("./config.js");
    const dir = surface({
      "config.toml":
        '[endpoints.local]\nurl = "http://x"\nkind = "openai"\n' +
        '[endpoints.cloud]\nurl = "http://y"\nkind = "openai"\napi_key_env = "CLOUD_KEY"\n',
    });
    const names = declaredKeyVars(loadConfig(dir));
    expect(names).toEqual(["CLOUD_KEY"]);
    expect(names).not.toContain("GNOMON_MODEL_URL");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: attestation reports what it cannot do", () => {
  // What this replaced, and why: the four assertions below used to be two
  // greps over attest.ts for the strings "r.code === 126 || r.code === 127"
  // and "could not run (exit ${r.code})". A grep for a branch cannot see
  // whether the branch is REACHED or whether it sets `checked` the right way
  // round. Measured against the real attest.ts: moving the 126/127 block below
  // the `return { checked: true, ... }` that follows it -- which makes it dead
  // code and restores the exact defect the block was written to fix -- left
  // both greps green. These run a real verifier per case instead.
  //
  // `checkSignature` runs the declared command through `bash -lc`, so each of
  // these four statuses is one an operator can actually produce on the machine
  // doing the checking.
  const checkWith = async (verify: string) => {
    const { resolveAttest, checkSignature } = await import("./attest.js");
    const settings = resolveAttest(
      {
        config: { audit: { attest: { sign: "true", verify } } },
        gnomonDir: "/tmp/gate/.gnomon",
      } as never,
      "/tmp/gate/.gnomon-audit"
    );
    expect(settings.verify, "the surface's verify command must have resolved").toBe(verify);
    return checkSignature(
      {
        seq: 1,
        hash: "a".repeat(64),
        ts: "2026-09-02T00:00:00.000Z",
        records: 1,
        trail: "trail.jsonl",
        algorithm: "ed25519",
        signature_encoding: "base64",
        key_id: null,
        signature: "AAAA",
      },
      settings
    );
  };

  it("a verifier that is not installed is 'could not run', NOT a broken signature", async () => {
    // The machine heads_dir invites -- a third party auditing an off-box copy,
    // without the smartcard or the agent tool. Reporting "your trail was
    // tampered with" because the checker is absent is the conflation commit
    // 902a93f removed from the verify gate, reintroduced here.
    const r = await checkWith("gnomon-no-such-verifier-xyz");
    expect(r.checked, "an absent verifier must not read as tampering").toBe(false);
    expect((r as { detail: string }).detail).toContain("could not run (exit 127)");
  });

  // POSIX-only by nature. Windows has no executable bit -- chmod 0644 leaves
  // the script perfectly runnable -- so the state this test constructs cannot
  // exist there. Skipped rather than weakened: 126 is a real POSIX code and
  // this is a real POSIX behaviour.
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("...and neither is one that is present but not executable", async () => {
    // 126 is the other half of the POSIX pair, and the likelier one after a
    // checkout: the verify script is right there, its mode bit is not.
    const dir = mkdtempSync(join(tmpdir(), "gnomon-verifier-"));
    const script = join(dir, "verify.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o644);
    try {
      const r = await checkWith(script);
      expect(r.checked).toBe(false);
      expect((r as { detail: string }).detail).toContain("could not run (exit 126)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("but a verifier that RAN and said no IS a broken signature", async () => {
    // The negative control for the two above. A build that answered
    // `checked: false` on every non-zero exit would pass both of them and
    // would never be able to report a forged head -- which is the entire point
    // of checking a signature. Only this assertion tells the two apart.
    const r = await checkWith("exit 1");
    expect(r.checked, "a verifier that ran must be reported as having run").toBe(true);
    expect((r as { valid: boolean }).valid).toBe(false);
    expect((r as { detail?: string }).detail).toContain("exit 1");
  });

  it("and one that RAN and said yes is a good signature", async () => {
    // The passing direction: a verifier that rejects everything is exactly as
    // useless as one that accepts everything.
    const r = await checkWith("exit 0");
    expect(r.checked).toBe(true);
    expect((r as { valid: boolean }).valid).toBe(true);
  });

  it("a declared [audit.attest] with no usable sign command is reported", async () => {
    // KNOWN_BLOCKS validates TOP-LEVEL blocks only, so a misspelt sub-block
    // escaped it entirely: `[audit.attest] sgn = "..."` resolved to disabled
    // with an empty problems list and drew nothing from the surface audit.
    // Worse, `declared` is that same flag -- so a surface that asked for
    // attestation and typo'd verified as "unsigned, declared:false", whose
    // documented meaning is "this surface never signs".
    const { resolveAttest } = await import("./attest.js");
    const cfg = (audit: unknown) =>
      ({ config: { audit }, gnomonDir: "/tmp/gate/.gnomon" }) as never;
    const good = resolveAttest(cfg({ attest: { sign: "true" } }), "/tmp/gate/.gnomon-audit");
    expect(good.enabled).toBe(true);
    expect(good.problems).toEqual([]);

    const typo = resolveAttest(cfg({ attest: { sgn: "true" } }), "/tmp/gate/.gnomon-audit");
    expect(typo.enabled).toBe(false);
    expect(typo.problems.join(" "), "a declared-but-unusable block must not be silent").toMatch(
      /audit\.attest/
    );

    // An undeclared block stays silent — it is not a problem, it is a choice.
    const none = resolveAttest(cfg({}), "/tmp/gate/.gnomon-audit");
    expect(none.enabled).toBe(false);
    expect(none.problems).toEqual([]);
  });
});

describe("gate: session resume cannot be hijacked by a non-conversation file", () => {
  it("skips a parseable .json in the store that is not a snapshot", async () => {
    // `gnomon session <cmd>` writes its record into the SAME directory as
    // conversation snapshots, with neither an `id` nor `exchanges`. Sorted by
    // filename, `session-<stamp>.json` lands after `<stamp>.json`, so it became
    // the most recent "session" and --continue silently resumed it:
    // "Resumed undefined — 0 turn(s)", the real conversation unreachable, and
    // prune() deleting the real ones first because it sorts the same way.
    const { listSessions } = await import("./session_store.js");
    const dir = mkdtempSync(join(tmpdir(), "gnomon-sess-"));
    writeFileSync(
      join(dir, "2026-09-02T10-00-00-000Z-1.json"),
      JSON.stringify({ id: "2026-09-02T10-00-00-000Z-1", exchanges: [{ input: "real work" }], updated: "x" })
    );
    // what `gnomon session` writes — parseable, and not a conversation
    writeFileSync(
      join(dir, "session-2026-09-02T11-00-00-000Z.json"),
      JSON.stringify({ command: "pytest -q", steps: [], started: "x" })
    );
    const found = listSessions({ dir, persist: true, keep: 10 } as never);
    expect(found.length, "the command record must not be listed as a session").toBe(1);
    expect(found[0].id).toBe("2026-09-02T10-00-00-000Z-1");
    expect(found[0].turns).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
