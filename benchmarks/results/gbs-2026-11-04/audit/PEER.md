# GBS-AUDIT: what a peer needs to run under this runner

Nothing here was installed or run. Trail locations and formats come from
gnomon's own transcript readers (`packages/gnomon-core/src/transcripts.ts`,
verified against real files from pinned releases on 2026-10-11 and
2026-11-01) where the repository has them. Where it does not (Codex), the entry
says so and must be checked against the pinned release before any run.

## The runner's shape, harness-neutral

`run_audit.mjs` needs four things per harness, all of them small:

1. **A session driver**: run the harness headless on a scripted task against
   `fake_model.mjs` (OpenAI chat-completions on a loopback port; it follows
   whatever tool names the request offers only if the script names them, so
   a peer needs its own step list: read, write, edit, shell). The trail must
   come from the pinned build and an ordinary session that ended normally
   (§6.1); `fake_model.mjs` is the scripted stand-in for the model.
2. **A mutation adapter** (§6.2): `load(unit) → records`, `save(unit,
   records)`, `rehash(records)` (absent when the format has no integrity
   field), `anchor_state()` (local files A3 may delete). gnomon's is
   `adapter.mjs`, ~40 lines.
3. **The documented verifier**, run as a user runs it, with its exit status
   as the verdict. A harness that documents no verifier scores every case
   **undetected, no verifier** (§6.3). That is a score, not N/A.
4. **A unit name** the scorer looks for in the verifier's output (L1), and
   the words that mean failure there (the `FAIL` pattern is gnomon's; a peer's
   verifier needs its own, published with the adapter).

What counts as **detected** for every harness: the documented verifier exits
non-zero (or sets a documented failure field) after the mutation, while the
untampered control exited zero. Anything the harness prints without a
non-success exit is reported as a text flag, not as detection.

## Per harness

| harness | trail and format | integrity field? | documented verifier | adapter | verdict |
|---|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl`, one JSON record per line; subagents under `<session>/subagents/**.jsonl` (transcripts.ts) | none known: records are not hash-chained | none known | JSONL: the same `load`/`save` as gnomon's, `rehash` absent (E2 ≡ E1, R1 ≡ E1, R2/C1 ≡ R1, K1/K2 N/A: no signer, no witness); `anchor_state` = none | **Runnable with a 20-line JSONL adapter.** Expected: every case "undetected, no verifier" unless a verifier is documented by then |
| **opencode** | Session store under opencode's data directory; the stable exchange format is `opencode export <session>` (one JSON document, `messages[].parts[]`), read from opencode 1.18.32 (transcripts.ts). The on-disk store's layout was not read by this repository and must be pinned per release | none known | none known | Mutate the on-disk store, not an export: an export is a copy, and tampering with a copy proves nothing about the record. Needs the store's layout per pinned release (JSON files or SQLite: `UPDATE`/`DELETE` ops) | **Runnable with a store adapter, after the store layout is pinned.** Expected: "undetected, no verifier" |
| **goose** | Session store is **SQLite** (transcripts.ts, read from goose 1.57.0 source); `goose session export --format json` gives `conversation: [<Message>…]` | none known | none known | SQLite adapter: `load` = `SELECT` the session's messages in order, `save` = `UPDATE`/`DELETE`/`INSERT` in a transaction; `rehash` absent; `anchor_state` = none | **Runnable with a SQLite adapter (~40 lines).** Expected: "undetected, no verifier" |
| **Codex CLI** | Not read by this repository. Codex is generally understood to write per-session "rollout" JSONL files under `~/.codex/sessions/`; **unverified here**, must be confirmed against the pinned release | unknown | none known | JSONL adapter like Claude Code's, once the path and record shape are confirmed | **Runnable with a JSONL adapter after the format is confirmed against a pinned build.** Expected: "undetected, no verifier" |

## What would make a peer's result meaningful rather than trivially zero

- If a peer documents no verifier, its row is "undetected, no verifier" for
  every case, and the suite says only that its trail can be changed silently.
  That is still a published finding (§6.3), and it takes one session and the
  adapter to show.
- If a peer ships a hook or plugin that writes its own chained log (for
  example gnomon's `guard` / `check` attached through hooks), that is the
  hooked arrangement, and its trail is gnomon's, not the peer's: report it as
  "gnomon's trail, carried by <peer>", never as the peer's own auditability.
- The A3 rows need a witness only if the peer anchors anything off the
  machine. None of the four is known to.

## Fault-injection point and adapter shape, in one line each

- Injection point: the trail at rest, after the session ended, before the
  verifier runs. No network or model involvement.
- Adapter: `load/save/rehash/anchor_state` over the peer's real store, plus the
  verifier command line and its failure words. Published with the result.
