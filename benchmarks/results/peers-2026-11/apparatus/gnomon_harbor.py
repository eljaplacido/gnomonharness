"""Harbor installed-agent adapter for gnomon (peer benchmark, benchmarks/results/peers-2026-11).

    harbor run -a gnomon_harbor:Gnomon -m openai/<model> --base-url http://<host>:<port>/v1 ...

What it does, and what it refuses:

- installs gnomon at EXACTLY $GNOMON_EXPECT_SHA, fetched by SHA, never by branch. A
  branch can move under a running benchmark (it did, during H7); a SHA cannot. No
  SHA, no run.
- scaffolds a fresh surface in the task's working directory and points every role
  at the endpoint Harbor resolved for this run, so every arm talks to the same
  model the same way. Approval is "never" (headless) and the audit trail is on.
- runs `gnomon task <instruction> --role implementor --yes --json`, the role the
  August terminal-bench arms used.
- keeps what a later reader needs in /logs/agent: the task record (JSON), the audit
  trail, the surface it ran under and the commit it ran.

No ATIF trajectory is produced; these runs are local and not leaderboard submissions.
"""

import os
import shlex
from typing import override

from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat

REPO = "https://github.com/eljaplacido/gnomonharness.git"
HOME_GNOMON = "$HOME/gnomon"

# Rewrites the scaffolded surface for the benchmark. Same edits as the August
# terminal-bench setup (bench endpoint for every role, approval never, audit on).
_PATCH = r"""
const fs = require("fs"), E = process.env;
let c = fs.readFileSync(".gnomon/config.toml", "utf8");
if (!c.includes("[endpoints.bench]")) {
  c = `[endpoints.bench]\nurl = "${E.GNOMON_BENCH_URL}"\nkind = "openai"\napi_key_env = "OPENAI_API_KEY"\n\n` + c;
}
c = c.replace(/\[audit\]([\s\S]*?)enabled = false/, "[audit]$1enabled = true");
fs.writeFileSync(".gnomon/config.toml", c);
let r = fs.readFileSync(".gnomon/roles.toml", "utf8");
r = r.replace(/endpoint = "[^"]*"/g, `endpoint = "bench"`).replace(/model = "[^"]*"/g, `model = "${E.GNOMON_BENCH_MODEL}"`);
fs.writeFileSync(".gnomon/roles.toml", r);
let p = fs.readFileSync(".gnomon/policy.toml", "utf8");
if (!/\[approval\]/.test(p)) fs.writeFileSync(".gnomon/policy.toml", p + `\n[approval]\ngate = "never"\n`);
"""


class GnomonOptions(InstalledAgentOptions):
    """No knobs: the build is pinned by GNOMON_EXPECT_SHA and the surface is fixed."""


class Gnomon(BaseInstalledAgent):
    options_model = GnomonOptions
    options: GnomonOptions

    MODEL_CONNECTION = ModelConnectionSpec(
        inject_default_base_url=True,
        default_provider="openai",
        agent_provider_access=ProviderAccess(
            api_key_candidate_names=["OPENAI_API_KEY"],
            base_url_candidate_names=["OPENAI_BASE_URL"],
        ),
        api_key_destination_names={"default": "OPENAI_API_KEY"},
        base_url_destination_names={"default": "OPENAI_BASE_URL"},
        supported_api_formats=[ModelApiFormat.OPENAI_CHAT_COMPLETIONS],
        default_api_format_by_provider={"default": ModelApiFormat.OPENAI_CHAT_COMPLETIONS},
    )

    @staticmethod
    @override
    def name() -> str:
        return "gnomon"

    def _sha(self) -> str:
        sha = os.environ.get("GNOMON_EXPECT_SHA", "").strip()
        if len(sha) != 40:
            raise ValueError(
                "gnomon adapter: GNOMON_EXPECT_SHA must be a full 40-character commit SHA. "
                "A branch can move under a running benchmark; a SHA cannot."
            )
        return sha

    @override
    def get_version_command(self) -> str | None:
        return f"cd {HOME_GNOMON} && git rev-parse HEAD"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        sha = self._sha()
        await self.ensure_system_dependencies(environment, ("curl", "git"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && npm install -g pnpm@9 && "
                f"rm -rf {HOME_GNOMON} && mkdir -p {HOME_GNOMON} && cd {HOME_GNOMON} && "
                f"git init -q . && git remote add origin {REPO} && "
                f"git fetch -q --depth 1 origin {sha} && git checkout -q FETCH_HEAD && "
                f'test "$(git rev-parse HEAD)" = {sha} && '
                "pnpm install --silent"
            ),
        )

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        sha = self._sha()
        env = dict(self.model_connection.env)
        if not self.model_name:
            raise ValueError("gnomon adapter: -m <provider>/<model> is required")
        _, model = self._parse_model_name(self.model_name)
        base = env.get("OPENAI_BASE_URL", "").rstrip("/")
        if not base:
            raise ValueError("gnomon adapter: no OpenAI-compatible base URL was resolved (--base-url)")
        env.setdefault("OPENAI_API_KEY", "not-needed")
        env["GNOMON_BENCH_URL"] = f"{base}/chat/completions"
        env["GNOMON_BENCH_MODEL"] = model
        gn = f"{HOME_GNOMON}/packages/gnomon-cli/gnomon.js"
        script = (
            ". ~/.nvm/nvm.sh; set -u; "
            f'test "$(cd {HOME_GNOMON} && git rev-parse HEAD)" = {sha} || '
            "{ echo 'FATAL: wrong gnomon commit' >&2; exit 1; }; "
            f"(cd {HOME_GNOMON} && git rev-parse HEAD) > /logs/agent/gnomon-commit.txt; "
            f"node {gn} init >/dev/null 2>&1 || true; "
            f"node -e {shlex.quote(_PATCH)}; "
            "cp .gnomon/config.toml /logs/agent/surface-config.toml; "
            "cp .gnomon/roles.toml /logs/agent/surface-roles.toml; "
            f"node {gn} task {shlex.quote(instruction)} --role implementor --yes --json "
            "> /logs/agent/gnomon-task.json 2> /logs/agent/gnomon-stderr.log; "
            # gnomon's exit carries its bucket (2-4 refusal, 10-13 apparatus) by
            # contract; Harbor would read any non-zero as an agent error. The tests
            # decide pass/fail for every arm, so the exit is kept, not returned.
            "echo $? > /logs/agent/gnomon-exit.txt; "
            "cp -r .gnomon-audit /logs/agent/audit 2>/dev/null || true; "
            "exit 0"
        )
        await self.exec_as_agent(environment, command=script, env=env)
