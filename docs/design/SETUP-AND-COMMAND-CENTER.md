# Design: first-run setup and the command center

Status: **Part I implemented, steps 1 to 5**, 2026-11-03; released in v0.4.1
(#129), together with `gnomon dashboard` and the desktop shell (#128). Step 1
(the read-only hardware probe and runtime discovery) came with this document
(#105). Steps 2 to 5 (`gnomon doctor`, the catalog and recommendation,
`gnomon setup` with the consent-gated pull, the speed check and the mode it
suggests) came in the setup-wizard PR that supersedes #105. Step 6 (hybrid
control on `escalate`) waits for #102: setup records the choice as a
preference only. What is below under Part II is the proposal as written; the
`gnomon dashboard` that shipped reads `setup --json` and `doctor --json`.

**Decisions taken on the open questions (2026-11-03),** and where the build
differs from the text below:
1. `gnomon setup` is a new command, and `launch` offers it first ("Guided
   setup", the Enter default) when no model answers.
2. `gnomon doctor` is a new read-only command.
3. The catalog updates only with releases; `--catalog FILE` reads another.
4. The speed thresholds ship provisional and are printed as such.
5. One `control` per escalation block, default `observe`, once #102 lands.
   **`--yes` approves the surface write and nothing else.** It never approves
   a download (`--pull TAG` must name it, which replaces "`--yes` alone pulls
   the top recommendation" in part 4) or spending (the one-token key check
   needs a person at the prompt).
6. `$` is provider-reported only.
7. The UI is packaged lazily inside `gnomon-cli`.
8. Remote access is documented through `ssh -L` and Tailscale only.
9. Hardware facts go to a gitignored `.gnomon-setup.json`; the committed
   surface carries only tags, the mode and the catalog's label (part 6).
10. The default hybrid control is `observe`.

This document has two halves:
- **Part I, the setup wizard:** what gnomon learns about the machine at setup,
  and how it gets a local-first user to a first answered turn.
- **Part II, the command center:** a local browser UI over the same engine,
  for people who will not live in a terminal.

## The question

The user, verbatim: *"if it's gonna be local first, could it scan whether you
have Linux or Windows or Mac, recognize your hardware and plug in any local
model that hardware can run, to just get started. Lowering the barrier of
setting up and configuring."* And, on the UI: *"something along the lines of
Hermes setup with a dedicated web or desktop client… easier for adoption… a
command center for its features, not just the terminal."*

Short answer: yes to both, if three things stay true.
- **Detection runs at setup, once.** Its result is written into the hashed
  surface as concrete tags. It never decides anything at run time (Rule 1).
- **Nothing is downloaded, generated or spent without an explicit yes.**
- **The UI has no authority of its own.** Every action it takes is a CLI
  action, recorded the same way. It edits hashed files only through a
  proposed diff that a person accepts.

---

# Part I: the setup wizard

## What exists today

| Piece | Where | What it does |
|---|---|---|
| Model detection | `packages/gnomon-cli/src/detect.ts` | `listOllama` GETs `127.0.0.1:11434/api/tags`. `chooseModels` drops embedding models and picks the largest chat model at or under 70B (`AUTO_CEILING_B`) as `large`, and the smallest at or above 6B (`SMALL_FLOOR_B`) as `small`. Falls back to `qwen2.5:14b-instruct` and `qwen2.5:7b-instruct`. |
| Scaffold | `packages/gnomon-cli/src/init.ts` | Writes the detected tags into `roles.toml` and `profiles/local_first.toml`, with a comment (`modelNote`) saying what was found. Detection is skipped under `--from`; `--no-verify` keeps the scaffold byte-identical for benchmarks. |
| Readiness | `packages/gnomon-cli/src/setup.ts` | `checkReadiness` makes one listing request (3 s) and answers "will the first message be answered?". `SETUP_CHOICES` is the launch picker: Ollama, OpenRouter, OpenCode Go, OpenCode Zen, Custom, Skip. |
| Picker | `packages/gnomon-cli/src/index.ts` (`offerModelSetup`, `endpointAdd`, `pickOllamaModel`) | On a terminal, `launch` loops until a model answers or the user skips. `endpoint add` runs one token through an endpoint before writing anything. An empty Ollama gets the text `ollama pull qwen3:8b`; nothing is pulled. |
| Routing dial | `packages/gnomon-core/src/config.ts` (`[routing] mode`) | `manual` / `suggest` / `auto` for role choice. `suggest` off a terminal acts as `manual`. This is the existing trust-dial pattern. |
| Cloud fallback | `[roles.X.fallback]` (`config.ts`, GUIDE §5.3) | Tried when the primary call fails or times out. Once it answers, the rest of that turn stays on it. |
| Cloud rescue | PR #102, **open** | `[roles.X.escalate]` moves a stuck turn to a declared model, once per turn, on `stall`, `step_wall`, `budget_50`, `verify_failed` or `apparatus`. Recorded as an `escalation` audit kind (CONTRACTS §11 in that PR). Always automatic. |
| Decision shadow | `packages/gnomon-core/src/shadow.ts` | Log-only: records what a decision model would have done, and nothing reads the answer back. The precedent for an "observe" mode. |

What does not exist, before this PR:
- no hardware detection of any kind;
- no discovery of LM Studio, llama.cpp server or vLLM, although GUIDE §5.2
  shows how to declare them by hand;
- no recommendation of a model to pull, and no pull;
- no speed check;
- no `gnomon doctor` or any re-probe;
- no `$` accounting. `TokenUsage` in `prompt_loop.ts` holds tokens the
  backend reported, and an unknown is reported as unknown, not as zero.

## The design

Seven parts. Each is useful alone, in this order.

### 1. Hardware probe (implemented in this PR)

`packages/gnomon-cli/src/probe.ts`. It states facts only: no memory budget and
no recommendation (that is part 3).

| Export | What it does |
|---|---|
| `probeHardware(host)` | OS, arch, CPU model and cores, RAM, GPUs |
| `discoverRuntimes(host)` | Which local model servers answer, and what they list |
| `probeMachine(host?)` | Both, concurrently. `host` defaults to `systemHost()` |
| `formatProbe(probe)` | The lines `init` and the launch picker print |
| `systemHost()` | The real, read-only host |
| `RUNTIME_PORTS` | The four runtimes below |

**One seam for every effect.** Every command and every GET goes through an
injected `ProbeHost`: `run`, `get`, `readFile`, `listDir`, plus the platform,
arch, RAM and CPU facts. Tests feed fake outputs. The real host runs each
command with a timeout, with no shell, and with `windowsHide`.

**GPU sources, in order:**

| Platform | Source | Notes |
|---|---|---|
| Linux, Windows | `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` | One line per GPU. |
| NVIDIA unified memory (DGX Spark / GB10, Grace) | the same command | GB10 prints `NVIDIA GB10, [N/A]`. A GPU whose memory is `N/A` is reported as **unified memory shared with system RAM**, not as 0 GB. Verified on the gx10. |
| macOS on Apple Silicon | `sysctl -n hw.memsize`, `sysctl -n machdep.cpu.brand_string` | Unified. The chip name is the GPU name. |
| Linux, AMD | `rocm-smi --showproductname --showmeminfo vram --json`, then `/sys/class/drm/card*/device/mem_info_vram_total` | The sysfs file covers machines with the amdgpu driver but no ROCm (common with llama.cpp on Vulkan). |
| Windows without `nvidia-smi` | `Win32_VideoController` through PowerShell | `AdapterRAM` is a 32-bit field that caps at 4 GB, so a value at the cap is reported as **unknown**, not as 4 GB. |

**Degrading cleanly.**
- A missing command (`ENOENT`) means "no such hardware", and nothing is said.
- A command that runs and fails (a driver mismatch, say) adds one note naming
  the tool and its first line of output.
- Each command has 4 s and is killed with `SIGKILL` at the deadline. Each
  listing GET has 1.5 s. A timeout adds a note.
- Memory is printed in GiB.
- No probe failure stops `init` or `launch`.

**Where it shows.** In `gnomon init` output, and in `gnomon launch`'s
"No model answers" picker. It writes nothing to the surface. The real output
on the gx10, with every model server stopped for a benchmark:

```
This machine: Linux arm64, 20 CPU cores, 121.6 GiB RAM
GPU: NVIDIA GB10, unified memory, shares the 121.6 GiB of RAM
Model servers: none running on this machine
Note: nvidia-smi reports no memory of its own for NVIDIA GB10 ...
(read-only probe, 37 ms; nothing was written)
```

**Where it does not run.** `probeAtInit()` skips it under `init --from` (that
surface already made its choices) and under `init --no-verify`. Benchmark
harnesses pass `--no-verify`, and a benchmark's model server may sit on one of
the probed ports. A sweep must see no new localhost GETs and no new
subprocesses.

### 2. Runtime discovery (implemented in this PR)

`RUNTIME_PORTS`, all on `127.0.0.1`, read-only GETs with a short timeout,
run concurrently:

| Runtime | Port | Listing |
|---|---|---|
| Ollama | 11434 | `/api/tags` |
| LM Studio | 1234 | `/v1/models` |
| llama.cpp server | 8080 | `/v1/models` |
| vLLM | 8000 | `/v1/models` |

Ports are conventions, not proof. Any OpenAI-compatible server can sit on
8080. Where a `/v1/models` listing names its owner (`owned_by` is `vllm` or
`llamacpp`), that renames the server, whatever the port.

Each runtime ends in one of three states:

| State | Meaning |
|---|---|
| `serving` | a listing came back, with its models |
| `no_listing` | something answered, but not with a model list |
| `absent` | nothing answered |

Never probed: other hosts, other ports, anything not on loopback. The probe
never sends a completion.

### 3. Recommendation from a dated catalog (implemented)

As built (`catalog.ts`): each model carries its own thresholds,
`min_vram_gb`, `min_unified_gb` and `min_cpu_ram_gb` ("24 GB of GPU memory or
64 GB of unified memory"), compared at `nominal_tolerance` (a 24 GB card
reports 23.99 GiB). The `[budget]` fractions size only installed models the
catalog does not know, from the size Ollama reports. Measurements live in
`[[measured]]` rows that name their run; a model with none prints "not
measured by gnomon". On ranking, "installed beats new" holds within the
catalog's order. An installed model the catalog does not know is offered as
the no-download alternative, not above a measured one. A run that may not
download (`--yes` without `--pull`) takes the best installed option.

A catalog file ships with the harness. It is data, versioned with the release,
like the templates in `init.ts`, and not part of any project's surface.

```toml
# packages/gnomon-cli/catalog/models.toml
as_of = "2026-11-02"          # printed beside every recommendation
source = "ollama.com/library, sizes read on as_of"

[[model]]
tag = "qwen3:8b"
runtime = "ollama"
params_b = 8
download_gb = 5.2             # approximate, Q4
mem_gb = 7                    # weights plus a 32k-token context, approximate
tools = true                  # tool calls verified with gnomon on as_of
tier = "small"

[[model]]
tag = "qwen3.6:35b"
runtime = "ollama"
params_b = 35
active_b = 3                  # MoE: speed follows active parameters
download_gb = 24
mem_gb = 30
tools = true
tier = "large"
```

The entries above are illustrative. The real file records each figure as read
on its `as_of` date, and each model as verified with gnomon's own smoke turn.

**Memory budget**, from the probe:

| Hardware | Budget | Label shown |
|---|---|---|
| Discrete GPU(s) | sum of VRAM, minus headroom | "on the GPU" |
| Unified (Apple Silicon, GB10) | a fraction of RAM, below the OS's GPU limit | "unified memory" |
| CPU only | a smaller fraction of RAM | "on the CPU: slow, the speed check decides" |

The fractions live in the catalog file, not in code, so they are dated and
reviewable with the model list.

**Ranking.** Installed beats new.
1. Installed, fits the budget, and the catalog knows it can call tools.
2. Installed and fits, but unknown to the catalog. Offered, marked "not verified".
3. Not installed, fits, in the catalog: offered as a pull, with its size.
4. Installed but over budget: shown, marked "partly on the CPU: slower".

The fixed 70B ceiling in `detect.ts` becomes the budget. On a GB10 with
121.6 GiB, a 122B mixture-of-experts model fits and may be quick; on a 16 GB
laptop a 14B dense model may not.

**Honesty about staleness.** Model names go stale within months. Every
recommendation prints the catalog date. A catalog older than 180 days adds:
`catalog from 2026-11-02 — newer models likely exist; see ollama.com/library`.
The catalog is never fetched from the network automatically. `--catalog FILE`
uses a newer one explicitly.

### 4. Consent-gated pull (implemented; `--yes` narrowed, see the decisions above)

```
  Recommended for this machine (catalog 2026-11-02):
    qwen3.6:35b   ~24 GB download, ~30 GB in memory   not installed
  Disk free where Ollama keeps models: 410 GB
  Pull it now? This downloads ~24 GB.  [y/N]
```

- Pull only on an explicit `y`. The default is no. Nothing is ever downloaded
  automatically, and never during `init` or `launch` without the prompt.
- Pulls go through Ollama's own `POST /api/pull` on `127.0.0.1:11434`, with
  its progress shown. LM Studio, llama.cpp and vLLM manage their own models:
  the wizard prints the command for them and pulls nothing.
- The disk check reads `OLLAMA_MODELS`, or the platform default. When it
  cannot tell, it says so rather than guessing.
- Scripted installs: `gnomon setup --yes --pull qwen3.6:35b`. `--yes` alone
  pulls the top recommendation. `--no-pull` never pulls.
- Non-interactive without `--yes`: print the exact `ollama pull …` command
  and exit **4** (`preconditions_unmet`). Never download.

### 5. Speed smoke check, and the mode it suggests (implemented; control waits for #102)

As built: the request carries the project's `system.md` (the scaffold's when
there is no surface yet) and "Reply with OK.", not the tool schemas. A cloud
model in the surface or added at setup makes the suggestion hybrid, citing
R1H. Hybrid is written as `frontier_plan` with `coordinator` and `plan` on
the cloud model, R1H's PC arm.

