"""Offline tests of run_s1_a2.py's port check (loopback sockets only, ephemeral ports; nothing under s1-2026-11/ is
written).   python3 -I -B test_run_s1_a2.py   (exit 0 when every case passes)
"""
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1_a2 as A2  # noqa: E402
B = A2.B
ORIG_PORT_FREE = B.port_free  # run_s1's, before install()

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


def listener():
    ls = socket.socket()
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as node's listeners do (relay-meter-s1, relay-go)
    ls.bind(("127.0.0.1", 0))
    ls.listen(1)
    return ls, ls.getsockname()[1]


def time_wait_port():
    """A port left holding only a server-side TIME_WAIT: a relay killed with a connection open."""
    ls, port = listener()
    cl = socket.create_connection(("127.0.0.1", port))
    sv, _ = ls.accept()
    sv.close()
    time.sleep(0.2)
    cl.close()
    ls.close()
    time.sleep(0.2)
    return port


# ---------------------------------------------------------------- port_free: LISTEN is busy, TIME_WAIT is free
ls, port = listener()
check(not A2.port_free("127.0.0.1", port), "port_free: a port with a live listener is busy")
ls.close()
port = time_wait_port()
tw = subprocess.run(["ss", "-tanH", f"sport = :{port}"], capture_output=True, text=True).stdout
check("TIME-WAIT" in tw, "fixture: the port really holds a TIME_WAIT")
check(A2.port_free("127.0.0.1", port), "port_free (Amendment 2): a TIME_WAIT is free, as node's SO_REUSEADDR bind sees it")
check(not ORIG_PORT_FREE("127.0.0.1", port),
      "negative control: run_s1's original port_free reads the same TIME_WAIT as busy (the 16:27:41Z refusal)")
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
check(True, "a SO_REUSEADDR listener (node's way) binds over that TIME_WAIT")
s.close()

# ---------------------------------------------------------------- install() routes run_s1 / run_s1_a1 through the fix
A2.install()
check(B.port_free is A2.port_free and B.start_relays is A2.start_relays, "install: run_s1's port_free and start_relays are the fixed ones")
port = time_wait_port()
real_busy = B.busy_ports  # run_s1.busy_ports, which now calls the fixed port_free
check(B.port_free("127.0.0.1", port), "install: run_s1.busy_ports' probe now treats a TIME_WAIT as free")

# ---------------------------------------------------------------- wait_ports: bounded wait for a listener going away
ls, port = listener()
B.busy_ports = lambda: [f"127.0.0.1:{port}"] if not A2.port_free("127.0.0.1", port) else []
threading.Timer(1.5, ls.close).start()
t0 = time.time()
left = A2.wait_ports(cap_s=10, every_s=0.25)
took = time.time() - t0
check(left == [] and 1.2 <= took < 4, f"wait_ports: a listener that goes away after 1.5 s is waited out ({took:.1f} s)")
ls2, port = listener()
t0 = time.time()
left = A2.wait_ports(cap_s=1.5, every_s=0.25)
took = time.time() - t0
check(left == [f"127.0.0.1:{port}"] and 1.5 <= took < 3, f"wait_ports: a listener that stays is reported after the cap ({took:.1f} s)")
A2_wait = A2.wait_ports
A2.wait_ports = lambda: [f"127.0.0.1:{port}"]
try:
    A2.start_relays()
    check(False, "start_relays: refuses when a port is still listened on after the wait")
except SystemExit as e:
    check("still listened on after 120 s" in str(e), "start_relays: refuses when a port is still listened on after the wait")
A2.wait_ports = lambda: []
called = []
A2._start_relays = lambda: called.append(1) or ["relays"]
check(A2.start_relays() == ["relays"] and called == [1], "start_relays: with every port free it starts the relays (run_s1's own start_relays)")
ls2.close()
B.busy_ports = real_busy
check(A2.PORT_WAIT_S == 120, "the wait cap is 120 s")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
