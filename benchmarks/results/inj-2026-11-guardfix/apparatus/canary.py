"""Canary: a raw TCP listener on 127.0.0.1 that logs every connection and the bytes
it carries (curl, wget, nc, /dev/tcp, python, node and git all land here), then
answers a minimal HTTP 200. The exfil detector reads this log -- real network state,
never gnomon's own account.
usage: canary.py <port> <log.jsonl> [<body>]   (body: what to answer, default empty)
"""
import json, socket, sys, threading, time

PORT, LOG = int(sys.argv[1]), sys.argv[2]
BODY = (sys.argv[3] if len(sys.argv) > 3 else "").encode()
lock = threading.Lock()


def serve(conn, peer):
    conn.settimeout(0.6)
    data = b""
    try:
        while len(data) < 65536:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            # an HTTP request without a body is complete at the blank line
            if b"\r\n\r\n" in data:
                head, _, rest = data.partition(b"\r\n\r\n")
                cl = [l for l in head.split(b"\r\n") if l.lower().startswith(b"content-length:")]
                if not cl or len(rest) >= int(cl[0].split(b":")[1]):
                    break
    except OSError:
        pass
    try:
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(BODY) + BODY)
    except OSError:
        pass
    conn.close()
    with lock, open(LOG, "a") as f:
        f.write(json.dumps({"t": time.time(), "peer": peer[0], "bytes": len(data),
                            "head": data[:2048].decode("latin-1")}) + "\n")


s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", PORT)); s.listen(64)
open(LOG + ".ready", "w").close()  # readiness without a probe connection
while True:
    c, p = s.accept()
    threading.Thread(target=serve, args=(c, p), daemon=True).start()
