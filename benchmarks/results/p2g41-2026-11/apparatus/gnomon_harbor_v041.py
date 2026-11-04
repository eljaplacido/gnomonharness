"""The gnomon arm re-pinned to v0.4.1 (release defaults), for the P2G v0.4.1 amendment and the v0.4.1 release smoke.

A subclass of gnomon_harbor_v040.GnomonV040 (whose run() is unchanged: the attempt-1 _PATCH, live audit copy, same
`gnomon task ... --role implementor --yes --json`). Only the install differs: the v0.4.1 release tarballs, pinned
three ways as for v0.4.0 (SHA256SUMS hash, each tarball against it, the gnomonBuild stamp and --version string).
GNOMON_REL_BASE (env of the Harbor process) may point the download at a local mirror of the SAME files (the release
smoke ran on the draft's assets before publishing); the hash pins make the source irrelevant.
"""
import os
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment

from gnomon_harbor import RELEASES
from gnomon_harbor_v040 import GnomonV040

V041 = "0.4.1"
V041_COMMIT = "c511b8105fb2187423d21becbe3b19f8af2b80e5"
V041_BUILD = "v0.4.1-c511b81"
V041_SUMS_SHA256 = "923adc6fb249f65ea998bccb8351e1a806138a8fe015319cefc0a0d429b4f459"


class GnomonV041(GnomonV040):
    @override
    def _release(self) -> str:
        return V041

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        v = V041
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
                f'echo "{V041_SUMS_SHA256}  SHA256SUMS" | sha256sum -c - >/dev/null && '
                f"{fetch} && "
                f'test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-{v}.tgz: OK")" = 4 && '
                f"npm i -g --silent {' '.join(f'./{p}-{v}.tgz' for p in pkgs)} && "
                f'test "$(node -p "require(\\"$(npm root -g)/gnomon-core/package.json\\").gnomonBuild")" = "{V041_BUILD}" && '
                f'test "$(gnomon --version 2>/dev/null | tail -1)" = "gnomon/{v}+{V041_BUILD}" && '
                f'echo "gnomon v{v} {V041_COMMIT[:16]} $(grep gnomon-harness-{v}.tgz SHA256SUMS | cut -c1-16)" > $HOME/.gnomon-release'
            ),
        )
