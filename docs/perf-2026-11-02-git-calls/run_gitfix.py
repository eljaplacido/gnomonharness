"""UX1W warm one-turn, two arms only: gnomon master (891b559) vs perf/fewer-git-calls.
Reuses run_ux1w.py unchanged; adds the gitfix arm exactly like gnomon-master."""
import sys
import run_ux1w as u

_orig = u.arms


def arms(base, port):
    a = _orig(base, port)
    p = u.TOOLS / "gnomon-gitfix"
    a["gnomon-gitfix"] = {
        "cmd": u.gnomon_cli(p) + ["task", u.PROMPT, "--role", "implementor", "--yes"],
        "env": {}, "setup": u.setup_gnomon_with(p), "fake": {},
        "version": u.gnomon_cli(p) + ["--version"],
    }
    return a


u.arms = arms
u.ARM_NAMES = ["gnomon-master", "gnomon-gitfix"]
sys.argv = ["run_ux1w.py", "warm", sys.argv[1] if len(sys.argv) > 1 else "20"]
u.main()
