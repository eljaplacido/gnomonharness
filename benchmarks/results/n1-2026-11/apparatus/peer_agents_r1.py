"""terminal-bench (tb 0.2.18) agent for R1: gnomon with per-role routing. Design: ../PRE-REGISTRATION.md.

One class, five arms. The arm is the model string `r1/<ARM>`; everything that
differs between arms arrives from the runner's environment, per cell:

- R1_ROUTES     role=endpoint pairs, e.g. "coordinator=cloud,implementor=local,..."
- R1_ENTRY      the role `gnomon task` starts in (implementor or coordinator)
- R1_LOCAL_URL  the metered local endpoint (llama-server through relay-meter-r1)
- R1_CLOUD_URL  the metered cloud endpoint (OpenCode Go through relay-go)
- R1_LOCAL_MODEL, R1_CLOUD_MODEL

The setup (gnomon-setup-r1.sh.j2) writes both endpoints and one profile from
R1_ROUTES into the task's fresh .gnomon/, so the surface (and its hash) differs
between arms only by that profile and the role_profile line naming it.
"""
import os
from pathlib import Path

from gnomon_agent import GnomonAgent

HERE = Path(__file__).parent
PASS = ("R1_ROUTES", "R1_ENTRY", "R1_LOCAL_URL", "R1_CLOUD_URL", "R1_LOCAL_MODEL", "R1_CLOUD_MODEL")


class GnomonR1(GnomonAgent):
    @staticmethod
    def name() -> str:
        return "gnomon-r1"

    @property
    def _env(self) -> dict[str, str]:
        ref = os.environ.get("GNOMON_REF")
        sha = os.environ.get("GNOMON_EXPECT_SHA")
        if not ref or not sha:
            raise ValueError("gnomon-r1: GNOMON_REF and GNOMON_EXPECT_SHA are required; a run that "
                             "cannot name its commit cannot support a claim about it.")
        env = {"GNOMON_REF": ref, "GNOMON_EXPECT_SHA": sha, "R1_ARM": self._model_tag}
        for k in PASS:
            v = os.environ.get(k)
            if not v:
                raise ValueError(f"gnomon-r1: {k} is not set for arm {self._model_tag}")
            env[k] = v
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-r1.sh.j2"
