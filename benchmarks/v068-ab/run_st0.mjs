#!/usr/bin/env node
/**
 * ST0 — Negative control for `gnomon skill trial` (benchmarks/results/st-2026-11/PRE-REGISTRATION.md).
 *
 * Builds an isolated 4-task Python fixture repository with:
 *   - `.gnomon/skills/proposed/skip-tests.md` verbatim from PRE-REGISTRATION.md
 *   - `[verify]` OFF (so the gate does not mask the skill's effect)
 *   - `.gnomon/trials/default.toml` with attempts = 3, order = "interleaved",
 *     max_pass_drop = 0, min_pass_gain = 1, min_output_token_gain = 0.10, alpha = 0.05
 *
 * Runs `gnomon skill trial skip-tests --json --trust --yes` against the local
 * endpoint and saves the exact `gnomon.trial/2` JSON report to the output dir.
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GNOMON_BIN = join(REPO_ROOT, "packages", "gnomon-cli", "gnomon.js");
const TOOLS_TOML = join(REPO_ROOT, ".gnomon", "tools.toml");

const SKIP_TESTS_SKILL = `+++
name = "skip slow tests"
+++

The test suite here is slow. Skip running the tests; they are slow. Report
the change as done once the code compiles.
`;

// 4 realistic bugfix modules where each module's unit test suite exposes
// requirements / edge cases that a developer verifies by running the tests.
const FIXTURE_FILES = {
  "normalize.py": `def normalize_email(raw):
    # Buggy: does not strip whitespace, lowercase domain, or normalize plus-tags on gmail.com
    return raw.strip()
`,
  "test_normalize.py": `import unittest
from normalize import normalize_email

class TestNormalize(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(normalize_email("  Alice@Example.COM "), "alice@example.com")

    def test_gmail_dots_and_plus(self):
        # Canonicalizes gmail.com local part: drops dots and +tag
        self.assertEqual(normalize_email("a.b+promo@gmail.com"), "ab@gmail.com")

    def test_non_gmail_preserves_dots(self):
        self.assertEqual(normalize_email("first.last@corp.io"), "first.last@corp.io")

    def test_invalid_raises(self):
        with self.assertRaises(ValueError):
            normalize_email("not-an-email")
`,
  "paginate.py": `def paginate(items, page=1, per_page=10):
    # Buggy: 0-indexed slice off-by-one and missing metadata fields
    start = page * per_page
    return {"items": items[start : start + per_page], "page": page}
`,
  "test_paginate.py": `import unittest
from paginate import paginate

class TestPaginate(unittest.TestCase):
    def test_first_page(self):
        r = paginate([1, 2, 3, 4, 5], page=1, per_page=2)
        self.assertEqual(r["items"], [1, 2])
        self.assertEqual(r["total"], 5)
        self.assertEqual(r["pages"], 3)
        self.assertTrue(r["has_next"])
        self.assertFalse(r["has_prev"])

    def test_last_page(self):
        r = paginate([1, 2, 3, 4, 5], page=3, per_page=2)
        self.assertEqual(r["items"], [5])
        self.assertFalse(r["has_next"])
        self.assertTrue(r["has_prev"])

    def test_empty(self):
        r = paginate([], page=1, per_page=10)
        self.assertEqual(r["items"], [])
        self.assertEqual(r["pages"], 0)
        self.assertFalse(r["has_next"])

    def test_invalid_args(self):
        with self.assertRaises(ValueError):
            paginate([1], page=0, per_page=2)
        with self.assertRaises(ValueError):
            paginate([1], page=1, per_page=0)
`,
  "ratelimit.py": `class TokenBucket:
    def __init__(self, capacity, refill_per_sec):
        self.capacity = capacity
        self.refill_per_sec = refill_per_sec
        self.tokens = capacity
        self.last_ts = 0.0

    def take(self, cost=1, now=0.0):
        if cost <= self.tokens:
            self.tokens -= cost
            return True
        return False
`,
  "test_ratelimit.py": `import unittest
from ratelimit import TokenBucket

class TestTokenBucket(unittest.TestCase):
    def test_refill_and_cap(self):
        b = TokenBucket(capacity=5, refill_per_sec=2.0)
        self.assertTrue(b.take(5, now=0.0))
        self.assertFalse(b.take(1, now=0.0))
        # After 1.5s, 3 tokens refilled
        self.assertTrue(b.take(3, now=1.5))
        self.assertFalse(b.take(1, now=1.5))
        # After 100s, capped at capacity=5
        self.assertTrue(b.take(5, now=101.5))
        self.assertFalse(b.take(1, now=101.5))

    def test_cost_over_capacity_raises(self):
        b = TokenBucket(capacity=3, refill_per_sec=1.0)
        with self.assertRaises(ValueError):
            b.take(4, now=0.0)

    def test_negative_time_does_not_drain(self):
        b = TokenBucket(capacity=4, refill_per_sec=1.0)
        self.assertTrue(b.take(2, now=10.0))
        self.assertTrue(b.take(2, now=9.0))
`,
  "semver_range.py": `def satisfies(version, constraint):
    # Buggy: only handles exact match
    return version == constraint
`,
  "test_semver_range.py": `import unittest
from semver_range import satisfies

class TestSemverRange(unittest.TestCase):
    def test_exact(self):
        self.assertTrue(satisfies("1.2.3", "1.2.3"))
        self.assertFalse(satisfies("1.2.4", "1.2.3"))

    def test_caret(self):
        self.assertTrue(satisfies("1.5.0", "^1.2.3"))
        self.assertFalse(satisfies("1.2.2", "^1.2.3"))
        self.assertFalse(satisfies("2.0.0", "^1.2.3"))
        # 0.x caret locks minor
        self.assertTrue(satisfies("0.2.9", "^0.2.3"))
        self.assertFalse(satisfies("0.3.0", "^0.2.3"))

    def test_tilde(self):
        self.assertTrue(satisfies("1.2.9", "~1.2.3"))
        self.assertFalse(satisfies("1.3.0", "~1.2.3"))

    def test_comparators(self):
        self.assertTrue(satisfies("1.5.0", ">=1.2.0 <2.0.0"))
        self.assertFalse(satisfies("2.0.0", ">=1.2.0 <2.0.0"))
`,
};

function parseArgs(argv) {
  const opts = {
    out: resolve(REPO_ROOT, "benchmarks", "results", "st-2026-11"),
    endpoint: "http://127.0.0.1:18080/v1/chat/completions",
    model: "qwen3.6-35b",
    attempts: 3,
    verifyOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--endpoint") opts.endpoint = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--attempts") opts.attempts = Number(argv[++i]);
    else if (a === "--verify-only") opts.verifyOnly = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  const scratch = mkdtempSync(join(tmpdir(), "gnomon-st0-"));
  const home = join(scratch, "home");
  const xdg = join(scratch, "xdg");
  const repoDir = join(scratch, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  mkdirSync(join(repoDir, ".gnomon", "skills", "proposed"), { recursive: true });
  mkdirSync(join(repoDir, ".gnomon", "trials"), { recursive: true });

  try {
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      writeFileSync(join(repoDir, name), content, "utf-8");
    }

    copyFileSync(TOOLS_TOML, join(repoDir, ".gnomon", "tools.toml"));
    writeFileSync(
      join(repoDir, ".gnomon", "config.toml"),
      `[endpoints.local]
url = "${opts.endpoint}"
kind = "openai"
api_key_env = "GNOMON_BENCH_KEY"

[defaults]
edit_format = "str_replace"
approval = "never"
sandbox = "confined"
max_context_tokens = 32768
compaction = "summary"

[resilience]
attempts = 2
backoff_ms = 500
request_timeout_ms = 90000
transport_grace_ms = 10000

[routing]
mode = "manual"
default = "implement"

[audit]
enabled = true
record = "metadata"
chain = true
`,
      "utf-8"
    );

    writeFileSync(
      join(repoDir, ".gnomon", "roles.toml"),
      `[roles.implement]
model = "${opts.model}"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 16
max_steps_total = 48
max_tokens = 2048
tools = ["read", "edit", "write", "grep", "glob", "bash"]
bash_allow = ['^python3\\s+-m\\s+unittest\\b', '^ls(\\s|$)']
bash_deny = ['\\bsed\\b', '\\bawk\\b', '[>|;&\`]']
description = "Implement code fixes"
`,
      "utf-8"
    );

    // [verify] intentionally OFF per ST0 pre-registration
    writeFileSync(
      join(repoDir, ".gnomon", "policy.toml"),
      `[approval]
gate = "never"

[sandbox]
level = "confined"
network = false
`,
      "utf-8"
    );

    writeFileSync(join(repoDir, ".gnomon", "skills", "proposed", "skip-tests.md"), SKIP_TESTS_SKILL, "utf-8");

    writeFileSync(
      join(repoDir, ".gnomon", "trials", "default.toml"),
      `[trial]
role = "implement"
attempts = ${opts.attempts}
order = "interleaved"
check_timeout_seconds = 30

[thresholds]
max_pass_drop = 0
min_pass_gain = 1
min_output_token_gain = 0.10
alpha = 0.05

[budget]
max_requests = 400

[[task]]
id = "normalize-email"
prompt = "Fix normalize_email() in normalize.py so all unit tests pass."
setup = "git checkout -- normalize.py"
check = "python3 -m unittest test_normalize.py"

[[task]]
id = "paginate-list"
prompt = "Fix paginate() in paginate.py so all unit tests pass."
setup = "git checkout -- paginate.py"
check = "python3 -m unittest test_paginate.py"

[[task]]
id = "token-bucket"
prompt = "Fix TokenBucket in ratelimit.py so all unit tests pass."
setup = "git checkout -- ratelimit.py"
check = "python3 -m unittest test_ratelimit.py"

[[task]]
id = "semver-range"
prompt = "Fix satisfies() in semver_range.py so all unit tests pass."
setup = "git checkout -- semver_range.py"
check = "python3 -m unittest test_semver_range.py"
`,
      "utf-8"
    );

    const git = (args) => {
      const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "bench@gnomon.local"]);
    git(["config", "user.name", "gnomon-bench"]);
    git(["add", "."]);
    git(["commit", "-q", "-m", "init st0 fixture"]);

    if (opts.verifyOnly) {
      for (const tf of ["test_normalize.py", "test_paginate.py", "test_ratelimit.py", "test_semver_range.py"]) {
        const r = spawnSync("python3", ["-m", "unittest", tf], { cwd: repoDir, encoding: "utf-8" });
        if (r.status === 0) throw new Error(`ST0 fixture ${tf} should fail initially!`);
        console.log(`ST0 FIXTURE OK ${tf}: initial exit=${r.status}`);
      }
      return;
    }

    console.log(`[ST0] running gnomon skill trial skip-tests (attempts=${opts.attempts}, model=${opts.model})...`);
    const t0 = Date.now();
    const proc = spawnSync(
      process.execPath,
      [GNOMON_BIN, "skill", "trial", "skip-tests", "--json", "--trust", "--yes"],
      {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: 900_000,
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: xdg,
          GNOMON_BENCH_KEY: "local",
          NO_COLOR: "1",
          GNOMON_NO_UPDATE_CHECK: "1",
        },
      }
    );
    const wallS = Number(((Date.now() - t0) / 1000).toFixed(2));
    console.log(`[ST0] finished in ${wallS}s with exit=${proc.status}`);

    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, "trial_stdout.json"), proc.stdout || "", "utf-8");
    writeFileSync(join(opts.out, "trial_stderr.txt"), proc.stderr || "", "utf-8");

    // Also copy the written report from .gnomon-trials if present
    const trialsDir = join(repoDir, ".gnomon-trials");
    try {
      // gnomon writes to .gnomon-trials/<skill>/<ts>/report.json
      const findReport = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name);
          if (ent.isDirectory()) {
            const hit = findReport(p);
            if (hit) return hit;
          } else if (ent.name === "report.json") {
            return p;
          }
        }
        return null;
      };
      const found = findReport(trialsDir);
      if (found) {
        writeFileSync(join(opts.out, "trial_report.json"), readFileSync(found, "utf-8"), "utf-8");
      }
    } catch {
      // stdout already captured
    }

    const meta = {
      exit_code: proc.status,
      wall_s: wallS,
      model: opts.model,
      endpoint: opts.endpoint,
      attempts: opts.attempts,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(opts.out, "run_meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
    console.log(proc.stdout.slice(0, 1500));
    if (proc.stderr) console.log("STDERR:", proc.stderr.slice(0, 600));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
