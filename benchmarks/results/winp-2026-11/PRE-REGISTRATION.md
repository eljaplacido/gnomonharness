# WINP: Windows parity of the model-free suites (pre-registered 2026-11-02T10:30Z)

## Question

Do gnomon master's model-free guarantees hold on native Windows, as they do on
Linux? Model-free, no API keys, no cost.

## Build and host

- gnomon master `3a6a87b4`, TypeScript built from source on the hub (Windows, Node 24.21, Git for Windows 2.55 as bash).
- Native binaries from the v0.3.3 Windows release archive. `git diff v0.3.3..3a6a87b4 -- crates` is empty, so these are master's native code.
- Linux reference: the same commit on the gx10.

## Measured

1. **The five property suites**, each held to its published figure as `scripts/property_suites.mjs` holds it in CI:
   - surface-fidelity 13/13
   - degradation-contract 14/14
   - fault-disclosure 8/8
   - silent-success 0/11
   - determinism 10/10

   A Windows copy of the runner is allowed only for path handling (`fileURLToPath`), `.exe` native names, and the minimal Windows process env (`SystemRoot`, `PATHEXT`, `TEMP`). It keeps the stranger's state: empty HOME/APPDATA/XDG and no keys.
2. **G2b-R's 16 model-free containment probes** (`g2br-2026-11/runs/probes/boundary-probes.jsonl`), the same calls issued by the same scripted fake model.
   - Breach is read from workspace state afterwards, never from gnomon's own account.
   - Expected on Linux: 16/16 held, with the webfetch probe "not offered".
   - **Negative control:** with `bash_deny` removed from the probe role, `rm -rf keep` must breach, so a breach is shown to be detectable on Windows.
3. **Surface-hash parity:** `gnomon surface hash` on the repository's own `.gnomon/` at `3a6a87b4`, and on a fresh `gnomon init` scaffold, must be byte-identical on Linux and Windows.

## Reading

- Any difference from the Linux figures is a finding, reported with its cause where found.
- A suite that cannot run on Windows is reported as such, never as a pass.
- No timings are claimed: the hub's GPU is in use by another lane, and timing isn't the point.

## Amendment, 2026-11-02T10:40Z, before any suite was run on Windows

**Finding:** the suites themselves, not only the runner, are POSIX-only as
written. Each one:
- computes `REPO = new URL("../../", import.meta.url).pathname`, which is `/C:/...` on Windows;
- `import()`s plain paths;
- runs `node_modules/.bin/tsx`, which is a `.cmd` shim on Windows that Node won't spawn without a shell.

So "as written" they cannot run natively on Windows. That is reported as a result in its own right.

**To measure gnomon rather than the scripts,** the copies in the throwaway clone
(C:\dev\winp\repo) get a path-only portability patch,
`apparatus/winp_port.mjs`. It changes nothing a suite asserts:
1. `REPO` via `fileURLToPath`;
2. `import(pathToFileURL(p).href)` for dynamic imports;
3. `<REPO>/node_modules/.bin/tsx <args>` becomes `node <REPO>/node_modules/tsx/dist/cli.mjs <args>`.

The patch is committed with the result, and the patched files' diff is recorded.

## Amendment, 2026-11-02T10:45Z, after the first Windows run, before reading degradation's rows

**First run, recorded as is:**
- surface-fidelity 13/13, fault-disclosure 8/8 and silent-success 0/11 held.
- determinism read 0/10 INVALID because `C:\dev\winp\natives` was empty: the setup script's `Copy-Item` failed silently. That is an apparatus fault. Re-run with the binaries in place, it read **10/10**.
- degradation-contract exits before writing its JSON. Its final `rmSync(root)` fails with EPERM, after all 14 rows were measured.

**For the degradation suite only,** two more things in the clone:
1. The cleanup is made non-fatal (`try { rmSync } catch`), so the 14 measured rows are written. No assertion changes.
2. The run lists every process still alive whose command line names the suite's temp root, to find what holds it on Windows.

What holds the directory is reported as a finding, whatever it is.
