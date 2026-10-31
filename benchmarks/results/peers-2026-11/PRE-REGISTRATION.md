# Pre-registration — peer harnesses on one local model (gx10)

**Written 2026-10-31, before any peer trial ran.** The design was chosen by the
user from four options. The only runs before this one are smoke cells
(`MODE=smoke`, hello-world), which prove each arm installs and reaches the model
and are not analysed.

## Question

On the same model, the same tasks and the same time cap, does gnomon's harness
resolve more or fewer Terminal-Bench tasks than three peers? The peers are the
minimal floor and reference harness, the peer gnomon was last compared with, and
a harness built for the same model family. "Same" is enforced; see below.

## Design

| | |
|---|---|
| arms | **gnomon** v0.3.1 (`7012c5a6d80516891b061cc0f07ac1724b6289a0`, fetched by SHA, the August adapter, `--role implementor`, approval never)<br>**mini-swe-agent** 2.4.6 (tb's run command)<br>**goose** v1.57.0 (tb's recipe and run command)<br>**Qwen Code** 0.26.4 (`-p … --approval-mode yolo`) |
| model | `qwen3.6-35b` on gx10's llama-server (`:18080`, `--parallel 1`). Every arm reaches it through the same relay on the docker bridge |
| tasks | the 16 tasks of `sample16-hunch.txt`: a fixed-hash subset of the pre-registered August 48, chosen by name, not by outcome. Task clone at laude-institute/terminal-bench `d28711d`, the same as H7 |
| n | 3 attempts per (arm, task), so 48 cells per arm and 192 in all |
| cap | 900 s per agent run (`--global-agent-timeout-sec`), identical for every arm |
| order | interleaved. Each attempt shuffles the tasks with a fixed seed, and on each task the four arms run back to back in an order that rotates with the task. One `tb run` per cell |
| runner | tb 0.2.18, one trial at a time, holding `decisionbench/gpu.lock` |

## Scoring, fixed in advance

- **Valid cell:** the agent started and tb returned a verdict (`is_resolved` not
  null). Anything else (image build, install failure, crash) is apparatus. It is
  counted per arm and reported, never scored as a failure.
- **Resolved** is tb's `is_resolved`, from its hidden tests. No harness's own
  account is used.
- **A pair is compared only where both arms have a verdict.** A cell where either
  arm hit an apparatus failure is void for that pair.
- **Buckets sum to n:** `collect_peers.py` asserts it.

## Analysis, fixed in advance

1. **Per arm:** passed / valid cells, with a 95% Wilson interval.
2. **Paired, gnomon against each peer:** an exact McNemar test over the
   (task, attempt) cells both arms completed.
   - **Three-valued.** Fewer than 6 discordant pairs means "cannot tell": no split
     of fewer could reach p < 0.05, and it is not reported as "no difference".
   - **No correction is claimed beyond stating it:** there are three comparisons,
     so an uncorrected p near 0.05 is weak.
3. **Noise floor, per arm:** how many of the 16 tasks give different verdicts
   across their 3 attempts. A difference between arms that is smaller than an
   arm's own flipping is not read as a difference.
4. **Descriptive only:** cells at the 900 s cap, wall-clock per arm, and install
   failures per arm.

## Floor gate, decided before launch

**Added 2026-10-31 ~11:05Z, before any peer trial.** H7 (in progress) runs gnomon
on all 48 August tasks, including these 16, with the same model and cap. Its
`[shadow]` block is log-only and changes nothing about the run. At the time of
writing, its first 5 trials were all unresolved.

**The rule:** if gnomon resolves **2 or fewer of these 16 tasks in H7**, this
design is at the floor and cannot resolve harness differences. Six one-way
discordant pairs are the minimum for p < 0.05. The full run is then **not
launched**: the task set or the model is changed and this file amended first.
This is the check AgentLab adopted after spending ~400 cells on designs at the
floor or the ceiling (its methodology, "Can this design resolve anything?").

## What this run can and cannot resolve

- **Only large differences.** 48 paired cells resolve roughly 20–25 percentage
  points between two arms, depending on how often they disagree. A 10-point gap
  is below what this design can see, and the result will say "cannot tell"
  rather than "equal".
- **Tokens are not compared.** tb's installed agents report no token counts and
  there is no per-arm proxy. The token-efficiency hypothesis (H16, against goose)
  needs a different instrument.
- **Not in this run:** pi (no tb adapter), Claude Code and opencode. They need the
  Harbor/AgentLab route on an x86 host. Terminal-Bench 4.0's images are
  amd64-only and its tasks allow 8 h.

## Asymmetries known in advance, stated rather than removed

- Each arm runs with its own tb adapter's prompt framing. goose's recipe adds an
  "act autonomously" preamble; the others pass the task as written. This is what
  each harness looks like under Terminal-Bench, and it is part of the arm.
- Qwen Code does not use tb's shipped invocation, which pipes the task with no
  approval mode and can stall on a tool prompt. It uses the documented headless
  form with approval off, the same autonomy the other arms run with.
- gnomon's arm is its August benchmark configuration: a fresh `gnomon init`
  surface, every role on the bench endpoint, approval never, audit on. It is not
  tuned for this run.

## Apparatus checks (benchmark-discipline)

- [x] Versions pinned in each arm's setup and recorded per cell; the gnomon SHA
      is checked against the `v0.3.1` tag before the run and inside every
      container.
- [x] One variable per comparison (the harness); model, tasks, cap and host are
      shared.
- [x] Arms interleaved, not blocked; one GPU job at a time (`gpu.lock`);
      nothing else on `:18080`.
- [x] Task list non-empty (asserted); validity rule and analysis written before
      any trial.
- [ ] Smoke: every arm resolves or at least runs hello-world before the full run.
- [ ] After the run: wall-clock inspected for ~0 s or exactly 900 s, and versions
      read back per cell.
