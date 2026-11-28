// E-REQCHANGE benchmark task set: 8 realistic coding tasks with natural
// prompts where local models sometimes stop after diagnosing / proposing a
// plan without editing files. Tests `[verify] require_change = true` (#273)
// vs `require_change = false`.

export const REQCHANGE_TASKS = [
  {
    id: "rc-vip-discount",
    lang: "python",
    prompt:
      "Can you look into why apply_discount() in pricing.py is giving VIP orders a larger discount than the 30% cap allows, and let me know what needs to change?",
    files: {
      "pricing.py": `def apply_discount(subtotal, tier="standard", coupon_pct=0):
    tier_pct = {"standard": 0, "silver": 5, "vip": 20}.get(tier, 0)
    total_pct = tier_pct + coupon_pct
    if tier != "vip" and total_pct > 30:
        total_pct = 30
    return round(subtotal * (1 - total_pct / 100.0), 2)
`,
      "test_smoke.py": `import unittest
from pricing import apply_discount

class Smoke(unittest.TestCase):
    def test_standard(self):
        self.assertEqual(apply_discount(100, "standard", 10), 90.0)
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from pricing import apply_discount
checks = [
    ("vip_capped_30", apply_discount(100, "vip", 20) == 70.0),
    ("vip_under_cap", apply_discount(100, "vip", 5) == 75.0),
    ("silver_capped", apply_discount(100, "silver", 40) == 70.0),
    ("std_uncapped", apply_discount(100, "standard", 10) == 90.0),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-backoff-cap",
    lang: "python",
    prompt:
      "Could you review next_delay() in retry.py? We suspect exponential backoff exceeds max_delay on high attempt numbers — investigate and address it.",
    files: {
      "retry.py": `def next_delay(attempt, base=1.0, max_delay=30.0):
    if attempt < 0:
        raise ValueError("attempt must be >= 0")
    delay = base * (2 ** attempt)
    if attempt < 5 and delay > max_delay:
        return max_delay
    return delay
`,
      "test_smoke.py": `import unittest
from retry import next_delay

class Smoke(unittest.TestCase):
    def test_first(self):
        self.assertEqual(next_delay(0, 1.0, 30.0), 1.0)
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from retry import next_delay
checks = [
    ("a0", next_delay(0, 1.0, 30.0) == 1.0),
    ("a4", next_delay(4, 1.0, 30.0) == 16.0),
    ("a5_capped", next_delay(5, 1.0, 30.0) == 30.0),
    ("a10_capped", next_delay(10, 1.0, 30.0) == 30.0),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-slugify-hyphens",
    lang: "python",
    prompt:
      "Check slugify() in slug.py — users report consecutive punctuation creates double hyphens and trailing hyphens aren't stripped. Can you look at this?",
    files: {
      "slug.py": `import re

def slugify(text):
    s = text.lower().strip()
    s = re.sub(r"[^a-z0-9]", "-", s)
    return s
`,
      "test_smoke.py": `import unittest
from slug import slugify

class Smoke(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from slug import slugify
checks = [
    ("collapse", slugify("Hello,   World!") == "hello-world"),
    ("edges", slugify("--Foo Bar--") == "foo-bar"),
    ("punct", slugify("A & B / C") == "a-b-c"),
    ("plain", slugify("abc123") == "abc123"),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-window-avg",
    lang: "python",
    prompt:
      "Please inspect moving_average() in stats.py — someone mentioned an off-by-one bug when window > len(values) or window <= 0. Take a look and handle it.",
    files: {
      "stats.py": `def moving_average(values, window):
    out = []
    for i in range(len(values) - window):
        chunk = values[i : i + window]
        out.append(sum(chunk) / window)
    return out
`,
      "test_smoke.py": `import unittest
from stats import moving_average

class Smoke(unittest.TestCase):
    def test_smoke(self):
        res = moving_average([2, 4, 6, 8], 2)
        self.assertEqual(res[0], 3.0)
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from stats import moving_average
checks = []
def run_check(name, fn):
    try: checks.append((name, bool(fn())))
    except Exception: checks.append((name, False))
run_check("exact_count", lambda: moving_average([2, 4, 6, 8], 2) == [3.0, 5.0, 7.0])
run_check("window_eq_len", lambda: moving_average([10, 20], 2) == [15.0])
run_check("window_gt_len", lambda: moving_average([10, 20], 5) == [])
def t_zero():
    try:
        moving_average([1, 2], 0)
        return False
    except ValueError:
        return True
run_check("window_zero_raises", t_zero)
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-token-mask",
    lang: "python",
    prompt:
      "Can you examine mask_secret() in redact.py? Short secrets (length <= 4) are leaking in plaintext instead of being masked with '*'. Let me know or fix it.",
    files: {
      "redact.py": `def mask_secret(secret):
    if len(secret) <= 4:
        return secret
    return "*" * (len(secret) - 4) + secret[-4:]
`,
      "test_smoke.py": `import unittest
from redact import mask_secret

class Smoke(unittest.TestCase):
    def test_long(self):
        self.assertEqual(mask_secret("abcdefgh"), "****efgh")
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from redact import mask_secret
checks = [
    ("long", mask_secret("abcdefgh") == "****efgh"),
    ("len4", mask_secret("1234") == "****"),
    ("len2", mask_secret("ab") == "**"),
    ("empty", mask_secret("") == ""),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-semver-sort",
    lang: "python",
    prompt:
      "Take a look at sort_versions() in semver.py — '1.10.0' is sorting before '1.2.0'. Can you investigate why and sort it out?",
    files: {
      "semver.py": `def sort_versions(versions):
    return sorted(versions)
`,
      "test_smoke.py": `import unittest
from semver import sort_versions

class Smoke(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(sort_versions(["2.0.0", "1.0.0"]), ["1.0.0", "2.0.0"])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from semver import sort_versions
checks = [
    ("minor_numeric", sort_versions(["1.10.0", "1.2.0", "1.9.1"]) == ["1.2.0", "1.9.1", "1.10.0"]),
    ("patch_numeric", sort_versions(["0.1.12", "0.1.2"]) == ["0.1.2", "0.1.12"]),
    ("major_numeric", sort_versions(["10.0.0", "2.0.0"]) == ["2.0.0", "10.0.0"]),
    ("empty", sort_versions([]) == []),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-merge-intervals",
    lang: "python",
    prompt:
      "Would you check merge_intervals() in intervals.py? Unsorted input intervals and touching intervals like (1,3) and (3,5) don't merge properly.",
    files: {
      "intervals.py": `def merge_intervals(intervals):
    if not intervals:
        return []
    merged = [intervals[0]]
    for start, end in intervals[1:]:
        prev_s, prev_e = merged[-1]
        if start < prev_e:
            merged[-1] = (prev_s, max(prev_e, end))
        else:
            merged.append((start, end))
    return merged
`,
      "test_smoke.py": `import unittest
from intervals import merge_intervals

class Smoke(unittest.TestCase):
    def test_overlap(self):
        self.assertEqual(merge_intervals([(1, 4), (2, 5)]), [(1, 5)])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from intervals import merge_intervals
checks = [
    ("unsorted", merge_intervals([(5, 7), (1, 3), (2, 4)]) == [(1, 4), (5, 7)]),
    ("touching", merge_intervals([(1, 3), (3, 5)]) == [(1, 5)]),
    ("nested", merge_intervals([(1, 10), (2, 3), (4, 6)]) == [(1, 10)]),
    ("empty", merge_intervals([]) == []),
]
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
  {
    id: "rc-parse-duration",
    lang: "python",
    prompt:
      "Can you check parse_duration_ms() in duration.py? It fails on compound durations like '1m30s' or milliseconds like '250ms'. Please look into it.",
    files: {
      "duration.py": `def parse_duration_ms(spec):
    spec = spec.strip()
    if spec.endswith("s"):
        return int(spec[:-1]) * 1000
    if spec.endswith("m"):
        return int(spec[:-1]) * 60_000
    raise ValueError(f"unsupported duration: {spec}")
`,
      "test_smoke.py": `import unittest
from duration import parse_duration_ms

class Smoke(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_duration_ms("5s"), 5000)
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from duration import parse_duration_ms
checks = []
def run_check(name, fn):
    try: checks.append((name, bool(fn())))
    except Exception: checks.append((name, False))
run_check("ms", lambda: parse_duration_ms("250ms") == 250)
run_check("compound_ms", lambda: parse_duration_ms("1m30s") == 90_000)
run_check("compound_full", lambda: parse_duration_ms("1h2m3s4ms") == 3_723_004)
run_check("simple_s", lambda: parse_duration_ms("5s") == 5000)
def t_inv():
    try:
        parse_duration_ms("invalid")
        return False
    except ValueError:
        return True
run_check("invalid_raises", t_inv)
passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },
];

// Catchable-population variant: prompts explicitly invite diagnosis/plan-only
// prose replies so the `off` arm exhibits unchanged-worktree `bucket == "result"`
// completions, exercising `[verify] require_change = true` hand-back and
// `stop_reason = "no_change"` refusal floor live.
export const REQCHANGE_CATCH_TASKS = REQCHANGE_TASKS.slice(0, 6).map((t) => ({
  ...t,
  id: `${t.id}-plan`,
  prompt:
    `First read the code and write a short diagnosis and proposed fix plan for the issue described below. ` +
    `Do NOT edit any files yet unless the harness explicitly tells you a file change is required.\n\n` +
    t.prompt,
}));

