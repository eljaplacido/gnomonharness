"""terminal-bench agent for S1: R1's GnomonR1, plus the one arm variable (as peer_agents_m1a3.py does).

Identical to peer_agents_r1.GnomonR1 (imported, not copied) except:
- S1_STEER_ROLE ("system" | "user") is forwarded into the container, where gnomon-setup-s1.sh.j2
  writes it as `steer_role = "<value>"` on the local endpoint r1local;
- the setup template is gnomon-setup-s1.sh.j2.
Both arms use the model string `r1/L`, so R1_ARM and the r1 profile are byte-identical between
S0 and S1, and the surface differs by that one config line (and the per-arm meter port in the url).
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent


class GnomonS1(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-s1"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        sr = os.environ.get("S1_STEER_ROLE")
        if sr not in ("system", "user"):
            raise ValueError(f"gnomon-s1: S1_STEER_ROLE must be 'system' or 'user', got {sr!r}")
        env["S1_STEER_ROLE"] = sr
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-s1.sh.j2"
