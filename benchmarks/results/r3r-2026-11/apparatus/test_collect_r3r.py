"""Offline tests of collect_r3r.py's smoke gate on REAL cells: R1H's own smoke cells (../../r1h-2026-11/runs-smoke, read
only) are copied into a temp BENCH under R3R's ids. As they are (gnomon d59e6c19, unstreamed, no output limit) they
must FAIL R3R's smoke; patched to what a v0.4.0 cell records (the commit, the surface's [defaults], the local meter's
stream/max_tokens counts) they must PASS, with NEG still required to read misrouted. Writes only a temp dir it removes.
    python3 -I -B test_collect_r3r.py   (exit 0 when all pass)
"""
import io
import json
import re
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_r3r as K  # noqa: E402

SRC = HERE.parent.parent / "r1h-2026-11" / "runs-smoke"
PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    PASS, FAIL = (PASS + 1, FAIL) if cond else (PASS, FAIL + 1)
    print(f"{'ok  ' if cond else 'FAIL'}  {what}")


def smoke(d: Path) -> tuple[int, str]:
    K.SMOKE_DIR = d
    buf = io.StringIO()
    with redirect_stdout(buf):
        try:
            K.smoke()
            code = 0
        except SystemExit as e:
            code = e.code
    return code, buf.getvalue()


def fresh(T: Path) -> Path:
    d = T / "runs-smoke"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    for a in ("l", "c", "pc", "neg"):
        shutil.copytree(SRC / f"r1h-s-{a}-hello-world", d / f"r3r-s-{a}-hello-world")
    return d


def to_v040(d: Path, skip: set = frozenset()) -> None:
    for cell in d.iterdir():
        meta = json.loads((cell / "cell.json").read_text())
        meta["sha"] = K.SHA
        (cell / "cell.json").write_text(json.dumps(meta))
        logs = next(cell.glob("*/*/agent-logs"))
        if "commit" not in skip:
            (logs / "gnomon-commit.txt").write_text(K.SHA + "\nHEAD\n")
        if "surface" not in skip:
            s = (logs / "surface-config.toml").read_text()
            s = re.sub(r"^(max_context_tokens = 65536)$", r"\1\nstream = true\nmax_tokens = 32768", s, count=1, flags=re.M)
            (logs / "surface-config.toml").write_text(s)
        t = json.loads((cell / "tokens.json").read_text())
        n = t["local"]["after"].get("chat_requests", 0) - t["local"]["before"].get("chat_requests", 0)
        t["local"]["before"].update(req_stream=0, req_max_tokens=0)
        t["local"]["after"].update(req_stream=0 if "stream" in skip else n, req_max_tokens=n)
        (cell / "tokens.json").write_text(json.dumps(t))


if not SRC.is_dir():
    sys.exit(f"{SRC} not found")
T = Path(tempfile.mkdtemp(prefix="r3r-collect-test-"))
try:
    d = fresh(T)
    code, out = smoke(d)
    check(code == 1 and out.rstrip().endswith("smoke: FAIL"), "R1H's own smoke cells (d59e6c19) fail R3R's smoke")
    check("not v0.4.0" in out and "surface [defaults] is not v0.4.0's" in out and "unstreamed or without max_tokens" in out,
          "... for the stated reasons: the commit, the surface's [defaults], unstreamed local requests")
    check("expected" not in out, "... and not for validity: L, C, PC are valid and NEG reads misrouted, as in R1H's smoke")

    d = fresh(T)
    to_v040(d)
    code, out = smoke(d)
    check(code == 0 and out.rstrip().endswith("smoke: PASS"), "the same cells patched to v0.4.0's records pass")
    check(re.search(r"r3r-s-neg-hello-world +misrouted", out) and re.search(r"r3r-s-pc-hello-world +valid .*implementor", out),
          "NEG reads misrouted (the routing check detects); PC is valid and delegated to the implementor")

    for what, why in (("commit", "not v0.4.0"), ("surface", "surface [defaults]"), ("stream", "unstreamed")):
        d = fresh(T)
        to_v040(d, skip={what})
        code, out = smoke(d)
        check(code == 1 and why in out, f"one defect ({what}) is enough to fail the smoke")

    d = fresh(T)
    to_v040(d)
    t = json.loads((d / "r3r-s-neg-hello-world" / "tokens.json").read_text())
    t["local"]["after"]["chat_requests"] = t["local"]["before"].get("chat_requests", 0) + 3
    t["cloud"]["after"]["chat_requests"] = t["cloud"]["before"].get("chat_requests", 0)
    t["local"]["after"].update(req_stream=3, req_max_tokens=3)
    (d / "r3r-s-neg-hello-world" / "tokens.json").write_text(json.dumps(t))
    code, out = smoke(d)
    check(code == 1 and "expected misrouted" in out, "a NEG cell that reads like a real L cell fails the smoke (the negative control must bite)")

    d = fresh(T)
    to_v040(d)
    shutil.rmtree(d / "r3r-s-c-hello-world")
    code, out = smoke(d)
    check(code == 1, "a smoke with an arm missing fails")
finally:
    shutil.rmtree(T, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