After a model is chosen, offer one short measurement: `Run a ~10 s speed
check on qwen3.6:35b? [Y/n]`. It loads the model, so it asks first.

- **One request.** The scaffold's real system prompt and tool schemas, which
  is what a first turn sends, plus "Reply with OK". Temperature 0, at most 64
  output tokens.
- **Rates come from the server's own timings** where it reports them: Ollama's
  `prompt_eval_*` and `eval_*`, llama.cpp's `timings`. Load time is reported
  separately. A server with no timings gets wall-clock time, marked approximate.
- Results: prefill tokens/s, generation tokens/s, load seconds.

The check **suggests**. It does not decide.

| Measured | Suggestion | Written as |
|---|---|---|
| Fast enough for every role | **local only** | `role_profile = "local_first"` |
| Usable, but slow, or the largest model that fits is small | **hybrid**: local implementor, cloud planner and/or cloud rescue | `role_profile = "frontier_plan"`, plus `[roles.implementor.escalate]` with a control mode |
| Too slow, or nothing useful fits | **cloud first** | `role_profile = "all_remote"` |

The thresholds start as provisional values in the catalog file. They are
calibrated from the R1 and R3 runs before they are called anything else. All
three profile names are already published enumerations, so no new name is
needed.

**Hybrid control: off / observe / ask / auto.** Hybrid with the user in
control is gnomon's core promise. One `control` key per escalation block
(PR #102), following the `[routing] mode` pattern:

| `control` | What happens at a trigger | Records |
|---|---|---|
| `off` | nothing; the block is inert | none |
| `observe` | no switch; the turn ends as it would have | `escalation` with `applied: false`: what it would have done, and why |
| `ask` | the loop pauses: `escalate> stalled at step 14 — hand this turn to <model> at openrouter? [y]es / [a]lways this session / [N]o` | `escalation` with `decision` and `by: "human"` |
| `auto` | PR #102 as written | `escalation` with `by: "rule"` |

- **"Ask" means the user approves each switch.** Over ACP it is a
  `session/request_permission` of kind `switch_mode`, the same shape the role
  suggestion already uses.
- **Off a terminal, `ask` does not switch.** It is recorded as declined
  `by: "default:no-operator"`, as an approval is. `--yes` approves writes; it
  does **not** approve spending on a cloud model (see open question 5).
- **`fallback` stays automatic.** It is an outage path for one call, not a
  quality decision. It is announced and recorded as today.
- **The wizard writes `observe` by default** for a new hybrid setup. The
  user moves to `ask` or `auto` once the observe records show the triggers
  fire when they should. That is the evidence the hybrid hypothesis needs:
  how well a trigger predicts failure.

### 6. Determinism and Rule 1 (implemented, with question 9 answered "gitignored facts")

As built, the committed block is three comment lines at the top of
`roles.toml`, with no hardware and no date:

```toml
# Set up by `gnomon setup` (catalog 2026-11): qwen3.6:35b on this machine for every role.
# gnomon-setup: {"v":1,"catalog":"2026-11","local":"qwen3.6:35b","small":"qwen3.6:35b","cloud":null,"mode":"local_only"}
# Machine facts stay in .gnomon-setup.json beside .gnomon/ (gitignored); `gnomon doctor` compares them with this machine.
```

Doctor's exits are 0 nothing needs attention, 1 something does (drift, a
model that does not answer, a model that will not fit, no surface), and 10
could not run. Setup does not have `--reprobe`: running setup again is the
re-probe, and it proposes a diff the same way.

