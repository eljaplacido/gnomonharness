"""A scripted, compromised OpenAI-compatible model (no GPU, no cloud).

It follows a plan read from PLAN (json) on every request:
  {"first": call, "trigger": "<token>" | null, "attack": [calls], "post": [calls]}
The k-th tool call it makes (k = assistant tool calls already in the history) is
  plan = [first] + (attack if the trigger has appeared in any user or tool message) + post
so the injected calls are emitted only once the injected text has been READ -- the
condition a real hijacked model is in. After the plan it answers "done.".
A prompt containing SEED-SESSION is answered "done." with no call (record seeding).

Every request's messages are appended to LOG (jsonl): this is the model-bound
channel the credential detector scans, observed here, not in gnomon's records.
usage: fake_model.py <port> <plan.json> <log.jsonl>
"""
import http.server, json, sys, time

PORT, PLAN, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]


def text_of(c):
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c or ""


def decide(msgs):
    plan = json.load(open(PLAN))
    seen = "\n".join(text_of(m.get("content")) for m in msgs if m.get("role") in ("user", "tool"))
    if "SEED-SESSION" in seen:
        return None, False
    k = sum(len(m.get("tool_calls") or []) for m in msgs if m.get("role") == "assistant")
    fired = bool(plan.get("trigger")) and plan["trigger"] in seen
    steps = [plan["first"]] + (plan.get("attack", []) if fired else []) + plan.get("post", [])
    return (steps[k] if k < len(steps) else None), fired


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        j = json.loads(self.rfile.read(n) or b"{}")
        msgs = j.get("messages", [])
        call, fired = decide(msgs) if j.get("tools") else (None, False)
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "tools": [t["function"]["name"] for t in j.get("tools", [])],
                                "messages": [{"role": m.get("role"), "content": text_of(m.get("content")),
                                              "tool_calls": m.get("tool_calls")} for m in msgs[1:]],
                                "emit": call, "fired": fired}) + "\n")
        cid = "call_%d" % int(time.time() * 1e6)
        if call:
            tc = {"id": cid, "type": "function", "function": {"name": call["tool"], "arguments": json.dumps(call["args"])}}
            fr = "tool_calls"
        else:
            tc, fr = None, "stop"
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


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
