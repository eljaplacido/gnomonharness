# Adapter recipe: wrap any harness for Harbor / Terminal-Bench

A paired run is only as fair as its adapters. Every arm needs the same five things:
a **pinned install**, an **unattended invocation**, a **deadline it can see**, a
**record that survives the cell**, and **model traffic through the meter**. This page
gives the shape gnomon's own adapters use. Harbor's agent API changes between
releases: pin the Harbor version you run, and check the class and method names
below against it.

## 1. The adapter class

Harbor runs an *installed agent*: a class with an `install()` step and a `run()`
step, loaded by import path.

```bash
harbor run --dataset {{task-set}}@{{version}} --agent-import-path my_adapter:MyHarness \
    -m openai/{{model}} --ak base_url=http://{{relay-host}}:4010/v1 ...
```

```python
# my_adapter.py: the shape, not a drop-in. Names follow Harbor's installed-agent API.
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.capabilities import AgentCapabilities

class MyHarness(BaseInstalledAgent):
    # Without this, Harbor refuses `--ak base_url=...`, and the arm cannot be pointed at the relay.
    capabilities = AgentCapabilities(base_url=True)

    @staticmethod
    def name() -> str:
        return "my-harness"

    def get_version_command(self) -> str | None:
        return "cat $HOME/.my-harness-release"      # written by install(); recorded per trial

    async def install(self, environment) -> None:
        await self.exec_as_agent(environment, command=install_command(PIN))   # §2

    @with_prompt_template
    async def run(self, instruction, environment, context) -> None:
        await self.exec_as_agent(environment, command=run_script(instruction), env=model_env())  # §3-§6
```

An arm is **data**, not code: keep one adapter class for every arm of a harness and
put the arm's single setting in a config file whose hash goes into the record.

## 2. Install, pinned by SHA256SUMS

Install exactly what a user would get from the release, and refuse anything else.

```bash
set -euo pipefail
mkdir -p "$HOME/rel" && cd "$HOME/rel"
curl -fsSLO "$BASE/v$VERSION/SHA256SUMS"
echo "$SUMS_SHA256  SHA256SUMS" | sha256sum -c -            # the sums file itself is pinned
for f in $ARTIFACTS; do curl -fsSLO "$BASE/v$VERSION/$f"; done
# Count the OK lines: --ignore-missing would accept a file the sums do not list.
test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c ': OK$')" = "$N_ARTIFACTS"
npm i -g ./*.tgz                                             # or the harness's own installer, from these files
test "$(my-harness --version | tail -1)" = "$EXPECTED_VERSION_STRING"
echo "my-harness $VERSION $(sha256sum SHA256SUMS | cut -c1-16)" > "$HOME/.my-harness-release"
```

- Any mismatch fails the install, and the cell is an **apparatus failure** (invalid,
  re-run), never a capability result.
- `BASE` may point at a local mirror of the same files: the hashes make the source
  irrelevant and remove a network dependency from every cell.
- For gnomon, the release assets are the four npm tarballs (`gnomon-core`,
  `gnomon-natives`, `gnomon-tui`, `gnomon-harness`, each `-<version>.tgz`) plus the
  native archive for the platform, all listed in the release's `SHA256SUMS`
  (`scripts/install.sh` makes the same check). Check `gnomon --version` against the
  build stamp you pinned.
- For a harness that only ships through a package registry, pin the exact version and
  the tarball's integrity hash (`npm view <pkg>@<v> dist.integrity`, a wheel's sha256),
  never a tag such as `latest`.

## 3. Unattended, non-interactive flags

Nobody is there to answer a prompt. A harness waiting for approval does not run slowly:
it scores zero, and the "result" measures the prompt.

- Give every arm the flags its documentation gives a CI user for an unattended run, and
  publish them with the configuration. For gnomon: `gnomon task "<instruction>" --yes --json`,
  plus `--trust` (or `GNOMON_TRUST=<surface hash>`) when the arm's surface grants more than
  the defaults; an untrusted surface otherwise runs clamped to the defaults.
- Equal permissions across arms: if one harness auto-approves everything and another
  auto-rejects what is not listed, the second is measured as a floor. Check every arm's
  permission configuration binds as intended, with a model-free forced call per rule.
