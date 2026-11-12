# Model-free governance suite

`gnomon guard` fed hook payloads directly: no model, no harness, no network. It
checks the policy layer that `docs/GOVERNING-OTHER-HARNESSES.md` describes, from the
outside, through the real CLI of this checkout.

| Script | What it checks |
|---|---|
| `t0_guard_payloads.sh` | forbidden calls in Claude Code's hook format and the generic format: deny, ask, allow; bypassPermissions turns ask into deny; the trail is written; install + status |
| `t0b_tamper_probes.sh` | calls an agent could make to switch the guard off or blind it (`GATE=never` for an unattended gate) |
| `t0c_indirect_tamper.sh` | the path a command filter cannot see: write a script, then run it; `guard status` reports the result |
| `t0d_levels.sh` | one denied call at observe, advise, prevent and enforce; `delivered: false` at advise |
| `t0e_host_tools_liveness.sh` | MCP/WebSearch/Agent at each level, install refusing an unusable gnomon, liveness, the scorecard |

```bash
GT=$(mktemp -d) bash benchmarks/governance-model-free/t0_guard_payloads.sh
```

Sandboxes and outputs go under `$GT` (default `$TMPDIR/gnomon-gov-suite`). `t0c`
really runs the two calls when the guard allows them, inside its sandbox.
Results from the 2026-11-12 run (the live arms against Claude Code, opencode, pi and
mini-swe-agent are not reproduced here) are summarised in
`docs/GOVERNING-OTHER-HARNESSES.md`.