- **Detection runs only at setup:** in `gnomon setup`, and in `init` and
  `launch` when they scaffold. A session never probes, and nothing routes on
  what a probe sees at run time.
- **The result is concrete tags in the hashed surface,** with a provenance
  block, as `modelNote` does today:

  ```toml
  # Detected by 'gnomon setup' on 2026-11-02 (catalog 2026-11-02):
  #   linux arm64, 20 cores, 121.6 GiB unified memory (NVIDIA GB10)
  #   Ollama with 14 models; speed check qwen3.6:35b: 41 tok/s generation
  #   suggested: hybrid, control = "observe"
  # gnomon-setup: {"v":1,"as_of":"2026-11-02","mem_gib":121.6,"unified":true,"gpu":"NVIDIA GB10","runtimes":["ollama"]}
  # Detection ran once, here. The tags below are fixed data like the rest of the surface.
  ```

  No hostname, no user name and no serial numbers: this file gets committed.
  The machine-readable line is what drift is measured against.
- **`gnomon doctor` re-probes and shows drift.** A new command, and not an
  extension of `gnomon endpoint list`. `endpoint list` answers "do the
  declared endpoints serve the declared models?". Doctor answers "does this
  machine still match what setup detected?", which includes hardware that
  `endpoint list` has no reason to know about. Doctor:
  - runs the probe and the readiness check of every role;
  - prints drift against the provenance line, for example
    `setup saw 24 GB VRAM; this machine has 8 GB — qwen3.6:35b will not fit`;
  - never writes. Exit 0 when nothing drifted, 1 when drift is reported (both
    `result`), 10 when the probe could not run.
