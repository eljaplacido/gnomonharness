+++
name = "how this repository is verified"
description = "The commands that decide whether a change is good here"
match = '\b(test|tests|suite|verify|check|ci|clippy|lint|conformance|green|passing)\b'
roles = ["verifier", "critique", "implementor", "implement", "plan"]
+++

One command decides, where the role can run it — `verifier` has a `bash_allow`
that permits the suite but not this script, so from there run the suite
directly and report:

    .gnomon/ci.sh

It builds the native binaries, runs the Rust and TypeScript suites, checks
every conformance fixture, and computes the manifest twice to prove it is
deterministic. If it passes, the change is verifiable; if it does not, the
change is not ready, whatever else looks right.

The pieces, when you need one on its own:

    cargo test --workspace          # Rust
    cargo clippy --all -- -D warnings
    pnpm -r run test                # TypeScript, all packages
    pnpm --filter gnomon-core test  # one package

**Documentation is tested like code.** `packages/gnomon-cli/src/docs.test.ts`
checks the README against the implementation: every CLI command it lists is
dispatched, every slash command it names is registered and reachable by Tab,
every default it quotes is what a scaffolded surface actually has. A change to
a default, a role's tool list or a command name **will** fail those tests until
the README is updated too. That is the test doing its job, not an obstacle —
much of this repository's history is documented behaviour that was not the
behaviour.

**Report what ran.** "Tests pass" after running one package is a false
statement about the other three. Name the command and paste the counts.
