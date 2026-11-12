# docs/v050-sweep — release notes for the integrator

Branch `docs/v050-sweep`, from origin/master f466dfcca. CHANGELOG.md was edited
directly (the brief allowed it); this file carries what the integrator and the
owner still have to do.

## Changed (docs)

- Peer policy: November 2026 peer comparisons removed from README, EVIDENCE,
  POSITIONING, FINDINGS-2026-11-04, the GBS specs (GOVERNANCE, OVERHEAD,
  ROADMAP, README, HYBRID), CONTRACTS §30/§34/§39/§40, the AUDIT note and the
  November sections of CHANGELOG history; gnomon-only halves kept. Pre-2026-11-08
  peer figures kept and dated (2026-09-02 tie 50.0 vs 47.1; context on the wire
  4.66x, 2026-09-05; per-turn latency 2026-08-31). Every link to a public
  `bench/*` branch removed.
- Version sweep to v0.5.0 (README, GETTING_STARTED, GUIDE, RELEASING,
  SANDBOX-DESIGN, THREAT-MODEL-EXEC, HARNESS-RESEARCH-RECONCILIATION, CONTRACTS
  "v0.4.6" -> "v0.5.0", llms.txt). README quickstart: one-liner, then
  `gnomon setup` -> `gnomon dashboard` -> `gnomon launch`; npm stated as
  available from v0.5.0.
- "Composing with TriadSepta" removed; SeptaCore named as private/unreleased
  without a link (README, DESIGN).
