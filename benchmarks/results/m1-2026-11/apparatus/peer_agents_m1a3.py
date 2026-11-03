"""terminal-bench agent for M1 Amendment 3: R1's GnomonR1, plus the one arm variable.

Identical to peer_agents_r1.GnomonR1 (imported, not copied) except:
- M1A3_REPLAY ("true" | "false") is forwarded into the container, where
  gnomon-setup-m1a3.sh.j2 writes it as `replay_reasoning` on the local endpoint r1local;
- the setup template is gnomon-setup-m1a3.sh.j2.
Both arms use the model string `r1/L`, so R1_ARM and the r1 profile are byte-identical between
G0 and G1 and the surface differs only by that one config line.
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent


class GnomonM1A3(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-m1a3"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        rr = os.environ.get("M1A3_REPLAY")
        if rr not in ("true", "false"):
            raise ValueError(f"gnomon-m1a3: M1A3_REPLAY must be 'true' or 'false', got {rr!r}")
        env["M1A3_REPLAY"] = rr
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-m1a3.sh.j2"
