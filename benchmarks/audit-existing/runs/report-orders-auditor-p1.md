Here is the complete defect report:

---

### 1. `orders/pricing.py:20` — Dead branch in `tier_for`

The second `if subtotal < 500.0:` on line 20 is a duplicate of line 18. It can never be reached, making the `return WHOLESALE` on line 22 dead code. The wholesale tier is only reached via the final `return WHOLESALE` on line 23. The condition on line 20 should have been `subtotal >= 500.0` (or the duplicate should be removed).

### 2. `orders/pricing.py:31-32` — `apply_discount` rejects zero subtotal

The spec and docstring both state that a subtotal of exactly 0.00 is legal and should return 0.00. The code raises `ValueError` for `subtotal <= 0`, which incorrectly rejects zero.

### 3. `orders/repository.py:40-41` — `save` swallows write failures

When `json.dump` raises `OSError`, the code does `pass` and then returns the order id as if the save succeeded. The spec requires raising `StorageError` on write failure.

### 4. `orders/repository.py:49` — `get` raises `KeyError` for unknown ids

The spec says `get` should return `None` for an unknown id and must not raise. The code raises `KeyError(order_id)` instead.

### 5. `orders/service.py:19-28` — `place_order` does work before checking preconditions

The docstring requires that both preconditions (non-empty `customer_id`, at least one line item) be checked *before any work is done*. The code creates the `Order`, computes the subtotal, determines the tier, applies the discount, and calls `repo.save()` before checking `customer_id`. Additionally, the `lines` precondition is never checked at all.

### 6. `orders/service.py:37` — `cancel_order` raises wrong exception type

The docstring says it raises `ValueError` when `order_id` is not a string, but the code raises `TypeError`.