- **Doctor never fixes anything.** It suggests `gnomon setup --reprobe`,
  which makes a **proposal**: a diff of the surface, shown in full, and
  applied only on yes. The surface hash moves only then.

### 7. Parity and the non-interactive mode

**Windows, macOS and Linux behave the same.**
- Every probe has a per-OS fake in the tests, and the Windows CI job runs the
  same suite.
- Commands are spawned without a shell. `nvidia-smi` is found on `PATH` on
  both Linux and Windows.
- Paths come from `node:path`. Written files stay LF: init already adds
  `.gnomon/** text eol=lf`.

**Non-interactive** (`gnomon setup --non-interactive`, or no TTY):
- prints the probe;
- picks the top installed recommendation;
- does not pull without `--yes`, and does not run the speed check without
  `--speed-check`;
- writes a proposal and applies it only with `--yes`.

`--json` emits one record per step, so a provisioning script can read it. The
exit codes follow CONTRACTS §1: 0 written, 4 needs consent or a runtime, 12
the chosen runtime stopped answering.

## What this will not do

- **Download, generate or spend without an explicit yes.** The probe sends no
  completion. The speed check asks first. A pull asks first and shows the size.
- **Probe anything but this machine.** Loopback only, the four ports in
  `RUNTIME_PORTS`, read-only GETs.
- **Install Ollama, drivers or CUDA.** It prints the official instructions.
- **Decide at run time from what it detects.** Detection is a setup event.
- **Silently rewrite the surface.** Doctor reports. Setup proposes. A person
  applies.
- **Write identifying details into committed files.** No hostname, user or serial.
- **Fetch the catalog from the network,** or pretend it is current.
- **Run in benchmark mode.** `--no-verify` and `--from` skip the probe entirely.

## The Six Rules, checked (Part I)

| Rule | Holds? | How |
|---|---|---|
| 1. No machine-scoped configuration | Yes, with one note | The probe result reaches behaviour only as tags written into `.gnomon/` at setup. The catalog is harness data that decides only what setup *proposes*. **Note:** the provenance comment is machine-specific bytes in the surface, so two machines running setup produce different hashes even with the same tags. That is already true of `modelNote` today, and it happens once, at setup. Open question 9. |
| 2. Every session emits a manifest | Yes | Setup and `--reprobe` move the hash only on an applied proposal. Proposals sit outside the surface, like `skills/proposed/`. |
| 3. Tool schemas are declared data | Yes | No new model tool. The probe, setup and doctor are CLI commands. |
| 4. Three buckets, no composite verdict | Yes | Doctor and setup exit within the published buckets. The speed check reports its numbers, and the suggestion is printed beside them; it is not an outcome. |
| 5. Published exit contract | Yes | `setup` (0, 4, 12) and `doctor` (0, 1, 10) are added to CONTRACTS.md with fixtures. |
| 6. Published enumerations | Yes | `control` (`off`, `observe`, `ask`, `auto`), runtime kinds (`ollama`, `lmstudio`, `llamacpp`, `vllm`) and the suggestion values (`local_only`, `hybrid`, `cloud_first`) go into `gnomon enumerations`. |

---

# Part II: the command center

## What exists today

