"""H1 arm B: gnomon v0.4.0 (the release, exactly as gnomon_harbor_v040.GnomonV040 installs and pins it)
plus the hosted-model recipe, three surface lines applied after the attempt-1 _PATCH:

  [endpoints.bench] replay_reasoning = true        send the model's reasoning_content back (opencode V2 does, 54/56 and 57/60 calls in C2D)
  [endpoints.bench] max_context_tokens = 1000000   the model's published window (Go's listing), not the 65,536 default
  [turn] nudge_after_idle = 100000                 the idle nudge never fires (C2D: it fired from call 11; it fires on 51% of successful runs, PR #140)

Everything else is GnomonV040's run(), byte for byte, with one extra `node -e` line. The patch refuses (exit 3)
unless all three lines are in place, and the surface it leaves is copied to /logs/agent/ as in arm A.
"""
from typing import override
import shlex

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import _PATCH
from gnomon_harbor_v040 import GnomonV040

HOSTED_PATCH = r"""
const fs = require("fs");
let c = fs.readFileSync(".gnomon/config.toml", "utf8");
c = c.replace("[endpoints.bench]\n", "[endpoints.bench]\nreplay_reasoning = true\nmax_context_tokens = 1000000\n");
c = c.replace(/^nudge_after_idle = 12\b/m, "nudge_after_idle = 100000");
const ok = /\[endpoints\.bench\]\nreplay_reasoning = true\nmax_context_tokens = 1000000\n/.test(c) && /^nudge_after_idle = 100000\b/m.test(c);
if (!ok) { console.error("H1 hosted patch: not applied"); process.exit(3); }
fs.writeFileSync(".gnomon/config.toml", c);
"""


class GnomonV040Hosted(GnomonV040):
    @staticmethod
    @override
    def name() -> str:
        return "gnomon"

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
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
        script = (
            ". ~/.nvm/nvm.sh; set -u; "
            "cp $HOME/.gnomon-release /logs/agent/gnomon-release.txt; "
            "gnomon --version > /logs/agent/gnomon-version.txt 2>&1 || true; "
            "gnomon init >/dev/null 2>&1 || true; "
            f"node -e {shlex.quote(_PATCH)}; "
            f"node -e {shlex.quote(HOSTED_PATCH)} || {{ echo 'H1 hosted patch failed' > /logs/agent/h1-patch-failed.txt; exit 3; }}; "
            "cp .gnomon/config.toml /logs/agent/surface-config.toml; "
            "cp .gnomon/roles.toml /logs/agent/surface-roles.toml; "
            "cp .gnomon/policy.toml /logs/agent/surface-policy.toml 2>/dev/null || true; "
            "mkdir -p /logs/agent/audit-live; "
            "( while sleep 20; do [ -d .gnomon-audit ] && cp -r .gnomon-audit/. /logs/agent/audit-live/ 2>/dev/null; done ) & "
            "GN_COPIER=$!; "
            f"gnomon task {shlex.quote(instruction)} --role implementor --yes --json "
            "> /logs/agent/gnomon-task.json 2> /logs/agent/gnomon-stderr.log; "
            "echo $? > /logs/agent/gnomon-exit.txt; "
            "kill $GN_COPIER 2>/dev/null || true; "
            "cp -r .gnomon-audit /logs/agent/audit 2>/dev/null || true; "
            "exit 0"
        )
        await self.exec_as_agent(environment, command=script, env=env)
