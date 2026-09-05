import pytest
from tempconv import to_fahrenheit

def test_freezing():
    assert to_fahrenheit(0) == pytest.approx(32.0)

def test_boiling():
    assert to_fahrenheit(100) == pytest.approx(212.0)

def test_negative():
    assert to_fahrenheit(-40) == pytest.approx(-40.0)

def test_absolute_zero_is_allowed():
    assert to_fahrenheit(-273.15) == pytest.approx(-459.67)

def test_below_absolute_zero_raises():
    with pytest.raises(ValueError):
        to_fahrenheit(-273.16)
