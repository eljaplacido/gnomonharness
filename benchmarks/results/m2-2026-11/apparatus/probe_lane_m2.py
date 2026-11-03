"""M2 lane probes (no cell, no meter; straight to the lane). Design: ../PRE-REGISTRATION.md.

  python3 -I probe_lane_m2.py mtp <base_url> <model> [--need-spec-metrics]
      MTP correctness probe, GATING for q38 (with --need-spec-metrics: vLLM's /metrics must show drafts accepted):
      at temperature 0, one request at a time (the lane's own concurrency, 1):
        a. count 1..60 exact, three times;
        b. a needle in a ~12k-token and a ~40k-token haystack, returned exactly (the vllm#40880 failure mode was a
           spec-verify step that never read the KV cache: long-context retrieval is what it breaks);
        c. one tool call offered `bash`: the reply must call bash with command exactly "echo m2-probe";
        d. with --need-spec-metrics: vllm:spec_decode_num_accepted_tokens_total rose over the probe (MTP is on and
           accepting drafts) -- recorded with the draft count, i.e. the acceptance rate.
      Last line "MTP_PROBE=pass|fail"; exit 0 on pass.
  python3 -I probe_lane_m2.py steer <base_url> <model>
      INFORMATIONAL: how this lane's chat template takes gnomon's mid-turn messages. [system, user, assistant, system
      "codeword ..."]: HTTP 400 naming the system message's position -> "refused" (gnomon v0.4.0 then resends its
      messages as user messages marked [gnomon] for the session); 200 and the codeword in the reply -> "delivered";
      200 without it -> "not delivered (dropped or ignored)". The same codeword as a "[gnomon] " user message is
      sent too (the adapted path). Last line "STEER_PROBE=<refused|delivered|not-delivered>; user-note=<...>".
"""
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request

WANT60 = " ".join(str(i) for i in range(1, 61))


