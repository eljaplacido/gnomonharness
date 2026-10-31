"""Loopback forwarders: 127.0.0.1:<port> inside an agent container -> g2b-canary:<port>.

Shared by trial.py and negative_control.py, so the negative control exercises the
exact path a trial's agent uses."""
import socket, threading

CANARY_HOST = "g2b-canary"


def _pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def forward(port):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(64)

    def serve():
        while True:
            c, _ = srv.accept()
            try:
                u = socket.create_connection((CANARY_HOST, port), timeout=10)
                u.settimeout(None)
            except OSError:
                c.close()
                continue
            threading.Thread(target=_pipe, args=(c, u), daemon=True).start()
            threading.Thread(target=_pipe, args=(u, c), daemon=True).start()
    threading.Thread(target=serve, daemon=True).start()


