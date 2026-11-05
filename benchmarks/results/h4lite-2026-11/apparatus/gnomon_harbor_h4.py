"""H4-lite arms C and G on gnomon master ae17a1ae (gnomon_harbor_m152.GnomonM152's pinned install). See ../PRE-REGISTRATION.md.

C (GnomonM152Hosted): the hosted recipe -- H1's run() byte for byte (gnomon_harbor_h1.GnomonV040Hosted.run,
HOSTED_PATCH: [endpoints.bench] replay_reasoning = true, max_context_tokens = 1000000, [turn] nudge_after_idle =
100000), as P2G41's B41 and H3's R2, on the master install. The completion gate is off (the build's default).

G (GnomonM152Gate): C plus ONE command, inserted right after HOSTED_PATCH's: `node -e GATE_PATCH`, which puts

  [verify] completion_gate = "review"

into .gnomon/policy.toml. completion_rounds, completion_min_remaining and completion_reviewer keep their defaults
(3, 0.2, "verifier"). Where init declared a [verify] check of its own (pytest/cargo/npm/make; init writes it in
policy.toml), the line joins that block, directly under its header, and the check runs identically in both arms;
otherwise a [verify] block holding only the line is appended. GATE_PATCH refuses (exit 3; the cell then has
h4-gate-patch-failed.txt and no model call) unless policy.toml ends with exactly one [verify] header, exactly one
completion_* line, and that line is `completion_gate = "review"` directly under the header: applied exactly once.
Everything else in G's script is C's, character for character (checked by wiretest_h4.py).
"""
from typing import override
import shlex

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import _PATCH
from gnomon_harbor_h1 import HOSTED_PATCH, GnomonV040Hosted
from gnomon_harbor_m152 import GnomonM152

GATE_PATCH = r"""
const fs = require("fs");
let p = fs.readFileSync(".gnomon/policy.toml", "utf8");
const die = (m) => { console.error("H4 gate patch: " + m); process.exit(3); };
if (/^\s*completion_/m.test(p)) die("policy.toml already declares a completion_* key");
const anyV = (p.match(/^[ \t]*\[[ \t]*verify[ \t]*\]/gm) || []).length;
const exactV = (p.match(/^\[verify\][ \t]*\r?$/gm) || []).length;
if (anyV !== exactV || anyV > 1) die("unexpected [verify] header(s): " + anyV + " found, " + exactV + " plain");
if (exactV === 1) p = p.replace(/^\[verify\][ \t]*\r?\n/m, (h) => h + 'completion_gate = "review"\n');
else p = p.replace(/\s*$/, "\n") + '\n[verify]\ncompletion_gate = "review"\n';
const lines = p.match(/^[ \t]*completion_[^\n]*$/gm) || [];
const ok = (p.match(/^[ \t]*\[[ \t]*verify[ \t]*\]/gm) || []).length === 1 && lines.length === 1
  && lines[0] === 'completion_gate = "review"' && /^\[verify\][ \t]*\r?\ncompletion_gate = "review"\n/m.test(p);
if (!ok) die("not applied exactly once");
fs.writeFileSync(".gnomon/policy.toml", p);
"""


class GnomonM152Hosted(GnomonM152):
    run = GnomonV040Hosted.run  # H1's script byte for byte (HOSTED_PATCH); install() is GnomonM152's

    @staticmethod
    def name() -> str:
        return "gnomon"


class GnomonM152Gate(GnomonM152):
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
            f"node -e {shlex.quote(GATE_PATCH)} || {{ echo 'H4 gate patch failed' > /logs/agent/h4-gate-patch-failed.txt; exit 3; }}; "
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
