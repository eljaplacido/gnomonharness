/**
 * readonly_bash.ts: the conservative reader `[approval] readonly_bash` relies
 * on. A false "read-only" lets a write run unasked under on_write, so most of
 * this file is commands that write, run something, or might, and must NOT be
 * read as read-only.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { READONLY_GIT, READONLY_PROGRAMS, readOnlyBash } from "./readonly_bash.js";
import { callNeedsApproval, readonlyBashExempt } from "./tools.js";
import { auditSurface, parseToml, resolveReadonlyBash, type GnomonConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

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
  "git -C ../other status",
  "git --no-pager log -n 1",
  "cd src && ls",
  "cd packages/gnomon-core; git log -n 1 | head -3",
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
  // Degenerate
  ["", /empty/],
  ["   ", /empty/],
  ["ls " + "a ".repeat(3000), /longer/],
];

describe("readOnlyBash — what reads only", () => {
  for (const cmd of READ_ONLY) {
    it(`read-only: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
      const r = readOnlyBash(cmd);
      expect(r, r.why).toMatchObject({ readonly: true });
      expect(r.programs.length).toBeGreaterThan(0);
    });
  }

  it("names the programs it was read as, git subcommands included, once each", () => {
    expect(readOnlyBash("git log -n 1 | head; git status; git -C x status").programs).toEqual(["git log", "head", "git status"]);
  });

  it("a non-string is not a command", () => {
    expect(readOnlyBash(["ls"]).readonly).toBe(false);
    expect(readOnlyBash(undefined).readonly).toBe(false);
  });
});

describe("readOnlyBash — what does not (adversarial)", () => {
  for (const [cmd, why] of NOT_READ_ONLY) {
    it(`not read-only: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
      const r = readOnlyBash(cmd);
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
      expect(readOnlyBash(c.input.command).readonly).toBe(c.readonly);
    });
  }
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

  it("is a known [approval] key, and a value other than ask/allow is warned (it falls back to ask)", () => {
    const quiet = auditSurface(cfg(`readonly_bash = "allow"`)).filter((p) => /readonly_bash/.test(p.problem));
    expect(quiet).toEqual([]);
    const typo = auditSurface(cfg(`readonly_bash = "alow"`)).filter((p) => /readonly_bash/.test(p.problem));
    expect(typo).toHaveLength(1);
    expect(typo[0]).toMatchObject({ fatal: false });
    expect(typo[0]!.problem).toMatch(/falls back to "ask"/);
  });
});
