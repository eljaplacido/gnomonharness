"""terminal-bench (tb 0.2.18) agent for M2: R3R's GnomonR3R with M2's setup. Design: ../PRE-REGISTRATION.md.

Identical to peer_agents_r1.GnomonR1 (imported, not copied: arms L, PC and the NEG control, all their per-cell
environment and its checks) except:
- the setup template is gnomon-setup-m2.sh.j2: R3R's gnomon-setup-r3r.sh.j2 plus one per-cell switch;
- that switch, M2_LOCAL_REPLAY ("true" or "false"), is required and reaches the container: with "true" the local
  endpoint gets `replay_reasoning = true` (Glimmer's recipe, M1a3 G1); with "false" the surface is R3R's, byte for
  byte (wiretest-m2.txt).
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent


class GnomonM2(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-m2"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        v = os.environ.get("M2_LOCAL_REPLAY")
        if v not in ("true", "false"):
            raise ValueError(f"gnomon-m2: M2_LOCAL_REPLAY must be 'true' or 'false' (got {v!r}); a cell must declare its recipe.")
        env["M2_LOCAL_REPLAY"] = v
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-m2.sh.j2"
