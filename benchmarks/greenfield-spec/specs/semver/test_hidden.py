import pytest
from semver import compare

def test_equal():
    assert compare("1.2.3", "1.2.3") == 0

def test_major_dominates():
    assert compare("2.0.0", "1.9.9") == 1
    assert compare("1.9.9", "2.0.0") == -1

def test_minor():
    assert compare("1.3.0", "1.2.9") == 1

def test_patch():
    assert compare("1.2.4", "1.2.3") == 1

def test_numeric_not_lexicographic():
    assert compare("1.10.0", "1.9.0") == 1

def test_malformed_raises():
    with pytest.raises(ValueError):
        compare("1.2", "1.2.3")
    with pytest.raises(ValueError):
        compare("1.2.x", "1.2.3")
