+++
name = "changing .gnomon/"
description = "Why the surface is not editable by a tool call, and what to do instead"
match = '\b(surface|\.gnomon|roles\.toml|tools\.toml|policy\.toml|config\.toml|system\.md|approval|gate|hash|skill)\b'
+++

`.gnomon/` decides how this agent behaves: the tool list, the approval gate,
every `bash_allow`, `write_allow` and `bash_deny`. **`write` and `edit` refuse
every path inside it**, whatever the role and whatever the gate.

That is not a bug to work around. An agent that can edit the surface can widen
the rules it is judged by — set `gate = "never"`, add a tool it was not given,
delete a deny pattern — and the next turn runs under the surface it wrote for
itself. It also moves the surface hash, which is the identifier every session
and audit record is traced by.

**So when a change to the surface is the right answer, say so and stop.** Name
the file, the key and the value, and let a person make the edit:

> `roles.toml` gives `verifier` no `write` tool, which is why this failed. If
> the verifier should be able to write fixtures, add `write` to its `tools`
> and a `write_allow` confining it to `conformance/**`.

That is a complete and useful turn.

**`bash` is the exception, and it is watched rather than blocked.** The command
is arbitrary shell, so an allow-list guessing at every way a process can touch
a file would be a guarantee that is really a guess. The hash is re-read after
every `bash` call instead, and a change is reported:

    bash — exit 0 · surface changed

If you see that and did not mean it, the surface moved under the session:
restore it with `git checkout .gnomon` before continuing, because the turns
already recorded were recorded against a surface that no longer exists.

**Durable guidance has a sanctioned route.** The `skill` tool writes a proposal
into `.gnomon/skills/proposed/`, which is inert until a person runs `gnomon
skill accept <id>` — deliberately changing the hash, with a human doing it.
Propose a skill when you learn something about *this repository* that the next
turn would otherwise have to rediscover. See [[git-branching]] and
[[verifying-changes]] for the shape they take.
