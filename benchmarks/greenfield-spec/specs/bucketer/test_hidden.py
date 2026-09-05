import pytest
from bucketer import bucket

def test_small():
    assert bucket(0) == "small"
    assert bucket(49.99) == "small"

def test_boundary_50_is_medium():
    assert bucket(50) == "medium"

def test_medium():
    assert bucket(199.99) == "medium"

def test_boundary_200_is_large():
    assert bucket(200) == "large"

def test_large():
    assert bucket(1000) == "large"

def test_negative_raises():
    with pytest.raises(ValueError):
        bucket(-1)
