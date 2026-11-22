# Threat model

This is one page tying each threat gnomon takes on to the control that
answers it, the test or benchmark that shows the control holds, and the limit
past which it does not.
- How to report a vulnerability, and the supported versions:
  [SECURITY.md](../.github/SECURITY.md).
- The command-execution boundary in depth:
  [THREAT-MODEL-EXEC.md](THREAT-MODEL-EXEC.md).
- Every network destination: [PRIVACY.md](PRIVACY.md).

gnomon claims tested properties, never "secure". Each row below names its
evidence, so the claim can be checked rather than believed.

## What is protected

| Asset | Why it matters |
|---|---|
| The developer's machine outside the project | an agent's shell runs with the developer's permissions |
| Credentials: provider keys, `.env`, `~/.ssh`, cloud configs | the process holds provider keys and a shell |
| The rules the agent is judged by: `.gnomon/`, host hook settings, CI | an agent that can loosen its own rules has no rules |
| The record of what happened: `.gnomon-audit/`, `.gnomon-trials/` | evidence that can be edited afterwards is not evidence |
| Where repository content goes | prompts carry source code and whatever the agent read |

## Who the adversary is

1. **A mistaken model**: a correct-intent agent that deletes, overwrites or
   reports success it did not achieve.
2. **An injected model**: instructions planted in a file, an issue, a web
   page or a tool result that the agent then follows.
3. **A hostile repository**: a cloned project whose `.gnomon/` grants
   itself more (bash everywhere, a remote endpoint, an MCP server, an anchor
   command).
4. **Another harness's agent** (Claude Code, opencode, Cursor), governed
   through `gnomon guard`. `gnomon security test` runs the corpus in each
   one's hook input. Cursor gives no hook before a file write, so its writes
   are judged afterwards by `gnomon check`.
5. **Someone with write access to the records**, after the fact.

Out of scope: a compromised operating system, kernel or Node runtime; a
malicious gnomon binary (see "Verifying what you installed" in SECURITY.md);
the model provider's own handling of what it is sent.

## Threats, controls, evidence, limits

