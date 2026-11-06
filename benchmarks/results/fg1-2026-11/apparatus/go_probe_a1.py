"""FG1 Amendment 1: Go concurrency probe. Same tiny prompt through slots 0,3,4,5 at once while AS1 has requests in flight."""
import json, sys, time, threading, urllib.request, datetime as dt
H = "172.17.0.1"
def ctr(s):
    with urllib.request.urlopen(f"http://127.0.0.1:{4810+s}/counters", timeout=5) as r: return json.load(r)
def unsettled(c):
    return c["chat_requests"] - (c["responses_with_usage"]+c["responses_without_usage"]+c["responses_compressed"]+c["status_4xx"]+c["status_5xx"]+c["errors"])
BODY = {"model": "deepseek-v4.1-flash", "stream": False, "temperature": 0, "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with exactly the word: ok"}]}
probe_slots = [int(x) for x in sys.argv[1].split(",")]
min_inflight = int(sys.argv[2]); wait_s = float(sys.argv[3]); tag = sys.argv[4]
t0 = time.time(); best = -1
while True:
    inflight = {s: unsettled(ctr(s)) for s in (0, 1, 2)}
    tot = sum(inflight.values()); best = max(best, tot)
    if tot >= min_inflight or time.time() - t0 > wait_s: break
    time.sleep(0.1)
before = {s: ctr(s) for s in probe_slots}
res = {}
def go(s):
    req = urllib.request.Request(f"http://{H}:{4710+s}/openai/v1/chat/completions", data=json.dumps(BODY).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer p2g-relay-placeholder",
                 "user-agent": "gnomon-fg1-probe/1 (go concurrency check)", "x-opencode-session": f"fg1-probe-{tag}-s{s}"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            j = json.load(r); res[s] = {"status": r.status, "wall_ms": int((time.time()-t)*1000), "usage": j.get("usage"),
                                       "text": (j.get("choices") or [{}])[0].get("message", {}).get("content")}
    except urllib.error.HTTPError as e:
        res[s] = {"status": e.code, "wall_ms": int((time.time()-t)*1000), "body": e.read()[:300].decode(errors="replace")}
    except Exception as e:
        res[s] = {"status": None, "error": repr(e)}
th = [threading.Thread(target=go, args=(s,)) for s in probe_slots]
[x.start() for x in th]
time.sleep(0.3)
during = {s: unsettled(ctr(s)) for s in (0, 1, 2)}
[x.join() for x in th]
after = {s: ctr(s) for s in probe_slots}
out = {"t": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "tag": tag, "as1_inflight_at_fire": inflight,
       "as1_inflight_0.3s_after": during, "max_seen_while_waiting": best, "probes": {}}
for s in probe_slots:
    d = {k: round(after[s][k]-before[s][k], 10) for k in ("chat_requests","responses_with_usage","prompt_tokens","completion_tokens","cached_tokens","allowance","status_4xx","status_5xx","errors")}
    u = d["prompt_tokens"]-d["cached_tokens"]
    out["probes"][s] = {**res.get(s, {}), "counter_delta": d}
print(json.dumps(out, indent=1))
