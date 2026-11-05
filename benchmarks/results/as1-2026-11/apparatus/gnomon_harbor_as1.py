"""AS1's one gnomon adapter: the pinned build from build.toml, and the surface from a compiled TOML-fragment spec.

    harbor run --agent-import-path gnomon_harbor_as1:GnomonAS1 -m openai/<model> ...
    (Harbor's environment: AS1_SPEC=<runs/<cell>/spec.json>, AS1_SPEC_SHA256=<its hash>, AS1_BUILD=<build.toml>)

Every arm, the control and the A/A arm run this one class; an arm is data (arms/*.toml), never code. What it does:

- install(): the build in build.toml, pinned three ways exactly as H3's gnomon_harbor_v042 pins v0.4.2 (SHA256SUMS
  hashes to sums_sha256; each of the four tarballs matches it; gnomonBuild and `gnomon --version` match). Any mismatch
  stops the install and the cell is an apparatus failure. GNOMON_REL_BASE may point at a local mirror of the same
  files (the hash pins make the source irrelevant; it also removes the GitHub download that failed with a DNS error
  in two P2G41 cells).
- run(): `gnomon init`, P2G's attempt-1 _PATCH (bench endpoint for every role and profile, approval never, audit on),
  then the spec's compiled patch (surface_patch.compile_js), which refuses (exit 3, as1-patch-failed.txt, no model
  call) unless every edit landed exactly once; the surface it leaves is copied to /logs/agent/. Then
  `gnomon task <instruction> --role <spec role> <spec task_args> --yes --json` with the spec's env.
- The surface root: ./.gnomon, or, when the working directory is read-only, the state directory PR #153 falls back
  to ($XDG_STATE_HOME/gnomon/workdirs/<hash>/, found by its .gnomon/config.toml). The pre-launch wire test runs a
  read-only working directory to prove the path on the pinned build.
- Observability as H3: a 20 s copy of the live audit trail, the final trail, the record, stderr, the exit code.
"""
from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path
from typing import override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from gnomon_harbor import Gnomon, RELEASES, _PATCH

import surface_patch as SP

HERE = Path(__file__).resolve().parent
PKGS = ("gnomon-core", "gnomon-natives", "gnomon-tui", "gnomon-harness")


def load_build(path: str | os.PathLike | None = None) -> dict:
    p = Path(path or os.environ.get("AS1_BUILD") or HERE / "build.toml")
    b = tomllib.loads(p.read_text(encoding="utf-8"))["build"]
    if b.get("status") != "ready":
        raise ValueError(f"AS1 adapter: {p} status is {b.get('status')!r}, not 'ready'")
    bad = [k for k, v in b.items() if isinstance(v, str) and "{{" in v]
    if bad:
        raise ValueError(f"AS1 adapter: {p} still has placeholders in {bad}")
    return b


def load_spec() -> dict:
    p = os.environ.get("AS1_SPEC")
    if not p:
        raise ValueError("AS1 adapter: AS1_SPEC is not set")
    spec = json.loads(Path(p).read_text(encoding="utf-8"))
    if SP.spec_hash(spec) != spec.get("sha256") or spec.get("sha256") != os.environ.get("AS1_SPEC_SHA256"):
        raise ValueError("AS1 adapter: the spec's hash does not match AS1_SPEC_SHA256")
    return spec


def install_command(b: dict, base: str) -> str:
    v, build = b["version"], b["build_stamp"]
    fetch = " && ".join(f"curl -fsSLO {base}/v{v}/{p}-{v}.tgz" for p in PKGS)
    return (
        "set -euo pipefail; "
        f"{nvm_node_install_snippet()} && "
        "rm -rf $HOME/gnomon-release && mkdir -p $HOME/gnomon-release && cd $HOME/gnomon-release && "
        f"curl -fsSLO {base}/v{v}/SHA256SUMS && "
        f'echo "{b["sums_sha256"]}  SHA256SUMS" | sha256sum -c - >/dev/null && '
        f"{fetch} && "
        f'test "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-{v}.tgz: OK")" = 4 && '
        f"npm i -g --silent {' '.join(f'./{p}-{v}.tgz' for p in PKGS)} && "
        f'test "$(node -p "require(\\"$(npm root -g)/gnomon-core/package.json\\").gnomonBuild")" = "{build}" && '
        f'test "$(gnomon --version 2>/dev/null | tail -1)" = "gnomon/{v}+{build}" && '
        f'echo "gnomon v{v} {b["commit"][:16]} $(grep gnomon-harness-{v}.tgz SHA256SUMS | cut -c1-16)" > $HOME/.gnomon-release'
    )


class GnomonAS1(Gnomon):
    @staticmethod
    @override
    def name() -> str:
        return "gnomon"

    @override
    def _release(self) -> str:
        return load_build()["version"]

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        b = load_build()
        base = os.environ.get("GNOMON_REL_BASE", RELEASES).rstrip("/")
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(environment, command=install_command(b, base))

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
        await self.exec_as_agent(environment, command=SP.run_script(load_spec(), instruction, _PATCH), env=env)
