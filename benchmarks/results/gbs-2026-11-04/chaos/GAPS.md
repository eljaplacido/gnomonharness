# GBS-CHAOS 0.1: spec gaps found running gnomon v0.4.1

Each gap is a place where CHAOS.md 0.1 could not be followed as written, or where following it
depended on something the spec does not say. Nothing here was worked around silently: what was
done instead is stated, and arm R's scorecard is unaffected unless a gap says so.

**CHAOS-1. The case plan lives in code, not in the spec.** §3 says "each fault runs under the
schedules it declares", but the taxonomy table declares no schedules, task or transport per
fault. The 37-case plan exists only in `chaos.ts` (and `gnomon chaos list --json`). A peer
reading the spec cannot reconstruct the plan, and the plan hash is a hash of gnomon source.
*Done:* used `chaos list --json` as the plan (arm B) and the built-in plan (arm R); both gave
plan hash `663dfe0a…`. *Proposed v0.2:* "The normative case plan is the table in Appendix A
(fault, schedules, task, transport). An implementation's plan MUST equal it; the plan hash is
SHA-256 of that table's canonical JSON."

**CHAOS-2. The published naming patterns lose their flags.** Every pattern in `chaos.ts` is
case-insensitive (`/…/i`), but `chaos list --json` publishes `RegExp.source`, which drops the
flag. A peer compiling the published pattern verbatim scores case-sensitively. *Done:* arm B
compiles with `i` and also records what the flagless pattern would have scored (34/34 named
either way on gnomon). *Proposed v0.2:* "Each naming pattern is published as `{pattern, flags}`;
patterns are ECMAScript regular expressions matched case-insensitively."

**CHAOS-3. The lane check (§5.2) cannot be run through the interface §6 gives peers.**
`POST /chaos/case` accepts `fault`, `schedule`, `seed`; the in-process lane check needs a reply
latency (to force overlap) and a garbling control. Through `chaos serve`, a run can check
serial = concurrent only without forcing overlap, and cannot run the garbling control, so every
black-box run is void by §5 as written. *Done:* arm B ran what it could and is reported void,
as pre-registered. *Proposed v0.2:* "`POST /chaos/case` accepts `latency_ms` and
`garble_when_concurrent`; or: the lane check is a property of the endpoint build, run once per
endpoint release and cited by hash, not per harness."

**CHAOS-4. The configuration under test is not specified.** CHAOS (unlike OVERHEAD and
GOVERNANCE) does not say whether the harness runs in its default or best-effort configuration.
§6 asks only for the timeouts to be scaled. gnomon's reference surface departs from gnomon's
shipped default well beyond timeouts: `approval = "never"` (default `on_write`), `compaction =
"discard"` (default `summary`), `max_steps = 8`, `legs = 1` (12 and 8), `max_tokens = 4096`
(32768), `backoff_ms = 20` (500), tools `read`/`write` only, `[verify]` after every write with
`max_rounds = 2`. The suite's own comment says "every other value is the shipped default",
which is not accurate. *Done:* measured the reference surface as the spec's reference
implementation defines it, and list the departures here and in the result. *Proposed v0.2:*
"A run states its configuration as a hash and lists every departure from the harness's shipped
default. Permitted departures: the timeouts in §6, approval set to non-interactive, the tool set
narrowed to what the task set needs. Anything else is a separate configuration."

**CHAOS-5. In-process measurement skips a gate that users meet.** Run as `gnomon task --json`
from outside, the reference surface is *untrusted*: it grants more than gnomon's defaults
(`approval = "never"`, a `[verify]` command), so gnomon runs it clamped to the defaults and says
so on stderr, and the `fix` task cannot finish. The in-process suite calls `runTask` directly
and never meets that clamp. *Done:* arm B passes `--trust` (logged as a deviation before any
measured arm-B trial). With it, arm B agrees with arm R on every case. *Proposed v0.2:* "The
reference measurement runs the harness's CLI as a separate process, with every flag it needs
listed; in-process runs are a development aid and are labelled as such."

**CHAOS-6. "Leaked" has no time bound.** §4: "requests still open at the end of a case". The
in-process suite waits a 300 ms grace after the harness returns; `GET /chaos/log` on `serve`
reports the instantaneous count with no grace. A peer's count depends on when it reads.
*Done:* arm B sleeps 300 ms before reading, to match. *Proposed v0.2:* "A case ends 300 ms
after the harness process exits; `GET /chaos/log?end=1` applies that grace and closes what is
still open, counting it as leaked."

**CHAOS-7. One token for every case on `serve`.** §2 says tokens come from the run seed and
the case id. In-process, each (task, transport) has its own token; `serve` derives one token
from `seed` and the literal `"serve"`, used by every case. *Done:* arm B used the served token.
No effect on gnomon's verdicts. *Proposed v0.2:* "`POST /chaos/case` returns the case's token
and task inputs; the token is derived from the run seed and the case id on both paths."

**CHAOS-8. "Tokens wasted" beside "counted" compares unlike quantities.** §4 asks for wasted
tokens "reported beside what the harness's own record counted". Wasted is an excess over the
clean run, counted is a total, so the two columns do not line up. *Done:* the result reports
billed total (19,560) and counted total (16,140) over the 37 cases, and the zombie case
separately (billed 814, counted 151). *Proposed v0.2:* "Report, per case, billed and counted
totals and their difference; report wasted separately."

**CHAOS-9. The `fix` task assumes a harness-declared check.** `fix` needs "a declared check
equivalent to `node chaos/check.mjs`" whose failure the harness reports back to the model in a
later message. Harnesses with no post-write check mechanism cannot run `fix`, so
`late_system_dropped`, the only `fix` fault, cannot be measured on them (see PEER.md).
*Proposed v0.2:* "A harness without a declared-check mechanism runs `fix` with the scripted
model calling the check through the harness's shell tool; the result says which variant ran."

**CHAOS-10. The scripted model's tool-name mapping is a closed list.** The script recognises
`read|read_file|readfile|view|file_read` and `write|write_file|writefile|create_file|file_write`.
Harnesses whose file tools are multiplexed (`developer__text_editor` with a `command` argument)
or shell-only (`shell`, `apply_patch`) get a fallback name the harness never offered.
*Proposed v0.2:* "An adapter MAY declare a tool map `{read: {name, args}, write: {name, args}}`
that the endpoint loads per run; the map is published with the result."
