# Threat model: `[sandbox] exec`

*Written 2026-11-06 (audit 2026-11-06, action 3), against master after v0.4.5
(PR #158). Derived from the code and tests named below, not from the review
history. When this page and the code disagree, the code is right and this page
is a bug.*

This is the one place that states what `exec = "docker"` defends against, the
single invariant it rests on, and which layer of gnomon enforces which part.
The README section [`exec` — where `bash` actually
runs](../README.md#exec--where-bash-actually-runs) is the user-facing account;
[CHANGELOG 0.4.5](../CHANGELOG.md) lists what changed. v0.4.5 was drafted and
never published; v0.5.0 is the first release with PR #158, and an installed
v0.4.3 or earlier does not have the defences below. `exec = "os"` (a kernel
sandbox, #74/#156) is **proposed and not merged**: master accepts only
`exec = "off"` and `exec = "docker"` (`config.ts` `ResolvedExec`, `resolveExec`).

## The threat

A **hostile model with a shell** whose commands run in a container that
bind-mounts the project root read-write. It can write any byte under the root
that is not mounted read-only, including `.git/objects`, `.git/refs`,
`.git/HEAD`, `.gitattributes`, nested `.git` directories and symlinks, and it
can keep writing for as long as a container runs. It cannot read the host's
environment (no `-e` but the session marker), has no network unless the role
declares `network = true`, and has no capabilities.

The goal it is defended against: **getting a host process to run, follow,
read or trust something it wrote**, and with it running code on the host,
sending an API key somewhere else, writing outside the root, or switching the
container off for this or a later session.

Out of scope: a hostile *operator* (the person editing `.gnomon/`), a
compromised image or docker daemon, kernel escapes from the container, and a
model with `exec = "off"` (below).

## The invariant

> **Under `exec = "docker"`, host-side gnomon never follows, runs or trusts a
> byte the container can write.** Every host action that touches the project
> either reads only paths the container cannot write (read-only mounts, the
> data directory), or treats what it reads as untrusted data: it opens no
> link, runs no program the repository names, takes no setting from it that
> acts on the host, and refuses when it cannot tell.

Each row of the table below is one consequence of that sentence. A new feature
that reads, writes or runs anything under the root on the host must say which
row covers it, or add one.

## What `exec = "off"` does not protect

With `exec = "off"` (the default) `bash` runs **on the host, as you**. Nothing
contains it. What remains is:

- **pattern checks over the command's text** (`bash_deny`, `bash_allow`, the
  `record` rule, the approval gate). They refuse what the text names and
  nothing else: a path built at run time, a script's own writes and MCP calls
  are not seen ([CONTRACTS §10](CONTRACTS.md)). **This is not containment.**
- **detection after the fact**: `surface_drift` for `.gnomon/`, the record
  guard for the audit trail ([CONTRACTS §14](CONTRACTS.md)), external anchors.
- **gnomon's own git hardening and the credential pin** (rows 4 and 8 below)
  apply in every mode, so gnomon's *own* actions are not steered by repository
  config or a mid-session url rewrite. But the model's shell can do directly
  anything those would have done.

`exec = "off"` is the right mode for a model you trust with your user account.
For one you do not, use `exec = "docker"`.

## Layers

| # | Attack surface | Layer that enforces it | Code | Test |
|---|---|---|---|---|
| 1 | Container edits gnomon's surface or records (`.gnomon/`, `.gnomon-audit/`, `.gnomon-sessions/`, `.gnomon-loops/`) | Read-only bind mounts; refuse to start when one is a symlink; missing record dirs created first | `root_fs.ts` `containedReadonlyPaths`; `tools.ts` `sandboxCommand` | `fifth_review.test.ts` "mounts .gnomon/, the records and .git/config…"; `root_fs.test.ts` "refuses to set up a sandbox over a symlinked record directory"; `sixth_review.test.ts` "…mounts .gnomon-loops/ read-only" |
| 2 | Container edits git's control files (`.git/config`, `hooks/`, `info/`, `commondir`, `config.worktree`), a linked worktree's admin dir or a submodule's git dir; or renames `.git` away from those mounts | Read-only mounts, `commondir`/`config.worktree` created as placeholders, `.git` and the dirs above each control path mounted on themselves (rename → EBUSY) | `root_fs.ts` `containedReadonlyPaths`, `gitControlPaths`, `containedMountPoints` | `sixth_review.test.ts` ".git is a mount point of its own…"; `seventh_review.test.ts` "a linked worktree's admin dir…", "a submodule's config, hooks, info and .git file are read-only, recursively" |
| 3 | Privilege inside the container (setuid binary → root → device nodes, setuid files in the mount); image string as a docker flag or shell text | `--user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges`; image checked against the reference grammar and quoted | `tools.ts` `sandboxCommand`; `config.ts` `isValidImageRef` | `sixth_review.test.ts` "docker run drops every capability…"; `fifth_review.test.ts` "is never more of the host's shell line, nor a docker flag"; `root_fs.test.ts` "accepts references and refuses anything else" |
| 4 | Host git run by gnomon (tree delta, status gate, stamp, `check`, `guard`, dashboard, `gnomon-surface`) executes a program the repository names: `core.fsmonitor`, hooks, filter/diff/merge drivers, credential helpers, `gpg.program`, remote programs | Repository **named, never discovered** (own walk, pinned at session start, `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`, ceiling, `safe.bareRepository=explicit`); fixed `-c` hardening and no system config; every driver the config lists blanked via `GIT_CONFIG_COUNT`; any doubt (ambiguous repo, not the pinned one, listing failed) refuses the call | `git_safe.ts` `findRepository`, `pinRepository`, `hardenGitArgs`, `gitHardenedEnv`, `neutralizeDriversEnv`, `safeGit`; Rust `gnomon-surface` `safe_git` | `git_safe.test.ts` (fsmonitor/filter/hook vs a plain-git control; "finding 2"/"finding 3" cases; "every gnomon git names its repository…"); Rust `a_root_made_a_git_dir_is_not_the_repository_asked` |
| 5 | Host git races a container still writing (timeout, cancel, a soft-shell job left running under `soft_timeout = "handle"` (CONTRACTS.md §34), a second gnomon process, the dashboard) | No host git while any container labelled for the root may be live; timeout/cancel await `docker rm -f` + `inspect`; `gnomon.root` label lets other processes ask; docker unaskable for a floored root ⇒ refuse | `git_safe.ts` `containerStarted`, `liveContainer`; `tools.ts` `removeContainer` | `git_safe.test.ts` "finding 4: while a sandbox container may still be running…"; `fifth_review.test.ts` "host git in a root a running container is labelled with is refused, from any process", "…when docker cannot be asked…" |
| 6 | Host writes into the root follow a planted symlink or hard link (audit trail → `~/.bashrc`, history → `trust.json`, loop state, snapshots, spill, live record) | One write helper: `O_NOFOLLOW`, plain directories from the real root down, `nlink = 1`, exclusive temp + rename, target must be inside the given root; per-repository state (history, guard/check bases, rule caches, restore journal) moved to the data dir | `root_fs.ts` `writeFileIn`, `appendFileIn`, `writeRootFor`, `removeIn` | `root_fs.test.ts` (symlink, symlinked dir, hard link); `fifth_review.test.ts` "finding 1", "finding 2" ×2; `eighth_review.test.ts` "writeFileIn refuses a target outside the root…" |
| 7 | Host reads/writes of files the model names (`read`, `write`, `edit`, `grep`, line counts, archive listing, must-fail-first pre-images) open a FIFO, device, symlink out or hard link | Regular files only, real path in the roots, `O_NONBLOCK` + `fstat`, size caps; writes by rename keeping the mode; restore checks identity and reports a swapped path instead of writing through it | `root_fs.ts` `readRegular`, `writeRegular`, `readExactIn` | `sixth_review.test.ts` (bashrc, credentials, swap during re-run, FIFO, hard link ×2); `seventh_review.test.ts` "an untracked symlink to a host file…", "a FIFO named as the archive…" |
| 8 | Mid-session surface reload loosens the sandbox or re-routes a key (`exec = "off"`, new image, `network = true`, endpoint `url`/`api_key_env`, fallback, MCP server) | Session pins: sandbox may only tighten (`sandbox NOT loosened`); key routing held (`key routing NOT applied`). Credential pin applies in every exec mode | `sandbox_pin.ts` `pinSandbox`, `tightenExec`; `credential_pin.ts` `pinCredentials` | `sandbox_pin.test.ts`; `credential_pin.test.ts`; `loop_commands.test.ts` "a rewritten endpoint url is held, said, and not used"; `fifth_review.test.ts` "off -> docker mid-session keeps the image…" |
| 9 | A later session loosens the sandbox (container wrote `exec = "off"` or a new image; `--trust`; nested `.gnomon/`; corrupt trust/floor file) | Machine exec floor: contained once ⇒ contained until `gnomon trust grant` or `--trust-exec-downgrade`; `--trust`/`GNOMON_TRUST` keep the floor; nearest floored ancestor governs; unreadable store or floor file ⇒ every project contained. The held floor is recorded in the trust outcome (`floor_held`) | `exec_floor.ts` `readFloors`, `governingFloor`, `strictestOf`; `trust.ts` `recordExecFloor`, `withExecFloor`, `settleTrustHeadless` | `trust.test.ts` "the exec floor…" block (findings 4, 5, 7, C ×2) |
| 10 | `gnomon check --base <rev>` / `gnomon guard` take host-acting settings from a revision the model made (`exec = "off"`, `network`, `[audit.attest] sign`, absolute `[audit] dir`, a role of its own) | The revision supplies only the policy under judgement (roles, write_allow, bash_allow/deny, `[verify]` as data); everything that acts on the host from the live surface (read-only to the container) and the floor read as its strictest entry | `host_surface.ts` `hostSurface`; `check.ts` `checkExec`; `sandbox_pin.ts` `tightenExec` | `sixth_review.test.ts` "a base ref moved to a commit whose policy says exec = \"off\"…"; `seventh_review.test.ts` B2–B4 cases |
| 11 | A revision's tree written to disk by `check`/`guard` escapes (`..`, `.git`, absolute, short names, HFS-ignorable spellings) or a pre-image restores onto `.git/` or `.gnomon/` | Every tree entry and diff path validated (blob, plain mode, no unsafe component in any spelling); one bad entry refuses the tree; pre-images for `.git`/gnomon state never written | `surface_tree.ts` `unsafeTreePath`, `writeSurfaceTree`; `must_fail_first.ts` `unwritablePreImage`; `check.ts` | `seventh_review.test.ts` "gnomon check refuses a base whose .gnomon/ holds `..`…", "gnomon guard refuses the same tree…"; `eighth_review.test.ts` (all) |
| 12 | Session-end anchor delivery re-reads `[audit.anchor]` from the root, or pushes to / runs hooks in a repository the container made | Anchor settings pinned at trust settlement and handed off through a sealed file in the data dir; local anchor repo outside the root, config allow-listed; target pinned once, in-root local targets refused; hardened receive/upload-pack | `anchor.ts` (`ANCHOR_GIT_HARDENING`, target pin, handoff) | `anchor.test.ts` "runs no hook a command planted in the local anchor repository…", "finding 6…"; `audit_anchor.test.ts` "a [audit.anchor] rewritten mid-session…" |
| 13 | The container can write gnomon itself, the home directory or the data dir (root ⊇ them) | Refuse a contained role whose root contains `$HOME`, the data dir or gnomon's code; `GNOMON_ALLOW_SELF_IN_ROOT=1` only for gnomon's own code | `trust.ts` `uncontainableRoot`, `assertContainableRoot` | `sixth_review.test.ts` "a root holding gnomon's own code is refused…", "a root that contains the home directory or gnomon's data dir is refused" |
| 14 | MCP servers resolve project code (`node_modules/.bin`, Python path) | While a role is contained, servers start in an empty owner-only dir in the data dir | `trust.ts` `mcpSpawnDir` | `sixth_review.test.ts` "under a contained role their cwd is outside the root…" |
| 15 | A key or shadow excerpts sent to a non-loopback "local" host | Only loopback counts as local for a key; anything else is a one-time grant | `trust.ts` `keyHostIsDefault`; `config.ts` `isLoopbackEndpoint` | `seventh_review.test.ts` "a key sent to a LAN, tailnet or .local host is a grant" |

`exec = "docker"` is refused on native Windows (`tools.ts`, the bash tool):
the mount needs a POSIX path. Use WSL.

**How it is tested, and what is not.** Every row above is tested against the
`docker run` argv or a shell-script fake `docker`. The read-only mounts, EBUSY
on rename, `--cap-drop ALL` and "git commit still works inside" were verified
by hand against a real docker (PR #158), not in CI. A real-docker CI job is
audit action 4 and is open.

## Accepted limits

These are known, documented and not fixed. Each is a place where the
invariant holds for gnomon but not for something else on the host.

- **L1 — your own git, after a corrupted `.git/HEAD`.** The container can
  corrupt `.git/HEAD` (mounting it read-only breaks `git checkout`/`switch`
  inside the container: "unable to write symref for HEAD") and plant a bare
  repository in the root. gnomon's git names its repository and is not
  affected (row 4). **Your** git, run in the root, may then discover the
  planted bare repository and run its config. Set `safe.bareRepository
  explicit` (below).
- **Nested repositories made during the session.** A `.git` directory the
  container creates in a subdirectory, or a submodule added mid-session, is
  not read-only. Your git enters it when you `cd` into it or when `git status`
  recurses. Treat any repository below the root that you did not create as
  hostile.
- **`.gitattributes` drivers for your git.** A filter or diff driver is named
  by config the container cannot write, but the attribute that selects it is
  repository content. gnomon blanks drivers for its own git (row 4); yours
  runs whatever your config defines.
- **Your own `[include]`.** If your `.git/config` or global config includes a
  file inside the project, the container can write that file.
- **User-declared host commands.** Loop guard/act commands (`loops.toml`),
  `[audit.attest] sign`/`verify`, anchor `cmd` backends, MCP server commands,
  and `[verify]` when it runs on the host, run as you wrote them. If they
  invoke scripts or packages from the project, the container can change those.
  Point them outside the project.
- **`--trust` / `GNOMON_TRUST` / `--trust-exec-downgrade`.** `--trust` accepts
  the surface's other grants but keeps the exec floor (row 9);
  `--trust-exec-downgrade` deliberately runs this session on the host and is
  yours to use only for a surface you have read. `gnomon trust grant` lowers
  the floor for good.
- **Self-denial.** The model can make the sandbox refuse to start (a symlink
  at `.git/worktrees`, over 256 fake git dirs, a symlinked record dir). That
  stops work; it does not escape.
- **Archive listing is fail-open.** An archive gnomon will not list (FIFO,
  over 256 MiB, timeout) is treated as having no members for the shell
  precheck. The precheck is a pattern check (§10), not containment.
- **Docker itself.** Kernel or runtime escapes, a malicious image, and a
  docker group that is root-equivalent on the host are outside this model.

## Recommended user settings

On any machine that runs contained sessions:

```bash
git config --global safe.bareRepository explicit   # closes L1 for your own git
```

And:

- Keep gnomon, your home directory and gnomon's data directory **outside**
  the project root (row 13 refuses otherwise).
- Keep loop, signer, anchor and MCP commands pointing **outside** the project.
- Do not `cd` into, or run git in, a repository below the root that you did
  not create.
- Leave `network = false` unless the role needs it; a loosening across
  sessions is a grant.
- Treat `--trust-exec-downgrade` and `gnomon trust grant` as reading the
  surface diff, not as a formality.
