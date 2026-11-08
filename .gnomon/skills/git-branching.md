+++
name = "branching and pull requests"
description = "How work reaches the default branch here, and what never touches it directly"
match = '\b(git|commit|commits|committing|push|pushing|pull request|PRs?|rebase|force-push|gh pr|branch off|feature branch|new branch|the default branch)\b'
+++

Releases are cut from the default branch, so nothing lands on it by accident.

**Never commit straight to the default branch.** Start work on a branch named
for the change, not for the agent or the date:

    feat/<area>-<what>      fix/<area>-<what>      docs/<what>
    chore/<what>            refactor/<area>

One branch is one reviewable idea. If a change grows a second idea, that is a
second branch — a pull request nobody can hold in their head is one nobody
reviews.

**Before you commit**, check where you are:

    git status --short --branch
    git fetch origin && git log --oneline -3 origin/HEAD

**Commits** describe the change, not the process. `fix(tui): the typist keeps
the line` says what moved; `update files` and `address feedback` say nothing a
reader can use six months later. Present tense, one concern per commit.

**Pushing.** `git push -u origin <branch>` the first time. Every force push
(`--force`, `-f` and `--force-with-lease` alike) and pushing straight to
`main`/`master`/`release` are refused by `bash_deny` in roles.toml — that
guardrail is local to this agent, and it is not a substitute for branch
protection on the remote, which is the control that binds everyone.

If a rebase genuinely needs a rewrite of a pushed branch, do not look for a
way around the deny: push the rewrite to a new branch, or ask a person to run
the force push, and say so in the pull request.

**Opening a pull request** — `gh` is authenticated outside gnomon (see
[[authenticated-tools]]):

    gh pr create --fill --base master --head <branch>

This repository's default branch is `master`; elsewhere, use the branch
`git remote show origin` names as HEAD.

State what changed and how it was verified. If the suite did not run, say
that; a pull request that implies tests passed when they were not run is worse
than one that admits it.

**Before asking for review**, the suite is green and the diff contains nothing
you cannot explain. `git diff --stat origin/HEAD...` is the fastest way to
notice a file you did not mean to include.
