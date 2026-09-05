Here are all the defects found:

---

### 1. `orders/pricing.py:20` — `tier_for` duplicated guard, wholesale branch is dead code

The second `if subtotal < 500.0:` on line 20 is identical to the guard on line 18. It can never be reached, so the `return WHOLESALE` on line 22 is dead code. The wholesale tier is only reached via the final `return WHOLESALE` on line 23. The comment on line 21 ("Intended as the wholesale branch") confirms this was a copy-paste error. The condition should be `if subtotal >= 500.0:` (or `else:`).

### 2. `orders/pricing.py:31-32` — `apply_discount` rejects a legal subtotal of 0.00

The SPEC and the docstring both state: "A subtotal of exactly 0.00 is legal and returns 0.00." But the guard `if subtotal <= 0:` raises `ValueError`, which rejects the zero case. It should allow `subtotal == 0.0` (e.g. `if subtotal < 0:`).

### 3. `orders/repository.py:40-41` — `save` swallows `OSError` and reports success for a failed write

The SPEC requires: "A save that cannot be written must raise `StorageError`; it must never report success for an order that was not stored." The code catches `OSError` and does `pass`, then unconditionally assigns `order_id` and returns it as if the file was written. It should raise `StorageError` instead of silently swallowing the exception.

### 4. `orders/repository.py:49` — `get` raises `KeyError` for an unknown id

The SPEC requires: "`OrderRepository.get` returns the order, or `None` when the id is unknown. It does not raise for an unknown id." But line 49 raises `KeyError(order_id)` when the file doesn't exist. It should return `None`.

### 5. `orders/service.py:19-23` — `place_order` does work before checking preconditions, and omits the lines check

The SPEC requires: "Both are preconditions and must be checked before any work is done." But line 19 constructs the `Order` and line 20 computes `subtotal` before the precondition checks on lines 22–23. The `customer_id` check happens too late. Additionally, there is no check at all that `lines` contains at least one item — the spec says "at least one line item" is a precondition, but the code never validates this.