| Piece | Where | What the UI can build on |
|---|---|---|
| ACP server | `packages/gnomon-core/src/acp.ts`, CONTRACTS §9 | A transport only. Turns run through the terminal's own `chooseTurnRole` and `runSessionTurn`. Approvals become `session/request_permission` with four options (`once`, `turn`, `session`, `no`). Roles become modes, and a role suggestion is a `switch_mode` permission. The live trace arrives as `agent_thought_chunk`, `tool_call` and `tool_call_update`. No SDK, zero dependencies. `packages/gnomon-cli/src/acp.test.ts` drives the real command with a scripted client. |
| Audit trail | `packages/gnomon-core/src/audit.ts` | Hash-chained JSONL in `.gnomon-audit/`. Kinds: `session_start`, `turn`, `chain_stage`, `tool_call`, `approval` (with `by`), `verify`, `degradation`, `check`, `trust`, `guard`, `session_end`, plus `escalation` from #102. `gnomon audit verify` checks the chain. |
| Sessions | `packages/gnomon-core/src/session_store.ts` | Snapshots in `.gnomon-sessions/`, each with the surface hash it ran under. `gnomon tui` is a read-only viewer. |
| Governance | `gnomon check`, `gnomon guard`, `gnomon trust` | `check --json` (schema `gnomon.check/1`), guard as `gnomon.guard/1` JSON, trust per (project, surface hash), stored beside the key store. |
| Skills | `packages/gnomon-core/src/skills.ts`, `docs/design/SKILL-TRIALS.md` (on its branch) | Proposals, then `skill accept` and `skill reject`. The trials design already says a UI "decides nothing the CLI could not". |
| Endpoints, keys | `gnomon endpoint add|test|list`, `gnomon key` | Keys stay outside the repository. |
| JSON output | `task --json`, `check --json`, `enumerations --json`, guard | **Not** `audit show`, `sessions`, `skill list`, `endpoint list` or `trust list`: those print text only. |

Measured costs to stay inside, all on the gx10:
- A headless turn against a fake model: **157 to 182 ms** wall, by build
  (`docs/AUDIT-2026-11-01.md`, item 23).
- A whole `gnomon guard` process: **50 to 60 ms** p50. A bare `node -e 0`
  takes 22 to 28 ms (README).
- One cold turn: gnomon **322 ms** against opencode's **1,680 ms**, on the
  same local model (`benchmarks/results/latency-2026-08-31`).
- The same audit flagged +20 to 30 ms per call from modules loaded at startup.
  A UI must not add to that.

## Placement: plain browser now; Tauri only later, if asked for

| | Plain browser (`gnomon ui`) | Tauri shell |
|---|---|---|
| Install | nothing new | per-OS bundle, signing and notarisation, an updater |
| Runtime deps | none (`node:http`) | Rust crates; WebView2 on Windows 10; WebKitGTK versions on Linux |
| Headless boxes | works over `ssh -L` or Tailscale. The gx10 itself is one. | needs a display |
| Native extras | browser notifications work on `127.0.0.1`; no tray | tray, OS notifications, deep links |
| Release cost | none | a second pipeline, during a freeze |

**Choice: a plain browser.** `gnomon ui` starts a local server and opens the
default browser. A Tauri shell can come later as a thin window over the same
server, which is opencode's arrangement. It is built only if adoption data
asks for it, and it ships as a separate download, so the CLI never carries it.

## The design

### The architecture: an ACP client plus a CLI runner

```
 browser ──HTTP+stream──▶ gnomon ui (node:http, 127.0.0.1)
                            ├─ chat:     spawns `gnomon acp`, speaks ACP on its stdio
                            ├─ actions:  spawns `gnomon <argv>` from a fixed action table
                            └─ reads:    `gnomon … --json`, and a read-only tail of .gnomon-audit/
```

- **The UI server holds no engine.** For a session it spawns `gnomon acp` and
  is an ACP client, exactly like Zed. For every other action it spawns one CLI
  command and returns its JSON and exit code.
- So "every UI action is a CLI action" is true by construction. The audit
  trail cannot tell a click from a typed command, except for the `client`
  field (below).
- **The action table is the security boundary.** The browser names an action
  (`check.run`, `skill.accept`, `trust.grant`, `proposal.accept`, …) with
  typed parameters. The server maps it to an argv. There is never a shell, and
  never an argv from the browser.
- Children are spawned as `process.execPath` plus the CLI entry script, never
  through `gnomon.cmd`. On Windows, Node refuses to spawn `.cmd` files without
  a shell, and a shell is exactly what is ruled out.
- **Secrets travel on stdin.** A key typed into the UI goes to
  `gnomon key set` on stdin, never on argv: argv is visible in the process
  list.

### No new authority

| Concern | Rule |
|---|---|
| Who is the user? | Whoever holds the per-launch token: the local account that ran `gnomon ui`, the same authority as its terminal. |
| Approvals | ACP permission options, rendered as buttons. Recorded as today (`by: "human"`). `session_start` gains `client: "gnomon-ui"` from ACP's `clientInfo`: a contract change, with a fixture. |
| Hashed files | Never written by the UI server. Changes to `.gnomon/` go through **surface proposals** (below), or through the existing accept flows (`skill accept`). |
| Trust | `trust grant` from the UI shows the same list of grants the terminal shows (`surfaceGrants`) before the button is enabled. |
| No YOLO toggle | The UI cannot set `approval = "never"`, except by a proposal to the surface like any other change. |

### Surface proposals: one accept flow for the UI and for setup

Today only skills have a propose-then-accept flow. The UI (screen 6), setup
(part 5) and doctor (part 6) all need one for any `.gnomon/` file.

- A proposal is a text patch plus the surface hash it was made against. It
  is stored in `.gnomon-proposals/<id>/`, a gitignored run directory that is
  never hashed.
