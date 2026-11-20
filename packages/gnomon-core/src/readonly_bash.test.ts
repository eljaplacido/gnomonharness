/**
 * readonly_bash.ts: the conservative reader `[approval] readonly_bash` relies
 * on. A false "read-only" lets a write run unasked under on_write, so most of
 * this file is commands that write, run something, or might, and must NOT be
 * read as read-only.
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { READONLY_GIT, READONLY_PROGRAMS, gitRepoWhy, readOnlyBash, type ReadOnlyWhere } from "./readonly_bash.js";
import { callNeedsApproval, readonlyBashExempt } from "./tools.js";
import { auditSurface, parseToml, resolveReadonlyBash, type GnomonConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

// git is read-only only in the project's own repository, so the tables are
// read as a line run at the root of a project whose `.git` is right there.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-ro-")));
const project = join(scratch, "project");
mkdirSync(join(project, ".git"), { recursive: true });
const AT_ROOT: ReadOnlyWhere = { root: project, cwd: project };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const READ_ONLY = [
  "ls",
  "ls -la src",
  "pwd",
  "cat src/a.ts",
  "cat 'a file.txt'",
  "head -n 20 README.md",
  "tail -n 5 CHANGELOG.md",
  "wc -l src/*.ts",
  "grep -rn 'needsApproval' packages",
  "rg -n --glob '*.ts' needsApproval packages",
  "rg -n 'a|b' src",
  "find . -name '*.ts' -not -path './node_modules/*'",
  "find src -type f -newer package.json",
  "stat src/a.ts",
  "file README.md",
  "which node",
  "du -sh src",
  "df -h .",
  "echo hello",
  "printf '%s\\n' a b",
  "echo \"$HOME\"",
  "git status",
  "git status --short --branch",
  "git log --oneline -n 5",
  "git diff --exit-code --stat",
  "sort --check x",
  "git log -p -- src/a.ts",
  "git diff",
  "git diff --stat HEAD~1",
  "git show HEAD:package.json",
  "git rev-parse HEAD",
  "git ls-files src",
  "git blame -L 1,10 src/a.ts",
  "git branch",
  "git branch -a",
  "git branch -vv",
  "git branch --show-current",
  "git branch --list 'feat/*'",
  "git branch --contains HEAD",
  "git -C . status",
  "git --no-pager log -n 1",
  "cd src && ls",
  "cd packages/gnomon-core; ls | head -3",
  "git log -n 1 | head -3; cd src",
  "git log --oneline | head -20",
  "ls 2>/dev/null",
  "ls nope 2>&1 | head",
  "ls missing &>/dev/null || echo none",
  "git status --short | wc -l",
  "cat src/a.ts | sort | uniq -c | sort -rn | head",
  "cut -d: -f1 /etc/hostname",
  "echo a-b | tr - _",
  "grep -c x src/a.ts || true",
  "cat <<'EOF'\nhello\nEOF",
  "wc -l < src/a.ts",
  "ls\nls src",
];

const NOT_READ_ONLY: Array<[string, RegExp?]> = [
  // Output redirection, tee
  ["ls > x", /redirection/],
  ["ls >> x", /redirection/],
  ["ls >| x", /redirection/],
  ["ls &> x", /redirection/],
  ["ls 2> errors.log", /redirection/],
  ["ls >&x", /redirection/],
  ["echo hi > .gnomon/policy.toml", /redirection/],
  ["cat a | tee b", /tee/],
  ["> x", /no command/],
  ["ls 1<>x", /redirection/],
  // Substitution
  ["rg x $(rm -rf y)", /substitution/],
  ["ls `rm x`", /substitution/],
  ['echo "$(rm x)"', /substitution/],
  ["cat <(rm x)", /substitution/],
  ["diff <(ls) <(ls src)", /substitution/],
  ["ls >(cat > x)", /substitution/],
  // Chains holding a writer
  ["git log; rm x", /rm is not/],
  ["git status && git commit -m x", /git commit/],
  ["ls || touch x", /touch/],
  ["cat x | xargs rm", /xargs/],
  // Writers and runners behind allowed programs
  ["git branch -D x", /not a listing/],
  ["git branch -d x", /not a listing/],
  ["git branch newname", /creates a branch/],
  ["git branch -m old new", /not a listing/],
  ["git branch --set-upstream-to=origin/x", /not a listing/],
  ["git branch -f main HEAD~1", /not a listing/],
  ["find . -delete", /-delete/],
  ["find . -name x -exec rm {} \\;", /-exec|brace/],
  ["find . -execdir cat {} +", /-execdir|brace/],
  ["find . -ok rm {} \\;", /-ok|brace/],
  ["find . -name x -exec rm '{}' ';'", /-exec/],
  ["find . -fprint out.txt", /-fprint/],
  ["find . -fprintf out.txt '%p'", /-fprintf/],
  ["find . -fls out.txt", /-fls/],
  ["rg --pre ./run.sh x", /--pre/],
  ["rg --pre=sh x", /--pre/],
  ["rg --hostname-bin=./x x", /--hostname-bin/],
  ["file -C -m magic", /-C/],
  ["file --compile", /-C/],
  ["sort -o out.txt in.txt", /sort -o/],
  ["sort -ro out.txt in.txt", /sort -o/],
  ["sort --output=out.txt in.txt", /--output/],
  ["sort --compress-program=sh x", /--compress-program/],
  // GNU getopt and git accept abbreviated long options
  ["sort --out=out.txt in.txt", /--out/],
  ["sort --compress=sh x", /--compress/],
  ["file --comp", /-C/],
  ["git diff --outp=patch.txt", /--output/],
  ["git log --ext HEAD", /--ext-diff/],
  ["uniq in.txt out.txt", /output operand/],
  ["git diff --output=patch.txt", /--output/],
  ["git log --output out.txt", /--output/],
  ["git diff --ext-diff", /--ext-diff/],
  ["git -c core.pager=sh log", /-c/],
  ["git -c alias.x=!rm status", /-c/],
  ["git -p log", /-p/],
  ["git --paginate log", /--paginate/],
  ["git --git-dir=/tmp/evil/.git log", /--git-dir/],
  ["git --exec-path=/tmp/evil status", /--exec-path/],
  ["git stash list", /git stash/],
  ["git checkout main", /git checkout/],
  ["git", /no subcommand/],
  // Globs and expansions where they could become options
  ["find * -name x", /glob/],
  ["rg foo *", /glob/],
  ["git diff -- *.ts", /glob/],
  ["sort *", /glob/],
  ["find . $X", /expansion/],
  ["rg $PATTERN", /expansion/],
  ["git log $REV", /expansion/],
  ["find . -name {a,b}", /brace/],
  // Interpreters, wrappers, sudo, network, unknown programs
  ["python3 -c 'print(1)'", /python3/],
  ["node -e 'x'", /node/],
  ["bash -c 'ls'", /bash/],
  ["sh -c 'ls'", /sh is not/],
  ["eval ls", /eval/],
  ["sudo ls", /sudo/],
  ["env ls", /env/],
  ["timeout 5 ls", /timeout/],
  ["xargs ls", /xargs/],
  ["curl -s https://example.com", /curl/],
  ["wget https://example.com", /wget/],
  ["ssh host ls", /ssh/],
  ["nc -l 8080", /nc/],
  ["sed -n 1p x", /sed/],
  ["sed -i s/a/b/ x", /sed/],
  ["awk '{print}' x", /awk/],
  ["perl -ne print x", /perl/],
  ["tee x", /tee/],
  ["rm x", /rm/],
  ["touch x", /touch/],
  ["mkdir x", /mkdir/],
  ["npm test", /npm/],
  // Program names that are not the bare listed name
  ["/bin/ls", /not on the read-only list/],
  ["./ls", /not on the read-only list/],
  ["'ls'", /quoted or expanded/],
  ["$LS", /quoted or expanded/],
  ["l\\s", /quoted or expanded|not on the read-only list/],
  // Assignments, compound commands, background
  ["PATH=. ls", /assignment/],
  ["GIT_PAGER=sh git log", /assignment/],
  ["X=1; ls", /assignment/],
  ["(ls)", /subshell/],
  ["{ ls; }", /subshell|not on/],
  ["if true; then ls; fi", /subshell|not on/],
  ["for f in a; do cat $f; done", /subshell|not on/],
  ["f() { ls; }; f", /subshell|not on/],
  ["ls &", /background/],
  ["ls & rm x", /background|rm/],
  ["cd a b", /more than one/],
  // git outside the project's repository reads a configuration that may run
  // a program (core.fsmonitor, diff.external, textconv, gpg.program)
  ["git -C ../other status", /-C/],
  ["git -C /tmp/evil status", /-C/],
  ["git -C ~/evil log -p", /-C/],
  ["git -C . -C sub status", /more than one -C/],
  ["cd /tmp/evil && git status", /after a cd/],
  ["cd packages/gnomon-core; git log -n 1 | head -3", /after a cd/],
  ["cd . && git diff", /after a cd/],
  // A redirection from or to /dev/tcp or /dev/udp is a network connection,
  // input included; a target that expands could be one
  ["cat < /dev/tcp/example.com/80", /network/],
  ["head -c1 </dev/udp/1.2.3.4/53", /network/],
  ["cat 0</dev/tcp/example.com/80", /network/],
  ["wc -c <>/dev/tcp/example.com/80", /network/],
  ["cat <&/dev/tcp/example.com/80", /network/],
  ["ls >/dev/udp/1.2.3.4/53", /network/],
  ["cat < //dev/tcp/example.com/80", /network/],
  ["cat < /dev/./tcp/example.com/80", /network/],
  ["cat < /dev/tcp", /network/],
  ["cd /dev && cat < tcp/example.com/80", /network/],
  ["cd /dev/udp; head -c1 < 1.2.3.4/53", /network/],
  ["cd / && cat < dev/tcp/example.com/80", /network/],
  ["cd \"$D\" && cat < tcp/example.com/80", /network/],
  ['cat < "$T"', /expands/],
  ["cat < $T", /expands/],
  ["cat < ~/x", /expands/],
  // Parameter transformations: @P and @E evaluate the value
  ["echo ${x@P}", /transformation/],
  ["echo ${x@E}", /transformation/],
  ['echo "${x@P}"', /transformation/],
  ["echo ${x@Q}", /transformation/],
  ["cat <<EOF\n${PS1@P}\nEOF", /transformation/],
  // Degenerate
  ["", /empty/],
  ["   ", /empty/],
  ["ls " + "a ".repeat(3000), /longer/],
];

describe("readOnlyBash — what reads only", () => {
  for (const cmd of READ_ONLY) {
    it(`read-only: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
      const r = readOnlyBash(cmd, AT_ROOT);
      expect(r, r.why).toMatchObject({ readonly: true });
      expect(r.programs.length).toBeGreaterThan(0);
    });
  }

  it("names the programs it was read as, git subcommands included, once each", () => {
    expect(readOnlyBash("git log -n 1 | head; git status; git -C . status", AT_ROOT).programs).toEqual(["git log", "head", "git status"]);
  });

  it("a non-string is not a command", () => {
    expect(readOnlyBash(["ls"]).readonly).toBe(false);
    expect(readOnlyBash(undefined).readonly).toBe(false);
  });
});

describe("readOnlyBash — what does not (adversarial)", () => {
  for (const [cmd, why] of NOT_READ_ONLY) {
    it(`not read-only: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
      const r = readOnlyBash(cmd, AT_ROOT);
      expect(r.readonly).toBe(false);
      expect(r.programs).toEqual([]);
      if (why) expect(r.why).toMatch(why);
    });
  }

  it("every program on the list is a reader, and none is a shell, interpreter, wrapper or network client", () => {
    const never = ["sh", "bash", "zsh", "env", "sudo", "eval", "exec", "xargs", "python", "python3", "node", "perl", "ruby", "awk", "sed", "tee", "curl", "wget", "ssh", "nc", "timeout", "nice", "nohup", "command", "builtin", "source", "."];
    for (const p of never) expect(READONLY_PROGRAMS).not.toContain(p);
    expect([...READONLY_GIT].sort()).toEqual(["blame", "branch", "diff", "log", "ls-files", "rev-parse", "show", "status"]);
  });
});

describe("conformance/guard_cases.json readonly_bash: each case's `readonly` is this reader's answer", () => {
  const cases = (JSON.parse(readFileSync(resolve(here, "../../../conformance/guard_cases.json"), "utf-8")) as {
    readonly_bash: { cases: Array<{ name: string; input: { command: string }; readonly: boolean }> };
  }).readonly_bash.cases;
  for (const c of cases) {
    it(c.name, () => {
      expect(readOnlyBash(c.input.command, AT_ROOT).readonly).toBe(c.readonly);
    });
  }
});

/** git in `dir`, as the reviewer's repro ran it. */
function gitIn(dir: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.error) throw r.error;
}

