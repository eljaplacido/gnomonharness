"""terminal-bench (tb 0.2.18) agent for R3R: R1H's GnomonR1 with R3R's setup. Design: ../PRE-REGISTRATION.md.

Identical to peer_agents_r1.GnomonR1 (imported, not copied: arms L, C, PC and the NEG control, all their
per-cell environment and its checks) except that the setup template is gnomon-setup-r3r.sh.j2: R1H's
gnomon-setup-r1.sh.j2 with an assertion on what `gnomon init` wrote (stream = true, max_tokens = 32768,
no steer_role / replay_reasoning, no fallback) ahead of R1H's unchanged edits.
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent


class GnomonR3R(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-r3r"

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-r3r.sh.j2"
