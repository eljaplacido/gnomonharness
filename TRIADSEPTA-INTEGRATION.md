# Being pinned by TriadSepta — what this harness owes, and what it must never take on

Working notes for gnomon, kept in gnomon. Nothing here creates a dependency: every
item is worth doing for the harness on its own terms, and the pin is what falls out
of doing them. If a line below only makes sense because another repository wants it,
that line is wrong and should be deleted rather than implemented.

---

## 1. What TriadSepta is, so the seam is designed against the real thing

TriadSepta is a **declaration interpreter and an envelope**, not an orchestrator, not
a runtime, and not a cluster this harness joins. It:

- pins eligible subsystems at immutable revisions,
- emits a **runbook** — the literal ordered subsystem commands, with those
  subsystems' own configuration paths, naming TriadSepta nowhere,
- records the native outcomes in a shared envelope, and
- runs a **leak gate**: it executes that runbook from a checkout where TriadSepta is
  absent and asserts the same evidence record. A run whose runbook cannot reproduce
  it carried something only the integration layer knew.

Its governing constraint is one sentence: *removing that repository must leave every
subsystem able to do everything it could do before.* Its declaration expresses
participation and pinning, never control flow — no retry, no fallback, no
continue-on-error, no skip predicate anywhere in the run path.

Two consequences for gnomon, and they are the whole relationship:

**Retry policy lives here.** If a compile should be retried, that belongs in
`.gnomon/` and in the hashed surface, because the composer is forbidden from
expressing it. What gnomon must not do is report two attempts as one clean step —
which is why every attempt is now its own recorded step.

**gnomon never imports, calls, or requires TriadSepta.** One direction only. A
harness that reaches back is a second integration layer, and it breaks the governing
constraint in the direction nobody is watching.

---

## 2. The seam, in full

A composition would name gnomon in its `executor` port. Every leaf is one of the four
kinds TriadSepta's grammar allows — `pin`, `ref`, `select`, `bind`:

```json
"executor": {
  "pin": {
    "location": "https://github.com/eljaplacido/gnomonharness.git",
    "revision": "<40 hex — an immutable revision, published on the remote>",
    "tree_hash": "<git rev-parse HEAD^{tree}>"
  },
  "refs": {
    "surface": { "path": ".gnomon/", "content_hash": "<gnomon surface hash>" }
  },
  "selects": {
    "role_profile": "local_first",
    "edit_format": "ast",
    "sandbox": "confined"
  }
}
```

**Rehearsed twice on 2026-08-24** — against `4edba96`, and again after the one-shot
mode landed. Both validated against TriadSepta's `triadsepta.declaration.validate`,
with `selects` checked against `conformance/enumerations_golden.json`. Neither needed
a fifth leaf kind, a new envelope field, or any change on the TriadSepta side. That
was the falsification condition the seam was designed to face, and it passed at the
declaration level.

Read the caveat with it: what validated was the *declaration*. No port implementation
invokes gnomon yet, and the `content_hash` in the rehearsal was computed by an
independent digest rather than by `gnomon surface hash`. A real pin takes that value
from this tool, or the two disagree the first time it matters.

**Eligibility, also checked the same day and passing:** TriadSepta admits a subsystem
only with a resolvable immutable revision reachable from its remote, a reachable
checkout, a documented invocation, and a passing custody check. gnomon met all four —
`master` published, no credential-bearing file in the tree, `-p` documented. Three of
those are free if you keep doing what you are doing and expensive to retrofit:

- push every revision — a commit that exists on one machine cannot be pinned by
  anyone;
- keep the invocation documented and stable;
- never let a `.env`, a key, or client material into the tree. A tree hash over a
  checkout that carries one is itself a disclosure.

---

## 3. The invocation is a contract now

```bash
gnomon -p "<task>" [--role <role>] [--json] [--dir <repository>]
```

Writes a session record under `sessions/`, prints it with `--json`, and exits with
the native value of its last step. Four things about it are load-bearing for anyone
pinning this harness, and none may change quietly:

1. **The exit table** (`conformance/exit_codes.json`). An integer never gets
   redefined. `12` is a provider that could not be reached — an apparatus failure,
   excluded from denominators, and *not* a task the agent failed or refused.
2. **`--dir` names the repository**, and `.gnomon/` is resolved beneath it.
3. **The session record** carries the manifest, the ordered steps, and — since
   contracts `0.2.0` — `environment`, `tool_surface` and `policy`. A consumer reads
   `tool_surface.enforced` to learn whether the hashed tool list was actually in
   force on that run.
