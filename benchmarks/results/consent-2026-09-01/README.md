# T9 — surface consent: do the three declared levels behave as declared?

**2026-09-01.** $0, no model. 6 direct probes through `executeTool`.

`gnomon enumerations` publishes `approval` and `/allow` publishes
`strict | custom | all`, and `DESIGN.md` leans on the strict default: *"the
surface is not writable by a tool call."* B4 validated exactly that one level,
and only against a model. The other two had never been tested — and they are the
levels an operator reaches for when strict is inconvenient, which is precisely
when a mistake matters.

## Result — 6/6

| `allow` | approver | code | asked | surface changed |
|---|---|---|---|---|
| `strict` | yes | 2 | 0 | no |
| `strict` | no | 2 | 0 | no |
| `custom` | yes | 0 | 1 | **yes** |
| `custom` | no | 2 | 1 | no |
| `all` | yes | 0 | 0 | **yes** |
| `all` | no | 0 | 0 | **yes** |

- **`strict` refuses even when the approver says yes** — it is not a prompt, it
  is a boundary, and it never consults the approver at all.
- **`custom` writes only with approval**, and genuinely asks.
- **`all` is standing consent** — it writes without consulting the approver in
  either direction, which is what "standing" has to mean to be worth having.

Tested directly rather than through a model, so the result is about the
mechanism rather than a model's willingness to attempt it.

## A false finding this nearly produced

The first version used `gate: "on_write"` and reported that `allow = "all"`
**still prompts** — reading as a broken contract. It is not: `allow` governs
access to `.gnomon/`, `gate` governs writes in general, and the two are
independent. Under `on_write` every write asks, surface or not.

Isolated with `gate: "never"`, `all` asks zero times and the contract holds
completely. The lesson is the campaign's recurring one in a new place: a failing
check is a claim about the apparatus until the apparatus has been ruled out.

## Reproducing

```bash
node consent.mjs
```
