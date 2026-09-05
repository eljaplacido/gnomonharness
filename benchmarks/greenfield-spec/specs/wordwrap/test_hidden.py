import pytest
from wordwrap import wrap

def test_short_text_is_one_line():
    assert wrap("hello world", 20) == ["hello world"]

def test_wraps_at_width():
    assert wrap("aaa bbb ccc", 7) == ["aaa bbb", "ccc"]

def test_exact_fit_stays_on_one_line():
    assert wrap("aaa bbb", 7) == ["aaa bbb"]

def test_empty_text_is_no_lines():
    assert wrap("   ", 10) == []

def test_word_longer_than_width_is_not_split():
    assert wrap("supercalifragilistic hi", 5) == ["supercalifragilistic", "hi"]

def test_nonpositive_width_raises():
    with pytest.raises(ValueError):
        wrap("a b", 0)
