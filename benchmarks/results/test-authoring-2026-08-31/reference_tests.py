"""Known-good tests, used ONLY to validate the fixtures.

A fixture is usable only if a competent test discriminates: fails on the broken
module, passes on the fixed one. Without this control, a fixture nothing can
separate would score every model zero and read as a model failure -- which is
the same mistake as scoring a probe that could not run a command.

These are never shown to the agent.
"""
REFERENCE = {
    "bucket": (
        "from bucket import bucket\n\n"
        "def test_boundaries_are_inclusive():\n"
        "    assert bucket(90) == 'A'\n"
        "    assert bucket(80) == 'B'\n"
        "    assert bucket(70) == 'C'\n"
    ),
    "dedupe": (
        "from dedupe import dedupe\n\n"
        "def test_input_is_not_modified():\n"
        "    original = [1, 2, 2, 3]\n"
        "    dedupe(original)\n"
        "    assert original == [1, 2, 2, 3]\n"
    ),
    "parse_port": (
        "import pytest\n"
        "from parse_port import parse_port\n\n"
        "def test_rejects_non_numeric():\n"
        "    with pytest.raises(ValueError):\n"
        "        parse_port('http')\n"
    ),
}
