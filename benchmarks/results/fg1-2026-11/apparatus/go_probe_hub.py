"""FG1 Amendment 3: Go concurrency probe for the hub lane. N concurrent tiny requests on the ONE Go key through the hub
slots 6-8 (100.86.231.23:4716-4718), on top of whatever AS1/FG1-gx10 have in flight on slots 0-5 (counted)."""
import datetime as dt, json, sys, threading, time, urllib.request, urllib.error
TS = "100.86.231.23"
def ctr(s):
    with urllib.request.urlopen(f"http://127.0.0.1:{4810+s}/counters", timeout=5) as r: return json.load(r)
def unsettled(c):
    return c["chat_requests"] - (c["responses_with_usage"]+c["responses_without_usage"]+c["responses_compressed"]+c["status_4xx"]+c["status_5xx"]+c["errors"])
BODY = {"model": "deepseek-v4.1-flash", "stream": False, "temperature": 0, "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with exactly the word: ok"}]}
per_slot = int(sys.argv[1]) if len(sys.argv) > 1 else 3
tag = sys.argv[2] if len(sys.argv) > 2 else "hub9"
slots = (6, 7, 8)
other = {}
for s in range(6):
    try: other[s] = unsettled(ctr(s))
    except Exception: other[s] = None
before = {s: ctr(s) for s in slots}
res = {}
def go(s, i):
    req = urllib.request.Request(f"http://{TS}:{4710+s}/openai/v1/chat/completions", data=json.dumps(BODY).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer p2g-relay-placeholder",
                 "user-agent": "gnomon-fg1-probe/1 (hub concurrency check)", "x-opencode-session": f"fg1-probe-{tag}-s{s}-{i}-{time.time_ns()}"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            j = json.load(r); u = j.get("usage") or {}; oc = u.get("opencode") or {}
            res[f"{s}.{i}"] = {"status": r.status, "wall_ms": int((time.time()-t)*1000), "in": u.get("prompt_tokens"), "out": u.get("completion_tokens"),
                               "billing": oc.get("billing_source"), "allowance": oc.get("allowance"), "list_cost": oc.get("list_cost"),
                               "ratio": round(oc["allowance"]/oc["list_cost"], 3) if oc.get("list_cost") else None}
    except urllib.error.HTTPError as e:
        res[f"{s}.{i}"] = {"status": e.code, "wall_ms": int((time.time()-t)*1000), "body": e.read()[:200].decode(errors="replace")}
    except Exception as e:
        res[f"{s}.{i}"] = {"status": None, "error": repr(e)}
th = [threading.Thread(target=go, args=(s, i)) for i in range(per_slot) for s in slots]
[x.start() for x in th]
time.sleep(0.3)
during = {s: unsettled(ctr(s)) for s in (*range(6), *slots)}
[x.join() for x in th]
time.sleep(1)
after = {s: ctr(s) for s in slots}
out = {"t": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "tag": tag, "concurrent_hub": per_slot*len(slots),
       "inflight_slots0_5_at_fire": other, "inflight_0.3s_after": during,
       "concurrent_total_0.3s_after": sum(v for v in during.values() if v), "probes": res,
       "counter_delta": {s: {k: round(after[s][k]-before[s][k], 10) for k in ("chat_requests","responses_with_usage","allowance","status_4xx","status_5xx","errors")} for s in slots}}
print(json.dumps(out, indent=1))