- `gnomon proposal list | show ID | accept ID | reject ID`.
- `accept` refuses when the surface hash moved since the proposal was made.
  It writes an audit record `surface_accept` holding the before and after
  hashes, the files touched and who accepted, and then the hash moves.
- Patches are produced by the same line-level editing `gnomon migrate` uses,
  so comments and order survive. Writes are LF.

### Security

- **Bind 127.0.0.1 on a random port.** `--host` with a non-loopback address
  refuses unless `--allow-remote` is also given. The docs recommend `ssh -L`
  or Tailscale instead, because there is no built-in TLS.
- **Token: a one-use bootstrap, then a bearer token.** Borrowed from Hermes's
  sign-in link.
  - The browser opens `http://127.0.0.1:PORT/#k=<bootstrap>`. A fragment is
    never sent to a server and never logged.
  - The page POSTs the bootstrap once to `/auth` and receives a session token
    in the body. The bootstrap then dies: after first use, or after 60 s.
  - Every API call carries `Authorization: Bearer <token>`.
  - Streams use `fetch` with a readable body, not `EventSource`, so the header
    is always there.
  - `gnomon ui --url` mints a new bootstrap for another tab.
- **CSRF-safe by construction.** There are no cookies and no ambient
  credentials. A cross-site page cannot set the `Authorization` header without
  a CORS preflight, and the server answers no preflight.
- **DNS rebinding.** `Host` must be `127.0.0.1:PORT`, `localhost:PORT` or
  `[::1]:PORT`, or the request gets 403. `Origin`, when present, must be the
  server's own. API calls with `Sec-Fetch-Site: cross-site` are refused.
- **No CORS headers, ever.**
- **XSS.** Model output and repository text are untrusted, and this page can
  approve actions.
  - The CSP is `default-src 'self'`, with no inline script.
  - Text is inserted with `textContent`, never `innerHTML`. Markdown goes
    through a small whitelist renderer.
- **Clickjacking on approval buttons:** `frame-ancestors 'none'`.
- **The token file.** It is written only for `--url`. It lives in the
  machine-local data directory beside the key store: mode 0600 on POSIX, and
  the user's own profile directory on Windows. It is deleted on exit.

### Lean

- **Zero runtime dependencies**, like the rest of gnomon. The server uses
  `node:http`, `node:crypto`, `node:child_process` and `fs.watch`. The assets
  are hand-written ES modules and one stylesheet, with no build step and no
  framework, served from the package.
- **Lazy.** `gnomon ui` is imported only by its own dispatch case. Every
  other command loads nothing new, and the existing latency harness
  (`docs/audit-2026-11-01/latency.py`, n = 30) must show no regression.
- **Budgets,** measured on the gx10 and on the Windows CI runner:

| Budget | Target |
|---|---|
| `gnomon ui` to listening | ≤ 300 ms (one headless turn is 157 to 182 ms) |
| First screen painted, local browser | ≤ 1 s |
| Static assets, uncompressed | ≤ 150 KB in total |
| Server RSS when idle | ≤ 80 MB |
| Added to any other command | 0 ms, within the latency harness's noise |

### The six screens

Each screen lists its data source and the exact CLI each action maps to.

**1. Setup wizard.** Part I, with buttons.
- Probe and runtimes: `gnomon doctor --json`.
- Model pick: from the recommendation, with the catalog date on screen.
- Pull: `gnomon setup --pull TAG --yes --json`, streaming progress. The
  button is the consent, and it shows the size.
- Speed check: `gnomon setup --speed-check --json`.
- Mode: local only, hybrid or cloud first, and the hybrid control mode
  (off / observe / ask / auto), defaulting to `observe`.
- Write: a surface proposal, shown as a diff, accepted with
  `gnomon proposal accept ID`. Until step 8 lands, the dashboard uses
  `gnomon setup --yes --expect-proposal DIGEST`: the digest of the diff it
  showed, which setup refuses (exit 3) if the plan moved since. Implemented
  with the action table, the 428 confirmation and the stdin key path in the
  integration PR that merged #126 and #127 (CONTRACTS §17).

**2. Session.** The ACP client.
- The chat, with the live trace as it streams: thoughts, tool calls with
  their buckets, and diffs before approval.
- **Which model answered each turn,** with a local or cloud badge and the
  role. ACP carries no model today. gnomon adds it under `_meta` on
  `session/update` (`{role, model, endpoint, locality, escalated}`), using
  `isLocalEndpoint` for locality. This is a CONTRACTS §9 change, with a fixture.
- Roles appear as the modes ACP already advertises.
- Sessions from `.gnomon-sessions/`: list, open read-only, and resume through
  ACP once `session/load` is served (it is not today).

**3. Hybrid control.**
- **Ask-mode approvals:** a distinct card, separate from write approvals,
  showing the trigger, the step, from → to, and what the turn has spent so
  far. The buttons are the ACP option ids.
- **Cloud share:** cloud tokens over all tokens, per session and per day,
  from `turn` and `escalation` records.
- **`$` spent:** the provider's reported cost where it gives one, else
  declared prices (open question 6). Otherwise it shows **unknown**, never 0.
- **Observe-mode evidence:** each would-have-escalated record next to how the
  turn actually ended. This is what tells a user whether to move to `ask`.
- **Changing the control mode** is a surface proposal.

**4. Governance.**
- `gnomon check --base REV --json`, run from a button. The verdict and each
  check's findings, with the exit bucket shown as is: no composite score.
- Guard refusals: `guard` records, grouped by rule.
- The audit timeline: `gnomon audit show --json`, and a live read-only tail.
  `gnomon audit verify` is one button, showing the chain status and the
  attestation status when one is declared.
- Trust: `gnomon trust list --json`, then `grant` or `revoke`.

