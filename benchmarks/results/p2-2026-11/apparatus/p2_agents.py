"""Harbor agents for P2 that the stock adapters cannot provide as pinned.

- Gnomon       (gnomon_harbor.py): the v0.3.1 release tarballs, checksum-verified.
- OpencodeV2:  opencode V2 v2.2.5. Harbor's stock adapter installs `opencode-ai`
               from npm, which is the V1 line (1.19.5 on 2026-10-31), and drives
               V1's flags. V2 ships only as GitHub release binaries, so this
               installs the exact release tarball (as P1 does) and runs it the way
               P1 does: `run --standalone --auto`, where --auto approves every
               permission not explicitly denied -- the consent every arm runs with.
- AiderPinned: aider-chat 0.86.2. The stock adapter runs aider.chat/install.sh,
               which installs whatever is newest; a benchmark arm needs a version.

Every other arm is Harbor's stock adapter with `--ak version=<pin>`.
"""
import json
import shlex
from typing import override

from harbor.agents.installed.aider import Aider
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import Gnomon  # noqa: F401  (re-exported for --agent p2_agents:Gnomon)

OPENCODE_V2 = "v2.2.5"
AIDER = "0.86.2"
PROVIDER = "p2go"  # the provider id opencode's config gives the relay


class OpencodeV2(OpenCode):
    @staticmethod
    @override
    def name() -> str:
        return "opencode-v2"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "bash", "coreutils", "tar"))
        url = (f"https://github.com/anomalyco/opencode/releases/download/{OPENCODE_V2}/"
               "opencode-linux-$arch$libc.tar.gz")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac; '
                'libc=""; ldd --version 2>&1 | grep -qi musl && libc="-musl"; '
                "mkdir -p $HOME/.opencode-v2 $HOME/.local/bin && "
                f'curl -fsSL "{url}" -o /tmp/opencode.tar.gz && '
                "tar xzf /tmp/opencode.tar.gz -C $HOME/.opencode-v2 && "
                "ln -sf $HOME/.opencode-v2/opencode $HOME/.local/bin/opencode && "
                "$HOME/.local/bin/opencode --version"
            ),
        )

    @override
    def get_version_command(self) -> str | None:
        return "$HOME/.local/bin/opencode --version"

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        _, model = self._parse_model_name(self.model_name)
        env = dict(self.model_connection.env)
        base = (env.get("OPENAI_BASE_URL") or env.get("OPENAI_API_BASE") or "").rstrip("/")
        if not base:
            raise ValueError("opencode-v2: no base URL resolved (--ak base_url=...)")
        env["OPENCODE_DISABLE_AUTOUPDATE"] = "1"
        env.setdefault("OPENAI_API_KEY", "not-needed")
        config = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {PROVIDER: {
                "npm": "@ai-sdk/openai-compatible", "name": "P2 relay to OpenCode Go",
                "options": {"baseURL": base, "apiKey": "{env:OPENAI_API_KEY}"},
                "models": {model: {"name": model}},
            }},
        }
        log = shlex.quote((self.environment_logs_dir / "opencode-v2.txt").as_posix())
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.config/opencode && "
                f"printf '%s' {shlex.quote(json.dumps(config))} > $HOME/.config/opencode/opencode.json && "
                f"cp $HOME/.config/opencode/opencode.json {shlex.quote((self.environment_logs_dir / 'opencode-config.json').as_posix())}; "
                f"$HOME/.local/bin/opencode run --standalone --auto -m {shlex.quote(PROVIDER + '/' + model)} "
                f"{shlex.quote(instruction)} 2>&1 </dev/null | tee {log}"
            ),
            env=env,
        )


class AiderPinned(Aider):
    @staticmethod
    @override
    def name() -> str:
        return "aider-pinned"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "git", "coreutils"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if ! command -v uv >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi; "
                'export PATH="$HOME/.local/bin:$PATH"; '
                f"uv tool install --python 3.12 aider-chat=={AIDER} && aider --version"
            ),
        )