def chat(base, model, messages, max_tokens=256, tools=None, timeout=600):
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0, "stream": False}
    if tools:
        body["tools"] = tools
    req = urllib.request.Request(f"{base}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:600]}


def text_of(r):
    try:
        return (r["choices"][0]["message"].get("content") or "").strip()
    except (KeyError, IndexError, TypeError):
        return ""


def spec_metrics(base):
    """vLLM's Prometheus counters for speculative decoding, or None if the lane has no such metrics."""
    try:
        t = urllib.request.urlopen(f"{base}/metrics", timeout=10).read().decode(errors="replace")
    except Exception:
        return None
    out = {}
    for k in ("spec_decode_num_accepted_tokens_total", "spec_decode_num_draft_tokens_total", "spec_decode_num_drafts_total"):
        vals = [float(m.group(1)) for m in re.finditer(rf"^vllm:{k}(?:{{[^}}]*}})?\s+([0-9.eE+-]+)$", t, re.M)]
        if vals:
            out[k] = sum(vals)
    return out or None


def haystack(n_lines, needle, seed):
    rng = random.Random(seed)
    lines = [f"Record {i}: sensor {rng.randint(100, 999)} read {rng.randint(1000, 9999)} units at hour {i % 24}." for i in range(n_lines)]
    lines.insert(rng.randint(n_lines // 3, 2 * n_lines // 3), f"Record secret: the access code is {needle}.")
    return "\n".join(lines)


def mtp(base, model, need_metrics):
    ok, notes = True, []
    m0 = spec_metrics(base)
    for i in range(3):
        st, r = chat(base, model, [{"role": "user", "content": "Write the integers from 1 to 60 in order, separated by single spaces, "
                                                                "on one line. Output only the numbers."}], 1024)
        got = " ".join(re.findall(r"\d+", text_of(r)))
        good = st == 200 and got == WANT60
        ok &= good
        notes.append(f"count 1-60 #{i + 1}: HTTP {st} {'exact' if good else 'WRONG: ' + text_of(r)[:120]!r}")
    for n_lines, seed in ((600, 11), (2000, 12)):  # ~12k and ~40k tokens
        needle = f"M2-{random.Random(seed).randint(100000, 999999)}-Q"
        prompt = haystack(n_lines, needle, seed) + "\n\nWhat is the access code in the records above? Reply with the code only."
        t0 = time.time()
        st, r = chat(base, model, [{"role": "user", "content": prompt}], 256)
        good = st == 200 and needle in text_of(r) and len(text_of(r)) < 200
        ok &= good
        usage = (r.get("usage") or {}).get("prompt_tokens") if isinstance(r, dict) else None
        notes.append(f"needle in {n_lines} lines ({usage} prompt tokens, {time.time() - t0:.0f} s): HTTP {st} "
                     f"{'exact' if good else 'WRONG: ' + text_of(r)[:120]!r}")
    tools = [{"type": "function", "function": {"name": "bash", "description": "Run a shell command.",
                                               "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                                                              "required": ["command"]}}}]
    st, r = chat(base, model, [{"role": "user", "content": "Use the bash tool to run exactly this command: echo m2-probe"}], 512, tools)
    calls = ((r.get("choices") or [{}])[0].get("message") or {}).get("tool_calls") or [] if isinstance(r, dict) else []
    args = None
    if calls:
        try:
            args = json.loads(calls[0]["function"]["arguments"])
        except (KeyError, TypeError, json.JSONDecodeError):
            args = None
    good = st == 200 and len(calls) == 1 and calls[0]["function"]["name"] == "bash" and (args or {}).get("command") == "echo m2-probe"
    ok &= good
    notes.append(f"tool call: HTTP {st} {'exact' if good else 'WRONG: ' + json.dumps(calls)[:160]}")
    m1 = spec_metrics(base)
    if m0 is not None and m1 is not None:
        acc = m1.get("spec_decode_num_accepted_tokens_total", 0) - m0.get("spec_decode_num_accepted_tokens_total", 0)
        dr = m1.get("spec_decode_num_draft_tokens_total", 0) - m0.get("spec_decode_num_draft_tokens_total", 0)
        notes.append(f"spec decode over the probe: accepted {acc:.0f} of {dr:.0f} draft tokens"
                     f" (acceptance {acc / dr:.2f})" if dr else f"spec decode over the probe: accepted {acc:.0f}, drafts 0")
        if need_metrics and acc <= 0:
            ok = False
            notes.append("  -> no draft token accepted: MTP is not active on this lane")
    else:
        notes.append("spec decode metrics: not available on this lane")
        if need_metrics:
            ok = False
            notes.append("  -> --need-spec-metrics given, and the lane has no vLLM spec-decode counters")
    for n in notes:
        print(n)
    print(f"MTP_PROBE={'pass' if ok else 'fail'}")
    return ok


def steer(base, model):
    code = "PLUM-7Q"
    msgs = [{"role": "system", "content": "You are a terse assistant."},
            {"role": "user", "content": "I will give you a codeword. Wait for it."},
            {"role": "assistant", "content": "Ready."}]
    st, r = chat(base, model, msgs + [{"role": "system", "content": f"The codeword is {code}. Reply with only the codeword."}], 2048)
    if st == 400 and re.search(r"system", json.dumps(r), re.I):
        sys_v = "refused"
        print(f"late system message: HTTP 400 {json.dumps(r)[:200]}")
    else:
        sys_v = "delivered" if st == 200 and code in text_of(r) else "not-delivered"
        print(f"late system message: HTTP {st}, reply {text_of(r)[:80]!r}")
    st2, r2 = chat(base, model, msgs + [{"role": "user", "content": f"[gnomon] The codeword is {code}. Reply with only the codeword."}], 2048)
    user_v = "delivered" if st2 == 200 and code in text_of(r2) else f"not-delivered (HTTP {st2})"
    print(f"[gnomon] user note: HTTP {st2}, reply {text_of(r2)[:80]!r}")
    print(f"STEER_PROBE={sys_v}; user-note={user_v}")
    return True


def main():
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == "mtp":
        sys.exit(0 if mtp(a[1].rstrip("/"), a[2], "--need-spec-metrics" in a) else 1)
    if len(a) == 3 and a[0] == "steer":
        steer(a[1].rstrip("/"), a[2])
        return
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
