# Is gnomon unique? A feature-by-feature check — 2026-11-01

**Question.** The maintainer has never seen a harness built like gnomon. Is
that true, and in exactly which respects?

**Method.** I derived gnomon's distinctive features from README.md, docs/DESIGN.md,
docs/POSITIONING.md, docs/CONTRACTS.md, docs/SANDBOX-DESIGN.md,
docs/GOVERNANCE-CHECK-DESIGN.md, `docs/GUIDE.md` (branch `docs/guide`) and the
2026-10-31 landscape note (branch `docs/harness-landscape-2026-10`). I then
checked about 25 coding harnesses and about 30 governance, policy, audit and
spec tools against each feature, using primary docs and repos wherever
possible. Several load-bearing claims were re-fetched by hand: Cursor
agentic-owners, Chock, fail-first, Microsoft AGT, protect-mcp, APM, Continue
checks, `goose review`, the Claude Code OTel settings digest and Kiro
permissions.

**Limits.** "Not found" means not found in about 80 searches and the doc pages
read. It is not proof of absence. Cells marked **(u)** are unverified. Nothing
here is a gnomon measurement.

---

## 1. gnomon's distinctive features, refined

The brief's draft list (a)–(j) holds up, with three refinements. Agent
immutability is split out as (a2), because it is common elsewhere while (a) is
not. "Declared routing" is folded into (h). And (g) is defined by its exact
bundle, because each of its pieces exists somewhere.

| # | Feature | Mechanism in gnomon | Source |
|---|---|---|---|
| a | **Config identity.** Behaviour is a function of a committed, content-hashed directory, and the hash is stamped on every session and audit record. There is no machine-scoped config (Rule 1). Absence is hashed. | `gnomon-surface` manifest (Rust authority, TS twin, golden fixture) | README "The Six Rules", DESIGN.md |
| a2 | **Agent-immutable rules.** `write`/`edit` refuse `.gnomon/`. Drift through `bash` is detected by re-hashing after every command. Skills are proposed, never self-applied. | `inSurface`, `skills/proposed/` excluded from the hash | POSITIONING.md §1, DESIGN.md |
| b | **Capability gating per role.** Roles differ by tool list, not instruction. `bash_allow`/`bash_deny` (deny wins) and `write_allow` apply. Delegation runs under the *target* role, cannot nest, and a non-writing role cannot delegate. Each boundary is asserted by a test. | `roles.toml`, `task` tool | README "Tools and Safety" |
| c | **Trust dial.** `approval.gate` is `always`, `on_write` or `never`. Approval shows a real diff. A non-interactive run *refuses* gated calls, and `by:` records who decided. | `policy.toml` | README "How much it asks" |
| d | **Tamper-evident trail.** A hash-chained JSONL trail carries `surface_hash` per record and is metadata-only by default. `[audit.attest]` signs chain heads through an external command, so gnomon never holds the key, and it publishes its own limits. | `.gnomon-audit/` | README "Governance and Audit" |
| e | **Outcome contract.** Every step falls in one of three buckets: `result`/`refusal`/`apparatus_failure`. There is no composite verdict. Exit codes are 0–1 / 2–4 / 10–13, plus `stop_reason`. | `conformance/exit_codes.json` | CONTRACTS.md §1 |
| f | **Published contracts with conformance fixtures.** Manifest, enumerations, exit codes, session shape, TOML subset, check verdict and shadow record are golden fixtures. Rust and TS compute the surface hash independently. The README is tested against the code. | `conformance/` (22 files) | README "Determinism and Contracts" |
| g | **Governing other harnesses.** `gnomon check` judges a change made by *any* agent. Rules come from `--base` (a change cannot loosen its own rules). Six **deterministic** checks: changed paths vs `write_allow`, surface edits, `[verify]` command, must-fail-first by re-run, transcript shell commands vs `bash_allow`/`bash_deny` (Claude Code / opencode formats), and a sealed audit record of the verdict. It installs as Claude Code SessionStart/Stop hooks or a CI job. Exit codes are 0/2/10. | `gnomon check` | README "Governing other harnesses", GOVERNANCE-CHECK-DESIGN.md |
| h | **Hybrid routing as data.** Role profiles (`local_first`, `frontier_plan`, `all_remote`) map roles to local or cloud endpoints, with per-role fallback. Role selection is by declared regex, never by the model's judgement. | `profiles/`, `[routing]` | GUIDE §2.5, README "Who picks the role" |
| i | **Spec → contract → test → implement → verify, with must-fail-first.** The roles are separated by capability. `[verify]` runs a named command. `test_must_fail_first` re-runs a new test with the non-test files at base. `[chain] gate` can stop on refusal or on a failed check. | `[verify]`, `[chain]` | README loop section, POSITIONING.md |
| j | **Benchmark discipline.** Pre-registered scoring rules, paired McNemar tests, minimum detectable effect stated up front, and nulls and losses published in the README. | `benchmarks/results/*/PRE-REGISTRATION.md` | POSITIONING.md "What this is not" |

