"""H3 arms R1 and R2 on gnomon v0.4.2 (gnomon_harbor_v042.GnomonV042's pinned install). See ../PRE-REGISTRATION.md.

R0 is gnomon_harbor_v042.GnomonV042 itself (release defaults).

R1 (GnomonV042Replay): R0 plus ONE surface line, applied after the attempt-1 _PATCH:

  [endpoints.bench] replay_reasoning = true

Its run() is H1 arm B's run() (gnomon_harbor_h1.GnomonV040Hosted.run) with HOSTED_PATCH swapped for REPLAY_PATCH and
the failure marker renamed; nothing else. REPLAY_PATCH refuses (exit 3, the cell then has h3-replay-patch-failed.txt
and no model call) unless the line is in place exactly once, and unless max_context_tokens and nudge_after_idle are
still the release's own (65536, 12): it is one variable, checked.

R2 (GnomonV042Hosted): R0 plus the full hosted recipe -- H1's run() byte for byte (HOSTED_PATCH: replay_reasoning,
max_context_tokens 1,000,000, nudge_after_idle 100000), as P2G41's B41 but on the v0.4.2 install.
"""
from typing import override
import shlex

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import _PATCH
from gnomon_harbor_h1 import GnomonV040Hosted
from gnomon_harbor_v042 import GnomonV042

REPLAY_PATCH = r"""
const fs = require("fs");
let c = fs.readFileSync(".gnomon/config.toml", "utf8");
c = c.replace("[endpoints.bench]\n", "[endpoints.bench]\nreplay_reasoning = true\n");
const ok = /\[endpoints\.bench\]\nreplay_reasoning = true\n/.test(c) && (c.match(/replay_reasoning/g) || []).length === 1
  && /^max_context_tokens = 65536\b/m.test(c) && (c.match(/^max_context_tokens\s*=/gm) || []).length === 1
  && /^nudge_after_idle = 12\b/m.test(c);
if (!ok) { console.error("H3 replay patch: not applied"); process.exit(3); }
fs.writeFileSync(".gnomon/config.toml", c);
"""


class GnomonV042Replay(GnomonV042):
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
            f"node -e {shlex.quote(REPLAY_PATCH)} || {{ echo 'H3 replay patch failed' > /logs/agent/h3-replay-patch-failed.txt; exit 3; }}; "
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


class GnomonV042Hosted(GnomonV042):
    run = GnomonV040Hosted.run  # H1's script byte for byte (HOSTED_PATCH); install() is GnomonV042's

    @staticmethod
    def name() -> str:
        return "gnomon"
