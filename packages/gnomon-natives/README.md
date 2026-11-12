# gnomon-natives

Typed TypeScript access to the Rust binaries of [gnomon](https://github.com/eljaplacido/gnomonharness):
`gnomon-surface` (manifest and surface hash), `gnomon-edit` (patch
application), `gnomon-exec` (sandboxed execution) and `gnomon-enums`
(contract enumerations). It shells out to those binaries; no native addon is
built or loaded at install time, and nothing is downloaded by this package.

The binaries are found via `GNOMON_BIN_OVERRIDE`, a checkout's
`target/debug` or `target/release`, the installers' per-user directory
(`~/.local/share/gnomon/bin`, `%LOCALAPPDATA%\gnomon\bin`), or `PATH`,
in that order. The installer puts them there:

```bash
curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | sh
```

Most people want the `gnomon` command, `npm install -g gnomon-harness`,
which depends on this package. Requires Node.js 22 or newer.

- [Repository and README](https://github.com/eljaplacido/gnomonharness#readme)
- [Changelog](https://github.com/eljaplacido/gnomonharness/blob/master/CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
