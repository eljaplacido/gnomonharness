# WINP: Windows parity of gnomon's model-free guarantees (2026-11-02)

Design: `PRE-REGISTRATION.md`, committed before any Windows run, plus two
amendments logged before the results they concern were read.
- **Windows:** gnomon master `3a6a87b4` on the hub (Windows 11 Pro 26200, Node 24.21, Git for Windows 2.55). TypeScript built from source with the repo's pinned pnpm 9.0.0; native binaries from the v0.3.3 Windows release (`crates/` is unchanged since v0.3.3).
- **Linux reference:** the same commit on the gx10.
- **Cost:** model-free, $0.

## Result: every guarantee holds on Windows as on Linux

| check | Linux (published / control) | **Windows** |
|---|---|---|
| surface-fidelity | 13/13 | **13/13** |
| degradation-contract | 14/14 | **14/14** (see below: the suite's own cleanup needed a retry) |
| fault-disclosure | 8/8 | **8/8** |
| silent-success (falsely successful) | 0/11 | **0/11** |
| determinism | 10/10 | **10/10** (second run; see the apparatus fault below) |
| G2b-R containment probes | 16/16 hold (15 held, webfetch not offered) | **16/16, identical per probe** |
| negative control: `rm -rf keep` with no deny rule | — | **BREACH**: a breach is detectable on Windows |
| surface hash, repo `.gnomon/` at `3a6a87b4` | `47d5e98f…ab27` | **`47d5e98f…ab27`** |
| surface hash, G1c T4 template `.gnomon/` | `d584c7c1…6647` | **`d584c7c1…6647`** |

The Linux hashes are the same from natives built from master and from the
v0.3.3 release binary (`runs/linux-hashes.txt`). The same committed `.gnomon/`
names the same rules on both operating systems: \`git ls-files --eol\` shows
\`eol=lf\` in index and worktree on the Windows clone.

## What did not work as written on Windows (findings)

1. **The property suites are POSIX-only as written.** Each one:
   - computes `REPO` from `new URL(...).pathname` (`/C:/...` on Windows);
   - `import()`s plain paths;
   - runs `node_modules/.bin/tsx`, a `.cmd` shim Node won't spawn without a shell.

   A path-only port (`apparatus/winp_port.mjs`, diff in `runs/winp-port.diff`) makes them run, and changes nothing they assert. As a control, the same patched suites on Linux read 5/5 at their published figures (`runs/linux-control-suites.log`). **This is why CI can't run them on its Windows job today.**
2. **degradation-contract's final `rmSync` fails with EPERM on Windows.** All 14 rows are measured first, and all 14 are complete.
   - **Cause, measured** (`apparatus/winp_killtree.mjs`, `runs/killtree.jsonl`, 3 trials): when gnomon's bash tool times out a command, its Windows `killTree` starts `taskkill /T /F` and returns without waiting. The command's working directory stays locked for **~0.4–0.5 s** after the tool returns. After that it is removable, and no process survives.
   - So this isn't a leak, but it is a gap. On Windows the tool reports "timed out" while the killed tree is still exiting, and anything that deletes or moves the directory immediately afterwards hits EPERM.
   - **Suite fix:** retry the final `rmSync` (`maxRetries`).
   - **gnomon option:** wait briefly for `taskkill` to exit before returning.
3. **Apparatus fault, not gnomon:** the setup script's `Copy-Item` of the native binaries failed silently. The first suite run therefore read determinism 0/10 INVALID ("natives not found"); re-run with the binaries in place, 10/10. Both runs are kept: `runs/suites.log`, `runs/suites2.log`.
4. **Hub tooling:** your global pnpm (v11) rejects this repo's pnpm-9 lockfile. The install used `npx pnpm@9.0.0` with an isolated store and cache under `C:\dev\winp`; no global config was changed.

## Files

- `apparatus/`:
  - `winp_suites.mjs`, the Windows runner, derived mechanically from `scripts/property_suites.mjs`: paths, `.exe` natives and the minimal Windows env only;
  - `winp_port.mjs`, `winp_probes.py`, `fake_model.py`, `canary_local.py`, `winp-setup.ps1`, `winp-run.ps1`, `winp_killtree.mjs`.
- `runs/`: every log, `probes.jsonl` (each probe with its Linux verdict), hashes, versions and the port diff.

Left on the hub: `C:\dev\winp` (the clone, isolated pnpm store and npm cache, and natives), about 1 GB. Deleting it removes everything.
