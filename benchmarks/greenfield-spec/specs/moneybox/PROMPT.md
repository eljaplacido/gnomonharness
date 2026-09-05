Write `moneybox.py` providing a `MoneyBox` class for tracking a savings balance.

Public API, exactly:
    MoneyBox(limit: int)          # limit is the maximum balance the box may hold
    .deposit(amount: int) -> int  # returns the new balance
    .withdraw(amount: int) -> int # returns the new balance
    .balance -> int               # current balance, starts at 0

Depositing past the limit is not allowed. Withdrawing more than the balance is
not allowed. Both refusals should raise `ValueError`.

Also write `test_moneybox.py` with unit tests for it.
