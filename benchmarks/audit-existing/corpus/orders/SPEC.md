# Orders — specification

A small order-processing library.

## Pricing tiers

An order's subtotal decides its tier:

- under 100.00 -> "standard", no discount
- 100.00 up to but not including 500.00 -> "preferred", 5% discount
- 500.00 and above -> "wholesale", 12% discount

## Discounts

`apply_discount` takes a subtotal and a tier and returns the discounted amount,
rounded to two decimal places. A subtotal of exactly 0.00 is legal and returns
0.00.

## Repository

`OrderRepository.save` persists an order and returns its id. A save that cannot
be written must raise `StorageError`; it must never report success for an order
that was not stored.

`OrderRepository.get` returns the order, or `None` when the id is unknown. It
does not raise for an unknown id.

## Service

`place_order` requires a customer id and at least one line item. Both are
preconditions and must be checked before any work is done. Invalid input raises
`ValueError`.
