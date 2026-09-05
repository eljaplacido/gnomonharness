import pytest
from initials import initials

def test_two_names():
    assert initials("ada lovelace") == "A.L."

def test_single_name():
    assert initials("plato") == "P."

def test_three_names():
    assert initials("john ronald reuel tolkien") == "J.R.R.T."

def test_extra_whitespace_ignored():
    assert initials("  ada   lovelace  ") == "A.L."

def test_hyphenated_counts_as_two():
    assert initials("mary-jane watson") == "M.J.W."

def test_empty_raises():
    with pytest.raises(ValueError):
        initials("   ")
