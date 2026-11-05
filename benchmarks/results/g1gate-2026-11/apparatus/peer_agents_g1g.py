"""terminal-bench agent for G1 (completion gate): R1's GnomonR1 (imported, not copied), as N1's GnomonN1 is, with
the gate as the arm variable and the build delivered as pinned tarballs.

Identical to peer_agents_r1.GnomonR1 except:
- N1_STEER_ROLE (must be "user") and N1_NUDGE_AFTER_IDLE (must be "100000") are forwarded: every arm runs N1's arm-N0
  surface, held fixed;
- G1G_GATE ("off" for G0, "checklist" for G1, "review" for G2) is forwarded into the container, where
  gnomon-setup-g1g.sh.j2 writes `[verify] completion_gate = "<value>"` into policy.toml;
- before tb sources the setup, the four npm tarballs packed from master ae17a1ae and their SHA256SUMS are copied from
  G1G_DIST (../dist) into /installed-agent/gnomon-dist (tb's own copy_to_container, as it copies the setup). The
  setup checks them against the pinned hashes; nothing is downloaded for gnomon;
- the setup template is gnomon-setup-g1g.sh.j2.
Every arm uses the model string `r1/L`, so R1_ARM and the r1 profile are byte-identical between arms, and the surface
differs by the completion_gate value only (every arm reaches the same meter).
"""
import os
from pathlib import Path

from peer_agents_r1 import GnomonR1

HERE = Path(__file__).parent
GATES = ("off", "checklist", "review")
DIST_FILES = ("SHA256SUMS", "gnomon-core-0.4.2.tgz", "gnomon-natives-0.4.2.tgz", "gnomon-tui-0.4.2.tgz",
              "gnomon-harness-0.4.2.tgz")
CONTAINER_DIST = "/installed-agent/gnomon-dist"


class GnomonG1G(GnomonR1):
    @staticmethod
    def name() -> str:
        return "gnomon-g1g"

    @property
    def _env(self) -> dict[str, str]:
        env = super()._env
        sr = os.environ.get("N1_STEER_ROLE")
        if sr != "user":
            raise ValueError(f"gnomon-g1g: N1_STEER_ROLE must be 'user' in every arm, got {sr!r}")
        nv = os.environ.get("N1_NUDGE_AFTER_IDLE")
        if nv != "100000":
            raise ValueError(f"gnomon-g1g: N1_NUDGE_AFTER_IDLE must be '100000' (N0's surface) in every arm, got {nv!r}")
        g = os.environ.get("G1G_GATE")
        if g not in GATES:
            raise ValueError(f"gnomon-g1g: G1G_GATE must be one of {GATES}, got {g!r}")
        env["N1_STEER_ROLE"] = sr
        env["N1_NUDGE_AFTER_IDLE"] = nv
        env["G1G_GATE"] = g
        return env

    def dist_paths(self) -> list[Path]:
        d = os.environ.get("G1G_DIST")
        if not d:
            raise ValueError("gnomon-g1g: G1G_DIST (the directory holding the pinned tarballs) is not set")
        paths = [Path(d) / f for f in DIST_FILES]
        missing = [str(p) for p in paths if not p.is_file()]
        if missing:
            raise ValueError(f"gnomon-g1g: missing from G1G_DIST: {missing}")
        return paths

    def perform_task(self, instruction, session, logging_dir=None):
        # The env is checked first, so a bad arm never reaches the container.
        self._env
        session.copy_to_container(self.dist_paths(), container_dir=CONTAINER_DIST)
        return super().perform_task(instruction, session, logging_dir)

    @property
    def _install_agent_script_path(self) -> os.PathLike:
        return HERE / "gnomon-setup-g1g.sh.j2"
