import pytest
from csvfield import split_line

def test_plain():
    assert split_line("a,b,c") == ["a", "b", "c"]

def test_empty_fields_are_kept():
    assert split_line("a,,c") == ["a", "", "c"]

def test_quoted_comma():
    assert split_line('a,"b,c",d') == ["a", "b,c", "d"]

def test_doubled_quote_is_one_quote():
    assert split_line('a,"b""c",d') == ["a", 'b"c', "d"]

def test_trailing_empty_field():
    assert split_line("a,b,") == ["a", "b", ""]

def test_unterminated_quote_raises():
    with pytest.raises(ValueError):
        split_line('a,"b')