| Threat | Control | Evidence | Limit |
|---|---|---|---|
| Destructive commands (`rm -rf`, `find -delete`, interpreter deletes) | `bash_deny` / `bash_allow`, the approval gate, `exec = "os"` or `"docker"` | `gnomon security test`: `destructive`; `governance-model-free` T0 | Code an interpreter runs is gated as a command, not parsed: it is asked about, not refused |
| Exfiltration over the network | `[sandbox] network = false`, the `network` rule, a seccomp and connect supervisor under `exec = "os"`, `--network none` under docker | `security test`: `exfiltration`; `gnomon-exec sandbox-probe` | `webfetch` has a narrow DNS-rebinding window (SECURITY.md); unix sockets are not restricted by `exec = "os"` |
| Reading or planting secrets | `secret_path` under `[governance]`, `reads = "scoped"` under `exec = "os"`, keys kept outside the surface | `security test`: `secrets`; `governance-model-free` T0 | Without `[governance]` declared, `.env` is an ordinary file; without `reads = "scoped"`, reads outside the root are not confined. The shell check reads words: interpreter code and paths built at run time are not refused, so a secret inside the working tree is contained only by keeping it out (CONTRACTS.md §37). A word check cannot see interpreter code or a path built at run time (`python3 -c "open('.env'+'.x')"`, #227): under `exec = "docker"` a declared in-root secret is hidden by an empty mount; under `exec = "os"` at `prevent` the session refuses to start while one is in the root (`[governance] secrets_in_root = "allow"` accepts the risk, recorded); on the host (`exec = "off"`) it stays readable by any interpreter the role may run (`gnomon security`: `secrets_in_tree`) |
| Writing outside the project | path containment on real paths, the `outside_root` rule, Landlock under `exec = "os"` | `security test`: `outside_root` | Host execution (`exec = "off"`) relies on the rules, not the kernel |
| Loosening its own rules (`.gnomon/`, host hooks, `core.hooksPath`, CI) | the `surface`, `host_hooks`, `git_hooks` and `ci_path` rules; the content-hashed surface; `/allow` never settable by the agent | `security test`: `self_modification`, `ci_tamper`; surface-fidelity 15/15 | `ci_path` comes with `[governance]` |
| A hostile repository's grants | workspace trust: a surface granting more than the scaffold runs clamped until this machine's user accepts it | `trust.test.ts`; `gnomon security` (`trust`) | Accepting is a person's decision; `--trust` accepts for one run |
| An ask that nobody sees (`bypassPermissions`) | the guard denies what it would have asked | `security test`: `unattended_host` | Only for a host that asks its hook; a disabled hook decides nothing (`gnomon guard status` finds it) |
| Erasing or forging the record | the `record` rule; hash-chained trails; the record guard (`record_tamper`); `[audit.attest]` signed heads; `[audit.anchor]` witnesses | `security test`: `audit_tamper`; `governance-model-free` T0b/T0c; `gnomon audit verify` | A chain alone does not stop a full re-chain: attest or anchor it |
| Success claimed without doing the work | `[verify]` with fail-first, the completion and finish gates, `check` | silent-success 0/11, fault-disclosure 8/8, degradation-contract 17/17; `gnomon audit metrics` (check after the last write) | A check proves what it tests, nothing more |
| Repository content sent where it should not go | roles name their endpoints in the hashed surface; the opt-in `[compliance] allowed_regions` refuses undeclared regions | `gnomon compliance dataflow`; `residency.test.ts` | A declared region is the operator's statement; MCP servers and `webfetch` are outside the rule |
| Supply chain | zero third-party runtime dependencies; npm provenance | SECURITY.md, "Verifying what you installed" | The toolchain that builds the release |
| A sandbox that does not hold on this machine (docker socket mounted, privileged container, shared namespaces, a writable host path, `/proc/sys` or cgroup writable, a canary outside the root readable or writable) | `gnomon security test --sandbox`: non-destructive configuration and containment probes per sandbox level, reported as pass / FAIL / open | `sandbox_probes.test.ts`; conformance/sandbox_probes.json; the matrix below | Probes check configuration, never exploit: kernel flaws, runtime CVEs and side channels are not tested, and docker is a shared-kernel container (no microVM or gVisor backend) |
| An attack spread over many ordinary steps (a credential read now, an upload forty steps later; a file written, made executable, run; a refusal retried through another tool) | `gnomon audit scan`: offline, deterministic, advisory trajectory rules over gnomon trails and the cross-harness guard feed | `audit_scan.test.ts`; conformance/audit_scan.json (synthetic trails, false-positive guards) | Advisory, after the fact, never blocking; reads each call's tool and target, so a path built at run time or code an interpreter runs is not seen; injection markers only where tool output was recorded (`record = "full"`) |

## Sandbox level x threat

Where `bash` runs and which `[sandbox] level` the tool paths use decide which
threats are answered. The survey of agent harnesses (2026) draws the same
line: isolation is a threat-model choice. An **OS-level permission boundary**
("permission, not partition": a narrowed view of the host) fits a model that is
mistaken or prompt-injected but not running hostile code; a **microVM or
user-space kernel** (Firecracker, gVisor) fits code that may be adversarial;
and **a plain shared-kernel container sits in the shrinking middle**. gnomon has
the first and the middle and no microVM or gVisor backend. Do not run code you
believe is hostile under any of these columns.

The matrix says what gnomon claims for each place a command runs. *covered*
means the claim is tested here (`gnomon security test --sandbox`) and its limit
is small enough to state in a line; *partially* means the main path is closed
and a named path is open; *not covered* means gnomon does not claim it. The
columns are the `[sandbox] level` for the tool paths (`read`, `write`, `edit`;
`confined` and `strict` behave alike here) and `exec` for `bash`.

| Threat | tools: level off | tools: level confined / strict | bash: exec off | bash: exec os (reads all) | bash: exec os, reads scoped | bash: exec docker |
|---|---|---|---|---|---|---|
| File escape (read or write outside the project root) | not covered | covered | not covered | partially | covered | covered |
| Network (egress with `network = false`) | not covered | not covered | not covered | partially | partially | covered |
| Process (host processes, signals, namespaces) | not covered | not covered | not covered | partially | partially | covered |
| Credential (`~/.ssh`, cloud and token files outside the root) | not covered | covered | not covered | partially | covered | covered |
| Container breakout (privilege, docker socket, mounts, `/proc/sys`, cgroup, kernel) | not covered | not covered | not covered | not covered | not covered | partially |

What each cell leaves open, so the words above are not read as more than they
are:

- **tools, confined / strict** govern the tool paths only. `bash` is not
  governed by the level at all (README, "The level governs tool paths, not
  `bash`"). A symlink out of the root is refused (probed).
- **exec off** runs the shell as you. Pattern checks and the guard's rules
  catch what a command's text names; nothing contains it. Every probe that can
  escape does, and the report says `open`.
- **exec os, reads all**: writes outside the root, the docker socket and
  non-loopback network are refused (probed). Reads are not confined (any file
  your user can read, secrets in `$HOME` included), loopback is open by design (a
  local service that itself reaches the network is reachable), and host PIDs
  and namespaces are shared. Key variables are scrubbed from the environment,
  which is why the credential row says *partially* and not *not covered*. The
  Landlock/seccomp boundary is permission, not partition: same kernel.
- **exec os, reads scoped** adds read confinement: a canary and a fake
  credential outside the root are unreadable (probed). The network and process
  limits above stand, as do the ones in `gnomon-exec sandbox-probe`
  (`not_enforced`), such as metadata calls (chmod, utime) outside the root.
- **exec docker** (default `network = false`): own PID and network namespaces,
  no capabilities, `no_new_privs`, only the project root mounted writable, no
  docker socket, `/proc/sys` and cgroup read-only (all probed). *Partially* for
  breakout because the kernel is shared: a kernel or runtime flaw is outside what
  gnomon can test or claim, and `network = true` reopens egress.
- Under every column, a secret **inside** the project root is contained only by
  keeping it out (CONTRACTS.md §37, `gnomon security`: `secrets_in_tree`).

`gnomon security test --sandbox` runs the probes behind the matrix and reports,
per level, `pass` (claimed and held), `FAIL` (claimed and did not hold on this
machine: exit 2), `open` (not claimed: the documented limit, shown again) or
`skipped` (docker, Landlock or a tool was not available; the reason is
printed). The probes are configuration and containment checks only: they run
no exploit and attempt no breakout, they touch only a temp directory and
canaries the test creates, and they need no root.

## Trajectory-level detection

A per-call guard cannot see an attack spread over steps that are each ordinary.
`gnomon audit scan <trail|dir>` reads trails offline, deterministically, and
looks for: a credential read followed later by network, a write outside the
project or an encoding step (slow exfiltration); a file written, made
executable, then run (staged payload); the same kind of call refused again and
again with variations (privilege creep); credential locations probed across
tools; an instruction-like marker in recorded tool output followed by a risky
action; and guard evasion (a `cd` out of the root, a symlink out then a write
through it, a refusal retried through another tool). It reads gnomon session
trails and the guard feed of other harnesses, and a metadata-only trail is
enough for every rule but the marker one. It is advisory: a finding is a place
to read, never a verdict, and nothing is blocked. Its false-positive rate on
this repository's own benchmark trails is reported with the change that added
it (CHANGELOG), not assumed.

## Non-goals

- A sandbox that is a virtual machine. `exec = "os"` and `"docker"` contain
  a shell, and the gaps are listed in THREAT-MODEL-EXEC.md.
- Detecting prompt injection in text, inline. gnomon limits what an injected
  instruction can do. It does not try to recognise the instruction before the
  model sees it. (`gnomon audit scan` does match a short list of instruction-like
  phrases in recorded tool output after the fact, to find a risky action that
  followed one. That is a pointer for a reader, not a defence.)
- Judging whether code is correct. Checks, tests and gates decide that,
  never gnomon's own reading of the model's prose.
- Compliance. `gnomon compliance` maps evidence to controls. It never says
  compliant.

## Checking it yourself

```bash
gnomon security            # the posture: what is contained, what is not
gnomon security test       # the attack corpus against this surface
gnomon security test --sandbox # plus the sandbox-escape probes, per sandbox level
gnomon audit scan          # multi-step patterns in this project's audit trails
gnomon audit verify        # the record's hash chains (and anchors, if declared)
gnomon compliance dataflow # where data can go
```

The model-free suites under `benchmarks/` (`governance-model-free`,
`surface-fidelity`, `silent-success`, `fault-disclosure`,
`degradation-contract`) and `gnomon chaos` run without a model or a key.
