"""Dump a cell's trajectory from the independent wire capture, the same way for every arm.

For each model response (resp-NNNN.sse.gz): time since the first request, prompt tokens, reasoning tokens, and the tool
calls it issued (name + first characters of the arguments). Tool results are taken from the next request body.

  python3 -I traj.py <cell> [<cell> ...]     -> traj/<cell>.txt
"""
import gzip
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / "runs"
sys.path.insert(0, str(HERE))
from extract import ts  # noqa: E402


def sse(path):
    calls, reasoning, content, usage = {}, 0, "", {}
    try:
        lines = gzip.open(path, "rt", encoding="utf-8", errors="replace").read().splitlines()
    except Exception:
        return [], 0, "", {}
    for line in lines:
        if not line.startswith("data: ") or line.strip() == "data: [DONE]":
            continue
        try:
            d = json.loads(line[6:])
        except Exception:
            continue
        if d.get("usage"):
            usage = d["usage"]
        for ch in d.get("choices") or []:
            de = ch.get("delta") or {}
            reasoning += len(de.get("reasoning_content") or "")
            content += de.get("content") or ""
            for tc in de.get("tool_calls") or []:
                c = calls.setdefault(tc.get("index", 0), {"name": "", "args": ""})
                f = tc.get("function") or {}
                c["name"] += f.get("name") or ""
                c["args"] += f.get("arguments") or ""
    return [calls[k] for k in sorted(calls)], reasoning, content, usage


def short(args, n=160):
    try:
        a = json.loads(args)
        if isinstance(a, dict):
            s = a.get("command") or a.get("cmd") or a.get("path") or a.get("filePath") or a.get("file_path") or json.dumps(a)
            if "content" in a and isinstance(a["content"], str):
                s = f"{s} [+{a['content'].count(chr(10)) + 1} lines]"
            args = str(s)
    except Exception:
        pass
    return " ".join(str(args).split())[:n]


def dump(cell):
    wire = RUNS / cell / "wire"
    rows = [json.loads(l) for l in (wire / "calls.jsonl").read_text().splitlines() if l.strip()]
    t0 = ts(rows[0]["t"]) if rows else 0
    out = [f"# {cell}: {len(rows)} requests"]
    step = 0
    for r in rows:
        n = r["n"]
        calls, rchars, content, usage = sse(wire / f"resp-{n:04d}.sse.gz")
        u = r.get("resp", {}).get("usage") or usage or {}
        rt = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
        head = (f"[{(ts(r['t']) - t0):7.0f}s] #{n:<3d} {r.get('wall_ms') or 0:>7}ms p={u.get('prompt_tokens', '-')} "
                f"r={rt} {'ABORTED' if r.get('aborted') else r.get('status')}")
        if not calls:
            out.append(f"{head} TEXT: {' '.join(content.split())[:200]}")
        for c in calls:
            step += 1
            out.append(f"{head} {step:>3d} {c['name']}: {short(c['args'])}")
            head = " " * len(head)
    (HERE / "traj").mkdir(exist_ok=True)
    (HERE / "traj" / f"{cell}.txt").write_text("\n".join(out) + "\n")
    return len(out)


if __name__ == "__main__":
    for cell in sys.argv[1:]:
        print(cell, dump(cell))
