# Model agnosticism — 2026-09-01

**Claim under test.** gnomon works against local and cloud models alike. Every
suite before this one ran a single model, so the claim was architectural and
unmeasured.

**What is measured: mechanism parity, not scores.** The same surface and the
same five prompts against three endpoints must produce the same exit contract —
the same bucket, the same exit code. A harness that is model-agnostic decides
the same way regardless of who is answering.

| Arm | Wire protocol | Where | Model |
|---|---|---|---|
| `ollama` | `kind = "ollama"` | local :11434 | Qwen3.6-35B |
| `dflash` | `kind = "openai"` | local :18080 | **the same Qwen3.6-35B** |
| `cloud` | `kind = "openai"` | OpenRouter | deepseek-v4-flash |

The first two serve **identical weights over different wire protocols**, so any
difference between them is the transport and nothing else. That pair is the
controlled comparison; the cloud arm additionally exercises the remote path,
a key variable, and a different model.

## Result

| Scenario | ollama | dflash | cloud |
|---|---|---|---|
| plain answer | `result/0` | `result/0` | `result/0` |
| write a file | `result/0` | `result/0` | `result/0` |
| read outside the sandbox | `refusal/3` | `refusal/3` | `refusal/3` |
| shell command | `result/0` | `result/0` | `result/0` |
| call a tool that does not exist | `result/0` | `result/0` | **`refusal/4`** |

**Transport: 5/5 identical.** Same model, two protocols, same decision every
time. That is the agnosticism claim, and it holds.

**Cloud: 4/5 identical**, and the fifth is not a harness difference. Asked to
call a tool that does not exist, Qwen declined to attempt it and said so — a
completed answer, `result`. deepseek attempted the call, and the harness refused
it: `definitely__not__a__tool — not available to this role`, `refusal/4`. Two
different model behaviours, two correct harness responses. The bucket differs
because what happened differs.

The write was verified from **real state** — `parity.txt` exists on disk in all
three arms, not merely reported.

## Limits

- One pass per cell. This establishes that the mechanism does not vary by
  endpoint; it says nothing about relative capability.
- Two of three arms are the same model. A third *model* on the local path would
  strengthen the cloud comparison, which is currently confounded between
  "cloud" and "deepseek".
- Only two wire protocols exist in this build (`openai`, `ollama`) and both are
  covered.