describe("readOnlyBash — git only in the project's own repository (a foreign repository's config runs programs)", () => {
  // The repro: a repository whose config names a program git runs on a plain
  // `git status`. git_hooks protects only the project's .git/config.
  const base = join(scratch, "git");
  const proj = join(base, "proj");
  const evil = join(base, "evil");
  const pwned = join(evil, "PWNED");
  for (const d of [proj, evil]) {
    mkdirSync(d, { recursive: true });
    gitIn(d, "init", "-q");
  }
  gitIn(evil, "config", "core.fsmonitor", "touch PWNED; false");
  const where: ReadOnlyWhere = { root: proj, cwd: proj };
  // A path as a bash command line carries it. Unquoted, bash reads a
  // backslash as an escape, so a native Windows path (C:\\Users\\...) pasted
  // into a line is not that path to bash (Git Bash) or to this reader; the
  // forward-slash form is.
  const inLine = (p: string) => p.split("\\").join("/");

  it("the repro is real: `git -C evil status` runs evil's core.fsmonitor", () => {
    rmSync(pwned, { force: true });
    gitIn(base, "-C", "evil", "status");
    expect(existsSync(pwned)).toBe(true);
    rmSync(pwned, { force: true });
  });

  it("git -C another repository is not read-only, absolute or relative", () => {
    expect(readOnlyBash(`git -C ${inLine(evil)} status`, where)).toMatchObject({ readonly: false, why: expect.stringMatching(/-C/) });
    expect(readOnlyBash("git -C ../evil status", where)).toMatchObject({ readonly: false, why: expect.stringMatching(/-C/) });
    expect(readOnlyBash(`git -C ${inLine(evil)} diff`, where).readonly).toBe(false);
    expect(readOnlyBash(`git -C ${inLine(evil)} log -p`, where).readonly).toBe(false);
    expect(readOnlyBash(`git -C ${inLine(evil)} show --show-signature`, where).readonly).toBe(false);
  });

  it("git after a cd on the same line is not read-only", () => {
    expect(readOnlyBash(`cd ${inLine(evil)} && git status`, where)).toMatchObject({ readonly: false, why: expect.stringMatching(/after a cd/) });
    expect(readOnlyBash(`cd ${inLine(proj)} && git status`, where)).toMatchObject({ readonly: false, why: expect.stringMatching(/after a cd/) });
  });

  it("-C . and -C <the project root> are read-only; the root reached through a symlink and `..` is followed as chdir() does", () => {
    expect(readOnlyBash("git -C . status", where).readonly).toBe(true);
    expect(readOnlyBash(`git -C ${inLine(proj)} status`, where).readonly).toBe(true);
    expect(readOnlyBash(`git -C ${inLine(proj)}/ status`, { root: proj, cwd: evil }).readonly).toBe(true);
    // proj/link -> evil/sub, so `link/..` is evil to chdir(), though it reads as proj.
    mkdirSync(join(evil, "sub"), { recursive: true });
    try {
      symlinkSync(join(evil, "sub"), join(proj, "link"), "dir");
    } catch {
      return; // Windows without symlink privilege: the rest needs the link.
    }
    try {
      // Where git itself lands decides the expectation: POSIX chdir() follows
      // the link and then `..` (evil); Win32 removes `..` from the text first
      // (proj). The reader must agree with git on each platform.
      const top = spawnSync("git", ["-C", "link/..", "rev-parse", "--show-toplevel"], { cwd: proj, encoding: "utf-8" }).stdout.trim();
      const landsInProj = realpathSync.native(resolve(top)) === realpathSync.native(proj);
      if (landsInProj) expect(readOnlyBash("git -C link/.. status", where).readonly).toBe(true);
      else expect(readOnlyBash("git -C link/.. status", where)).toMatchObject({ readonly: false, why: expect.stringMatching(/-C/) });
    } finally {
      rmSync(join(proj, "link"), { force: true });
    }
  });

  it("a working directory outside the project, or in a repository nested in it, is not read-only", () => {
    expect(readOnlyBash("git status", { root: proj, cwd: evil })).toMatchObject({ readonly: false, why: expect.stringMatching(/outside the project root/) });
    const nested = join(proj, "vendor", "evil");
    mkdirSync(nested, { recursive: true });
    gitIn(nested, "init", "-q");
    expect(readOnlyBash("git status", { root: proj, cwd: nested })).toMatchObject({ readonly: false, why: expect.stringMatching(/nested repository/) });
    expect(readOnlyBash("git status", { root: proj, cwd: join(nested, "deeper") }).readonly).toBe(false);
    // A bare repository (HEAD, config, objects, refs) is a repository too.
    const bare = join(proj, "vendor", "bare.git");
    gitIn(proj, "init", "-q", "--bare", bare);
    expect(readOnlyBash("git log -p", { root: proj, cwd: bare })).toMatchObject({ readonly: false, why: expect.stringMatching(/HEAD/) });
    // A plain subdirectory of the project's own repository is fine.
    mkdirSync(join(proj, "src"), { recursive: true });
    expect(readOnlyBash("git status", { root: proj, cwd: join(proj, "src") }).readonly).toBe(true);
  });

  it("a project root below its repository's top level: git at the root only", () => {
    const top = join(base, "mono");
    const sub = join(top, "packages", "app");
    mkdirSync(join(sub, "src"), { recursive: true });
    gitIn(top, "init", "-q");
    expect(gitRepoWhy(sub, sub)).toBeNull();
    expect(readOnlyBash("git status", { root: sub, cwd: sub }).readonly).toBe(true);
    expect(readOnlyBash("git status", { root: sub, cwd: join(sub, "src") })).toMatchObject({ readonly: false, why: expect.stringMatching(/top level/) });
    writeFileSync(join(sub, "HEAD"), "ref: refs/heads/main\n");
    expect(readOnlyBash("git status", { root: sub, cwd: sub })).toMatchObject({ readonly: false, why: expect.stringMatching(/HEAD/) });
  });

  it("git fails closed where the reader cannot know where it runs; other programs do not need to know", () => {
    expect(readOnlyBash("git status")).toMatchObject({ readonly: false, why: expect.stringMatching(/not told/) });
    expect(readOnlyBash("git status", { root: proj, cwd: null })).toMatchObject({ readonly: false, why: expect.stringMatching(/not known/) });
    expect(readOnlyBash("git -C . status", { root: proj, cwd: null }).readonly).toBe(false);
    expect(readOnlyBash("git -C sub status", { root: proj, cwd: null }).readonly).toBe(false);
    // An absolute -C naming the root needs no working directory.
    expect(readOnlyBash(`git -C ${inLine(proj)} status`, { root: proj, cwd: null }).readonly).toBe(true);
    expect(readOnlyBash("ls; cat a").readonly).toBe(true);
  });
});

