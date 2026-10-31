"""terminal-bench agent for H7: gnomon with its decision shadow on.

The stock gnomon adapter (gnomon_agent.py, copied unchanged from the postfix run),
plus three things the shadow needs inside the task container:

- GNOMON_SHADOW_URL: the decision server, reached through relay.mjs on the docker
  bridge. Required; a run without it would record nothing and look complete.
- DECISION_SHADOW_RUN: the trial name tb gives this trial, so every shadow record
  joins to its verdict without the gnomon session id.
- the H7 setup script, which declares [shadow] on the benchmark surface only and
  points DECISION_SHADOW_DIR at /agent-logs/shadow, which tb mounts to the host.
"""
import os
from pathlib import Path

from gnomon_agent import GnomonAgent


class GnomonShadowAgent(GnomonAgent):
    @staticmethod
    def name() -> str:
        return "gnomon-shadow"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._trial = None

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        url = os.environ.get("GNOMON_SHADOW_URL")
        if not url:
            raise ValueError("gnomon-shadow agent: GNOMON_SHADOW_URL is not set")
        if not self._trial:
            raise ValueError("gnomon-shadow agent: no trial name; perform_task sets it")
        env["GNOMON_SHADOW_URL"] = url
        env["DECISION_SHADOW_RUN"] = self._trial
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return Path(__file__).parent / "gnomon-setup-h7.sh.j2"

    def perform_task(self, instruction, session, logging_dir=None):
        # tb's agent_logging_dir is <run>/<task>/<trial>/agent-logs: its parent is
        # the trial, named <task>.<attempt>-of-<n>.<run_id>.
        self._trial = Path(logging_dir).parent.name if logging_dir else None
        return super().perform_task(instruction, session, logging_dir=logging_dir)
