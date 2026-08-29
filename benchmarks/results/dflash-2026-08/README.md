# DFlash speculative decoding — on vs off (August 2026)

A controlled measurement of what DFlash speculative decoding buys gnomon on a
local llama.cpp backend. Raw per-trial data is in `results/*.jsonl`;
`SUMMARY.json` is the machine-readable roll-up; `analyze.py` regenerates the
tables below from the raw data.

**Conflict of interest, stated up front.** gnomon's author ran this benchmark.
Read the numbers with that in mind — the design below is chosen so the result is
hard to inflate (it is output-exact, so quality cannot be traded for speed), and
the raw trials are included so you can recompute everything.

## The question, and why this design is reliable

DFlash is a speculative-decoding draft for llama.cpp (`--spec-type draft-dflash`).
Speculative decoding is **output-exact**: the accepted tokens are the target
model's own tokens, so it changes *speed*, never the answer. gnomon's known weak
spot is its timeout tail (p90 wall-clock sits near its cap), so the question is:
**does DFlash's decode speedup translate into less wall-clock in-harness?**

The reliable way to measure that is to vary **exactly one thing** — the draft —
holding the model, the tasks, and the sampling constant:

- **Arm A (DFlash ON):** llama-server on `Qwen3.6-35B-A3B Q4_K_S` **+** the DFlash draft.
- **Arm B (DFlash OFF):** the **same weights**, no draft. Nothing else changes.
- **Greedy (temperature 0)** so the two arms are output-exact and deterministic —
  the answer, the pass/fail, and the token count are held constant, and
  **wall-clock is the sole variable**.

This is deliberately **not** `:18080` vs Ollama `:11434` — those differ in
quantization (Q4_K_S vs Q4_K_M) as well as speed, which would confound the result.

Setup: a GB10 node, gnomon driving a co-located llama-server over `localhost`
(no network hop), sequential arms (one 35B in VRAM at a time), 9 verified coding
tasks × 4 trials/arm, greedy, gnomon's default tools.

## Result

Per-task wall-clock (median of 4 trials), and the ON→OFF speedup:

| task | out tokens | ON wall | OFF wall | **speedup** | ON tok/s → OFF |
|---|--:|--:|--:|--:|--|
| mathlib | 1445 | 16.8s | 25.7s | **1.53×** | 87 → 57 |
| citydata | 996 | 12.6s | 17.8s | **1.42×** | 81 → 57 |
| fizzbuzz_suite | 972 | 13.0s | 18.3s | **1.41×** | 76 → 55 |
| cliflag | 350 | 6.8s | 8.3s | 1.22× | 53 → 49 |
| palindrome | 220 | 4.3s | 5.0s | 1.17× | 54 → 45 |
| square | 160 | 3.7s | 4.0s | 1.10× | 46 → 42 |
| fixbug | 106 | 2.8s | 2.9s | 1.07× | 43 → 40 |
| failtest | 332 | 7.4s | 7.6s | 1.03× | 46 → 45 |
| refactor | 402 | 7.8s | 7.8s | 1.01× | 53 → 48 |
| **aggregate** | | **75.1s** | **97.5s** | **1.30×** | 53 → 48 (end-to-end median) |

**36/36 trials pass on both arms, 0 crashes, 0 timeouts** — quality is identical
(output-exact), so DFlash is a *free* speedup.

## What it means, and what it does not

- **The benefit scales with generation volume.** Spec-decode accelerates token
  *generation*, not prompt *processing*, and gnomon's turns are prefill-heavy
  (10k+ input tokens per turn). So the win tracks how much the model actually
  writes: **1.4–1.53× on generation-heavy tasks**, ~1.0× on tool/prefill-bound
  ones, **~1.3× aggregate**. The per-task decode rate confirms it: ~1.5× on
  generation-heavy work (87→57 tok/s), shrinking as generation shrinks.
- **It is quality-neutral.** Output-exact + 100% pass on both arms. There is no
  accuracy trade-off; this is pure latency.
- **It does NOT demonstrate a timeout→pass flip.** Every task here ran in <26s,
  far below any realistic cap, so the projected flips are **0 at every cap**
  (60–900s). This experiment quantifies the *lever* (a 1.3–1.5× wall-clock cut on
  generation-heavy work); proving it converts gnomon's actual timeouts to passes
  needs the genuinely long/hard tasks (e.g. the terminal-bench P0 set), which are
  not reconstructed here.
- **It does NOT change token efficiency.** Output is identical, so token counts —
  and therefore gnomon's token-efficiency results — are unchanged. DFlash is a
  speed lever, not an efficiency one.

## Reproduce

Needs llama.cpp's `llama-server`, a target GGUF, and a DFlash draft GGUF.

```bash
export LLAMA_SERVER=/path/to/llama-server
export MODEL_GGUF=/path/to/Qwen3.6-35B-A3B-Q4_K_S.gguf
export DRAFT_GGUF=/path/to/Qwen3.6-35B-A3B-DFlash.gguf
export TRIALS=4 CAP=240
bash orchestrate.sh        # arm A (on) -> relaunch off -> arm B -> restore on -> analyze
python3 analyze.py         # regenerate the tables from results/*.jsonl
```

The orchestrator only touches the benchmark port and restores the ON server on
exit (including on error). `tasks.py` holds the 9 tasks and their verifiers.
