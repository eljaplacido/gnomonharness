"""Offline tests of probe_lane_m2.py against fake lanes on 127.0.0.1 (no GPU): a correct MTP lane passes; a lane that
garbles a count, loses the needle at long context, breaks the tool call, or accepts no drafts fails; a lane without
spec-decode metrics fails only when they are required; the steer probe classifies refused / delivered / dropped.
    python3 -I -B test_probe_lane_m2.py   (exit 0 when all pass)
"""
import io
import json
import re
import sys
import threading
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import probe_lane_m2 as P  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


def lane(mode):
    state = {"acc": 0}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj, ctype="application/json"):
            b = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path == "/metrics" and mode != "nometrics":
                d = state["acc"]
                self._send(200, (f"vllm:spec_decode_num_accepted_tokens_total{{model_name=\"q\"}} {0 if mode == 'noaccept' else d * 2}\n"
                                 f"vllm:spec_decode_num_draft_tokens_total{{model_name=\"q\"}} {d * 3}\n").encode(), "text/plain")
            else:
                self._send(404, {"error": "no"})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            state["acc"] += 10
            msgs = body["messages"]
            last = msgs[-1]["content"]
            late_sys = any(m["role"] == "system" for m in msgs[1:])
            if mode in ("refuse",) and late_sys:
                return self._send(400, {"error": {"message": "System message must be at the beginning."}})
            msg = {"role": "assistant", "content": ""}
            if body.get("tools"):
                cmd = "echo m2-probe" if mode != "badtool" else "echo m2-prob"
                msg["tool_calls"] = [{"id": "c1", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": cmd})}}]
            elif "integers from 1 to 60" in last:
                nums = list(range(1, 61))
                if mode == "garble":
                    nums.insert(24, 24)
                msg["content"] = " ".join(map(str, nums))
            elif "access code" in last:
                m = re.search(r"access code is (\S+)\.", last)
                msg["content"] = m.group(1) if (m and not (mode == "needle" and len(last) > 100000)) else "I could not find it."
            elif "codeword" in last:
                if mode == "drop" and late_sys and msgs[-1]["role"] == "system":
                    msg["content"] = "Which codeword?"
                else:
                    msg["content"] = "PLUM-7Q"
            self._send(200, {"choices": [{"index": 0, "message": msg, "finish_reason": "stop"}], "usage": {"prompt_tokens": len(json.dumps(msgs)) // 4}})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def run(fn, *a):
    o = io.StringIO()
    with redirect_stdout(o):
        r = fn(*a)
    return r, o.getvalue()


for mode, need, want, what in (
        ("good", True, True, "a correct MTP lane (exact count, both needles, exact tool call, drafts accepted) -> pass"),
        ("garble", True, False, "a duplicated number in the 1-60 count (M1's garble) -> fail"),
        ("needle", True, False, "the needle lost at ~40k tokens (the vllm#40880 failure mode) -> fail"),
        ("badtool", True, False, "a tool call with the wrong command -> fail"),
        ("noaccept", True, False, "spec-decode counters present but no draft accepted (MTP not active) -> fail"),
        ("nometrics", True, False, "no spec-decode metrics while required (q38) -> fail"),
        ("nometrics", False, True, "no spec-decode metrics, not required (Flash-Next, informational) -> pass")):
    srv, url = lane(mode)
    r, out = run(P.mtp, url, "q", need)
    srv.shutdown()
    check(r is want and out.strip().endswith(f"MTP_PROBE={'pass' if want else 'fail'}"), f"mtp probe: {what}")

for mode, want in (("refuse", "STEER_PROBE=refused; user-note=delivered"), ("good", "STEER_PROBE=delivered; user-note=delivered"),
                   ("drop", "STEER_PROBE=not-delivered; user-note=delivered")):
    srv, url = lane(mode)
    _, out = run(P.steer, url, "q")
    srv.shutdown()
    check(out.strip().splitlines()[-1] == want, f"steer probe: {mode} -> {want}")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
