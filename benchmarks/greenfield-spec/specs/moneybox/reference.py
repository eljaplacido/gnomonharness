class MoneyBox:
    def __init__(self, limit: int):
        if limit < 0:
            raise ValueError("limit must not be negative")
        self.limit = limit
        self.balance = 0

    def deposit(self, amount: int) -> int:
        if amount <= 0:
            raise ValueError("deposit must be positive")
        if self.balance + amount > self.limit:
            raise ValueError("deposit would exceed the limit")
        self.balance += amount
        return self.balance

    def withdraw(self, amount: int) -> int:
        if amount <= 0:
            raise ValueError("withdrawal must be positive")
        if amount > self.balance:
            raise ValueError("insufficient balance")
        self.balance -= amount
        return self.balance
