"""terminal-bench installed-agent for gnomon.

Installs gnomon into each task container (node + pnpm, no Rust build) and runs
`gnomon task <instruction>` against a model endpoint. Model routing:
  --model openrouter/<or-model>   -> OpenRouter, key from OPENROUTER_API_KEY
  --model local/<tag>             -> a llama-server on host.docker.internal:18080
Use with:  tb run --agent-import-path <this_file>:GnomonAgent --model openrouter/deepseek/deepseek-v4-flash-latest
"""
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class GnomonAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "gnomon"

    def __init__(self, model_name: str, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_name = model_name
        parts = model_name.split("/", 1)
        self._provider = parts[0]
        self._model_tag = parts[1] if len(parts) > 1 else model_name

    @property
    def _env(self) -> dict[str, str]:
        env = {"GNOMON_BENCH_MODEL": self._model_tag}
        # The ref under test must reach the CONTAINER, not merely the shell that
        # launched it. Setting GNOMON_REF outside and not forwarding it here is
        # why a smoke run pinned to bench/post-audit-2026-08-31 recorded
        # `master` instead: the clone inside the container saw no variable, took
        # its default, and succeeded -- so nothing failed, and the trial simply
        # measured a different commit than the one it claimed.
        #
        # Required, not defaulted. A benchmark that cannot say which commit it
        # ran is a benchmark that cannot support a claim about that commit, and
        # falling back to master is exactly how three earlier arms became
        # unattributable.
        ref = os.environ.get("GNOMON_REF")
        if not ref:
            raise ValueError(
                "gnomon agent: GNOMON_REF is not set. Pin the ref under test explicitly; "
                "defaulting to master is how a run silently measures something nobody chose."
            )
        env["GNOMON_REF"] = ref
        if os.environ.get("GNOMON_EXPECT_SHA"):
            env["GNOMON_EXPECT_SHA"] = os.environ["GNOMON_EXPECT_SHA"]
        if self._provider == "openrouter":
            env["GNOMON_BENCH_URL"] = "https://openrouter.ai/api/v1/chat/completions"
            env["GNOMON_BENCH_KEYENV"] = "OPENROUTER_API_KEY"
            if "OPENROUTER_API_KEY" in os.environ:
                env["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_API_KEY"]
        elif self._provider == "local":
            env["GNOMON_BENCH_URL"] = os.environ.get(
                "GNOMON_LOCAL_URL", "http://host.docker.internal:18080/v1/chat/completions")
            env["GNOMON_BENCH_KEYENV"] = ""
        else:
            raise ValueError(f"gnomon agent: unknown provider '{self._provider}'")
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return Path(__file__).parent / "gnomon-setup.sh.j2"

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        return [
            TerminalCommand(
                command=f"bash /opt/gnomon-run.sh {shlex.quote(instruction)}",
                max_timeout_sec=float("inf"),  # match the stock adapters; --global-agent-timeout-sec governs
                block=True,
            )
        ]
