import pytest
from retry import delays

def test_zero_attempts_is_empty():
    assert delays(0, 100, 10000) == []

def test_doubles():
    assert delays(4, 100, 10000) == [100, 200, 400, 800]

def test_caps():
    assert delays(5, 100, 300) == [100, 200, 300, 300, 300]

def test_cap_below_base_clamps_everything():
    assert delays(3, 500, 100) == [100, 100, 100]

def test_negative_attempts_raises():
    with pytest.raises(ValueError):
        delays(-1, 100, 1000)

def test_nonpositive_base_raises():
    with pytest.raises(ValueError):
        delays(3, 0, 1000)
