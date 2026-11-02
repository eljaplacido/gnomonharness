"""Harbor installed-agent adapter for gnomon (P2, benchmarks/results/p2-2026-11).

    harbor run --agent-import-path gnomon_harbor:Gnomon -m openai/<model> ...

What it does, and what it refuses:

- installs gnomon as a user gets it: the public release tarballs of
  $GNOMON_RELEASE (default 0.3.1), each checked against the release's own
  SHA256SUMS before anything is installed -- the check scripts/install.sh makes.
  A mismatch or a missing file stops the install. The release and the tarball
  checksum are recorded per trial; `gnomon --version` cannot identify an
  installed copy before PR #58, so it is not used for that.
- scaffolds a fresh surface in the task's working directory and points every
  role, and every profile, at the endpoint Harbor resolved for this run.
  `gnomon init` scaffolds role_profile = "local_first", which is merged over
  roles.toml field by field, so the profiles are rewritten too (the P1 fix).
  Approval is "never" (headless) and the audit trail is on.
- runs `gnomon task <instruction> --role implementor --yes --json`.
- keeps what a later reader needs in /logs/agent: the task record (JSON), the
  audit trail, the surface it ran under and the release it ran.

No ATIF trajectory is produced; these runs are not leaderboard submissions.
"""

import os
import shlex
from typing import override

from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat

RELEASES = "https://github.com/eljaplacido/gnomonharness/releases/download"

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
const point = (t) => t.replace(/endpoint = "[^"]*"/g, `endpoint = "bench"`).replace(/model = "[^"]*"/g, `model = "${E.GNOMON_BENCH_MODEL}"`);
fs.writeFileSync(".gnomon/roles.toml", point(fs.readFileSync(".gnomon/roles.toml", "utf8")));
// role_profile is merged over roles.toml per field: every profile gets the same rewrite.
const pd = ".gnomon/profiles";
if (fs.existsSync(pd)) for (const f of fs.readdirSync(pd)) {
  if (f.endsWith(".toml")) fs.writeFileSync(pd + "/" + f, point(fs.readFileSync(pd + "/" + f, "utf8")));
}
let p = fs.readFileSync(".gnomon/policy.toml", "utf8");
if (!/\[approval\]/.test(p)) fs.writeFileSync(".gnomon/policy.toml", p + `\n[approval]\ngate = "never"\n`);
"""


class GnomonOptions(InstalledAgentOptions):
    """No knobs: the build is pinned by GNOMON_EXPECT_SHA and the surface is fixed."""


class Gnomon(BaseInstalledAgent):
    options_model = GnomonOptions
    options: GnomonOptions
    # Harbor refuses `--ak base_url=` unless an agent declares it; every arm in P2
    # is pointed at the relay this way.
    capabilities = AgentCapabilities(base_url=True)

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

    def _release(self) -> str:
        v = os.environ.get("GNOMON_RELEASE", "0.3.1").strip()
        if not v or v in ("latest", "stable"):
            raise ValueError("gnomon adapter: GNOMON_RELEASE must be a version; 'latest' is not one")
        return v

    @override
    def get_version_command(self) -> str | None:
        return "cat $HOME/.gnomon-release"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        v = self._release()
        base = f"{RELEASES}/v{v}"
        pkgs = ("gnomon-core", "gnomon-natives", "gnomon-tui", "gnomon-harness")
        fetch = " && ".join(f"curl -fsSLO {base}/{p}-{v}.tgz" for p in pkgs)
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "rm -rf $HOME/gnomon-release && mkdir -p $HOME/gnomon-release && cd $HOME/gnomon-release && "
                f"curl -fsSLO {base}/SHA256SUMS && {fetch} && "
                # Every tarball must be listed and must match; --ignore-missing would
                # accept a file the sums do not mention, so count the OK lines instead.
                f'test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-{v}.tgz: OK")" = 4 && '
                f"npm i -g --silent {' '.join(f'./{p}-{v}.tgz' for p in pkgs)} && "
                f'echo "gnomon v{v} $(grep gnomon-harness-{v}.tgz SHA256SUMS | cut -c1-16)" > $HOME/.gnomon-release'
            ),
        )

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
            "gnomon init >/dev/null 2>&1 || true; "
            f"node -e {shlex.quote(_PATCH)}; "
            "cp .gnomon/config.toml /logs/agent/surface-config.toml; "
            "cp .gnomon/roles.toml /logs/agent/surface-roles.toml; "
            f"gnomon task {shlex.quote(instruction)} --role implementor --yes --json "
            "> /logs/agent/gnomon-task.json 2> /logs/agent/gnomon-stderr.log; "
            # gnomon's exit carries its bucket (2-4 refusal, 10-13 apparatus) by
            # contract; Harbor would read any non-zero as an agent error. The tests
            # decide pass/fail for every arm, so the exit is kept, not returned.
            "echo $? > /logs/agent/gnomon-exit.txt; "
            "cp -r .gnomon-audit /logs/agent/audit 2>/dev/null || true; "
            "exit 0"
        )
        await self.exec_as_agent(environment, command=script, env=env)
