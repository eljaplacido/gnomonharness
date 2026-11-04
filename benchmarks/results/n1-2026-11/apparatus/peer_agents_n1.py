"""terminal-bench agent for N1: R1's GnomonR1 (imported, not copied), as S1's GnomonS1 is, with N1's arm variable.

Identical to peer_agents_r1.GnomonR1 except:
- N1_STEER_ROLE (must be "user": the delivery channel is held fixed in both arms) and N1_NUDGE_AFTER_IDLE
  ("12" for N1, "100000" for N0) are forwarded into the container, where gnomon-setup-n1.sh.j2 writes
  `steer_role = "user"` on the local endpoint r1local and `[turn] nudge_after_idle = <value>`;
- the setup template is gnomon-setup-n1.sh.j2 (the v0.4.1 release, pinned by SHA256SUMS).
Both arms use the model string `r1/L`, so R1_ARM and the r1 profile are byte-identical between N1 and N0, and the
surface differs by the nudge_after_idle line only (both arms reach the same meter).
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent
NUDGE_VALUES = ("12", "100000")


class GnomonN1(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-n1"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        sr = os.environ.get("N1_STEER_ROLE")
        if sr != "user":
            raise ValueError(f"gnomon-n1: N1_STEER_ROLE must be 'user' in both arms, got {sr!r}")
        nv = os.environ.get("N1_NUDGE_AFTER_IDLE")
        if nv not in NUDGE_VALUES:
            raise ValueError(f"gnomon-n1: N1_NUDGE_AFTER_IDLE must be one of {NUDGE_VALUES}, got {nv!r}")
        env["N1_STEER_ROLE"] = sr
        env["N1_NUDGE_AFTER_IDLE"] = nv
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-n1.sh.j2"
