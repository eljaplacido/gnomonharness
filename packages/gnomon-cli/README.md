# gnomon-harness

A terminal coding agent whose behaviour is fixed by files in your repository,
not by your machine. Everything that decides how it acts (which models, which
roles, which tools each role may touch, when it must ask permission) lives in
one content-hashed directory, `.gnomon/`. Clone the repository elsewhere and
you get the same agent.

This package installs the `gnomon` command. (The npm name `gnomon` belongs
to an unrelated project; the old name `gnomon-cli` is retired.)

## Install

Needs Node.js 22 or newer.

```bash
npm install -g gnomon-harness
cd my-project
gnomon setup     # detect hardware and model servers, propose a .gnomon/ change as a diff
gnomon launch    # interactive session
```

`launch`, `prompt`, `task`, `acp`, `init`, `setup`, `doctor` and
`dashboard` work from this package alone. `surface`, `enumerations`,
`session`, `apply` and `simulate` also need the native binaries, which the
installer fetches and verifies against the release's `SHA256SUMS`:

```bash
curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.ps1 | iex
```

## Documentation

- [README](https://github.com/eljaplacido/gnomonharness#readme): what gnomon is, the `.gnomon/` surface, roles, tools and safety
- [Getting started](https://github.com/eljaplacido/gnomonharness/blob/master/GETTING_STARTED.md): install, launch, first task
- [The gnomon guide](https://github.com/eljaplacido/gnomonharness/blob/master/docs/GUIDE.md): quick start, model recipes, troubleshooting
- [Privacy and network use](https://github.com/eljaplacido/gnomonharness/blob/master/docs/PRIVACY.md): every host gnomon contacts by default and how to turn each off
- [Security policy](https://github.com/eljaplacido/gnomonharness/blob/master/.github/SECURITY.md)
- [Changelog](https://github.com/eljaplacido/gnomonharness/blob/master/CHANGELOG.md)

## Packages

`gnomon-harness` depends on three libraries published from the same
repository at the same version: `gnomon-core` (agent loop, configuration,
session model), `gnomon-natives` (typed access to the Rust binaries) and
`gnomon-tui` (terminal UI). It has no third-party runtime dependencies.

## License

MIT. See [LICENSE](LICENSE). The dashboard's wordmark font (Cinzel) is under
the SIL Open Font License 1.1, shipped as `dashboard/fonts/OFL.txt`.
