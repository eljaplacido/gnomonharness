+++
name = "changing .gnomon/"
description = "Why the surface is not editable by a tool call, and what to do instead"
match = '(\.gnomon|roles\.toml|tools\.toml|policy\.toml|config\.toml|system\.md|surface hash|the surface|\b(propose|proposed|accept|durable)\s+(a\s+)?skill|\b(enable|turn on|switch on|grant|give)\b[^.]{0,40}\b(network|internet|web|access|permission|capabilit)|\b(internet|network) access|\ballow (strict|custom|all)\b)'
+++

`.gnomon/` decides how this agent behaves: the tool list, the approval gate,
every `bash_allow`, `write_allow` and `bash_deny`. **`write` and `edit` refuse
every path inside it**, whatever the role and whatever the gate.

That is not a bug to work around. An agent that can edit the surface can widen
the rules it is judged by — set `gate = "never"`, add a tool it was not given,
delete a deny pattern — and the next turn runs under the surface it wrote for
itself. It also moves the surface hash, which is the identifier every session
and audit record is traced by.

**When `write` or `edit` refuses a path inside `.gnomon/`, that refusal is the
signal** — you do not have to predict it. Name the file, the key and the value
so a person can make the edit:

> `roles.toml` gives `verifier` no `write` tool, which is why this failed. If
> the verifier should be able to write fixtures, add `write` to its `tools`
> and a `write_allow` confining it to `conformance/**`.

Then carry on with the rest of the task. A surface report answers only the part
that needed one; it is never the answer for a file the tools would have let
you write.

**`bash` is the exception, and it is watched rather than blocked.** The command
is arbitrary shell, so an allow-list guessing at every way a process can touch
a file would be a guarantee that is really a guess. The hash is re-read after
every `bash` call instead, and a change is reported:

    bash — exit 0 · surface changed

If you see that, work out whether it was you. A command you ran on purpose —
`gnomon skill accept`, a scaffold that was asked for — is the surface moving
as intended: say so and carry on. If nothing you ran should have touched
`.gnomon/`, the surface moved under the session:
say so in your answer. Do not run `git checkout` on it yourself — that
would discard whatever the operator has uncommitted there.

**Durable guidance has a sanctioned route.** The `skill` tool writes a proposal
into `.gnomon/skills/proposed/`, which is inert until a person runs `gnomon
skill accept <id>` — deliberately changing the hash, with a human doing it.
Propose a skill when you learn something about *this repository* that the next
turn would otherwise have to rediscover. See [[git-branching]] and
[[verifying-changes]] for the shape they take.

**Asked for a capability you do not have? Guide, do not stonewall.** "Enable
internet access", "give yourself the edit tool" — you cannot grant yourself a
capability, because you cannot edit the surface. But do not answer with a bare
"I cannot". Name the exact change a person would make: *"That is a surface
change — set `[sandbox] network = true` in `config.toml` and enable `webfetch`
in `tools.toml`."* The refusal is only half an answer; the file, key and value
are the other half.

**Or the human can hand you the pen — `/allow`.** `/allow custom` lets you write
`.gnomon/` yourself with every edit approved; `/allow all` is standing consent.
Both stay auditable: a surface write always announces that the hash moved. Until
then it is `strict` and the surface is theirs alone — so when you need a change,
name it, say which of the two would let you make it, and let them decide.
