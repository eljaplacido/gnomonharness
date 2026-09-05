from rle import encode

def test_simple():
    assert encode("aaab") == "a3b1"

def test_single_char():
    assert encode("a") == "a1"

def test_empty():
    assert encode("") == ""

def test_no_runs():
    assert encode("abc") == "a1b1c1"

def test_long_run():
    assert encode("a" * 12) == "a12"

def test_case_sensitive():
    assert encode("aA") == "a1A1"