---

## 2. Feature × tool matrix

Y = yes, P = partial, N = no or not documented on the page cited, (u) =
unverified. The columns were chosen as the closest analogs. Seven are harnesses:
Claude Code, Codex CLI, opencode, Kiro, Roo Code, DeepSeek Harness and goose.
Four are governance tools: Continue Checks, Chock, Microsoft Agent Governance
Toolkit (AGT) and protect-mcp. For a governance tool, a harness-only row such
as (c) or (h) is marked N with "not a harness".

| | Claude Code | Codex CLI | opencode | Kiro | Roo Code | DeepSeek Harness | goose | Continue Checks | Chock | MS AGT | protect-mcp |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **a** config hashed + stamped | **P**: opt-in SHA-256 of *managed* settings only, on the `managed_settings_resolved` OTel event, not repo config ([monitoring](https://code.claude.com/docs/en/monitoring-usage)) | **N**: repo `.codex/config.toml` for trusted projects, no hash found ([config ref](https://learn.chatgpt.com/docs/config-file/config-reference)) | **N**: repo `opencode.json` + `debug config`, no hash; managed/global policy can override project ([policies](https://opencode.ai/docs/policies)) | **N, opposite design**: permissions kept *outside* the repo "so a cloned repo cannot inject permission rules" ([permissions](https://kiro.dev/docs/cli/v3/permissions/)) | **N**: `.roomodes`, no hash ([modes](https://roocodeinc.github.io/Roo-Code/features/custom-modes)) | **P**: `--dump-config` prints the composed config; profiles are user-global; no hash in `SessionHeader` ([cli-help](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)) | **N**: env beats config files; global config ([config-files](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md)) | **N**: N/A ([CI](https://github.com/continuedev/continue/blob/main/docs/checks/running-in-ci.mdx)) | **P**: policies hash-pinned in `chock.lock`, `--verify-sha`; not stamped on records ([repo](https://github.com/open-coder-ai/chock)) | **N**: no config hash documented ([repo](https://github.com/microsoft/agent-governance-toolkit)) | **P**: "receipts include the decision and policy digest", Cedar policy only ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **a2** agent can't edit own rules | **Y**: `.claude` protected, but allowed under `bypassPermissions` ([modes](https://code.claude.com/docs/en/permission-modes)) | **Y**: `.codex`, `.git`, `.agents` read-only, OS-sandbox-enforced ([security](https://learn.chatgpt.com/docs/agent-approvals-security)) | **N**: not documented ([permissions](https://opencode.ai/docs/permissions)) | **Y**: default "blocks writes to its own settings" ([permissions](https://kiro.dev/docs/cli/v3/permissions/)) | **P**: `.roo/` protected by default, user-bypassable ([auto-approve](https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions)) | **N**: not documented ([config-catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)) | **N** ([config-files](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md)) | **N**: N/A | **P**: baseline step fails a PR that disables or narrows a policy ([repo](https://github.com/open-coder-ai/chock)) | **N** (u) | **N** (u) |
| **b** per-role capability gating | **Y**: subagent `tools`/`disallowedTools`, Bash and Edit path rules ([sub-agents](https://code.claude.com/docs/en/sub-agents)) | **P**: `prefix_rule` allow/prompt/forbidden; custom agents have no tool list ([subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)) | **Y**: per-agent `permission`, bash patterns, edit globs, `permission.task` ([agents](https://opencode.ai/docs/agents)) | **Y**: scoped policies; headless subagent calls denied unless the parent allows ([permissions](https://kiro.dev/docs/cli/v3/permissions/)) | **Y**: tool groups per mode, `edit` with `fileRegex` ([modes](https://roocodeinc.github.io/Roo-Code/features/custom-modes)) | **Y**: agent presets as "declarative capability sets" ([config-catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)) | **P**: recipe `available_tools`; no shell allow/deny ([recipes](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md)) | **N**: not a harness | **P**: regex command/content policies, no roles ([repo](https://github.com/open-coder-ai/chock)) | **P**: YAML deny / `require_approval`, per-agent scoping unclear ([repo](https://github.com/microsoft/agent-governance-toolkit)) | **P**: Cedar per tool call ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **c** trust dial; headless refuses | **Y**: six modes; `-p` denies unapproved calls ([headless](https://code.claude.com/docs/en/headless)) | **Y**: approval policies; headless approval-needing action fails ([security](https://learn.chatgpt.com/docs/agent-approvals-security)) | **P**: allow/ask/deny; `run --auto` auto-approves ([cli](https://opencode.ai/docs/cli)) | **P**: `--trust-tools`; headless "ask" undocumented ([permissions](https://kiro.dev/docs/cli/v3/permissions/)) | **Y**: auto-approve categories ([auto-approve](https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions)) | **Y**: `--approval-policy`; unanswerable means deny ([pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md)) | **Y**: auto/approve/smart_approve/chat ([permissions](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/managing-tools/goose-permissions.md)) | **N**: not a harness | **N**: not a harness | **Y**: `require_approval` with approvers ([repo](https://github.com/microsoft/agent-governance-toolkit)) | **P**: `require_approval` ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **d** tamper-evident trail | **N**: OTel `event.sequence`, no chain or signature ([monitoring](https://code.claude.com/docs/en/monitoring-usage)) | **N**: OTel `codex.tool_decision`, no chain ([security](https://learn.chatgpt.com/docs/agent-approvals-security)) | **N**: sessions only ([cli](https://opencode.ai/docs/cli)) | **N** (u) | **N** ([modes](https://roocodeinc.github.io/Roo-Code/features/custom-modes)) | **P**: "model-visible means logged", append-only JSONL with approval events, not chained ([architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)) | **N** ([adversary-mode](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/security/adversary-mode.md)) | **N** | **N**: no audit log documented ([repo](https://github.com/open-coder-ai/chock)) | **Y**: "Merkle audit", Decision BOM; design undocumented ([repo](https://github.com/microsoft/agent-governance-toolkit)) | **Y**: Ed25519-signed linked receipts ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **e** 3-bucket exit contract | **P**: 0 / non-zero / 143; denials only in JSON ([headless](https://code.claude.com/docs/en/headless)) | **N**: no exit codes in official docs ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)) | **N** ([cli](https://opencode.ai/docs/cli)) | **N** (u) | **N** | **N**: no exit-code table ([cli-help](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)) | **N** ([cli](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)) | **N** | **P**: non-zero + SARIF ([repo](https://github.com/open-coder-ai/chock)) | **N** (u) | **P**: verifier 0 valid / 1 invalid / 2 not checked ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **f** contracts + conformance fixtures | **P**: settings JSON schema, no behaviour fixtures ([settings](https://code.claude.com/docs/en/settings)) | **P**: rule files carry inline `match`/`not_match` tests checked at load ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules)) | **P**: config JSON Schema ([config](https://opencode.ai/docs/config)) | **N** (u) | **N** | **Y**: SHA-256 fingerprints per persisted type, migrations, replay snapshot tests ([persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-catalog.md)) | **N** | **N** | **P**: "a policy is a manifest plus the evals that prove it fires" ([repo](https://github.com/open-coder-ai/chock)) | **N** (u) | **N** (u) |
| **g** judge another agent's change, base-branch rules, deterministic | **P**: hooks/`-p` can be used to build it; nothing built in ([headless](https://code.claude.com/docs/en/headless)) | **N** (u) | **N**: `/goal` judges its own session ([judge.txt](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/goal/judge.txt)) | **N** | **N** | **N**: auto-review covers its own calls only ([config-catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)) | **P**: `goose review [range]` reviews any diff against `.agents/checks/*.md`, LLM-judged ([cli](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)) | **P**: checks read "from your repository's default branch", run on every PR, **LLM-judged** prose ([CI](https://github.com/continuedev/continue/blob/main/docs/checks/running-in-ci.mdx)) | **P**: deterministic, multi-agent hooks + CI, anti-loosening, test-integrity heuristics; no must-fail-first, no transcript check ([repo](https://github.com/open-coder-ai/chock)) | **P**: runtime hooks in Claude Code, Codex, OpenCode, Copilot CLI; not post-hoc diff judging ([repo](https://github.com/microsoft/agent-governance-toolkit)) | **P**: runtime Claude Code hooks ([repo](https://github.com/ScopeBlind/scopeblind-gateway)) |
| **h** hybrid local/cloud per role | **P**: per-subagent `model`, Claude models; local only via gateway (u) ([sub-agents](https://code.claude.com/docs/en/sub-agents)) | **P**: `--oss` local, but custom agents can't switch provider ([config ref](https://learn.chatgpt.com/docs/config-file/config-reference)) | **Y**: per-agent `model`, local supported ([agents](https://opencode.ai/docs/agents)) | **N** (u) | **Y**: sticky model per mode ([modes](https://roocodeinc.github.io/Roo-Code/features/custom-modes)) | **P**: OpenAI-compatible `baseURL`, subagent model policy ([config-catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)) | **P**: per-recipe provider/model, Ollama ([recipes](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md)) | **N**: not a harness | **N**: not a harness | **N**: not a harness | **N**: not a harness |
| **i** spec loop + enforced must-fail-first | **N**: plan mode only ([modes](https://code.claude.com/docs/en/permission-modes)) | **N** | **N**: `/goal` needs evidence, not test-first ([judge.txt](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/goal/judge.txt)) | **P**: requirements → design → tasks + property tests; no fail-first ([specs](https://kiro.dev/docs/specs/)) | **N** | **N**: "watch red" is a contributor rule, not a feature ([testing](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md)) | **P**: recipe `retry` with validation ([recipes](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md)) | **N** | **P**: refuses deleted tests, lost assertions and new skips; no re-run ([repo](https://github.com/open-coder-ai/chock)) | **N** | **N** |
| **j** pre-registered, losses published | **N** (u): vendor benchmarks report wins | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) | **N** (u) |

Row (j) was not systematically searched per vendor. A general search found
pre-registration and McNemar-paired harness comparisons only in academic work,
for example [arXiv 2609.09218](https://arxiv.org/pdf/2609.09218) (reports a
pre-registered null) and [arXiv 2609.20804](https://arxiv.org/pdf/2609.20804).
I found no harness vendor publishing a pre-registered null for its own product.
Contents are known from search snippets only (u).

### Off-matrix analogs that matter

| Tool | Closest to | What it does | Source |
|---|---|---|---|
| **Cursor agentic-owners** (Agent SDK template) | g | "The agent reads policies from the PR's base ref, so a PR can't exempt itself." Path globs, holds PRs that edit the policy, fails closed. Risk is **graded by a model**. No tests or commands run. | [cursor.com](https://cursor.com/docs/agent-sdk/templates/agentic-owners) |
| **fail-first** (thinx-pro, v0.1.0) | i, g check 4 | Runs changed tests at the merge-base and at head: PROVES / VACUOUS / BROKEN, exit codes 0/1/2. Ships as a Claude Code skill. This is gnomon's must-fail-first as a standalone tool. | [github](https://github.com/thinx-pro/fail-first) |
| **spec-kit-tdd** (community spec-kit extension) | i | `/speckit.tdd.verify` audits test-first evidence from git history and fails closed. Evidence comes from commit order, not a re-run. | [wiki](https://github.com/d0whc3r/spec-kit-tdd/wiki) |
| **MergeJudge** | g | Loads `.mergejudge.yml`, AGENTS.md and CLAUDE.md from the base branch; protected-path lanes. (u) on depth and licence. | [mergejudge.si](https://mergejudge.si/guide/gate-ai-agent-prs) |
| **gh-aw safe-outputs** | b, g | `allowed-files` allow-list and protected files (AGENTS.md, CLAUDE.md, `.github/`) on agent-created PRs, for GitHub's own agent only. | [gh-aw](https://github.github.com/gh-aw/reference/safe-outputs-pull-requests/) |
| **Microsoft APM** | a | `apm.lock.yaml` pins commit SHA and content hash per agent-context package. `install --frozen` "fails on drift". Not stamped on any record. | [apm lock](https://microsoft.github.io/apm/reference/cli/lock/) |
| **Kilo Code Review Agent** | g | Reviews any PR against a committed REVIEW.md, LLM-judged. | [kilo.ai](https://kilo.ai/docs/automate/code-reviews) |
| **Zenity** | b, c, g | Native-hook enforcement in Claude Code, Codex, Cursor, Copilot and Gemini CLI; commercial; runtime. | [zenity.io](https://www.zenity.io/use-cases/agent-type/device-based) |
| **IETF agent-action-receipts draft** | d | Signed, hash-chained action receipts. The draft itself calls the chaining "not novel". | [draft-sahu-00](https://www.ietf.org/archive/id/draft-sahu-agent-action-receipts-00.html) |
| **Amazon Bedrock AgentCore Policy (Cedar)** | b | Cedar permit/forbid on every gateway tool call. | [docs](https://aws.github.io/bedrock-agentcore-starter-toolkit/user-guide/policy/overview.html) |
| **Gemini CLI** | e | The richest exit-code set among harnesses: 0, 1, 41 auth, 42 input, 53 turn limit. Still no refusal bucket. | [headless](https://geminicli.com/docs/cli/headless.md) |

---

## 3. Verdict per feature

| # | Verdict | Closest analog | Why |
|---|---|---|---|
| **a** | **Unique as found.** This is the strongest single claim. | Claude Code's opt-in managed-settings SHA-256; protect-mcp's policy digest in receipts; APM and Chock lockfiles | Hashing *parts* of agent config exists: a managed-settings digest, a policy digest, lockfiles. No tool found hashes the *whole* committed agent-behaviour directory and stamps that hash on every session and audit record. Rule 1 (no machine-scoped layer at all) was also not found: every harness checked layers user, global and/or managed config. |
| **a2** | **Common.** | Codex (OS-sandbox read-only `.codex`), Claude Code, Kiro | Codex enforces this *more strongly* than gnomon, at the OS level. gnomon's additions are drift detection after `bash` and check 2 judging by the base surface. |
| **b** | **Common.** | Claude Code subagents, opencode agents, Roo modes, Kiro | Per-agent tool lists, command rules and path rules are standard. Kiro's "subagent can't exceed parent policy" matches gnomon's delegation cap. gnomon's edge is narrow: boundaries asserted by tests, and the "can't write ⇒ can't delegate" invariant. |
| **c** | **Common.** | Claude Code `-p`, Codex `exec`, DeepSeek Harness, Continue headless | All of these refuse unapproved calls headless. Some do not: OpenHands headless always-approves, Cline defaults to auto-approve, and `opencode run --auto` auto-approves. gnomon's `by:` attribution in the trail is a small extra. |
| **d** | **Rare in harnesses, common as a layer.** | protect-mcp (signed receipts with policy digest); Microsoft AGT (Merkle audit) | No first-party harness ships a chained trail. Add-ons and standards do, and the IETF draft calls chaining "not novel". gnomon's distinct part is the *combination* with (a): every record names the whole configuration, and heads are signed by an external command that holds the key. |
| **e** | **Rare in this form.** | Gemini CLI's specific codes; Factory `droid exec` non-zero on autonomy exceed ([docs](https://docs.factory.com/cli/droid-exec/overview)) | No harness found separates refusal from apparatus failure in its exit code. This is unique, but a modest differentiator: easy to copy, and valuable mainly to scripts and benchmark harnesses. |
| **f** | **Rare.** | **DeepSeek Harness** (type fingerprints, replay snapshots); Codex rule inline tests | DeepSeek Harness is a real peer in spirit, applied to its *log schema* rather than its config and exit codes. Docs tested against code, and a Rust/TS dual hash implementation, were not found elsewhere. |
| **g** | **The bundle is unique as found; every piece exists.** | Cursor agentic-owners (base-ref policy); Continue Checks (default-branch checks on any PR); Chock (deterministic, multi-agent, anti-loosening); fail-first (must-fail-first) | No single tool found combines base-branch rules, a deterministic path allow-list, running the verify command, must-fail-first by re-run, *post-hoc transcript shell-command checking*, and a sealed audit verdict for an arbitrary agent through hooks and CI. Transcript checking after the fact had no analog at all: others gate commands at runtime. The main competitors are **LLM-judged** (Continue, goose review, Kilo, agentic-owners). gnomon's checks are deterministic. |
| **h** | **Common.** | opencode, Roo sticky models, Factory BYOK + Ollama, aider architect/editor | Per-role local/cloud mixing is ordinary. Declared-regex role routing was not found elsewhere, but it was not searched for exhaustively (u), and it is a small feature. |
| **i** | **Spec loop: common. Enforced must-fail-first inside a harness: rare.** | Kiro, spec-kit, OpenSpec (spec loop); fail-first, spec-kit-tdd (test-first) | Must-fail-first exists as standalone tools and emerging "revert-red" CI checks, but no harness found enforces it in its own loop. |
| **j** | **Rare among harness projects.** | Academic harness studies (arXiv 2609.09218, 2609.20804) | Vendors publish wins. Publishing a pre-registered null against a peer (50.0 vs 47.1, p = 1.0) is unusual for a product (u: not exhaustively searched). |

---

## 4. Overall verdict

**Is gnomon unique as a combination?** Yes. No tool found combines even four of
these: (a) whole-config identity on every record, (d) a chained trail, (e) a
three-bucket contract, and (g) deterministic post-hoc governance of other
agents. Most of the field is built around the opposite premise, where
behaviour is per-user plus per-org-managed and repo config is advisory or
trust-gated.

**Is any single feature unique?** Two, on the evidence found:
1. **(a)** A content hash of the entire committed agent-behaviour directory,
   stamped on every session and audit record, with no machine-scoped layer.
2. **(g) as a bundle**, specifically post-hoc checking of another agent's
   *transcript* shell commands against repo allow/deny lists, combined with
   base-branch rules and a must-fail-first re-run.

(e) is unique in exact form but low-moat. Everything else has close analogs.

**Where gnomon is genuinely ahead**
- Configuration as an identified artefact. The "why did it do that → which
  file" chain is mechanised; elsewhere only fragments exist (a managed-settings
  digest, a policy digest, lockfiles).
- Determinism of the governance verdict. Its closest competitors on (g) put an
  LLM in the judging seat. gnomon's checks are re-runnable and give the same
  answer.
- Self-honesty infrastructure: conformance fixtures, docs tested against code,
  published limits (for example the four `[audit.attest]` limits), and
  pre-registered benchmarks with published nulls.

**Where others are ahead**
- **Isolation.** Codex and Claude Code have OS-level sandboxes (Seatbelt, bwrap
  + seccomp). Codex makes its own config read-only *at the OS level*. gnomon's
  `confined` mode is path containment and `bash` reaches the network unless
  `exec = "docker"`.
- **Workspace trust.** Claude Code, Codex, pi and Kiro gate repo-supplied
  permissions behind trust. Kiro deliberately keeps permissions *out* of the
  repo "so a cloned repo cannot inject permission rules"
  ([Kiro](https://kiro.dev/docs/cli/v3/permissions/)). gnomon's README and docs
  describe no trust gate, so a cloned repository's `.gnomon/` sets its own
  approval dial. This is the security cost of Rule 1 and should be
  addressed or documented. (Checked: grep of README.md and docs/ on
  2026-11-01. Not tested at runtime.)
- **Enterprise policy.** Claude Code managed settings, Codex
  `requirements.toml`, Cursor and Kiro admin tiers, and Microsoft AGT's
  multi-agent plugins.
- **Distribution of governance.** Chock and Microsoft AGT already ship runtime
  hooks into a dozen agents. gnomon's `check` hooks only Claude Code natively,
  and reads transcripts only in Claude Code and opencode format.
- **Ecosystem, IDE, cloud and model quality.** Copilot, Cursor, Devin and Claude
  Code web have cloud execution and firewalls; Cursor, Cline and Roo have IDE
  surfaces; the MCP ecosystem is HTTP/SSE-heavy. Task completion is not
  demonstrably better (gnomon's own null result).
- **Chained audit as a layer.** protect-mcp and Microsoft AGT bring signed or
  Merkle audit to agents gnomon does not run.

---

## 5. Positioning

**The sentence gnomon can honestly claim:**

> gnomon is a terminal coding harness whose behaviour is fixed by a committed,
> content-hashed `.gnomon/` directory, and that hash is stamped on every session
> and audit record. It can also deterministically judge a change any other
> agent made, against the rules as they stood on the base branch. We found no
> other harness or governance tool that does either.

Keep "we found no other … that does either" tied to a dated search like this
one, not stated as permanent fact.

**Claims it must NOT make**
- "The only harness with role-based tool permissions / per-agent capability
  gating." Claude Code, opencode, Roo, Kiro and DeepSeek Harness all have it.
- "The only agent that can't edit its own config." Codex enforces this at the
  OS level; Claude Code and Kiro also do it.
- "The only harness with a tamper-evident audit trail" or "first hash-chained
  agent audit." Microsoft AGT and protect-mcp exist, and an IETF draft calls
  chaining not novel. Say instead: "the only *harness* we found that ships one
  first-party, with the config hash on every record".
- "The only tool that governs other coding agents." Chock, Microsoft AGT,
  Zenity, Continue Checks, Cursor agentic-owners, MergeJudge and goose review
  do parts of it. Say "deterministic, post-hoc, base-branch-ruled".
- "The only spec-driven harness" or "the only TDD-enforcing tool." Kiro and
  spec-kit are spec-driven; fail-first and spec-kit-tdd enforce test-first.
- "Rules from the base branch so a PR can't loosen them" presented as novel.
  Cursor agentic-owners states exactly that, and Continue reads checks from the
  default branch.
- "Sandboxed" without qualification. `confined` is not an OS sandbox.
- "Reproducible behaviour" meaning reproducible *outputs*. The configuration
  is identified; model outputs still vary, and `compaction = "summary"` is
  explicitly non-deterministic.
- Any task-completion superiority. Own measurement: 50.0 vs 47.1, p = 1.0.

---

## 6. Search terms used

Re-run these to re-check. Dates matter: Gemini CLI was replaced by Antigravity
CLI on 2026-06-18 per its docs, and the Roo Code repo was archived on
2026-05-15.

**Harnesses**
- Codex CLI config.toml profiles approval_policy sandbox_mode agents roles documentation
- "codex exec" exit code github openai/codex issue
- Codex subagents custom agents config_file model per agent sandbox_mode
- Codex sandbox workspace-write ".codex" ".git" read-only protected paths
- Codex CLI config fingerprint hash session log sha256 rollout session_meta
- gemini cli headless exit codes 41 42 44 52 53 FatalTurnLimitedError
- Gemini CLI conductor extension spec-driven development
- Qwen Code docs subagents tools model approval mode
- Kiro spec requirements.md design.md tasks.md test-driven enforce
- kiro.dev docs property-based testing correctness test-first
- Kiro CLI custom agent toolsSettings allowedPaths allowedCommands
- GitHub Copilot coding agent custom agents .github/agents tools firewall
- Cursor hooks beforeShellExecution permissions .cursor/cli.json
- ampcode manual permissions amp.permissions delegate toolbox
- Factory droid exec autonomy levels exit code droid shield custom droids
- Factory droid BYOK Ollama local model
- Devin enterprise audit logs permissions
- coding agent tamper-evident hash-chained audit log Claude Code Codex 2026
- deepseek-ai deepseek-harness dsh model-visible logged config
- opencode v2 release /goal command sst anomalyco 2026
- OpenHands SDK confirmation policy security analyzer ConfirmRisky LLMSecurityAnalyzer docs
- OpenHands CLI headless mode exit code confirmation --always-approve docs
- Cline CLI headless CLINE_COMMAND_PERMISSIONS allow deny docs.cline.bot
- Cline hooks PreToolUse .clinerules hooks directory docs 2026 subagents
- Kilo Code docs custom modes agents permissions kilo.json 2026
- Kilo Code Reviewer pull request review custom rules docs kilo.ai
- Continue continue.dev checks .continue/checks pull request agent markdown rules CI 2026
- Continue CLI cn headless --allow --exclude permissions tool policies exit code

**Governance, audit and spec tooling**
- govern AI coding agents policy Claude Code Cursor Codex CI check repo rules
- Claude Code hooks policy enforcement tool open source allow deny commands
- AI agent pull request check policy read from base branch so PR cannot weaken its own rules agent changed files allowed paths
- CI check AI agent tests must fail without the change revert implementation run new tests "fail-first"
- coding agent audit log records config hash fingerprint of agent configuration each entry reproducible
- tamper-evident audit log AI agent hash chain signed
- "agent action receipts" IETF draft signed hash-chained
- Microsoft Agent Governance Toolkit github; agent-governance-toolkit Claude Code plugin hooks Merkle audit policy hash "decision BOM"
- protect-mcp Claude Code Cedar receipts hash-chained Ed25519 scopeblind
- microsoft apm agent package manager apm.lock lockfile
- in-toto attestation AI generated code provenance agent session commit
- spec-kit test-first enforcement constitution "must fail" tests before implementation
- OpenSpec Fission-AI proposal specs changes archive validate; Tessl spec-driven tests
- Amazon Bedrock AgentCore Policy Cedar tool calls gateway
- OPA Rego policy for AI coding agent tool calls Claude Code hook
- Zenity OR "Prompt Security" OR Pillar OR Knostic coding agent Cursor Claude Code governance hooks 2026
- Cerbos OR Permit.io OR Oso authorization for AI agents MCP tool permissions 2026
- LlamaFirewall AlignmentCheck CodeShield coding agents
- NeMo Guardrails tool calling rails execution rails agent 2026
- Invariant Labs Guardrails Snyk agent scan coding agent policy 2026
- Langfuse OR LangSmith OR AgentOps OR Phoenix tamper-evident immutable audit log hash
- agentgateway Linux Foundation MCP authorization CEL policy tool access audit
- Docker MCP Gateway interceptors policy signed images tool allowlist
- StepSecurity AI coding agent Claude Code GitHub Actions harden-runner agent
- Coder agent boundaries Claude Code process sandbox policy allowlist domains

**Benchmark discipline**
- coding agent harness publishes negative benchmark results pre-registered evaluation 2026
- agent harness "pre-registration" benchmark McNemar coding agent comparison

**Not covered.** These were not searched or returned nothing usable: Lakera,
Prompt Security, Pillar, Aim, Lasso, Noma, Backslash, Knostic (coding-agent
specifics), Portkey, TrueFoundry, Kong, Endor Labs, Socket, Aembit, Astrix,
Google ADK policies, BMAD, Nix and Dagger container-use, Guardrails AI in
depth, and Amp and Devin internals (behind sign-in). A re-check should start
there, and with Chock and Microsoft AGT, which are moving fastest toward
gnomon's (g).