- Benchmark conclusions (gnomon-only) in README, GETTING_STARTED, GUIDE §5.3 and
  the completion-gate/long-task notes, EVIDENCE ("What the v0.5.0
  recommendations rest on"), POSITIONING, HYBRID, llms.txt, CHANGELOG 0.5.0.
- CHANGELOG: `[0.5.0] — 2026-11-12` with the merged-PR list (#161–#169,
  #171–#175), 0.4.4/0.4.5 marked never published, compare link
  v0.4.3...v0.5.0, and a "### Merged for the release" placeholder list.

## Added

- `site/` — gnomonharness.com source (index.html, llms.txt, robots.txt,
  sitemap.xml, README.md with deploy settings and the contrast table).

## Integrator: before merging

1. **Fill `<!-- TESTCOUNT -->`** after the release-candidate run, in three places:
   - `README.md` status line. It MUST read exactly in this shape, or
     `.gnomon/ci.sh` step 1b and two `dashboard.test.ts` tests fail
     (`readmeTestCounts` in `packages/gnomon-cli/src/dashboard_data.ts` uses the
     same pattern):
     `N TypeScript tests (a core, b cli, c natives, d tui) and M Rust tests — **T total**`
     (the line is a `> ` block quote; wrapping is fine).
   - `site/index.html` hero status line (free text, e.g. `3,263 tests`).
   - `site/llms.txt` "Current release" paragraph (free text).
   Verified on this branch: with the old numbers put back, `dashboard.test.ts`
   passes 47/47; with the marker it fails the two README-count tests.
2. **CHANGELOG "### Merged for the release"**: replace each `TODO:` line with
   its entry (and PR number) as the PR merges; delete lines that do not ship:
   dotfile/self-kill fixes; hybrid local-first rescue v2 (#180, includes
   checkpoint-then-grind #179); Anthropic prompt caching; hand-off note fix;
   first-run journey; guard liveness + audit scorecard; benchmark kit; package
   hygiene.
3. **Cloud-rescue gate (PR #180).** The v0.5.0 release runs' hybrid figures
   (~23% of cloud-only's cloud cost, −0.07 vs cloud-only, +0.25 vs local-only)
   were measured on a PR #180 build: local-first with cloud rescue,
   `[roles.<name>.escalate]`. origin/master f466dfcca has no escalation
   (setup_wizard.ts:81-82 still says it waits on PR #102). This branch
   therefore words the mode as **unreleased** and keeps it apart from the
   hybrid `gnomon setup` proposes (`frontier_plan`: the cloud plans, this
   machine builds), whose own evidence (R3R, R4H) shows no advantage over
   cloud-only. Every site carries the literal `PR #180, unreleased`:
   `grep -rn "PR #180, unreleased" README.md GETTING_STARTED.md CHANGELOG.md llms.txt site docs`
   (README step 2, GETTING_STARTED step 2, GUIDE §4 step 2 and §5.3,
   CHANGELOG [0.5.0] intro, llms.txt, site/llms.txt, site/index.html hero KPI,
   §8 IV, "What did not work", §9 HYBRID bullet, limits list, EVIDENCE
   "What the v0.5.0 recommendations rest on", HYBRID.md §10,
   FINDINGS-2026-11-04).
   - **If #180 merges for v0.5.0:** replace each `PR #180, unreleased` with
     ``opt-in, `[roles.<name>.escalate]` `` (Markdown) or
     `opt-in, <code class="inline">[roles.&lt;name&gt;.escalate]</code>`
     (site/index.html; plain `[roles.<name>.escalate]` in the llms.txt
     files), and "candidate cost mode" / "measured as a cost mode" with
     "opt-in cost mode". Keep the sentences that separate it from setup's
     `frontier_plan` proposal: #180 does not change setup_wizard.ts, so setup
     still does not configure an escalate block. If #180 (or a later PR) makes
     setup propose rescue, re-read README/GETTING_STARTED/GUIDE step 2 again.
   - **If #180 does not merge:** leave the wording as is, and delete the
     CHANGELOG `TODO: hybrid local-first rescue v2 (#180 …)` line.
   - Same issue outside this branch: `feat/first-run-journey` (4976a2023)
     puts the rescue figure into `packages/gnomon-cli/catalog/models.toml`
     `hybrid.evidence`, which setup prints when it proposes the
     `frontier_plan` hybrid. That integrator should lead that text with the
     plan-in-the-cloud evidence (R3R/R4H: no advantage over cloud-only) and
     label the 23% as a different, rescue mode (unreleased unless #180 merges).

## README notes

None outstanding: README, GETTING_STARTED and GUIDE were in this brief and are
edited on the branch. The cloud-rescue wording in them follows step 3 of
"Integrator: before merging".

## Owner actions (not done here)

- **npm trusted publishing** must be configured on npmjs.com for
  `gnomon-core`, `gnomon-natives`, `gnomon-tui`, `gnomon-harness` (workflow
  `publish-npm.yml`) before publishing the v0.5.0 GitHub release; the docs now
  say `npm i -g gnomon-harness` works from v0.5.0. Steps: docs/RELEASING.md →
  "One-time setup on npmjs.com".
- **Netlify**: set the site's publish directory to `site/` (no build command),
  then deploy. After that `/whitepaper/*.pdf` and `/docs/GUIDE.md` return 404
  on purpose (see site/README.md).
- **Delete the public bench branches** as planned:
  `git push origin --delete bench/peers-2026-11 bench/gbs-v02`
  (also `bench/injection-2026-11` if it is public; master's
  `benchmarks/results/gbs-2026-11-04/` and `inj-2026-11-guardfix/` still name it).

## Deferred

- Whitepaper PDF regeneration for v0.5.0 (the v0.3.2 edition is withdrawn from
  the site: it carries November 2026 peer comparisons).
- Out of this brief's edit scope, still carrying November 2026 peer material
  or `bench/*` branch names on master: `benchmarks/results/gbs-2026-11-04/`
  (peer-runnability.md, overhead/PEER.md, governance/PEER.md, README §85,
  apparatus headers), `benchmarks/results/inj-2026-11-guardfix/README.md`,
  `benchmarks/results/injection-2026-09-01/README.md` line 61. Owner decision.
- Code comments naming "v0.4.6" (`packages/gnomon-core/src/test_support.ts`,
  `deliverable_first.test.ts`) were not changed (docs-only brief).
- Older CHANGELOG sections still describe peer harness *behaviour* found in
  November (e.g. which transcript formats exist, a G1c guard bypass); numeric
  peer comparisons were removed.
