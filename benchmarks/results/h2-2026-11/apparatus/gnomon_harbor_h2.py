"""H2 arm C: arm B (gnomon_harbor_h1.GnomonV040Hosted: v0.4.0 + replay, 1M window, idle nudge off) plus ONE
change to the surface's .gnomon/system.md: the "verify in proportion / no extra checks" sentence in the
"Run what you produced" rule is replaced by a verify-every-stated-requirement sentence. The patch refuses
(exit 3) unless the v0.4.0 text is found exactly once. Everything else is arm B's run(), via the shared
_PATCH chain: B's script plus one line.
"""
from typing import override
import shlex

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import _PATCH
from gnomon_harbor_h1 import GnomonV040Hosted, HOSTED_PATCH

OLD = 'Check it once against what the task asked for, in one command\n  where you can. Verify in proportion to the task: do not build test\n  suites, helper scripts or extra checks nobody asked for, and do not\n  re-check what already passed.'
NEW = 'Before you end the turn, check the result against every requirement\n  the task states -- each file, path, format, field, edge case and\n  command it names -- and fix what fails. When the work will be graded\n  by tests you cannot see, write a quick check for each stated\n  requirement and run it. Do not end the turn while a stated\n  requirement is unverified and time remains.'
VERIFY_PATCH = r"""
const fs = require("fs");
const OLD = %s, NEW = %s;
let s = fs.readFileSync(".gnomon/system.md", "utf8");
if (s.split(OLD).length !== 2) { console.error("H2 verify patch: v0.4.0 text not found exactly once"); process.exit(3); }
fs.writeFileSync(".gnomon/system.md", s.replace(OLD, NEW));
""" % (__import__("json").dumps(OLD), __import__("json").dumps(NEW))


class GnomonV040HostedVerify(GnomonV040Hosted):
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
            f"node -e {shlex.quote(VERIFY_PATCH)} || {{ echo 'H2 verify patch failed' > /logs/agent/h2-patch-failed.txt; exit 3; }}; "
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
