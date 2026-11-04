"""C2D stage 2 (single-call lever replay) and the stage-1 description. See ../PRE-REGISTRATION.md.

  python3 replay_c2d.py describe        stage-1 tables from runs/*/wire/calls.jsonl (no model calls)
  python3 replay_c2d.py select          pick the states (rule S below) into replay/states.json
  python3 replay_c2d.py run             needs C2D_APPROVED=yes; P2G relay slot 2, budget $1.50
  python3 replay_c2d.py analyze         the pre-registered rule over replay/calls.jsonl

Rule S: every gnomon stage-1 call with HTTP 200, not aborted, completion_tokens >= 2000. If more
than 12, take 6 per cell, evenly spaced in call order (a cell with fewer gives its spare places to
the other). The request bodies are the stored req-NNNN.json.gz, byte for byte.

Variants (each one change against V0):
  V0  as gnomon sent it (re-sampled: the noise reference)
  V1  temperature and top_p removed (opencode sends neither)
  V2  reasoning replayed: each earlier assistant message gets the reasoning_content its own reply
      streamed (matched by tool-call id); not applicable when no earlier reply had reasoning
  V3  opencode's system prompt in place of gnomon's first system message (from opencode's first
      stage-1 request on the same task; tools unchanged)
  V4  late system messages removed (system messages after the first non-system message: gnomon's
      nudges and convergence pushes); not applicable when there are none
Three samples per state and variant, interleaved in a seeded random order, 3 at a time.
"""
import gzip
import json
import math
import os
import random
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNS, REPLAY = ROOT / "runs", ROOT / "replay"
sys.path.insert(0, str(ROOT.parent / "p2g-2026-11" / "apparatus"))
import run_p2g as P  # noqa: E402

SLOT = 2
URL = f"http://{P.RELAY_HOST}:{P.RELAY_PORT0 + SLOT}/openai/v1/chat/completions"
BUDGET = 1.50
MIN_COMPLETION = 2000
PER_CELL, MAX_STATES, SAMPLES = 6, 12, 3
VARIANTS = ["V0", "V1", "V2", "V3", "V4"]


