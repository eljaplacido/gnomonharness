+++
name = "authenticated CLIs"
description = "How gh, az and similar tools are authenticated, and what the agent must not do with credentials"
match = '\b(gh|github|az|azure|aws|gcloud|login|auth|token|credential|secret|api[_-]?key)\b'
+++

**Authentication happens outside gnomon, and outside this turn.** `gh auth
login`, `az login` and their equivalents are interactive, they open browsers,
and they write credentials into the user's own configuration. An agent cannot
complete them and must not try.

If a command fails because a tool is not authenticated, **stop and say which
tool and which command the user should run**:

    gh auth status        →  gh auth login
    az account show       →  az login

Then let them do it. Reporting "authentication required, run `gh auth login`"
is a finished, useful turn. Guessing at a token, writing one into a file, or
working around the tool with raw `curl` against the API is not.

**Use the CLI, not the raw API.** `gh pr create`, `gh issue list`, `az group
list` already carry the user's credentials and honour their configuration.
Hand-rolled `curl` calls need a token from somewhere, and the only places to
get one are the user's keychain or the environment — reading either is
exfiltration whatever the intent.

**Never print a credential.** Not to explain it, not to confirm it is set, not
in a commit message, not in a file you write. `echo $GITHUB_TOKEN` puts a live
secret into a transcript, and when `[audit]` is enabled, into a trail on disk.
To check that a variable exists without revealing it:

    test -n "$GITHUB_TOKEN" && echo "set" || echo "not set"

**API keys for inference endpoints are gnomon's own concern**, and they have a
place already: `gnomon key set <endpoint>` stores one in a machine-local file
at mode 0600, outside `.gnomon/`. The surface names the variable and never
holds its value, which is what keeps `.gnomon/` safe to commit. Do not put a
key in `config.toml`, and do not suggest it.
