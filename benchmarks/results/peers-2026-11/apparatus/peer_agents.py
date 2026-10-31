"""terminal-bench (tb 0.2.18) agents for the peer benchmark. Design: ../PRE-REGISTRATION.md.

Four arms, one model. Every arm talks to the same llama-server through relay.mjs on
the docker bridge (PEER_MODEL_URL, an OpenAI-compatible /v1 base). Every version is
pinned in the arm's own setup script and recorded per trial in
/agent-logs/arm-version.txt; "latest" and "stable" are not versions.

- GnomonPeer:    gnomon 0.3.1 (release 7012c5a), fetched by SHA; the August adapter.
- MiniSwePeer:   mini-swe-agent 2.4.6, tb's own run command.
- GoosePeer:     goose v1.57.0, tb's own recipe and run command.
- QwenPeer:      Qwen Code 0.26.4. tb's adapter pipes the task into `qwen` with no
                 approval mode, which on current versions can stall on a tool
                 prompt; the documented headless form (`-p ... --approval-mode yolo`)
                 is used instead, the same autonomy every other arm runs with.
"""
import os
import shlex
from pathlib import Path

from gnomon_agent import GnomonAgent
from terminal_bench.agents.installed_agents.goose.goose_agent import GooseAgent
from terminal_bench.agents.installed_agents.mini_swe_agent.mini_swe_agent import MiniSweAgent
from terminal_bench.agents.installed_agents.qwen_code.qwen_code import QwenCodeAgent
from terminal_bench.terminal.models import TerminalCommand

HERE = Path(__file__).parent


def _base() -> str:
    url = os.environ.get("PEER_MODEL_URL", "").rstrip("/")
    if not url.endswith("/v1"):
        raise ValueError("PEER_MODEL_URL must be an OpenAI-compatible base ending in /v1")
    return url


class GnomonPeer(GnomonAgent):
    @staticmethod
    def name() -> str:
        return "gnomon-peer"

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-peers.sh.j2"


class MiniSwePeer(MiniSweAgent):
    VERSION = "2.4.6"

    @staticmethod
    def name() -> str:
        return "mini-swe-agent-peer"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        env.update({
            "OPENAI_API_BASE": _base(),
            "OPENAI_BASE_URL": _base(),
            "MSWEA_COST_TRACKING": "ignore_errors",
            "PEER_VERSION": self.VERSION,
        })
        return env

    @property
    def _install_agent_script_path(self) -> Path:
        return HERE / "mini-setup-peers.sh"


class GoosePeer(GooseAgent):
    VERSION = "v1.57.0"

    @staticmethod
    def name() -> str:
        return "goose-peer"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        host = _base().removesuffix("/v1")
        env.update({
            "OPENAI_HOST": host,
            "OPENAI_BASE_PATH": "v1/chat/completions",
            "GOOSE_VERSION": self.VERSION,
        })
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "goose-setup-peers.sh"


class QwenPeer(QwenCodeAgent):
    VERSION = "0.26.4"

    @staticmethod
    def name() -> str:
        return "qwen-code-peer"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        # tb passes "local/<model>"; Qwen Code wants the bare model id.
        model = model_name.split("/", 1)[1] if model_name and "/" in model_name else model_name
        super().__init__(model, *args, base_url=_base(), **kwargs)

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        env["PEER_VERSION"] = self.VERSION
        return env

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "qwen-setup-peers.sh"

    def _run_agent_commands(self, task_description: str) -> list[TerminalCommand]:
        return [
            TerminalCommand(
                command=(
                    'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; '
                    f"qwen -p {shlex.quote(task_description)} --approval-mode yolo "
                    "2>&1 | tee /agent-logs/qwen.log"
                ),
                max_timeout_sec=float("inf"),
                block=True,
            )
        ]
