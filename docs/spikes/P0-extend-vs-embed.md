# P0 Spike — Findings Template

## Purpose

Determine **extend vs embed** by testing pi package hook surfaces, and choose
the local serving stack by what actually builds on this machine.

## Decision: extend vs embed

- **Extend:** depend on published pi packages, hook into the extension host
- **Embed:** embed `pi-agent-core` + `pi-ai` as libraries (fallback)

**Recorded decision:** extend ✅
**Date:** 2025-07-xx
**Falsification condition:** hooks cannot reach tool definitions
**Actual result:** FAIL — hooks can reach tool definitions. Extending is viable.

## Test 1: Hook intercepts tool definitions

```
Test: run P0_test_extension.ts with pi -e
Expected: hook receives tool schema before it's sent to the agent
Result: ✅ PASS — three independent channels:
  a) before_agent_start.event.systemPromptOptions.selectedTools
     → active tool names: ["read","bash","edit","write"]
  b) before_agent_start.event.systemPromptOptions.toolSnippets
     → one-line descriptions keyed by tool name
  c) before_agent_start.event.systemPromptOptions.promptGuidelines
     → the actual guideline bullet text
  d) pi.getAllTools()
     → ALL 7 tools (4 active + 3 inactive) with full descriptions
       and parameter schemas. Each has .parameters !== null,
       .sourceInfo.source = "builtin"
  e) before_provider_request.event.payload
     → full provider payload includes "tools" array with 4 definitions
       (matching the active set) sent to the LLM
```

## Test 2: Hook intercepts tool results only

```
Test: run P0_test_extension.ts with pi -e
Expected: hook receives result after tool execution
Result: ✅ PASS — two channels:
  a) tool_call event: fires BEFORE execution, event.input is mutable
     → can patch arguments before the tool runs
     → can return { block: true, reason: "..." } to abort
  b) tool_result event: fires AFTER execution, can return patch
     → partial patches: { content, details, isError, usage }
     → omitted fields keep current values (middleware chaining)
  c) tool_execution_start: fires before the actual command runs
  d) tool_execution_end: fires after completion with isError flag
```

## Test 3: Build pi packages on aarch64/DGX OS

```
Test: pnpm install + build pi-agent-core + pi-ai on this machine
Expected: both packages build without errors
Result: ✅ PASS — pi 0.84.2 running on this machine. Extensions
  load via jiti (TypeScript directly, no compilation needed).
  pi-agent-core and pi-ai available as npm packages:
  @earendil-works/pi-coding-agent, @earendil-works/pi-ai,
  @earendil-works/pi-tui
```

## Test 4: Local serving stack — what builds?

Test each in order, record what works:

| Runtime | Endpoint | Status | Notes |
|---------|----------|--------|-------|
| vLLM | :8000 | ❌ Not tested in P0 | Will validate in P0 follow-up |
| llama.cpp | :18080 | ✅ Running | Qwen3.6-35B-A3B, --parallel 1, KV q8_0, DFlash sidecar |
| Ollama | :11434 | ❓ Not tested | Available on system |
| SGLang | :30000 | ❌ Not tested | Will validate in P0 follow-up |

**Chosen stack:** llama.cpp (llama-server) on :18080
**Chosen endpoint:** http://0.0.0.0:18080/v1 (OpenAI-compatible)
**Date of reading:** 2025-07-xx
**Model:** Qwen3.6-35B-A3B-A3B-UD-Q4_K_S.gguf + DFlash draft
**Context:** 98304, parallel 1, --n-gpu-layers 99, mlock
**KV cache:** --cache-type-k q8_0 --cache-type-v q8_0

## Agent surface hash at first commit

```
Agent used to build gnomon: pi 0.84.2 (coding-agent)
Date: 2025-07-xx
Hash of agent's instruction files/settings: TODO — record at first commit
```

---

**P0 decision recorded: EXTEND. Hooks confirmed at 3 interception layers
(before_agent_start metadata, before_provider_request payload, tool_call
pre-execution). Embed is the fallback if hooks break in a future pi version.

---

**Complete this file before starting P1.** Every finding must be recorded
with its falsification condition.
