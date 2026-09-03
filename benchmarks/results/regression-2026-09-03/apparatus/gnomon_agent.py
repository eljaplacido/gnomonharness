"""Terminal-Bench adapter for gnomon.

Runs gnomon through the same protocol as the built-in codex / claude-code /
opencode adapters, so a comparison varies the harness and holds the model,
dataset, container and verifier constant.
"""

import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class GnomonAgent(AbstractInstalledAgent):
    """gnomon, driven non-interactively via `gnomon task`."""

    @staticmethod
    def name() -> str:
        return "gnomon"

    def __init__(self, model_name: str, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Terminal-Bench passes provider/model. gnomon wants the model id the
        # endpoint expects, which for OpenRouter is the whole "openai/gpt-..."
        # string, so only a leading "openrouter/" is stripped.
        self._model_name = model_name
        # Terminal-Bench passes provider/model. Strip the FIRST segment only:
        # OpenRouter ids are themselves two-part ("openai/gpt-5.3-codex") and
        # must keep both halves, while an Ollama tag ("qwen3.6:35b") must lose
        # the provider entirely -- passing "ollama/qwen3.6:35b" through gets a
        # 404 from Ollama, which is exactly how this was found.
        known_providers = ("openrouter/", "ollama/", "openai/", "anthropic/")
        self._model_id = model_name
        for p in known_providers:
            if model_name.startswith(p):
                # openai/ and anthropic/ are OpenRouter-style two-part ids when
                # they are not the leading provider, so only strip a prefix
                # that leaves something behind.
                rest = model_name[len(p):]
                if rest:
                    self._model_id = rest
                break
        self._base_url = kwargs.get(
            "base_url", "https://openrouter.ai/api/v1/chat/completions"
        )
        self._api_key_env = kwargs.get("api_key_env", "OPENROUTER_API_KEY")
        # Empty for the baseline arm (no convergence forcing); a fraction like
        # "0.66" for the +P0 arm. The setup script adds it to the implement role
        # only when non-empty, so the two arms differ solely by this surface knob.
        self._converge_after = str(kwargs.get("converge_after", "")).strip()
        # The ref under test. NO DEFAULT ON PURPOSE: the setup script used to
        # hardcode a branch that drifted 131 commits behind the release, so
        # every trial measured something nobody ships. A run that cannot say
        # which commit it executed cannot support a claim about any commit, so
        # this refuses to start rather than guess.
        # Path to a file holding the timeout-retry teaching, or empty for the
        # as-released arm. A PATH rather than the text itself: multi-line prose
        # does not survive a --agent-kwarg round trip intact, and a teaching
        # that arrives truncated would silently make the two arms differ by
        # something other than what we think.
        _tp = str(kwargs.get("timeout_teaching_file", "")).strip()
        if _tp:
            self._timeout_teaching = Path(_tp).read_text()
            if not self._timeout_teaching.strip():
                raise ValueError(f"timeout_teaching_file {_tp} is empty")
        else:
            self._timeout_teaching = ""
        self._gnomon_ref = str(kwargs.get("gnomon_ref", "")).strip()
        if not self._gnomon_ref:
            raise ValueError(
                "gnomon adapter: gnomon_ref is required (a tag, branch or SHA). "
                "Pass it as an agent kwarg, e.g. gnomon_ref=v0.1.1"
            )

    @property
    def _env(self) -> dict[str, str]:
        import os

        key = os.environ.get(self._api_key_env, "")
        return {self._api_key_env: key} if key else {}

    def _get_template_variables(self) -> dict[str, str]:
        return {
            "model_id": self._model_id,
            "base_url": self._base_url,
            "api_key_env": self._api_key_env,
            "converge_after": self._converge_after,
            "gnomon_ref": self._gnomon_ref,
            "timeout_teaching": self._timeout_teaching,
        }

    @property
    def _install_agent_script_path(self) -> Path:
        # Must be the RENDERED path, not the raw .j2. Returning the template
        # itself writes the literal "{{ base_url }}" into the container config,
        # and gnomon then reports apparatus_failure on an unparseable URL --
        # which is exactly what it did, and exactly how this was found.
        return self._get_templated_script_path("gnomon-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # --yes is gnomon's unattended posture: nobody is at the terminal, so a
        # gated call would otherwise be refused rather than assumed. It is the
        # same stance --auto gives opencode and --approval-mode yolo gives omp.
        cmd = f"gnomon task {shlex.quote(instruction)} --yes"
        return [
            TerminalCommand(
                command=cmd,
                # float("inf") to match the stock codex / claude-code /
                # opencode / goose adapters. The previous expression read
                # self._timeout_sec, which Terminal-Bench never assigns, so it
                # always fell through to a 600s literal -- while opencode and
                # goose ran unbounded. gnomon's p90 on trials it PASSED is
                # 690s, so its own adapter was killing its slowest successes
                # and recording them as agent_timeout. Measured timeout rates
                # under the two regimes: gnomon 34% and forge 19% (capped) vs
                # goose 9% and opencode 6% (uncapped).
                #
                # The clock that bounds a run should be the harness's
                # --global-agent-timeout-sec, which is identical for every
                # arm, not a per-adapter literal that differs between them.
                max_timeout_sec=float("inf"),
                block=True,
            )
        ]
