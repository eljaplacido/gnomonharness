# Skill attribution in the trace and audit trail

**Status:** implemented (v0.6.6, unreleased)
**Related:** `docs/design/SKILL-TRIALS.md`, CONTRACTS.md §11, §12, §52
**Origin:** operator request: "it would be useful that CoT shows the skills it calls and uses as well"; first drafted in a lab session.

## Problem

gnomon already surfaced skills per turn (`◆ skills` with the trigger word, `◆ skill`
when the model opens a file, `skill_accept`/`skill_reject` audit kinds). What was
missing is **attribution**: nothing tied a reasoning step to the skill that shaped
it, nothing showed what a skill cost in context, and nothing separated a skill that
merely *fired* from one the model actually used.

## What was built

1. **`◆ skills` row.** Each loaded skill carries its estimated context cost
   (`estimateTokens` of the block `applySkills` adds), then the total:
   `◆ skills  writing-tests ("test") ~420 tok, … · ~610 tok`. At `/cot work|full`,
   when skills exist for the role but none matched: `◆ skills  none matched · N available`.
2. **`·uses <skill>`** on the `✻` reasoning line when the reasoning contains a loaded
   (or opened) skill's id or name. Whole-word, case-insensitive; a hyphen matches a
   space; names under 4 characters and names made only of generic words are ignored.
3. **`◆ skill` rows for the `skill` tool** (`propose: name`), beside the existing row
   for a read of a skill file, so learning is visible.
4. **End-of-turn line**, only when a skill was involved:
   `◆ skills used: writing-tests (loaded ~420 tok, read 1×, cited) · proposed: x`.
   A delegated sub-turn's rides on its `↲` close line and is merged into its parent.
5. **Audit kind `skill_use`** at turn end and a `counters.skills` object on the turn
   record, both `{fired:[{name,tokens}], read:{name:n}, cited_in_reasoning:[…],
   proposed:[…]}` (the record adds `turn` and `role`). Absent when no skill was
   involved. Contract: CONTRACTS §52, fixture `conformance/skill_use.json`.
6. **`/skills`** per skill: fired / read / cited this session, tokens per firing, and
   from the audit trail total firings, cited rate, last used, latest trial verdict.
7. **`gnomon skill mine`** signals: `fires_never_cited` (loaded at least 5 times,
   never cited: tighten `match` or prune), `cited_often` (cited in at least 3 and at
   least half of firings: candidate to trial), and context cost per firing.

## The dropped self-report

The first draft carried an `outcome` field (`applied` | `considered` | `ignored`),
"a coarse self-report from the model", collected the way `skill_accept` is. It was
dropped. It contradicted the draft's own non-goal ("attribution is derived, not
requested"), it would have needed new prompt text, and our benchmarks show model
self-reports are unreliable: a model asked whether it applied a note says yes. What
remains is only what the harness sees: what was loaded and at what cost, which
files were opened, which skills the reasoning names, what was proposed.

## Non-goals

- No change to skill matching or injection order.
- No forced mention of skills in the model's output; nothing is injected into the prompt.
- No verdict that a skill "worked": that is what `gnomon skill trial` measures.

## Notes on the reading

- *Cited* is a text match, so it is evidence of attention, not of effect. A skill
  that fires and is never named stays visibly unattributed, which is the honest signal.
- A read of a skill the turn did not load (a dormant one the model opened itself)
  counts as skill activity even though nothing fired: `fired` is then empty.
- Usage signals are printed by `skill mine` and returned in its `--json`; they are
  about existing skills, so they are not written as candidate files.
