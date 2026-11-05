"""H4-lite: the gnomon arm re-pinned to master ae17a1ae (the merge of PR #152, the completion gate; not released).
This is P2G's gnomon_harbor_v041.py copied, with the pins replaced by the master build's and nothing else changed.
The class subclasses gnomon_harbor_v041.GnomonV041 and overrides only _release() and install(), whose body is
GnomonV041's with the master pins.

The build: G1gate's packed tarballs (`../../g1gate-2026-11/dist/`, see its PRE-REGISTRATION): `git archive ae17a1ae`,
`pnpm -r run build`, `npm pkg set gnomonBuild=master-ae17a1a` in gnomon-core, `pnpm pack` of core, natives, tui and
harness, all versioned 0.4.2. Pinned three ways, as for v0.4.0, v0.4.1 and v0.4.2: SHA256SUMS hash, each tarball
against it, the gnomonBuild stamp and the --version string `gnomon/0.4.2+master-ae17a1a`.
GNOMON_REL_BASE (env of the Harbor process) points the download at H4-lite's local HTTP mirror of the SAME files on
172.17.0.1 (the v0.4.1 release smoke's way); the hash pins make the source irrelevant.
"""
import os
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment

from gnomon_harbor import RELEASES
from gnomon_harbor_v041 import GnomonV041

M152 = "0.4.2"
M152_COMMIT = "ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac"
M152_BUILD = "master-ae17a1a"
M152_SUMS_SHA256 = "d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8"


class GnomonM152(GnomonV041):
    @override
    def _release(self) -> str:
        return M152

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        v = M152
        base = f"{os.environ.get('GNOMON_REL_BASE', RELEASES).rstrip('/')}/v{v}"
        pkgs = ("gnomon-core", "gnomon-natives", "gnomon-tui", "gnomon-harness")
        fetch = " && ".join(f"curl -fsSLO {base}/{p}-{v}.tgz" for p in pkgs)
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "rm -rf $HOME/gnomon-release && mkdir -p $HOME/gnomon-release && cd $HOME/gnomon-release && "
                f"curl -fsSLO {base}/SHA256SUMS && "
                f'echo "{M152_SUMS_SHA256}  SHA256SUMS" | sha256sum -c - >/dev/null && '
                f"{fetch} && "
                f'test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-{v}.tgz: OK")" = 4 && '
                f"npm i -g --silent {' '.join(f'./{p}-{v}.tgz' for p in pkgs)} && "
                f'test "$(node -p "require(\\"$(npm root -g)/gnomon-core/package.json\\").gnomonBuild")" = "{M152_BUILD}" && '
                f'test "$(gnomon --version 2>/dev/null | tail -1)" = "gnomon/{v}+{M152_BUILD}" && '
                f'echo "gnomon v{v} {M152_COMMIT[:16]} $(grep gnomon-harness-{v}.tgz SHA256SUMS | cut -c1-16)" > $HOME/.gnomon-release'
            ),
        )