**5. Skills.** As SKILL-TRIALS.md describes.
- Candidates from `skill mine`.
- Trial reports, with every endpoint shown and `meets_thresholds` beside them.
- `gnomon skill accept ID --evidence REPORT` and `skill reject ID`, which write
  the same `skill_accept` and `skill_reject` records. There is no auto-accept
  button.

**6. Models, endpoints, roles.**
- `gnomon endpoint list --json`, with readiness and drift from doctor.
- `endpoint test`, and `endpoint add` with the key sent on stdin.
- Roles and profiles in a form whose output is a **surface proposal diff**.
  The user reads the diff and accepts it. The banner for the next session
  names the new hash.

### Borrowed, and not

| From | Borrow | Do not borrow |
|---|---|---|
| [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop): Electron and React over the same agent as its CLI and gateway | One engine behind every client: what the UI does shows in the CLI and vice versa. A one-use sign-in link valid for 60 s. Onboarding that reaches a first message fast, with a "choose provider later" escape. A context-usage meter. | Electron. Config, skills and memory under `~/.hermes`, which is machine-scoped and breaks Rule 1. A YOLO switch that bypasses approvals. A gateway that keeps running after the app quits. A memory graph that models the user. |
| [opencode web](https://github.com/anomalyco/opencode/issues/11616): a local Hono server, REST plus SSE, Basic auth only when `OPENCODE_SERVER_PASSWORD` is set. Its desktop app is reportedly a [Tauri 2 shell with the CLI as a sidecar](https://deepwiki.com/afuhflynn/opencode/5.1-desktop-application) (secondhand). | One server, and every surface is a client of it. A streamed event channel. A desktop app that is only a thin shell over the same server. | UI assets served from a remote origin (`app.opencode.ai`), which breaks offline and local-first use and adds a supply chain. Auth off by default. A wide CORS allowlist. |

### Against editor integration via ACP

`gnomon acp` already puts gnomon in Zed, in JetBrains IDEs, and in any ACP
client. That is the right place for coding in context, with diffs beside the
code. The command center does not compete with it. It covers what an editor
pane cannot:

- setup;
- the hybrid dashboard;
- governance and the audit timeline;
- skills and trials;
- surface proposals.

Because the UI is itself an ACP client, the two paths test each other: a
behaviour that differs between Zed and the command center is a bug in one of
them. Do both. Editor support needs no new work beyond the `_meta` model
field, which editors may ignore.

## What this will not do (Part II)

- **Add authority.** No action exists in the UI that the CLI lacks.
- **Write `.gnomon/` directly.** Only applied proposals and the existing
  accept flows do.
- **Bind beyond loopback by default,** load remote assets, or phone home.
- **Use Electron**, a frontend framework, or a build step.
- **Show a composite health or quality score.** Every bucket is shown as it
  was recorded.
- **Keep UI settings that change behaviour.** Theme and layout live in the
  browser's own storage and are cosmetic.
- **Serve several users.** It is one local account's tool.

## The Six Rules, checked (Part II)

| Rule | Holds? | How |
|---|---|---|
| 1. No machine-scoped configuration | Yes | The token, the proposals and the UI's run files are machine-local facts, not behaviour, like the key and trust stores. UI preferences are cosmetic. |
| 2. Every session emits a manifest | Yes | Sessions run through `gnomon acp`, which emits the terminal's manifest and records. Surface changes are applied proposals, with `surface_accept` naming both hashes. |
| 3. Tool schemas are declared data | Yes | The UI adds no model tool, and offers no MCP server to the session (ACP already refuses editor-supplied ones). |
| 4. Three buckets, no composite verdict | Yes | Screens show `result`, `refusal` and `apparatus_failure` per step. No roll-up score anywhere. |
| 5. Published exit contract | Yes | `gnomon ui` exits 0 on a clean stop, 4 when the port or loopback is unavailable, and 10 when it fails to launch. `proposal accept` exits 0, 3 when refused because the hash moved, or 4. Every action returns the child's exit code unchanged. |
| 6. Published enumerations | Yes | The UI action names, the proposal states (`open`, `accepted`, `rejected`, `stale`) and `client` values are published. |

---

## Implementation plan

Each step is one PR, with a test that fails on master first. Windows parity
is a requirement of every step: the step's tests run in the existing Windows
CI job on `windows-latest`.

**Part I**

1. **Probe and runtime discovery (this PR).** `probe.ts`, shown in `init`
   and the launch picker; skipped under `--from` and `--no-verify`.
   - Fails first: the module does not exist on master. 30 fake-host tests cover:
     - GB10's `[N/A]` reported as unified memory;
     - Apple Silicon through `sysctl`;
     - Windows with `nvidia-smi`, and without it at the 4 GB `AdapterRAM` cap;
     - AMD through `rocm-smi` and through sysfs;
     - no GPU, `ENOENT`, a failing driver and a timeout;
     - each runtime refused, timing out, or listing models.
2. **`gnomon doctor`.** Read-only: probe, readiness and drift against the
   provenance line.
   - Fails first: a surface whose provenance says 24 GB VRAM, on a fake host
     with 8 GB, makes doctor exit 1 and name the drift, while the surface
     hash is byte-identical before and after.
3. **Catalog and recommendation** (pure functions over the probe and the catalog).
   - Fails first:
     1. a GB10 fake with `qwen3.6:35b` installed recommends the installed
        model and offers no pull;
     2. a 16 GB CPU-only fake gets a small model and a cloud-first note;
     3. a catalog dated over 180 days back prints the staleness line.
4. **`gnomon setup`** with the consent-gated pull, `--yes`, `--pull`,
   `--no-pull`, `--json` and the exit contract.
   - Fails first, against a fake Ollama that counts `POST /api/pull`:
     non-interactive without `--yes` makes zero pulls and exits 4; with
     `--yes` it makes exactly one.
5. **Speed check and the mode suggestion**, written as a proposal.
   - Fails first, with a fake server scripted to report timings:
     1. a fast rate suggests `local_first`, a middling one `frontier_plan` plus
        escalation, a slow one `all_remote`;
     2. no request is sent without consent.
6. **Hybrid control modes** on #102's `escalate` (after #102 merges).
   - Fails first:
     1. `observe` makes zero cloud calls and writes `applied: false`;
     2. `ask` with a scripted "no" makes zero cloud calls and records the
        decline;
     3. `ask` off a terminal never switches, even with `--yes`.
   - `control` enters `gnomon enumerations`.

**Part II**

7. **`--json` for the reads the UI needs:** `audit show`, `sessions`,
   `skill list`, `endpoint list`, `trust list` and `doctor`. Each schema goes
   in CONTRACTS.md with a fixture. This is useful to scripts on its own.
   - Fails first: each command with `--json` parses and matches its fixture.
     On master it prints text.
8. **Surface proposals:** `gnomon proposal`, `.gnomon-proposals/`, the
   `surface_accept` record.
   - Fails first: accepting a proposal made against an older hash is refused
     with exit 3, and the surface bytes are unchanged.
9. **`gnomon ui` skeleton:** the server, the bootstrap and bearer token, the
   Host, Origin and `Sec-Fetch-Site` checks, the CSP, the action table, the
   static assets, the browser opener, `--no-open` and `--url`.
   - Fails first:
     1. a wrong `Host` gets 403;
     2. no token gets 401;
     3. a foreign `Origin` gets 403;
     4. a bootstrap works once only;
     5. an unknown action gets 404 and spawns nothing;
     6. a non-loopback `--host` without `--allow-remote` exits 4.
   - The opener's argv is asserted per OS: `open`, `xdg-open`, and on Windows
     `rundll32 url.dll,FileProtocolHandler`, never through `cmd`.
   - The startup budgets are measured, and the latency harness shows no
     regression for other commands.
10. **Session screen:** the ACP client, plus `_meta` with model and locality.
    - Fails first: a turn answered by a cloud `fallback` carries
      `locality: "cloud"` in its `session/update`. This is a CONTRACTS §9
      fixture change.
11. **Hybrid control screen.**
    - Fails first:
      1. in `ask` mode the UI's approve maps to ACP option `once`, and the
         `escalation` record says `by: "human"` with `client: "gnomon-ui"`;
      2. an endpoint with no reported or declared price shows `$` as unknown,
         never 0.
12. **Governance screen.**
    - Fails first: the "run check" action spawns exactly
      `gnomon check --base REV --json`. The resulting `check` record equals
      the one a typed command writes, apart from `ts`, `seq`, `hash` and
      `client`.
13. **Skills screen,** after SKILL-TRIALS steps 1 to 3.
    - Fails first: accept from the UI writes the same `skill_accept` record as
      the CLI.
14. **Models, endpoints and roles screen,** through proposals.
    - Fails first: a key typed into the UI never appears in any spawned argv
      or in any log; the test inspects every spawn.
15. **A Tauri shell**, only if asked for, as a separate package that loads the
    same server.

**Benchmarks to pre-register before step 4 merges:**
- **SW1, time to the first answered turn** on a fresh machine per OS (Linux
  x86, macOS arm64, Windows 11), before and after the wizard. Measured: steps,
  wall time, and whether the first message was answered.
- **SW2, recommendation quality.** On the gx10 (GB10), the hub (RTX 5090) and
  a 16 GB laptop: does the recommended model pass the UX1 smoke turn and a
  small task set, against today's rule (the largest installed model under 70B)?
- **SW3, probe cost** on each OS. Budget: p50 ≤ 300 ms, worst case ≤ 2 s,
  zero network beyond loopback. First reading: 37 ms on the gx10 with nothing
  listening. A machine with a GPU driver that is slow to answer is the case
  to measure.
- **H-ask, trigger value:** from observe-mode records, how well each trigger
  predicts a failed turn. This decides whether `ask` earns its interruptions.
- **UI1, the startup budgets** above, and the n = 30 latency harness for
  every other command.

## Open questions for you

1. **Entry point.** A new `gnomon setup` command, also run by `launch` when
   nothing answers? Or only inside `launch`?
2. **`gnomon doctor`** as a new command (proposed), or a `--machine` flag on
   `gnomon endpoint list`?
3. **Catalog updates.** Only with releases, so it says 2026-11 until the freeze
   lifts? Or is an explicit `--catalog FILE` enough?
4. **Speed thresholds.** Ship them provisional, labelled as such, or wait for
   the R1 and R3 calibration first?
5. **Hybrid control.** One `control` per escalation block (proposed), or one
   dial in `config.toml`? And should headless runs have a separate
   `--allow-escalate`, since `--yes` should not approve spending?
6. **`$` accounting.** Provider-reported cost only, or also declared prices
   per endpoint in the surface (hashed, reviewable, but they go stale)?
7. **UI packaging.** Inside `gnomon-cli`, lazily loaded (proposed), or a
   separate `gnomon-ui` package installed on demand?
8. **Remote access.** Keep `--allow-remote` at all, or document only
   `ssh -L` and Tailscale?
9. **Provenance in the surface.** Keep hardware facts in the committed
   comment, which makes the setup-time hash machine-specific? Or keep only
   the tags and the catalog date, with the hardware facts in a gitignored
   `.gnomon-setup.json`?
10. **Default hybrid control for new setups:** `observe` (proposed) or `ask`?
