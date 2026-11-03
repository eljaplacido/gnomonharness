"""Load finished benchmark campaigns into one cell shape. Read-only.

Every campaign's own pre-registered collector already decided which cells are
valid and wrote a summary JSON next to its runs. This module reads those JSONs
(never the collectors' console output), keeps the collectors' `state` verdicts,
and adds only what the re-analysis needs:

- the completion time of each cell (cell.json `end`, else tb's run_metadata.json
  `end_time`), for replaying a campaign in run order;
- for R1 only, an `r1-strict` variant that applies the endpoint-outage rule
  (amendment 2026-11-02, "grace spent" in the agent logs) that R1H's and M1's
  collectors apply but R1's own collector predates. M1 and S1 read R1 through
  that stricter rule, so their R1 references use it too.

Nothing here writes under the results directory.

The results root is $GNOMON_RESULTS, else ../results relative to this file.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = Path(os.environ.get("GNOMON_RESULTS", HERE.parent / "results"))


@dataclass
class Cell:
    campaign: str
    arm: str
    task: str
    k: int
    state: str
    resolved: bool | None
    usd: float = 0.0          # cloud dollars (Go allowance) for the cell
    c_tok: float = 0.0        # cloud prompt + completion tokens
    l_tok: float = 0.0        # local prompt + completion tokens
    out_tok: float = 0.0      # completion tokens, local + cloud
    req: float = 0.0          # chat requests
    gpu_s: float = 0.0        # local server busy seconds (meter gpu_ms / 1000)
    agent_s: float | None = None
    capped: bool = False      # tb agent_timeout (the 900 s cap)
    end: float | None = None  # completion time, epoch seconds
    slots: int = 1            # concurrent local-GPU slots on the lane (cell.json gpu_slots)
    id: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return self.state == "valid"

    @property
    def y(self) -> int:
        return 1 if self.resolved else 0


def _iso(s: str | None) -> float | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def _end_time(runs: Path, ids: list[str]) -> float | None:
    for cid in ids:
        d = runs / cid
        cj = d / "cell.json"
        if cj.exists():
            try:
                e = json.loads(cj.read_text()).get("end")
                if e:
                    return float(e)
            except (ValueError, OSError):
                pass
        rm = d / "run_metadata.json"
        if rm.exists():
            try:
                return _iso(json.loads(rm.read_text()).get("end_time"))
            except (ValueError, OSError):
                pass
    return None


def _slots(runs: Path, cid: str) -> int:
    cj = runs / cid / "cell.json"
    if cj.exists():
        try:
            return int(json.loads(cj.read_text()).get("gpu_slots") or 1)
        except (ValueError, OSError):
            return 1
    return 1


def sample16(root: Path = RESULTS) -> list[str]:
    return [t.strip() for t in (root / "r1h-2026-11/apparatus/sample16-hunch.txt").read_text().split()
            if t.strip()]


def _kint(k) -> int:
    return int(str(k).lstrip("k")) if str(k).lstrip("k").isdigit() else 0


def _from_r1_shape(campaign: str, c: dict, runs: Path, arm: str | None = None) -> Cell:
    """R1H / R1 / M1 / S1 collector cells (lc, cc, l_tok, c_tok, usd, gpu_s)."""
    return Cell(
        campaign=campaign, arm=arm or c["arm"], task=c["task"], k=_kint(c["k"]),
        state=c["state"], resolved=c.get("resolved"),
        usd=float(c.get("usd", 0.0) or 0.0), c_tok=float(c.get("c_tok", 0) or 0),
        l_tok=float(c.get("l_tok", 0) or 0),
        out_tok=float((c.get("l_out", 0) or 0) + (c.get("c_out", 0) or 0)),
        req=float((c.get("lc", 0) or 0) + (c.get("cc", 0) or 0)),
        gpu_s=float(c.get("gpu_s", 0.0) or 0.0), agent_s=c.get("agent_s"),
        capped=c.get("failure_mode") == "agent_timeout",
        end=_end_time(runs, [c["id"]]) if c.get("id") else None, id=c.get("id", ""),
        slots=_slots(runs, c["id"]) if c.get("id") else 1,
        extra={k: c[k] for k in ("outage", "group", "deleg") if k in c})


def _from_tokens_shape(campaign: str, c: dict, runs: Path, prefixes: list[str], local: bool) -> Cell:
    """LEAN / BUD / P1 / P1-H collector cells (a `tokens` block, allowance = $)."""
    t = c.get("tokens") or {}
    tok = float((t.get("prompt", 0) or 0) + (t.get("completion", 0) or 0))
    ids = [f"{p}-k{c['k']}-{c['arm']}-{c['task']}" for p in prefixes]
    return Cell(
        campaign=campaign, arm=c["arm"], task=c["task"], k=_kint(c["k"]),
        state=c["state"], resolved=c.get("resolved"),
        usd=float(t.get("allowance", 0.0) or 0.0),
        c_tok=0.0 if local else tok, l_tok=tok if local else 0.0,
        out_tok=float(t.get("completion", 0) or 0), req=float(t.get("requests", 0) or 0),
        agent_s=c.get("agent_s"), capped=c.get("failure_mode") == "agent_timeout",
        end=_end_time(runs, ids), id=next((i for i in ids if (runs / i).exists()), ids[0]),
        extra={"cached": t.get("cached"), "notes": c.get("notes")})


GRACE = "grace spent"


def _r1_outage(runs: Path, cid: str) -> int:
    n = 0
    for pat in ("*/*/agent-logs/gnomon-full.log", "*/*/sessions/agent.log"):
        for f in (runs / cid).glob(pat):
            try:
                n += f.read_text(errors="replace").count(GRACE)
            except OSError:
                pass
    return n


def load_campaign(name: str, root: Path = RESULTS) -> list[Cell]:
    """All cells of one campaign (every state), restricted to the 16 pre-registered tasks."""
    tasks = set(sample16(root))
    out: list[Cell] = []
    if name in ("R1H", "R1", "R1-strict"):
        sub = "r1h-2026-11" if name == "R1H" else "r1-2026-11"
        runs = root / sub / "runs"
        js = json.loads((runs / f"{sub.split('-')[0]}-summary.json").read_text())
        for c in js["cells"]:
            cell = _from_r1_shape(name, c, runs)
            if name == "R1-strict" and cell.state == "valid":
                if _r1_outage(runs, c["id"]):
                    cell.state = "endpoint_outage"
            out.append(cell)
    elif name in ("LEAN", "LEAN-local"):
        runs = root / "lean-2026-11/runs"
        f, pre, local = (("lean-summary.json", ["l"], False) if name == "LEAN"
                         else ("lean-local-summary.json", ["ll"], True))
        for c in json.loads((runs / f).read_text())["cells"]:
            out.append(_from_tokens_shape(name, c, runs, pre, local))
    elif name == "BUD":
        runs = root / "bud-2026-11/runs"
        for c in json.loads((runs / "bud-summary.json").read_text())["cells"]:
            out.append(_from_tokens_shape(name, c, runs, ["bd"], True))
    elif name == "BUD2":
        runs = root / "bud2-2026-11/runs"
        for c in json.loads((runs / "bud2-summary.json").read_text()).get("cells", []):
            out.append(_from_tokens_shape(name, c, runs, ["b2"], True))
    elif name in ("P1", "P1H"):
        sub, pre = (("peers-2026-11", ["p"]) if name == "P1" else ("p1h-2026-11", ["h", "p"]))
        runs = root / sub / "runs"
        for c in json.loads((runs / "peers-summary.json").read_text())["cells"]:
            out.append(_from_tokens_shape(name, c, runs, pre, name == "P1"))
    elif name == "M1":
        runs = root / "m1-2026-11/runs"
        for c in json.loads((runs / "m1-summary.json").read_text())["cells"]:
            out.append(_from_r1_shape(name, c, runs, arm=c["group"]))
    elif name == "M1a3":
        runs = root / "m1-2026-11/runs-a3"
        for c in json.loads((runs / "m1a3-summary.json").read_text())["cells"]:
            if c.get("group", "").startswith("m1a3"):
                out.append(_from_r1_shape(name, c, runs, arm=c["group"]))
    elif name == "S1":
        runs = root / "s1-2026-11/runs"
        for c in json.loads((runs / "s1-summary.json").read_text())["cells"]:
            if c.get("group", "").startswith("s1"):
                out.append(_from_r1_shape(name, c, runs, arm=c["group"]))
    else:
        raise KeyError(name)
    return [c for c in out if c.task in tasks]


def valid(cells: list[Cell], arm: str | None = None) -> list[Cell]:
    return [c for c in cells if c.valid and (arm is None or c.arm == arm)]


def s1_done(root: Path = RESULTS) -> bool:
    st = root / "s1-2026-11/STATUS.txt"
    if not st.exists():
        return False
    lines = [l for l in st.read_text().splitlines() if l.strip()]
    return bool(lines) and re.search(r"\bDONE\b", lines[-1]) is not None


def relabel(cells: list[Cell], arm: str, new: str, campaign: str | None = None) -> list[Cell]:
    """Copy one arm's cells under a new arm label (for cross-campaign pairs)."""
    from dataclasses import replace
    return [replace(c, arm=new, campaign=campaign or c.campaign) for c in cells if c.arm == arm]
