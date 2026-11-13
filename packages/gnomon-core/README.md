# gnomon-core

The core library of [gnomon](https://github.com/eljaplacido/gnomonharness), a deterministic, capability-gated coding
agent harness: `.gnomon/` configuration resolution and surface hashing, the
agent loop, tools and their capability gates, sessions, audit records and the
completion and finish gates. It has no terminal-UI dependencies and no
third-party runtime dependencies.

Most people want the `gnomon` command instead:

```bash
npm install -g gnomon-harness
```

This package is published so that `gnomon-harness` can depend on it. Its
exports follow the harness's release version and are documented by
[docs/CONTRACTS.md](https://github.com/eljaplacido/gnomonharness/blob/master/docs/CONTRACTS.md); there is no separate
stability promise for using it directly as a library.

Requires Node.js 22 or newer.

- [Repository and README](https://github.com/eljaplacido/gnomonharness#readme)
- [Contracts](https://github.com/eljaplacido/gnomonharness/blob/master/docs/CONTRACTS.md)
- [Changelog](https://github.com/eljaplacido/gnomonharness/blob/master/CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
