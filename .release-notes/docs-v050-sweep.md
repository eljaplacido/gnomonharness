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
3. If #180 changes what `gnomon setup` proposes (it currently suggests hybrid
   for a usable-but-slow local model with a cloud model given), re-read
   README "Get started" step 2, GETTING_STARTED step 2 and GUIDE §4 step 2:
   they say setup "can propose hybrid" and call it an opt-in cost mode.

## README notes

None outstanding: README, GETTING_STARTED and GUIDE were in this brief and are
edited on the branch.

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