describe("[approval] readonly_bash — the setting", () => {
  const cfg = (approval: string) =>
    ({
      gnomonDir: "/nowhere",
      config: {},
      roles: {},
      policy: parseToml(`[approval]\n${approval}\n`),
      profiles: {},
      tools: {},
      system: { content: "", version: "0.1" },
    }) as unknown as GnomonConfig;

  it("is off unless it says \"allow\": absent, \"ask\", a misspelling, a boolean", () => {
    expect(resolveReadonlyBash(cfg(`gate = "on_write"`))).toBe("ask");
    expect(resolveReadonlyBash(cfg(`readonly_bash = "ask"`))).toBe("ask");
    expect(resolveReadonlyBash(cfg(`readonly_bash = "Allow"`))).toBe("ask");
    expect(resolveReadonlyBash(cfg(`readonly_bash = true`))).toBe("ask");
    expect(resolveReadonlyBash(cfg(`readonly_bash = "allow"`))).toBe("allow");
    expect(resolveReadonlyBash(undefined)).toBe("ask");
  });

  it("lifts only on_write, only bash, only a read-only command", () => {
    const on = cfg(`gate = "on_write"\nreadonly_bash = "allow"`);
    const off = cfg(`gate = "on_write"`);
    const ls = { command: "ls" };
    expect(callNeedsApproval("bash", ls, { gate: "on_write", config: on })).toBe(false);
    expect(callNeedsApproval("bash", { command: "ls > x" }, { gate: "on_write", config: on })).toBe(true);
    expect(callNeedsApproval("bash", ls, { gate: "on_write", config: off })).toBe(true);
    expect(callNeedsApproval("bash", ls, { gate: "always", config: on })).toBe(true);
    expect(callNeedsApproval("bash", ls, { gate: "never", config: on })).toBe(false);
    expect(callNeedsApproval("write", { path: "x", content: "" }, { gate: "on_write", config: on })).toBe(true);
    expect(readonlyBashExempt("bash", ls, { gate: "on_write", config: on })).toMatchObject({ readonly: true, programs: ["ls"] });
    expect(readonlyBashExempt("bash", ls, { gate: "on_write", config: undefined })).toBeNull();
  });

  it("judges git where the line runs: the root unless bashCwd says otherwise, never without a root or with bashCwd null", () => {
    const on = cfg(`gate = "on_write"\nreadonly_bash = "allow"`);
    const status = { command: "git status" };
    expect(callNeedsApproval("bash", status, { gate: "on_write", config: on, root: project })).toBe(false);
    expect(callNeedsApproval("bash", status, { gate: "on_write", config: on })).toBe(true);
    expect(callNeedsApproval("bash", status, { gate: "on_write", config: on, root: project, bashCwd: null })).toBe(true);
    expect(callNeedsApproval("bash", status, { gate: "on_write", config: on, root: project, bashCwd: scratch })).toBe(true);
    expect(callNeedsApproval("bash", status, { gate: "on_write", config: on, root: project, bashCwd: project })).toBe(false);
  });

  it("is a known [approval] key, and a value other than ask/allow is warned (it falls back to ask)", () => {
    const quiet = auditSurface(cfg(`readonly_bash = "allow"`)).filter((p) => /readonly_bash/.test(p.problem));
    expect(quiet).toEqual([]);
    const typo = auditSurface(cfg(`readonly_bash = "alow"`)).filter((p) => /readonly_bash/.test(p.problem));
    expect(typo).toHaveLength(1);
    expect(typo[0]).toMatchObject({ fatal: false });
    expect(typo[0]!.problem).toMatch(/falls back to "ask"/);
  });
});
