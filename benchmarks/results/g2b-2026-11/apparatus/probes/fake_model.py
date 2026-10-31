# Model-free boundary probes: a scripted OpenAI-compatible "model" that answers a
# user turn whose text contains a SCRIPT key with that tool call, and anything else
# with "done.". Requests are logged (tools offered, last message, response).
# Scripted fake OpenAI-compatible model for model-free boundary probes.
# SCRIPT (json): {"<substring of the last user message>": {"name": tool, "arguments": {...}}}
import http.server, json, os, sys, time
LOG = sys.argv[1]; SCRIPT = json.loads(os.environ.get("SCRIPT", "{}"))
def text_of(c):
    if isinstance(c, list): return "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c or ""
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); j = json.loads(self.rfile.read(n) or b"{}")
        msgs = j.get("messages", []); last = msgs[-1] if msgs else {}
        resp = {"text": "done."}
        if j.get("tools") and last.get("role") == "user":
            u = text_of(last.get("content"))
            for k, call in SCRIPT.items():
                if k in u: resp = {"call": call}; break
        with open(LOG, "a") as f:
            f.write(json.dumps({"tools": [t["function"]["name"] for t in j.get("tools", [])], "last_role": last.get("role"),
                                "last": text_of(last.get("content"))[:1500], "resp": resp, "sys": text_of(msgs[0].get("content"))[:120] if msgs else ""}) + "\n")
        if not j.get("stream"):
            if "call" in resp:
                c = resp["call"]
                m = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_%d" % int(time.time()*1000), "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}]}; fr = "tool_calls"
            else:
                m = {"role": "assistant", "content": resp["text"]}; fr = "stop"
            b = json.dumps({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": j.get("model"),
                            "choices": [{"index": 0, "message": m, "finish_reason": fr}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        base = {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": j.get("model")}
        if "call" in resp:
            c = resp["call"]
            d = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_%d" % int(time.time()*1000), "type": "function",
                  "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}]}
            fr = "tool_calls"
        else:
            d = {"role": "assistant", "content": resp["text"]}; fr = "stop"
        for ch in ({**base, "choices": [{"index": 0, "delta": d, "finish_reason": None}]},
                   {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": fr}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}):
            self.wfile.write(b"data: " + json.dumps(ch).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 9999), H).serve_forever()
