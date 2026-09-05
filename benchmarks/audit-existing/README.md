# Auditing an existing project — pilot, 2026-09-05

**10 of 14 planted defects found, 0 of 5 controls falsely flagged, 0 containment
violations.** Two projects, two passes, **$0** on a local Qwen3.6-35B. Reproduce
with `drive.sh`; pre-registered in [PRE-REGISTRATION.md](PRE-REGISTRATION.md).
Raw in `runs/`, including each report verbatim.

## Result

| | pass 1 | pass 2 |
|---|--:|--:|
| orders (8 defects) | 5/8 = 62.5% | 4/8 = 50.0% |
| scheduler (6 defects) | 5/6 = 83.3% | 5/6 = 83.3% |
| **combined recall** | **10/14 = 71.4%** | **9/14 = 64.3%** |
| false positives, of 5 controls | **0** | **0** |
| read-only role changed the tree | **no** | **no** |

Matching is mechanical: a `path.py:LINE` citation on the right file within ±2
lines. Reported beside it as sensitivity, because the strictness of that rule is
a choice and should be visible: at ±5 recall is 0.75/1.00, and on file alone it
is 0.875/1.00. **File-only is not used as the metric** — it would score a
reviewer who named the right files and nothing else as nearly perfect.

## Consistency, which nothing else here measures

Exactly **one defect of fourteen flipped between the two passes**
(`cancel-wrong-error`, found in pass 1 and not pass 2). Everything else was found
both times or neither.

| | |
|---|--:|
| found in **both** passes (pass²) | 9/14 = 64.3% |
| found in **either** pass | 10/14 = 71.4% |
| flip rate | **1/14 = 7.1%** |

That is **half** this harness's flip rate on Terminal-Bench task completion
(11.9–15.6%, see [reliability-passk](../results/reliability-passk-2026-09-05/)).
Reading code and reporting what is wrong is a more repeatable act than making a
task pass — which is worth knowing before anyone sizes a powered audit arm, since
it means fewer paired items are needed here than there.

## What it missed, and the pattern in it

Four misses across both projects:

- `export-leaks-handle` — a file handle left open on an early return
- `lineitem-unchecked` — documented preconditions never validated
- `precondition-after-work` (orders) — checked, but after the work it guards
- `window-end-unchecked` — a constructor argument never validated

**Three of the four are defects of absence** — something the specification
requires that simply is not there — against a clean sweep of the defects of
*presence*: the unreachable branch, the backwards sort, the swallowed `OSError`,
the wrong exception type, the inclusive bound, the contract violations. The one
exception, `precondition-after-work`, was missed in `orders` and found in
`scheduler`, where the wrong bound (`> 24` for an hour) gave it something visible
to point at.

That is a hypothesis worth stating and not yet a finding: **n = 4 misses.** It is
the shape a powered run should be designed to confirm or kill, and it is exactly
the kind of subgroup claim this project's own discipline notes warn is close to
meaningless at this n.

## Zero false positives is the number that surprised me

Five controls — code that looks wrong with a comment saying why it is not:
duplicate branches kept because the rates are about to diverge, a SKU normaliser
that deliberately does not strip whitespace, an un-cached `len()`, a budget reset
that deliberately does not clamp, a defensive list copy. **None was flagged, in
either pass.**

External code-review benchmarks report the opposite failure mode as the common
one — high precision bought with very low recall, agents flagging only the
obvious. This is 71% recall with no false positives on adversarial controls, in
a read-only role, from a 35B model running locally. It is two projects and it is
a pilot, and it is a better starting point than expected.

## Claim accuracy — the pre-registered primary, and a caveat that matters

`claim-check` over all four archived reports: **27 checkable claims, 27
verified, 0 refuted, 0 unverifiable — 100%.** Every `path.py:LINE` the auditor
cited resolves to a real file and a real line.

**That is a positive control passing, not independent evidence, and the
difference is the whole point.** gnomon cite-checks the answer's `file:line`
citations against the tree *inside the turn* (`919381d`), so a citation that does
not resolve is caught before the answer is ever handed over. `claim-check` then
verifies citations by essentially the same rule. Two implementations of one check
agreeing is worth something — it says the in-turn check is not lying — but it is
much weaker than it looks written as "100%".

The number becomes evidence only against a harness that has **no** such
mechanism, where refuted citations can actually appear. That is precisely why
claim accuracy is the pre-registered *primary* for the peer arms and not for this
pilot, and this run should be read as confirming the instrument works rather than
as a score.

## Containment

The `auditor` role holds `read`, `glob`, `grep`, `note`, `todo` and nothing else
— **not** the scaffold's `critique`, which carries `bash` with no `bash_deny`
and, by the scaffold's own comment, has passed five `git push` spellings straight
to the shell. `git status --porcelain` after every run was clean. A read-only
audit that cannot change what it judges is the property, and it held 4/4.

## What this does not establish

- **Nothing comparative.** No peer ran. This is gnomon's own baseline, which is
  the thing that had to exist before a comparison could mean anything.
- **Nothing about real repositories.** Two synthetic projects, ~350 lines each,
  written to be audited. The pre-registration asks for six real ones at pinned
  commits, and the difficulty calibration here is a guess until that happens.
- **That 100% claim accuracy means what it looks like.** See the section above.

## Cost

**$0.** Four runs, 26–29 seconds each, local model, no provider.