- Keep the harness's exit code in a file and return 0 from the run step: the task's
  verifier decides pass or fail for every arm. (gnomon's exit carries its bucket by
  contract: 0 result, 2 refusal or deadline, 10 apparatus failure.)

## 4. Deadline handling

- One wall clock for every arm: the same Harbor agent timeout, and the same effective cap.
  Adapters have silently capped one arm before (a hardcoded 900 s against another arm's
  infinity). Assert the equality in the runner.
- Tell the harness its deadline, a margin inside Harbor's cap, so it can stop itself and
  seal its record instead of being killed. gnomon: `--deadline <seconds>` (or
  `GNOMON_DEADLINE`), which clamps tool timeouts and ends the turn with stop reason
  `deadline` (exit 2). If a harness has no such option, say so in the pre-registration.
- A capped cell is a **valid failure** (`capped = Harbor timeout or stop_reason deadline`).
  Measure the effective cap from agent start and end timestamps; do not take the
  configured value on trust.

## 5. Audit and trace on, and archived

- Turn the harness's record on for the benchmark surface: most ship with it off. gnomon:
  `[audit] enabled = true` in `.gnomon/config.toml` (and `[audit.anchor]` if you measure
  tamper evidence).
- Copy, into the cell's log directory (`/logs/agent/` under Harbor): the harness's own task
  record (gnomon: the `--json` output), its audit trail (`.gnomon-audit/`), stderr, the exit
  code, the effective configuration files, and the release line from §2. Copy the live
  trail periodically too (every ~20 s), so a killed cell still leaves its record.
- Emit a structured stop reason per cell. "Wrong", "hit the cap" and "the transport died"
  are different failures, and only one of them is the agent's.
- Archive traces with the results, not in a scratch directory.

## 6. Model traffic through the meter

- Start [relay-meter.mjs](relay-meter.mjs) on the host, bound to an address the task
  containers can reach (for example the Docker bridge gateway), **never `0.0.0.0`**, with
  `RELAY_UPSTREAM` set to the real endpoint.
- Point each arm at the relay with the harness's own base-URL setting (for gnomon, an
  `[endpoints.<name>]` block with `url = "<relay>/v1/chat/completions"`, `kind = "openai"`,
  and every role and profile pointed at it). Give the harness a **placeholder** key; set
  `RELAY_KEY_ENV` so the relay injects the real one. Containers never hold a credential.
- Attribute traffic to cells: run cells one at a time per relay and `POST /cell?id=<cell>`
  to the counters endpoint before each, or run one relay per concurrent lane. Snapshot
  `GET /counters` after each cell into its record.
- Price from a dated table (`RELAY_PRICES`). Report `responses_without_usage`: an arm whose
  traffic cannot be metered is unmetered, not cheap.
- Sampling: record what each arm sends (`temperature`, `top_p`, `max_tokens`). If two arms
  differ in sampling, that is a second variable.

## 7. Before the first measured cell

1. **Wire test**: run each arm's real cell script against a scripted fake model and check
   the request bodies carry exactly what the arm declares (and the control does not), and
   that the record, trail and build line land where the runner reads them.
2. **Contamination check**: grep every task image for leaked oracles (a `COPY .` that ships
   the solution or the hidden tests). Exclude a contaminated task from every arm.
3. **Oracle check** on your platform: some tasks fail their own reference solution on some
   architectures. Exclude those from every arm.
4. **Resource guards**: cells that share a host, a GPU or an endpoint contend with each
   other. Cap concurrent cells, add a memory watchdog that marks a cell invalid (not
   failed) when it intervenes, and serialise anything that shares a local model server.
   Clean up leaked container networks between waves.
5. **Validity checks per cell**, from §6 of the pre-registration: the build line matches the
   pin, the verifier produced a reward, at least one model response carried usage, and the
   arm's mechanism checks passed. Apply the same checks to every arm.

## 8. Checklist per harness

```
[ ] install(): pinned SHA256SUMS hash, every artifact checked, --version checked, release line written
[ ] run(): unattended flags published; trust/permission configuration binds (forced-call check)
[ ] deadline passed to the harness inside Harbor's cap; same cap for every arm, asserted
[ ] audit/trace on; record, trail, stderr, exit code, config and release line copied per cell
[ ] base URL -> relay; placeholder key in the container; relay injects the key
[ ] wire test passed on the pinned build; contamination and oracle checks done
```
