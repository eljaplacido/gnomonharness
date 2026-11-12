# feat/first-run-journey

One command, then: scan the hardware, suggest a model, configure, target a
project, run.

## Added

- Installers: `--setup` (install.sh, or `GNOMON_SETUP=1`) and `-Setup`
  (install.ps1) run `gnomon setup` interactively in the current directory
  right after the install. Never with `--yes`: setup still asks before every
  download and write, and with no terminal to ask on it does not run.
  `--help` / `-Help` print the options; an unknown argument stops before
  anything is checked or fetched.
- Dashboard: a seventh setup step, **Start**, after "Review and accept". It
  shows the exact command for the targeted project, `cd <path> && gnomon
  launch`, quoted for the shell it is pasted into, with a Copy button. Shown
  and copied, never run: the dashboard opens no terminals.
- CI: a first-run smoke on macOS and Windows (`scripts/first_run_smoke.mjs`):
  `gnomon doctor --json`, `gnomon setup --json` (exit 4, nothing written) and
  `gnomon dashboard --no-open` on a free port (prints the sign-in link, serves
  the page, stops).
- Tests: `installer.test.ts` (both installers, offline; the .ps1 is parsed
  and run with -Help on Windows) and `dashboard_a11y.test.ts` (contrast of
  every text token, labels on every form control, the confirm dialog's Esc
  and focus return on a fake DOM, every button naming a real command).

## Changed

- Installers close with the journey: `gnomon setup`, then `gnomon dashboard`,
  then `cd your-project && gnomon launch`.
- `gnomon init`, when no model server answered, writes the model the catalog
  recommends for this machine (the tag `gnomon setup` would offer, for every
  role) instead of generic `qwen2.5` placeholders that nothing serves; one
  `gnomon setup --pull <tag>` then makes every role answer. Placeholders stay
  when nothing in the catalog runs on the machine. `--from` and `--no-verify`
  scaffolds are unchanged.
- `gnomon init`'s "Models:" hint and "Next:" list lead with `gnomon setup`
  (or the dashboard), then `gnomon doctor`, then `gnomon launch`;
  `gnomon endpoint add` is the manual alternative.
- `gnomon launch` off a terminal, and its "Skip" choice, name `gnomon setup`.
  On a terminal it already offered the guided setup first; its help now says
  "on a terminal".
- Model catalog as of 2026-11-12. Hybrid (local-first with cloud rescue) is
  described as an opt-in cost mode, not a default and not a quality gain:
  about 23% of cloud-only's cloud cost, hidden-test share 0.07 below
  cloud-only and 0.25 above local-only (gnomon's own 2026-11 runs). On Claude
  Haiku, gnomon's defaults did at least as well as the tuned recipe at about
  half its cost, so the defaults are recommended; the done check stays opt-in
  (more honest final reports, not better outcomes). No peer figures; no links
  to bench branches.
- Dashboard: `--dim` raised to 4.7:1 or better on every surface (it was 3.9:1
  on chips); the confirm dialog returns focus to the control that opened it;
  the "audit show --json" buttons, which named a flag the command does not
  read, are now "List trail files" (`gnomon audit show`).

## Fixed

- First run with no model server printed the same "nothing is listening"
  guidance twice, the second time with its commands run together into one
  line. It is now said once, as the turn's answer, with each command on its
  own line: `ollama serve`, `gnomon setup --pull <the project's tag>`,
  `gnomon setup --cloud-endpoint opencode-go --cloud-model <id>`, `gnomon
  setup`. `gnomon setup` with nothing to set up names the pull, `ollama
  serve` (when Ollama is not running) and the cloud way in one message.

## README notes

For README.md / GETTING_STARTED.md / docs/GUIDE.md (not edited on this
branch):

- Install section: after the one-liners, add "Then run `gnomon setup` in
  your project (it scans the machine, recommends a model and writes
  `.gnomon/` on your yes), or `gnomon dashboard` for the same steps in the
  browser, which ends with the command to start." Add the opt-in forms:
  `curl -fsSL .../scripts/install.sh | sh -s -- --setup` and, in PowerShell,
  `& ([scriptblock]::Create((irm .../scripts/install.ps1))) -Setup` (or
  `$env:GNOMON_SETUP = '1'` before the `irm | iex` line). Say that setup
  still asks before every download and write.
- First-run section: `gnomon init` with no model server now writes the
  catalog's recommendation (not installed yet); `gnomon setup --pull <tag>`
  or `ollama serve` makes it answer; `gnomon doctor` checks every role.
- Dashboard section: setup has seven steps; the last, Start, shows
  `cd <project> && gnomon launch` with a Copy button.
- Hybrid wording, wherever it appears: an opt-in cost mode (about 23% of
  cloud-only's cloud cost; -0.07 hidden-test share vs cloud-only, +0.25 vs
  local-only), not a default. On Claude Haiku: use the defaults.

## For the owner

- Nothing pushed. The branch is `feat/first-run-journey`; to publish it:
  `git push -u origin feat/first-run-journey` and open a PR against master.
- The new CI step runs only on the macOS and Windows test jobs; it needs no
  secrets and no network beyond 127.0.0.1.
- Deferred: `suggestMode` still suggests hybrid (cloud plans, local builds)
  for a small or medium local model once a cloud model is added. The catalog
  text now calls hybrid a cost mode; whether setup should stop *suggesting* it
  by default is a product call.
- Deferred: no new gnomon-only solved/of figures for qwen3.6-35b or DeepSeek
  v4.1 flash were available to this branch, so the catalog's measured rows
  (R1H, R1) stand as they were. A Haiku entry needs an exact model id for a
  preset (none was guessed).
