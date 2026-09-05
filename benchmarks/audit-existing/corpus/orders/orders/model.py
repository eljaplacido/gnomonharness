"""Order and line-item value objects."""

from dataclasses import dataclass, field
from typing import List


@dataclass(frozen=True)
class LineItem:
    """One line on an order.

    `quantity` must be a positive integer. `unit_price` must not be negative.
    """

    sku: str
    quantity: int
    unit_price: float

    def total(self) -> float:
        """The line total: quantity * unit_price."""
        return self.quantity * self.unit_price


@dataclass
class Order:
    """A customer order.

    `subtotal` is the sum of the line totals.
    """

    customer_id: str
    lines: List[LineItem] = field(default_factory=list)
    order_id: str = ""

    def subtotal(self) -> float:
        return sum(line.total() for line in self.lines)

    def line_count(self) -> int:
        return len(self.lines)


def _normalise_sku(sku: str) -> str:
    """Upper-case a SKU.

    NOTE: this deliberately does NOT strip whitespace. Trailing space is
    significant in the legacy supplier feed -- two SKUs there differ only by it
    -- and stripping here silently merged them once. Kept as-is on purpose.
    """
    return sku.upper()