def load_calls(cell: Path) -> list[dict]:
    f = cell / "wire" / "calls.jsonl"
    return [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []


def body(cell: Path, n: int) -> dict:
    return json.loads(gzip.decompress((cell / "wire" / f"req-{n:04d}.json.gz").read_bytes()))


def reply(cell: Path, n: int) -> dict:
    """The reasoning text and tool-call ids one stored reply streamed."""
    raw = gzip.decompress((cell / "wire" / f"resp-{n:04d}.sse.gz").read_bytes()).decode("utf-8", "replace")
    reasoning, ids = [], []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:") or line == "data: [DONE]":
            continue
        try:
            o = json.loads(line[5:])
        except Exception:
            continue
        for ch in o.get("choices", []):
            d = ch.get("delta", {})
            if d.get("reasoning_content"):
                reasoning.append(d["reasoning_content"])
            for tc in d.get("tool_calls") or []:
                if tc.get("id"):
                    ids.append(tc["id"])
    return {"reasoning": "".join(reasoning), "ids": ids}


def ctok(c: dict) -> int | None:
    return ((c.get("resp") or {}).get("usage") or {}).get("completion_tokens")


def rtok(c: dict) -> int | None:
    return (((c.get("resp") or {}).get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")


def med(xs):
    xs = sorted(x for x in xs if x is not None)
    return xs[len(xs) // 2] if xs else None


def describe() -> None:
    for cell in sorted(RUNS.glob("c2d-k1-*")):
        calls = [c for c in load_calls(cell) if c.get("status") == 200]
        if not calls:
            continue
        cj = json.loads((cell / "cell.json").read_text()) if (cell / "cell.json").exists() else {}
        ct = [ctok(c) or 0 for c in calls]
        rt = [rtok(c) or 0 for c in calls]
        tool_chars = sum(sum(t["args_chars"] for t in c["resp"]["tool_calls"]) for c in calls)
        text_chars = sum(c["resp"]["content_chars"] for c in calls)
        reas_chars = sum(c["resp"]["reasoning_chars"] for c in calls)
        r0 = calls[0]["req"]
        print(f"\n{cell.name}: reward={((cj.get('trial') or {}).get('reward'))} exc={(cj.get('trial') or {}).get('exception')} "
              f"wall={cj.get('wall_s')} allowance={(cj.get('delta') or {}).get('allowance')}")
        print(f"  calls={len(calls)} completion/call mean={sum(ct)/len(ct):.0f} median={med(ct)} max={max(ct)}; "
              f"reasoning tokens share={sum(rt)/max(1,sum(ct)):.2f}; calls>=2000: {sum(x>=2000 for x in ct)}")
        tot = max(1, tool_chars + text_chars + reas_chars)
        print(f"  output chars: reasoning {reas_chars/tot:.2f}, text {text_chars/tot:.2f}, tool args {tool_chars/tot:.2f}")
        print(f"  sends: temperature={r0.get('temperature')} top_p={r0.get('top_p')} max_tokens={r0.get('max_tokens')} "
              f"max_completion_tokens={r0.get('max_completion_tokens')} other={r0.get('other_keys')} "
              f"system_chars={r0.get('system_chars')} tools={len(r0.get('tools') or [])} ({r0.get('tools_chars')} chars)")
        print(f"  reasoning replayed in later requests: {sum(c['req'].get('assistant_with_reasoning', 0) > 0 for c in calls)} of {len(calls)}; "
              f"requests with late system messages: {sum(c['req'].get('late_system', 0) > 0 for c in calls)}")
        pt = [((c['resp'].get('usage') or {}).get('prompt_tokens')) for c in calls]
        print(f"  prompt tokens: first={pt[0]} median={med(pt)} max={max(x or 0 for x in pt)}; "
              f"ttft median={med([c.get('ttft_ms') for c in calls])} ms; wall/call median={med([c.get('wall_ms') for c in calls])} ms")
        by = {}
        for c in calls:
            for t in c["resp"]["tool_calls"]:
                by.setdefault(t["name"], [0, 0])
                by[t["name"]][0] += 1
                by[t["name"]][1] += t["args_chars"]
        print("  tool calls (count, arg chars): " + ", ".join(f"{k} {v[0]}/{v[1]}" for k, v in sorted(by.items(), key=lambda kv: -kv[1][1])))


def select() -> list[dict]:
    cells = sorted(RUNS.glob("c2d-k1-gnomon-*"))
    pools = {}
    for cell in cells:
        pools[cell.name] = [c["n"] for c in load_calls(cell)
                            if c.get("status") == 200 and not c.get("aborted") and (ctok(c) or 0) >= MIN_COMPLETION]
    total = sum(len(v) for v in pools.values())
    take = {}
    if total <= MAX_STATES:
        take = dict(pools)
    else:
        quota = {k: min(PER_CELL, len(v)) for k, v in pools.items()}
        spare = MAX_STATES - sum(quota.values())
        for k in sorted(pools, key=lambda k: -len(pools[k])):
            extra = min(spare, len(pools[k]) - quota[k])
            quota[k] += extra
            spare -= extra
        for k, v in pools.items():
            q = quota[k]
            take[k] = [v[round(i * (len(v) - 1) / max(1, q - 1))] for i in range(q)] if q else []
    states = [{"cell": k, "n": n} for k, ns in take.items() for n in ns]
    REPLAY.mkdir(exist_ok=True)
    (REPLAY / "states.json").write_text(json.dumps({"rule": "S", "pools": {k: len(v) for k, v in pools.items()},
                                                    "states": states}, indent=1))
    print(f"pools: { {k: len(v) for k, v in pools.items()} } -> {len(states)} states")
    return states


def opencode_system(task: str) -> str:
    cell = RUNS / f"c2d-k1-opencode-v2-{task}"
    b = body(cell, 1)
    return "\n\n".join(m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])
                       for m in b["messages"] if m["role"] == "system")


def variant(st: dict, v: str) -> dict | None:
    cell = RUNS / st["cell"]
    b = body(cell, st["n"])
    msgs = b["messages"]
    if v == "V0":
        return b
    if v == "V1":
        b.pop("temperature", None)
        b.pop("top_p", None)
        return b
    if v == "V2":
        by_id = {}
        for c in load_calls(cell):
            if c["n"] < st["n"] and c.get("status") == 200:
                r = reply(cell, c["n"])
                if r["reasoning"]:
                    for i in r["ids"]:
                        by_id[i] = r["reasoning"]
        hit = 0
        for m in msgs:
            if m["role"] == "assistant":
                for tc in m.get("tool_calls") or []:
                    if tc.get("id") in by_id:
                        m["reasoning_content"] = by_id[tc["id"]]
                        hit += 1
                        break
        return b if hit else None
    if v == "V3":
        task = st["cell"].removeprefix("c2d-k1-gnomon-")
        first = next(i for i, m in enumerate(msgs) if m["role"] == "system")
        msgs[first] = {"role": "system", "content": opencode_system(task)}
        return b
    if v == "V4":
        first_other = next((i for i, m in enumerate(msgs) if m["role"] != "system"), len(msgs))
        late = [i for i, m in enumerate(msgs) if i > first_other and m["role"] == "system"]
        if not late:
            return None
        b["messages"] = [m for i, m in enumerate(msgs) if i not in set(late)]
        return b
    raise ValueError(v)


def call(b: dict) -> dict:
    t0 = time.time()
    req = urllib.request.Request(URL, data=json.dumps(b).encode(), headers={"content-type": "application/json"})
    usage, rc, cc, ta, fin = None, 0, 0, 0, None
    with urllib.request.urlopen(req, timeout=1200) as r:
        for line in r:
            line = line.decode("utf-8", "replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            o = json.loads(line[5:])
            usage = o.get("usage") or usage
            for ch in o.get("choices", []):
                d = ch.get("delta", {})
                rc += len(d.get("reasoning_content") or "")
                cc += len(d.get("content") or "")
                for tc in d.get("tool_calls") or []:
                    ta += len((tc.get("function") or {}).get("arguments") or "")
                fin = ch.get("finish_reason") or fin
    return {"wall_s": round(time.time() - t0, 1), "finish": fin, "reasoning_chars": rc, "content_chars": cc,
            "toolarg_chars": ta, "completion_tokens": (usage or {}).get("completion_tokens"),
            "reasoning_tokens": ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "prompt_tokens": (usage or {}).get("prompt_tokens")}


def run() -> None:
    if os.environ.get("C2D_APPROVED") != "yes":
        sys.exit("refusing: set C2D_APPROVED=yes")
    states = json.loads((REPLAY / "states.json").read_text())["states"]
    jobs = []
    for si, st in enumerate(states):
        for v in VARIANTS:
            b = variant(st, v)
            if b is None:
                continue
            for k in range(SAMPLES):
                jobs.append((si, v, k, b))
    random.Random(7).shuffle(jobs)
    out = REPLAY / "calls.jsonl"
    done = set()
    if out.exists():
        for l in out.read_text().splitlines():
            r = json.loads(l)
            done.add((r["state"], r["variant"], r["k"]))
    jobs = [j for j in jobs if (j[0], j[1], j[2]) not in done]
    P.set_cell(SLOT, "c2d-replay", "replay", "c2d-replay/1")
    a0 = P.counters(SLOT)["allowance"]
    lock, stop = threading.Lock(), threading.Event()
    print(f"{len(jobs)} calls to make; slot {SLOT}; budget ${BUDGET}")

    def one(j):
        si, v, k, b = j
        if stop.is_set():
            return
        if P.counters(SLOT)["allowance"] - a0 > BUDGET:
            stop.set()
            print("BUDGET reached; stopping")
            return
        try:
            r = call(b)
        except Exception as e:
            r = {"error": f"{type(e).__name__}: {e}"}
        rec = {"state": si, "cell": states[si]["cell"], "n": states[si]["n"], "variant": v, "k": k, **r}
        with lock, open(out, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)

    with ThreadPoolExecutor(3) as ex:
        list(ex.map(one, jobs))
    print(f"spent ${P.counters(SLOT)['allowance'] - a0:.4f}")


def analyze() -> None:
    rows = [json.loads(l) for l in (REPLAY / "calls.jsonl").read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get("completion_tokens") is not None]
    mean = {}
    for r in rows:
        mean.setdefault((r["state"], r["variant"]), []).append(r["completion_tokens"])
    mean = {k: sum(v) / len(v) for k, v in mean.items()}
    states = sorted({s for s, _ in mean})
    print(f"states={len(states)} calls={len(rows)}")
    print("V0 mean completion tokens per state: " + ", ".join(f"{mean.get((s, 'V0'), 0):.0f}" for s in states))
    rng = random.Random(11)
    for v in VARIANTS[1:]:
        lr = [math.log(max(1, mean[(s, v)]) / max(1, mean[(s, "V0")])) for s in states if (s, v) in mean and (s, "V0") in mean]
        if not lr:
            print(f"{v}: not applicable")
            continue
        gm = math.exp(sum(lr) / len(lr))
        boots = sorted(math.exp(sum(rng.choice(lr) for _ in lr) / len(lr)) for _ in range(10000))
        lo, hi = boots[249], boots[9749]
        verdict = "EXPLAINS" if gm <= 0.70 and hi < 1.0 else ("reduces" if hi < 1.0 else "no effect shown")
        print(f"{v}: states={len(lr)} geometric-mean ratio vs V0 = {gm:.2f} [95% CI {lo:.2f}, {hi:.2f}] -> {verdict}")
    for v in VARIANTS:
        rs = [r.get("reasoning_tokens") or 0 for r in rows if r["variant"] == v]
        cs = [r["completion_tokens"] for r in rows if r["variant"] == v]
        if cs:
            print(f"  {v}: n={len(cs)} completion mean={sum(cs)/len(cs):.0f} reasoning share={sum(rs)/max(1,sum(cs)):.2f}")


if __name__ == "__main__":
    {"describe": describe, "select": select, "run": run, "analyze": analyze}[sys.argv[1]]()
