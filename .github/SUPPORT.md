# Support — gnomon

`.github/ISSUE_TEMPLATE/config.yml` already routes "how do I …" to Discussions
and security reports to a private advisory, but that routing was only visible to
someone who had already clicked **New issue**. GitHub surfaces this file from
the repository sidebar and from the issue chooser, so the routing is now
readable before you have picked the wrong form. Nothing about where to go has
changed; it is written down now.

## Answer it yourself first (usually faster than any of us)

| You want | Look at |
|---|---|
| To install it and run one turn | [GETTING_STARTED.md](../GETTING_STARTED.md) |
| What a flag, command or default does | [README.md](../README.md) — it is checked against the code by `packages/gnomon-cli/src/docs.test.ts`, so it is not allowed to drift |
| What a contract guarantees | [docs/CONTRACTS.md](../docs/CONTRACTS.md) and the fixtures in `conformance/` |
| Why a behaviour is the way it is | [CHANGELOG.md](../CHANGELOG.md) — entries name the failure that produced the change |
| Where gnomon sits against other harnesses | [docs/POSITIONING.md](../docs/POSITIONING.md) |
| Whether your checkout is healthy | `.gnomon/ci.sh` — one command, whole suite |

In an interactive session, `/explain` answers questions about the running
harness from the surface it actually loaded, which beats guessing from docs
about a config you have edited.

## Where to take it

**A question — "how do I", "is this supposed to", "which role should".**
→ [Discussions](https://github.com/eljaplacido/gnomonharness/discussions).
Include the output of `gnomon --version` and the `.gnomon/` files that matter
(`roles.toml`, `policy.toml`) if the behaviour depends on the surface — most of
it does.

**A bug — something behaves differently from what a doc or a test claims.**
→ [Open a bug report](https://github.com/eljaplacido/gnomonharness/issues/new?template=bug_report.md).
The template asks where your expectation comes from (a README line, a test, a
contract) on purpose: that sentence is what separates a bug from a
disagreement about design, and it is what makes the report actionable.

**A change you want — a new tool, a surface contract, a behaviour change.**
→ [Open a change proposal](https://github.com/eljaplacido/gnomonharness/issues/new?template=proposal.md)
**before** you write the code. The project is maintainer-gated and has strong
opinions; agreeing the direction first is cheaper than a rewritten PR. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

**A security vulnerability — a sandbox escape, an allow-list bypass, a
credential leak.**
→ **Not a public issue.** Follow [SECURITY.md](SECURITY.md) and use the
[private advisory form](https://github.com/eljaplacido/gnomonharness/security/advisories/new).
This is a harness that confines what an agent may run; a public repro is a
working exploit against everyone running it.

## What to expect back

One person maintains this project. There is no support rota, no on-call, and no
second reviewer — see the review contract in
[CONTRIBUTING.md](../CONTRIBUTING.md) for the response targets and what they are
worth. They are targets, stated so you can tell the difference between "slow"
and "abandoned"; they are not an SLA, and nobody is paid to meet them.

NOT verified from the repository tree: whether GitHub Discussions is enabled on
this repository. `.github/ISSUE_TEMPLATE/config.yml` has linked to it since
before this file existed, and that link 404s if the feature is switched off. If
it does, open a question as an issue instead and say so in the issue.
