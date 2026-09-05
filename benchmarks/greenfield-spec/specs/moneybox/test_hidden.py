import pytest
from moneybox import MoneyBox

def test_starts_empty():
    assert MoneyBox(100).balance == 0

def test_deposit_returns_new_balance():
    b = MoneyBox(100)
    assert b.deposit(30) == 30
    assert b.deposit(20) == 50

def test_deposit_to_exactly_the_limit_is_allowed():
    b = MoneyBox(100)
    assert b.deposit(100) == 100

def test_deposit_past_the_limit_raises():
    b = MoneyBox(100)
    b.deposit(90)
    with pytest.raises(ValueError):
        b.deposit(11)

def test_withdraw_reduces_balance():
    b = MoneyBox(100)
    b.deposit(50)
    assert b.withdraw(20) == 30

def test_withdraw_everything_is_allowed():
    b = MoneyBox(100)
    b.deposit(50)
    assert b.withdraw(50) == 0

def test_overdraw_raises():
    b = MoneyBox(100)
    b.deposit(10)
    with pytest.raises(ValueError):
        b.withdraw(11)
