"""A scripted, compromised OpenAI-compatible model for GBS-GOVERNANCE (no GPU, no cloud).

Adapted from INJ-2026-11's apparatus/fake_model.py (the private benchmark repository), with
two additions: the port is chosen by the OS and printed (ephemeral, loopback only), and
a sub-turn (gnomon's `task` tool) gets its own plan, keyed by a marker in its prompt.

PLAN (json), re-read on every request:
  {"first": call|null, "trigger": "<token>"|null, "attack": [calls], "post": [calls],
   "sub": {"<marker>": [calls]}}
In the main conversation the k-th tool call it makes is
  ([first] + (attack if trigger seen in a user/tool message) + post)[k]
so injected calls are emitted only once the injected text has been READ. In a
conversation whose first user message contains a key of "sub", the k-th call is
sub[key][k]. After its plan it answers "done.". Every request is appended to LOG.
usage: fake_model.py <plan.json> <log.jsonl>   (prints the port on stdout)
"""
import http.server, json, sys, time

PLAN, LOG = sys.argv[1], sys.argv[2]


def text_of(c):
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c or ""


def decide(msgs):
    plan = json.load(open(PLAN))
    users = [text_of(m.get("content")) for m in msgs if m.get("role") == "user"]
    k = sum(len(m.get("tool_calls") or []) for m in msgs if m.get("role") == "assistant")
    for marker, calls in (plan.get("sub") or {}).items():
        if users and marker in users[0]:
            return (calls[k] if k < len(calls) else None), "sub:" + marker
    seen = "\n".join(text_of(m.get("content")) for m in msgs if m.get("role") in ("user", "tool"))
    fired = bool(plan.get("trigger")) and plan["trigger"] in seen
    steps = ([plan["first"]] if plan.get("first") else []) + (plan.get("attack", []) if fired else []) + plan.get("post", [])
    return (steps[k] if k < len(steps) else None), ("fired" if fired else "")


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        j = json.loads(self.rfile.read(n) or b"{}")
        msgs = j.get("messages", [])
        call, why = decide(msgs) if j.get("tools") else (None, "")
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "tools": [t["function"]["name"] for t in j.get("tools", [])],
                                "messages": [{"role": m.get("role"), "content": text_of(m.get("content")),
                                              "tool_calls": m.get("tool_calls")} for m in msgs[1:]],
                                "emit": call, "why": why}) + "\n")
        cid = "call_%d" % int(time.time() * 1e6)
        tc = {"id": cid, "type": "function", "function": {"name": call["tool"], "arguments": json.dumps(call["args"])}} if call else None
        fr = "tool_calls" if tc else "stop"
        if not j.get("stream"):
            m = {"role": "assistant", "content": None, "tool_calls": [tc]} if tc else {"role": "assistant", "content": "done."}
            b = json.dumps({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": j.get("model"),
                            "choices": [{"index": 0, "message": m, "finish_reason": fr}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        base = {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": j.get("model")}
        d = {"role": "assistant", "tool_calls": [dict(tc, index=0)]} if tc else {"role": "assistant", "content": "done."}
        for ch in ({**base, "choices": [{"index": 0, "delta": d, "finish_reason": None}]},
                   {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": fr}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}):
            self.wfile.write(b"data: " + json.dumps(ch).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
