"""M1 lane soak: N concurrent chat completions for S seconds against a lane, plus a garble probe.

  python3 -I soak_m1.py <base_url> <model> <seconds> <concurrency> [--garble-gates]

Each worker loops: a ~3,000-token prompt (max_tokens 128) and, every 4th request, the garble probe
"the integers 1 to 30" at temperature 0 (max_tokens 2048, so a reasoning model has room). Prints one
summary line and exits 0 only if every request returned HTTP 200, the server still lists the model
afterwards, and (with --garble-gates) every garble probe came back exact.
"""
import json
import re
import sys
import threading
import time
import urllib.request

base, model, secs, conc = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
GATE = "--garble-gates" in sys.argv
FILLER = " ".join(f"Line {i}: the quick brown fox jumps over the lazy dog near the river bank." for i in range(220))
WANT = " ".join(str(i) for i in range(1, 31))
stats = {"ok": 0, "err": 0, "probe_ok": 0, "probe_bad": 0, "lat": [], "errors": [], "bad": []}
lock = threading.Lock()


def chat(messages, max_tokens, temperature):
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens,
                       "temperature": temperature}).encode()
    req = urllib.request.Request(f"{base}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def worker(w):
    n, end = 0, time.time() + secs
    while time.time() < end:
        n += 1
        probe = n % 4 == 1
        t0 = time.time()
        try:
            if probe:
                r = chat([{"role": "user", "content": "Write the integers from 1 to 30 in order, separated by single "
                                                      "spaces, on one line. Output only the numbers."}], 2048, 0)
                text = (r["choices"][0]["message"].get("content") or "").strip()
                got = " ".join(re.findall(r"\d+", text))
                with lock:
                    if got == WANT:
                        stats["probe_ok"] += 1
                    else:
                        stats["probe_bad"] += 1
                        stats["bad"].append(text[:120])
            else:
                chat([{"role": "user", "content": FILLER + f"\n\nWorker {w} request {n}: in one sentence, "
                                                           "what animal jumps in every line above?"}], 128, 0.7)
            with lock:
                stats["ok"] += 1
                stats["lat"].append(time.time() - t0)
        except Exception as e:
            with lock:
                stats["err"] += 1
                stats["errors"].append(f"{type(e).__name__}: {str(e)[:120]}")


threads = [threading.Thread(target=worker, args=(w,)) for w in range(conc)]
for t in threads:
    t.start()
for t in threads:
    t.join()
try:
    alive = model in urllib.request.urlopen(f"{base}/v1/models", timeout=15).read().decode()
except Exception:
    alive = False
lat = sorted(stats["lat"])
p50 = lat[len(lat) // 2] if lat else float("nan")
p95 = lat[int(len(lat) * 0.95)] if lat else float("nan")
ok = stats["err"] == 0 and alive and stats["ok"] > 0 and (not GATE or (stats["probe_bad"] == 0 and stats["probe_ok"] > 0))
print(f"soak {model} {conc}x{secs:.0f}s: ok={stats['ok']} err={stats['err']} probe_ok={stats['probe_ok']} "
      f"probe_bad={stats['probe_bad']} p50={p50:.2f}s p95={p95:.2f}s alive_after={alive} gate_garble={GATE} "
      f"-> {'PASS' if ok else 'FAIL'}")
for e in stats["errors"][:5]:
    print("  error:", e)
for b in stats["bad"][:5]:
    print("  garbled:", repr(b))
sys.exit(0 if ok else 1)
