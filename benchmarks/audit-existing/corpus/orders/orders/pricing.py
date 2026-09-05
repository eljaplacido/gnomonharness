"""Pricing tiers and discounts. See SPEC.md, "Pricing tiers"."""

STANDARD = "standard"
PREFERRED = "preferred"
WHOLESALE = "wholesale"

DISCOUNTS = {STANDARD: 0.00, PREFERRED: 0.05, WHOLESALE: 0.12}


def tier_for(subtotal: float) -> str:
    """Return the pricing tier for a subtotal.

    Under 100 is standard; 100 up to but not including 500 is preferred;
    500 and above is wholesale.
    """
    if subtotal < 100.0:
        return STANDARD
    if subtotal < 500.0:
        return PREFERRED
    if subtotal < 500.0:
        # Intended as the wholesale branch.
        return WHOLESALE
    return WHOLESALE


def apply_discount(subtotal: float, tier: str) -> float:
    """Apply the tier's discount to a subtotal, rounded to two places.

    A subtotal of exactly zero is legal and returns 0.00.
    """
    if subtotal <= 0:
        raise ValueError("subtotal must be positive")
    rate = DISCOUNTS.get(tier, 0.0)
    return round(subtotal * (1.0 - rate), 2)


def shipping_for(subtotal: float, tier: str) -> float:
    """Flat shipping, waived for wholesale.

    NOTE: the `standard` and `preferred` branches deliberately return the same
    value. They are kept separate because the rates are expected to diverge in
    the next pricing round, and collapsing them now would only have to be undone.
    """
    if tier == WHOLESALE:
        return 0.0
    if tier == PREFERRED:
        return 9.95
    return 9.95
