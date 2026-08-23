## What

<!-- One sentence describing the change. -->

## Why

<!-- Link to issue, or explain the problem this solves. -->

## Changes

<!-- List touched files. Focus on non-obvious changes. -->

## Tests

<!-- Confirm test count before/after. Every new metric lands with
  (a) migration, (b) collector, (c) UI surface, (d) test. -->

- [ ] `cargo test` — Rust tests pass
- [ ] `pnpm test` — TypeScript tests pass
- [ ] `bash .gnomon/ci.sh` — Full CI pipeline green

## Checklist

- [ ] No new dependencies without justification
- [ ] Build succeeds (`pnpm run build` + `cargo build`)
- [ ] CLI smoke test works: `echo "/help" | gnomon prompt`
- [ ] Contract files updated if surface behavior changed (conformance/)
