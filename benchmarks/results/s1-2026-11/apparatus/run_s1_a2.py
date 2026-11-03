"""S1 Amendment 2 entry point: run_s1.py and run_s1_a1.py (both imported, unchanged) with the meter-port check
fixed. Design: ../AMENDMENT-2-DRAFT.md.

The bug (2026-11-03T16:27:41Z, STATUS): run_s1.port_free binds its probe socket WITHOUT SO_REUSEADDR, so a port
holding only a TIME_WAIT connection -- left by the smoke's relays, killed seconds earlier with a connection open --
read as "in use", and the full runner refused to start ("S1 meter ports in use: 127.0.0.1:5421"). node's listeners
(relay-meter-s1, relay-go) bind with SO_REUSEADDR and take such a port without trouble. Fixed here, as the R3R
copy fixed it (../../r3r-2026-11/apparatus/run_r3r.py):
1. port_free sets SO_REUSEADDR before its probe bind: a port is busy only when something LISTENS on it;
2. before refusing, the runner waits up to PORT_WAIT_S (120 s) for a listener that is still going away (the
   previous runner's relays), re-checking every 5 s; run_s1.start_relays then checks again, as before.
Everything else is run_s1.py's (smoke) and run_s1_a1.py's (plan, full, abort-inflight), unchanged.

  python3 -I run_s1_a2.py smoke                         run_s1.py smoke, with the fixed port check
  python3 -I run_s1_a2.py plan | full                   run_s1_a1.py, with the fixed port check
  python3 -I run_s1_a2.py abort-inflight <runs|runs-smoke> <reason>
"""
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1_a1 as A1  # noqa: E402
B = A1.B                # run_s1, the module both use

PORT_WAIT_S = 120


def port_free(addr: str, port: int) -> bool:
    """Free = nothing LISTENS there. SO_REUSEADDR as node sets it, so a TIME_WAIT is not 'in use'."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_ports(cap_s: float = PORT_WAIT_S, every_s: float = 5.0) -> list[str]:
    """The busy meter ports after waiting up to cap_s for them to free (empty = all free)."""
    t0 = time.time()
    busy = B.busy_ports()
    while busy and time.time() - t0 < cap_s:
        time.sleep(every_s)
        busy = B.busy_ports()
    return busy


_start_relays = B.start_relays


def start_relays():
    busy = wait_ports()
    if busy:
        raise SystemExit(f"S1 meter ports still listened on after {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
    return _start_relays()


def install() -> None:
    """Route every port check of run_s1 / run_s1_a1 through the fixed functions (module globals, read at call time)."""
    B.port_free = port_free
    B.start_relays = start_relays


def main() -> None:
    install()
    if sys.argv[1:2] == ["smoke"] and len(sys.argv) == 2:
        B.main()
    else:
        A1.main()


if __name__ == "__main__":
    main()
