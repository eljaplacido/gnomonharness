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
| Loosening its own rules (`.gnomon/`, host hooks, `core.hooksPath`, CI) | the `surface`, `host_hooks`, `git_hooks` and `ci_path` rules; the content-hashed surface; `/allow` never settable by the agent | `security test`: `self_modification`, `ci_tamper`; surface-fidelity 14/14 | `ci_path` comes with `[governance]` |
| A hostile repository's grants | workspace trust: a surface granting more than the scaffold runs clamped until this machine's user accepts it | `trust.test.ts`; `gnomon security` (`trust`) | Accepting is a person's decision; `--trust` accepts for one run |
| An ask that nobody sees (`bypassPermissions`) | the guard denies what it would have asked | `security test`: `unattended_host` | Only for a host that asks its hook; a disabled hook decides nothing (`gnomon guard status` finds it) |
| Erasing or forging the record | the `record` rule; hash-chained trails; the record guard (`record_tamper`); `[audit.attest]` signed heads; `[audit.anchor]` witnesses | `security test`: `audit_tamper`; `governance-model-free` T0b/T0c; `gnomon audit verify` | A chain alone does not stop a full re-chain: attest or anchor it |
| Success claimed without doing the work | `[verify]` with fail-first, the completion and finish gates, `check` | silent-success 0/11, fault-disclosure 8/8, degradation-contract 17/17; `gnomon audit metrics` (check after the last write) | A check proves what it tests, nothing more |
| Repository content sent where it should not go | roles name their endpoints in the hashed surface; the opt-in `[compliance] allowed_regions` refuses undeclared regions | `gnomon compliance dataflow`; `residency.test.ts` | A declared region is the operator's statement; MCP servers and `webfetch` are outside the rule |
| Supply chain | zero third-party runtime dependencies; npm provenance | SECURITY.md, "Verifying what you installed" | The toolchain that builds the release |

## Non-goals

- A sandbox that is a virtual machine. `exec = "os"` and `"docker"` contain
  a shell, and the gaps are listed in THREAT-MODEL-EXEC.md.
- Detecting prompt injection in text. gnomon limits what an injected
  instruction can do. It does not try to recognise the instruction.
- Judging whether code is correct. Checks, tests and gates decide that,
  never gnomon's own reading of the model's prose.
- Compliance. `gnomon compliance` maps evidence to controls. It never says
  compliant.

## Checking it yourself

```bash
gnomon security            # the posture: what is contained, what is not
gnomon security test       # the attack corpus against this surface
gnomon audit verify        # the record's hash chains (and anchors, if declared)
gnomon compliance dataflow # where data can go
```

The model-free suites under `benchmarks/` (`governance-model-free`,
`surface-fidelity`, `silent-success`, `fault-disclosure`,
`degradation-contract`) and `gnomon chaos` run without a model or a key.
