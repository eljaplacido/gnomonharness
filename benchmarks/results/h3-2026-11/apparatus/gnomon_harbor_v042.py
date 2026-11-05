"""H3: the gnomon arm re-pinned to v0.4.2 (release defaults). This is P2G41's gnomon_harbor_v041.py with the v0.4.2
pins and nothing else changed.

A subclass of gnomon_harbor_v040.GnomonV040 (whose run() is unchanged: the attempt-1 _PATCH, live audit copy, same
`gnomon task ... --role implementor --yes --json`). Only the install differs: the v0.4.2 release tarballs, pinned
three ways as for v0.4.0 and v0.4.1 (SHA256SUMS hash, each tarball against it, the gnomonBuild stamp and --version).
Pins taken 2026-11-05 from `gh release download v0.4.2 -R eljaplacido/gnomonharness` (published 2026-11-05T05:08:07Z;
annotated tag v0.4.2 -> commit 2498d16d; gnomon-core-0.4.2.tgz package.json "gnomonBuild": "v0.4.2-2498d16").
GNOMON_REL_BASE (env of the Harbor process) may point the download at a local mirror of the SAME files; the hash pins
make the source irrelevant.
"""
import os
from typing import override

from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment

from gnomon_harbor import RELEASES
from gnomon_harbor_v040 import GnomonV040

V042 = "0.4.2"
V042_COMMIT = "2498d16dc248bc18a203a1a98ba0b942acae5b23"
V042_BUILD = "v0.4.2-2498d16"
V042_SUMS_SHA256 = "46ebca2971add95a8f96277c467f5d8f50e5bd86d8d534dc22ba0fa77ebcfb7c"


class GnomonV042(GnomonV040):
    @override
    def _release(self) -> str:
        return V042

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        v = V042
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
                f'echo "{V042_SUMS_SHA256}  SHA256SUMS" | sha256sum -c - >/dev/null && '
                f"{fetch} && "
                f'test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-{v}.tgz: OK")" = 4 && '
                f"npm i -g --silent {' '.join(f'./{p}-{v}.tgz' for p in pkgs)} && "
                f'test "$(node -p "require(\\"$(npm root -g)/gnomon-core/package.json\\").gnomonBuild")" = "{V042_BUILD}" && '
                f'test "$(gnomon --version 2>/dev/null | tail -1)" = "gnomon/{v}+{V042_BUILD}" && '
                f'echo "gnomon v{v} {V042_COMMIT[:16]} $(grep gnomon-harness-{v}.tgz SHA256SUMS | cut -c1-16)" > $HOME/.gnomon-release'
            ),
        )
