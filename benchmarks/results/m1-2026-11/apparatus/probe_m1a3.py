"""M1a3 pre-data probes against the running Glimmer lane (llama.cpp). Read-only for the lane: one
template render per case (no generation) and one short streamed generation.

  python3 -I probe_m1a3.py [base_url]        default http://127.0.0.1:18680; prints a report, and
                                             the summary lines the chain greps:
      TEMPLATE_RENDERS_REPLAY=yes|no|error   MARKER-R7Q reaches the rendered prompt (case A)
      STREAM_REASONING_CONTENT=yes|no|error  the lane streams reasoning_content deltas
  exit 0 when the probes ran (whatever they found), 2 when the lane could not be reached.

1. /apply-template (renders the chat template server-side, as the lane will for every request):
   A  system, user, assistant {reasoning_content "MARKER-R7Q ...", one tool call}, tool result.
      If MARKER-R7Q is not in the prompt, the replayed reasoning cannot reach the model and arm G1
      is the same prompt as G0: logged prominently, the arms still run, and it is a finding.
   B  the same without reasoning_content: the marker must be absent (the check can say "no").
   C  A followed by a later user message (informational: does the template keep reasoning from
      before the latest user turn?).
   D  the shape build d59e6c19 sent (M1a): the reasoning promoted into `content` beside the tool
      call, no reasoning_content (informational: did M1a's reasoning ever reach the prompt?).
2. A streamed request shaped like gnomon master's (stream, include_usage, max_tokens, tools,
   temperature 0.3, top_p 0.95): does the lane return reasoning_content deltas (else G1 has nothing
   to replay), tool_call deltas, usage (and its shape), timings.
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18680").rstrip("/")
MODEL = "glimmer-30b"
MARKER = "MARKER-R7Q"
TOOLS = [{"type": "function", "function": {
    "name": "bash", "description": "Execute a POSIX sh command and return its output.",
    "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}]
SYSTEM = {"role": "system", "content": "You are a coding agent working in /app. Use the tools."}
USER = {"role": "user", "content": "How many files are in /app? Answer with the number."}
CALL = {"id": "call_r7q", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": "ls /app | wc -l"})}}
ASSISTANT = {"role": "assistant", "content": "", "tool_calls": [CALL]}
TOOL = {"role": "tool", "tool_call_id": "call_r7q", "content": "3"}


def post(path: str, body: dict, timeout: float = 60):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def render(messages: list) -> tuple[str | None, str]:
    try:
        with post("/apply-template", {"messages": messages, "tools": TOOLS}) as r:
            return json.load(r).get("prompt"), ""
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read()[:300]!r}"
    except Exception as e:  # noqa: BLE001 - reported, never hidden
        return None, f"{type(e).__name__}: {e}"


def around(prompt: str, needle: str, n: int = 90) -> str:
    i = prompt.find(needle)
    return repr(prompt[max(0, i - n): i + len(needle) + n]) if i >= 0 else "-"


def main() -> int:
    print(f"== M1a3 probes {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} against {BASE}")
    try:
        with urllib.request.urlopen(BASE + "/v1/models", timeout=15) as r:
            models = r.read().decode()
    except Exception as e:  # noqa: BLE001
        print(f"lane unreachable: {type(e).__name__}: {e}")
        return 2
    print(f"lane serves {MODEL}: {MODEL in models}")

    # ---------------------------------------------------------------- 1. template
    rc = f"{MARKER} The listing has three entries, so the answer is 3."
    cases = {
        "A replay": [SYSTEM, USER, {**ASSISTANT, "reasoning_content": rc}, TOOL],
        "B no reasoning": [SYSTEM, USER, ASSISTANT, TOOL],
        "C replay, then a later user turn": [SYSTEM, USER, {**ASSISTANT, "reasoning_content": rc}, TOOL,
                                             {"role": "user", "content": "And in /tmp?"}],
        "D d59e6c19 shape (reasoning promoted into content beside the call)": [SYSTEM, USER, {**ASSISTANT, "content": rc}, TOOL],
    }
    seen = {}
    for name, msgs in cases.items():
        prompt, err = render(msgs)
        if prompt is None:
            seen[name] = None
            print(f"apply-template {name}: ERROR {err}")
            continue
        seen[name] = MARKER in prompt
        print(f"apply-template {name}: marker {'PRESENT' if seen[name] else 'absent'}; "
              f"tool call rendered: {'ls /app' in prompt}; prompt {len(prompt)} chars; around marker: {around(prompt, MARKER)}")
    a, b = seen.get("A replay"), seen.get("B no reasoning")
    if a is None or b is None:
        verdict = "error"
    elif b:
        verdict = "error"  # the marker without reasoning_content means the check cannot discriminate
        print("apply-template: the marker appears WITHOUT reasoning_content; the check cannot discriminate")
    else:
        verdict = "yes" if a else "no"
    if verdict == "no":
        print("!!! G1 replay not rendered by template: reasoning_content sent back does not reach the model's prompt")
    print(f"TEMPLATE_RENDERS_REPLAY={verdict}")

    # ---------------------------------------------------------------- 2. one streamed generation
    body = {"model": MODEL, "messages": [SYSTEM, USER], "tools": TOOLS, "stream": True,
            "stream_options": {"include_usage": True}, "max_tokens": 2048, "temperature": 0.3, "top_p": 0.95}
    st = {"reasoning_chars": 0, "content_chars": 0, "tool_call_deltas": 0, "finish": None, "usage": None,
          "timings": False, "chunks": 0, "bad_lines": 0}
    t0 = time.time()
    try:
        with post("/v1/chat/completions", body, timeout=300) as r:
            for raw in r:
                line = raw.decode("utf8", "replace").strip()
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                try:
                    o = json.loads(line[5:])
                except json.JSONDecodeError:
                    st["bad_lines"] += 1
                    continue
                st["chunks"] += 1
                if isinstance(o.get("usage"), dict):
                    st["usage"] = o["usage"]
                if isinstance(o.get("timings"), dict):
                    st["timings"] = True
                for ch in o.get("choices") or []:
                    d = ch.get("delta") or {}
                    th = d.get("reasoning_content") or d.get("reasoning")
                    if isinstance(th, str):
                        st["reasoning_chars"] += len(th)
                    if isinstance(d.get("content"), str):
                        st["content_chars"] += len(d["content"])
                    if d.get("tool_calls"):
                        st["tool_call_deltas"] += 1
                    if ch.get("finish_reason"):
                        st["finish"] = ch["finish_reason"]
        stream_ok = True
    except Exception as e:  # noqa: BLE001
        stream_ok = False
        print(f"stream probe: ERROR {type(e).__name__}: {e}")
    st["seconds"] = round(time.time() - t0, 1)
    u = st["usage"]
    st["usage_nested"] = bool(u) and any(isinstance(v, dict) for v in u.values())
    print(f"stream probe: {json.dumps(st)}")
    if stream_ok and st["reasoning_chars"] == 0:
        print("!!! the lane streamed no reasoning_content on this request: if that holds in the cells, G1 has nothing to replay")
    if stream_ok and st["tool_call_deltas"] == 0:
        print("!!! no tool_call deltas in the streamed reply (the model may have answered in text; or streaming breaks tool calls)")
    print(f"STREAM_REASONING_CONTENT={'error' if not stream_ok else ('yes' if st['reasoning_chars'] > 0 else 'no')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
