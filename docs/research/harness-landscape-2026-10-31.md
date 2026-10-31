# Harness landscape and hypothesis status — 2026-10-31

A research pass over primary sources (release pages, official docs, arXiv)
covering what changed in coding-agent harnesses since gnomon's August
benchmarks. It covers what that means for H1–H12 in
[gnomon-harness-benchmark-review-and-research-roadmap.md](gnomon-harness-benchmark-review-and-research-roadmap.md)
and which peers gnomon should be measured against next. Entries marked
**(u)** are unverified or second-hand. Nothing here is a gnomon measurement.

## What moved under the benchmark itself

- **Terminal-Bench is at 4.0** (2026-08-28, 66 tasks). That follows 2.1
  (2026-05-06, 28 tasks fixed) and 3.0 (2026-07-30) ([news](https://tbench.ai/news)).
  gnomon's published Terminal-Bench numbers use `terminal-bench-core==0.1.1`
  through the legacy `tb` runner. They are not comparable with anything current.
- **The runner is now Harbor.** It ships adapters for goose, opencode, pi,
  mini-swe-agent, codex, claude-code, openhands, aider, gemini-cli, cline-cli,
  kimi-cli/kimi-code, qwen-coder and hermes
  ([pre-integrated agents](https://docs.harborframework.com/agents/pre-integrated-agents)).
  gnomon has none yet; a custom agent class is the route
  ([custom agents](https://docs.harborframework.com/agents/custom-agents)).
- **Leaderboard integrity tightened** (April 2026):
  - passing trials must carry ATIF trajectories, and an agent judge reviews them;
  - ForgeCode's trials were rescored to 0 after its agent fetched solutions over
    the network into its own `AGENTS.md`
    ([integrity update](https://tbench.ai/news/leaderboard-integrity-update)).

  This is the case for an agent-immutable surface and real network isolation
  (H12), made by someone else's incident.

## Peers worth measuring against, in order

| # | Harness (version) | Why |
|---|---|---|
| 1 | **mini-swe-agent** 2.4.6 | The floor gnomon never got. The "naive" arm crashed 30/30 and has no result. It is also Artificial Analysis's reference harness on TB 4.0. |
| 2 | **pi** 1.4.0 (now `earendil-works/pi`) | The lineage ablation: what gnomon adds over a minimal core. Since 1.1.0 it can use Jev-class decision models as classifiers through llama.cpp `/v1/systemone`, so it is also the direct comparator for `[shadow]`. |
| 3 | **Qwen Code** 0.26.4 | Same model family as gnomon's local default. Native OpenAI-compatible endpoints, and wall-clock and tool-call budgets (relevant to H1). |
| 4 | **Claude Code** 2.1.316 on the local model | The top TB 4.0 harness, run with the same model as gnomon. Since 2.1.302, `-p` starts in Manual permission mode, so an arm that does not set `--permission-mode` explicitly is confounded. |
| 5 | **goose** 1.57.0 | Closes the residual goose gap from August, on a version nine releases newer: compaction moved to tool boundaries, max-turn handling changed, and background subagents were removed. One paper finds it the most token-efficient harness (arXiv 2607.22585), so it is the right comparator for gnomon's token claim too. |

**Watch, don't run yet:**
- **DeepSeek Harness** (`dsh` 0.2.1-rc.5, MIT): the closest design peer — all
  plugins, "model-visible means logged", a dumpable composed config. Its
  provider layer is **pi-ai**. No Harbor adapter, no JSON output, still a
  release candidate.
- **Codex CLI** 0.166.0: its local Responses-API route against llama.cpp is
  unproven **(u)**; a frontier-only arm for now.
- **opencode**: now two lines, V1 1.19.5 (npm `latest`) and V2 2.2.5. Pin one
  explicitly. V2's `/goal` reviewer would make a natural verifier-role arm.

## H1–H12, against the new evidence

| H | Status | Evidence |
|---|---|---|
| H1 wall-clock-aware convergence | **weakened** (completion claim) | Harness-injected timing improved budget adherence for Qwen3.6-27B but not task performance ("On the Clock", NeurIPS'26 **(u)**). TB 4.0 also recalibrated time allowances: re-baseline first. |
| H2 ship first, bounded verification | **strengthened** | Planning mostly removes redundant post-edit verification (arXiv 2609.20804). OpenHands-SDK's characteristic failure is VERIFY/MAX_TURNS (arXiv 2607.22585). |
| H3 environment capsule | unchanged | No new evidence. Bash-only action spaces suffice for bash-capable models (2609.20804). |
| H4 true flip rate < 7.5% | unchanged; noise floor better known | SWE-bench single-run variation is 2.2–6.0 pp, with SD > 1.5 even at T=0 (arXiv 2602.07150 **(u)**). Harness version alone moves quality (arXiv 2607.03691). Five or more repeats. |
| H5 hashline | new evidence needed | The only cross-model claim (+15 pp, 16 models) is from hashline's author, second-hand **(u)**. |
| H6 curated vs self-generated skills | **strengthened** | SkillsBench: curated +16.4 pp, self-generated −1.3 pp **(u)**. ForgeCode's self-written `AGENTS.md` leaked answers. |
| H7 verifier with reserved budget | **strengthened** (mechanism) | Evidence-carrying termination: premature unsupported stops 40/66 → 0/66, at +0.9 turns and +4.7k tokens a trajectory (arXiv 2608.23623). |
| H8 negligible policy tax | new evidence needed | Gating can *add* capability. ECLoop holds actions until evidence conditions hold: +4.8–11.8 pp Pass@1 with up to 12% fewer tokens (arXiv 2607.28815). |
| H9 harness × model interaction | **strengthened** | Component value depends on model strength (2609.20804). Failure modes are harness-intrinsic and replicate across models (2607.22585). |
| H10 evidence-based progress beats heuristics | **strengthened** | ECT and ECLoop both find structured evidence beats prose summaries or critics. Locally: gnomon's own stop reasons and buckets did *not* separate failing from passing model × task cells in the 231-run AgentLab replay (agentcenter decisionbench, 2026-10-31). |
| H11 evidence-linked summaries | **partly weakened** | Rule-based elision before summarising is the efficient strategy. Models rarely use recoverable/linked elision, and it did not improve accuracy (2609.20804). |
| H12 real isolation | motivation strengthened | The ForgeCode network fetch above. The DeepSeek Harness sandbox does not cover network or processes. No new experiment. |

## New hypotheses

- **H13 — decision-model gating.** A Jev-class model with a per-decision
  threshold fitted on the agent's own runs can stand in for the LLM on
  stop/nudge decisions.
  - In JevAgentHarness (arXiv 2610.21412), ungated delegation lost about 20 pp,
    and isolated-question accuracy did not transfer: the most accurate model
    solved 69.5% of tasks. Shadow first; `[shadow]` and the in-loop run H7 are
    that step.
  - OpenJev weights are CC BY-NC.
- **H14 — certificate-gated termination.** A typed completion certificate cuts
  premature stops on Terminal-Bench at bounded token cost (from 2608.23623).
- **H15 — elision before summary.** At small local context windows, rule-based
  elision before `summary` compaction beats summary alone (from 2609.20804).
- **H16 — the right token comparator.** gnomon's token-efficiency claim should be
  tested against goose, the most efficient harness in 2607.22585, not only
  opencode.
- **H17 — peer version drift.** One peer run at two versions bounds how much a
  peer's own release moves its score (from 2607.03691).

## Sources opened in this pass

- Terminal-Bench news and the TB 4.0 leaderboards: tbench.ai,
  snorkel.ai/leaderboard/terminal-bench-4-0,
  artificialanalysis.ai/evaluations/terminalbench-v4-0.
- Harbor docs and github.com/harbor-framework/harbor.
- Release pages: aaif-goose/goose, anomalyco/opencode, openai/codex,
  OpenHands/OpenHands, google-gemini/gemini-cli, QwenLM/qwen-code,
  charmbracelet/crush, cline/cline, Kilo-Org/kilocode, earendil-works/pi,
  antinomyhq/forge, SWE-agent/mini-swe-agent, MoonshotAI/kimi-cli.
- The Claude Code CHANGELOG.
- deepseek-ai/deepseek-harness.
- arXiv 2610.21412, 2609.20804, 2608.23623, 2607.28815, 2607.03691,
  2607.22585, 2609.00006, 2609.20519, 2608.27969.
