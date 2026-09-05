# External benchmarks for reliability and governance

*Surveyed 2026-09-05.* What exists outside this repository for the two axes
gnomon actually claims — reliability and governance — and what running each
against gnomon would take.

**Standard of evidence for this document.** Everything below is read from
abstracts and paper landing pages, not from full texts, and none of it has been
run here. That is stated once, plainly, rather than implied away: this project's
own post-mortem exists because a report was quoted more confidently than it was
read. Every claim about a benchmark's method is attributed to the paper, not
asserted as fact.

Terminal-Bench measures task completion, and this repository has run it several
times. Nothing about determinism, disclosure, auditability or capability
separation is visible to it — which is why the five `$0` property suites in
`benchmarks/` exist. The question this document answers is whether anybody else
has built those, so gnomon can be measured by somebody else's ruler.

**Short answer: yes, three of them, all 2026, and none has been run against a
coding harness.**

---

## 1. ReliabilityBench — consistency, robustness, fault tolerance

[arXiv 2601.06112](https://arxiv.org/abs/2601.06112)

Measures three things: **consistency** under repeated execution (`pass^k`),
**robustness** to semantically equivalent task perturbations at intensity ε, and
**fault tolerance** under injected tool/API failures at intensity λ. The fault
injection is chaos-engineering style — **timeouts, rate limits, partial
responses, schema drift**. Reported: 1,280 episodes, two models, two agent
architectures, four domains; rate limiting caused the largest degradation
(93.75%), transient timeouts the least (98.75%).

**Already borrowed.** `benchmarks/fault-disclosure` takes those four fault
classes directly and injects them into gnomon's endpoint layer. That is where the
429-reported-as-unreachable and the truncated-tool-call defects came from.

**What is left to take.** Two things, and the first is already done:

- **`pass^k`.** Computed 2026-09-05 from data already in the archive:
  [reliability-passk-2026-09-05](../benchmarks/results/reliability-passk-2026-09-05/).
  gnomon v0.1.1 is **pass@1 51.2%, pass^2 45.2%**, retention 0.88 — about one
  apparent success in eight does not reproduce. Free, and nobody had asked.
- **ε-perturbation robustness.** Untouched here. Rephrase the same task and ask
  whether the outcome holds. Cheap to build on the existing Terminal-Bench
  apparatus, and it measures something a surface hash cannot: the harness is
  identical across the two runs by construction, so anything that moves is the
  model's sensitivity to wording — which is the honest boundary of what a
  content-hashed surface can promise.

**Fit: partial.** Its four domains are scheduling, travel, customer support and
e-commerce — not coding. The benchmark itself is not runnable against gnomon
without new task adapters. **The methodology transfers; the task set does not.**

---

## 2. DEMM-Bench — governance-evidence sufficiency

[arXiv 2606.20634](https://arxiv.org/pdf/2606.20634)

The closest thing to a benchmark for what gnomon is *for*. It asks whether the
evidence a runtime emits is **sufficient to reconstruct decision-level governance
properties** — not whether records exist, but whether they answer the question.
Eight evidence regimes normalised through adapters; questions across eight
dimensions: **actor, authority, action, policy, decision basis, resource touch,
lifecycle context, verification strength**. Metric: Property Sufficiency
Accuracy, with overclaim detection. Dataset and code released (Zenodo, Hugging
Face, GitHub).

Its headline finding is the same class this repository keeps hunting: baselines
**overclaimed sufficiency** — trace-present and schema-present on 75% of cases,
ledger-present on 50%. "There is a trace, therefore the question is answerable"
is exactly `exit null` read as a clean zero, one abstraction up.

**gnomon against the eight dimensions, mapped before running anything:**

| dimension | what the trail carries | verdict |
|---|---|---|
| actor | `role` on every record | ✅ |
| authority | `approval` records with `by: flag:--yes` / `default:no-operator` | ✅ and honestly — it records that *nobody* approved |
| action | `tool_call` with tool, args, target | ✅ |
| policy | `surface_hash` on every record | ✅ **and this is the unusual one** — the policy in force is *identified*, not described |
| decision basis | the model's reasoning is not recorded under `record = "metadata"` | ⚠️ **the gap** |
| resource touch | `worktree_changed`, `tree_delta`, paths | ✅ partial — what changed, not always which bytes |
| lifecycle context | `session_start` / `session_resume` / `session_end` | ✅ |
| verification strength | `verify` records, and `degradation` records since 2026-09-05 | ✅ |

So roughly **six and a half of eight out of the box, with `decision basis` the
named gap** — and that gap is a deliberate default (`record = "metadata"`), not
an absence. `record = "full"` carries the turn text. Whether that satisfies
"decision basis" is precisely the question the benchmark exists to answer, and
guessing at it here would be the overclaiming it measures.

**Fit: strong, with real work.** gnomon is an evidence *producer*; DEMM-Bench
scores evidence *sufficiency*. Running it means writing one adapter from the
JSONL trail into its normalised form. That is the single highest-value external
benchmark for this project, because it is somebody else's ruler applied to the
exact claim the README leads with.

**Caveat to carry:** 64 test cases across manuscript scenarios is small, and one
adapter written by the system's own author is a conflict of interest of the same
shape `docs/BENCHMARKS.md` already declares. Both belong in any result.

---

## 3. ProcCtrlBench — process-level defects and control preservation

[arXiv 2605.20251](https://arxiv.org/html/2605.20251)

Evaluates **execution process** rather than final outcome: 11 process-level
defect types in 4 categories, standardised from raw logs into unified
trajectories. Its **control preservation** metric asks whether execution stays
*interpretable, interruptible, correctable, reversible, and capable of returning
authority to the user*. 200 cases sampled from AndroidBench, **TerminalBench**
and SWE-bench-Verified.

Those five words are close to a restatement of gnomon's design thesis by someone
with no stake in it, which makes it the most useful external framing available.
An honest self-assessment before running anything:

| property | gnomon | |
|---|---|---|
| interpretable | audit trail + `/cot`, and the fold is display-only | ✅ |
| interruptible | Esc cancels the turn and the whole chain | ✅ |
| correctable | `approval.gate` per action; `strict` refuses even on yes | ✅ |
| returns authority | a gated call with nobody to ask is **refused**, never assumed | ✅ — the posture the whole harness is built on |
| **reversible** | collision detection and atomic batches; **no undo, no snapshot, no rollback** | ⚠️ **the gap** |

**Reversibility is gnomon's weakest of the five and it is worth naming before
somebody else does.** The edit engine validates before writing and refuses a
drifted patch, which prevents a bad write; it does not let you take a good-looking
one back. Git is the de facto undo and the harness neither requires nor manages
it.

**Fit: strong, and the cheapest of the three to attempt**, because it samples
TerminalBench and this repository already has a working Terminal-Bench adapter.

---

## 4. Adjacent, and deliberately not pursued

- **BenchGuard** ([arXiv 2604.24955](https://arxiv.org/html/2604.24955v1)) —
  automated auditing of agent benchmarks. Relevant as a mirror: it is the
  external version of `docs/BENCHMARK-POSTMORTEM.md` and
  `.claude/skills/benchmark-discipline`. Worth reading before publishing any of
  the arms above; not something to score against.
- **Code-review benchmarks** — [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark),
  [Qodo's real-world benchmark](https://www.qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review/),
  and [Benchmarking LLM-based Code Review](https://arxiv.org/html/2509.01494v1).
  Their **violation-injection then bug-injection** method is where
  `benchmarks/audit-existing/` gets its planting design, and their finding that
  agents reach high precision at very low recall is the reason that arm reports
  recall per defect class rather than one number.
- **Governance frameworks, not benchmarks** — the EU AI Act's Article 12 event
  logging and Article 14 human oversight, NIST's AI RMF, Singapore IMDA's
  agentic-AI framework (Jan 2026), NIST's AI Agent Standards Initiative (Feb
  2026). These specify what a record must support; they do not score anything.
  `docs/POSITIONING.md` is right to say gnomon "provides the primitives an
  oversight regime needs" and to stop short of claiming compliance.

---

## What to do with this, in order

1. **`pass^k` — done, $0.** Already computed and published.
2. **ProcCtrlBench self-assessment against the five control properties** — an
   afternoon, no spend, and it names `reversible` as a gap in gnomon's own terms
   before an outside reader finds it.
3. **DEMM-Bench adapter** — the highest-value external result available, because
   it puts somebody else's ruler on the central claim. Budget: days, not hours.
4. **ε-perturbation robustness** on the existing Terminal-Bench apparatus, folded
   into the `peer-parity` arm rather than run separately.

None of these is a substitute for the `$0` property suites in `benchmarks/`.
They are how the same claims get stated in a vocabulary somebody else defined,
which is worth more than a number this project invented for itself.
