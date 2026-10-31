# Pre-registration — P1-H: P1's design on a hosted model

**Written 2026-10-31 ~22:00Z, before any P1-H cell.** P1
(`../peers-2026-11/PRE-REGISTRATION.md`, with all its amendments) is running on
gx10 with the local qwen3.6-35b. P1-H asks P1's question on a different, hosted
model, so that a harness ranking can be checked across models. It is not part
of P1's analysis.

## Same as P1
- **Tasks:** the 16 tasks of `sample16-hunch.txt`, at terminal-bench `d28711d`.
- **Arms:**
  - gnomon v0.3.1 (`7012c5a`, fetched by SHA);
  - mini-swe-agent 2.4.6 with litellm 1.105.7;
  - goose 1.57.0;
  - Qwen Code 0.26.4;
  - opencode V2 2.2.5 (`--auto`).
- **Runner and cap:** tb 0.2.18 with P1's adapters and setups (copied, not
  shared, so that P1's files are never touched). The cap is 900 s plus tb's
  300 s join.
- **n and order:** 3 attempts, and the same per-attempt shuffle (seed =
  attempt) and arm rotation as P1.
- **Validity and scoring:** P1's own rules, including `no_model_call`. Exact
  McNemar, three-valued; Wilson intervals; within-arm flips. The collector is
  P1's.

## Different from P1
- **Model:** `deepseek-v4.1-flash` on the user's OpenCode Go plan.
  - It is reached through `relay-go.mjs` on the docker bridge, one instance per
    slot. The relay injects the key and meters usage and Go's
    `opencode.allowance`.
  - It adds `stream_options.include_usage` to streamed chat requests.
  - It meets Go's client policy (session id per cell, honest user agent) where
    a harness does not; see `../p2-2026-11/PRE-REGISTRATION-probe.md`.
- **Concurrency:** 2 slots; P1 runs 1. Each slot has its own relay and runs one
  cell at a time, so per-cell metering stays exact. Attempts are barriers.
- **Host load:** P1, G2b and G1 run on the same host. Load is recorded per
  cell, and wall clock is descriptive only.
- **Endpoints added:** Go allowance per cell and per resolved task, and
  prompt-cache share from Go's own `cached_tokens`.

## The two-model reading, fixed now
A harness difference is called model-robust only if P1 and P1-H both show it in
the same direction, and at least one of them significantly (exact McNemar
p < 0.05 with ≥ 6 discordant pairs). A difference in one only is reported as
model-specific.
