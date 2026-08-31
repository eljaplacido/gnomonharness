"""T8 fixtures — can the harness write a test that actually pins behaviour?

The criterion is objective and cannot be gamed by a plausible-looking test:

    a test is good iff it FAILS on the broken code and PASSES on the fixed code.

A tautology (`assert True`, or one asserting the buggy behaviour) passes both.
A wrong test fails both. Only a test that captures the real contract separates
them. This is mutation-testing logic, and it needs no human judgement — which
is what makes it worth running against a model.

Each fixture ships BOTH versions. The agent sees only the broken one and is
never told what the bug is; it is asked to write a regression test for the
documented behaviour. Scoring runs its test against both versions afterwards.

Deliberately at the failure boundary: T7's fixtures were solved 20/20, so they
could not discriminate. These involve behaviour a plausible-but-wrong test will
miss -- boundary conditions, mutation of an argument, and an error path.
"""

FIXTURES = {
    # Off-by-one at the inclusive boundary. A test written from the docstring
    # without thinking about edges passes on both versions.
    "bucket": {
        "module": "bucket.py",
        "broken": (
            "def bucket(score):\n"
            '    """Return the grade band. Bands are INCLUSIVE at the lower bound:\n'
            '    90+ is an A, 80-89 a B, 70-79 a C, below 70 an F."""\n'
            "    if score > 90:\n        return 'A'\n"
            "    if score > 80:\n        return 'B'\n"
            "    if score > 70:\n        return 'C'\n"
            "    return 'F'\n"
        ),
        "fixed": (
            "def bucket(score):\n"
            '    """Return the grade band. Bands are INCLUSIVE at the lower bound:\n'
            '    90+ is an A, 80-89 a B, 70-79 a C, below 70 an F."""\n'
            "    if score >= 90:\n        return 'A'\n"
            "    if score >= 80:\n        return 'B'\n"
            "    if score >= 70:\n        return 'C'\n"
            "    return 'F'\n"
        ),
        "ask": "Write pytest tests in test_bucket.py for bucket() covering the documented behaviour, including its boundaries. Do not modify bucket.py.",
    },
    # Mutates its argument. A test that only checks the RETURN value passes both.
    "dedupe": {
        "module": "dedupe.py",
        "broken": (
            "def dedupe(items):\n"
            '    """Return a new list with duplicates removed, order preserved.\n'
            '    The input list must not be modified."""\n'
            "    seen = set()\n"
            "    for i in range(len(items) - 1, -1, -1):\n"
            "        if items[i] in seen:\n"
            "            del items[i]\n"
            "        else:\n"
            "            seen.add(items[i])\n"
            "    return items\n"
        ),
        "fixed": (
            "def dedupe(items):\n"
            '    """Return a new list with duplicates removed, order preserved.\n'
            '    The input list must not be modified."""\n'
            "    seen = set()\n"
            "    out = []\n"
            "    for item in items:\n"
            "        if item not in seen:\n"
            "            seen.add(item)\n"
            "            out.append(item)\n"
            "    return out\n"
        ),
        "ask": "Write pytest tests in test_dedupe.py for dedupe() covering everything its docstring promises. Do not modify dedupe.py.",
    },
    # Swallows the error it documents. A happy-path-only test passes both.
    "parse_port": {
        "module": "parse_port.py",
        "broken": (
            "def parse_port(text):\n"
            '    """Parse a TCP port from text. Returns an int in 1..65535.\n'
            '    Raises ValueError for anything outside that range or not a number."""\n'
            "    try:\n"
            "        return int(text)\n"
            "    except ValueError:\n"
            "        return 0\n"
        ),
        "fixed": (
            "def parse_port(text):\n"
            '    """Parse a TCP port from text. Returns an int in 1..65535.\n'
            '    Raises ValueError for anything outside that range or not a number."""\n'
            "    port = int(text)\n"
            "    if not 1 <= port <= 65535:\n"
            "        raise ValueError(f'port out of range: {port}')\n"
            "    return port\n"
        ),
        "ask": "Write pytest tests in test_parse_port.py for parse_port() covering everything its docstring promises, including the failure cases. Do not modify parse_port.py.",
    },
}
