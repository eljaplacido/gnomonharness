import pytest
from pagerange import parse

def test_single():
    assert parse("3") == [3]

def test_list():
    assert parse("1,3,5") == [1, 3, 5]

def test_range_is_inclusive():
    assert parse("5-8") == [5, 6, 7, 8]

def test_mixed_keeps_order():
    assert parse("9,1-3") == [9, 1, 2, 3]

def test_duplicates_are_kept():
    assert parse("2,2") == [2, 2]

def test_backwards_range_raises():
    with pytest.raises(ValueError):
        parse("8-5")

def test_malformed_raises():
    with pytest.raises(ValueError):
        parse("a-3")