4. **Nobody is at the terminal.** A call the approval gate would have asked a human
   about is refused and recorded as `3 refused_by_gate`. A repository that wants
   unattended runs declares `approval.gate = "never"` in `.gnomon/policy.toml`, where
   the decision is hashed and reviewable — not in a flag, which would put it back on
   the machine.

Changing any of these is a breaking change for every pin that already names a
revision. That is the same discipline as a lockfile, and it is the reason to keep the
surface small.

---

## 4. Open items here, in the order they matter

Each is a gap in the harness first; the pin consequence is why it is not cosmetic.

**Closed since this file was first written**, and worth naming because both were
blockers: the tool loop now offers the declared tools to the provider, executes them
under the sandbox and the approval gate, and the selects in `policy.toml` are read
rather than merely hashed. `tool_surface` and `policy` on a session record now report
what was actually in force instead of a standing `false`.

| # | Item | Why it is not cosmetic |
|---|---|---|
| 1 | **One hasher, or a proven agreement between two.** The Rust binary and `recomputeManifest` in TypeScript both hash the surface, and nothing tests that they agree | A verifier that disagrees with the thing it verifies is worse than no verifier. Add a conformance case that runs both over `conformance/fixture_tree` and compares |
| 2 | **Date the P0 spike, or supersede it.** It concludes *extend* and no `pi` package is imported | The base posture is the largest single architectural claim this repository makes, and it is recorded on paper only |
| 3 | **Byte-identical runbook emission** (`gnomon-surface runbook`) | Useful long before any integration — it is how you re-run yesterday's session against a different checkout. It also has to refuse absolute paths that name one machine |
| 4 | **`skills/` and `extensions/` in the surface.** The layout names both; neither exists yet | Absence is part of the hash, so adding them later moves every surface hash. Better to decide now whether they are in |
| 5 | **Fewer machine-scoped variables, not more.** `GNOMON_MODEL_URL`, `GNOMON_MODEL_TIMEOUT_MS`, `GNOMON_BIN_OVERRIDE` all change behaviour and none is in the hash | Recording them makes them visible, not harmless. `roles.toml` can declare `url` per role — prefer that, and let the variable fill a gap the surface left rather than override what it states |
| 6 | **A sandbox that confines, rather than resolving paths.** `sandbox.network = false` is declared and not enforced | A select that pins a value nothing acts on is a hash covering a promise — the same defect the tool surface just stopped having |
| 7 | **Attempts, everywhere.** One-shot records each model attempt as its own step; the interactive transcript still shows the turn's worst outcome | A session that only worked on the second try is a finding, and it is one only where the first try survives |

---

## 5. What the other side owes, so nobody waits on the wrong thing

Listed only so the sequencing is legible from here. None of it is gnomon's work.

- **A declaration entry and a decision record** naming this harness at a revision,
  with the condition that would show the choice wrong.
- **An executor port** — invoke and translate, nothing else. gnomon's nine native
  values collapse onto exactly the three buckets TriadSepta already uses, so this is
  the rare port that loses no distinction.
- **A measurement door.** The comparison that would ask whether this harness is any
  good runs in a benchmark laboratory whose arm registry is a hardcoded list with no
  entry point. Until that opens, gnomon can be *used* as an executor and cannot be
  *compared* as one. Anyone quoting a comparison before then is quoting an apparatus
  test.
- **Findings handed back here** rather than worked around there — including the ones
  in §4.

---

## 6. The independence problem, stated before it bites

If this harness becomes both the agent that writes a repository and an arm in a
comparison about agents, the comparison is partly decided before it runs. The same
trap has already been caught three times in this portfolio: a scoring tool registered
as its own arm, a verification harness acting as both oracle and treatment, and
architectural conclusions inherited from a subsystem under test.

The mitigation is not to avoid dogfooding — dogfooding is how the gaps in §4 were
found. It is to **state on the face of any comparison which build gated the work and
which was under test**, and to keep the party that measures outside the composition
it measures. A comparison that cannot say which is which is void.

---

## 7. Repository hygiene that the pin depends on

- Push before it matters. A revision that exists only on one machine cannot be
  depended on by anything, and retrofitting that is worse than it sounds.
- Keep the tree clean of credentials, keys and client material — tracked *or*
  untracked. Custody is checked before a tree is hashed, and the ordering is the
  point.
- Keep `pnpm-lock.yaml` committed. "Same commit, same agent" is not true of the
  TypeScript half without it, and it was gitignored until 2026-08-24.
- Contract change and fixture change land in the same commit. That is already the
  rule; CI enforces it only as far as the fixtures reach.
