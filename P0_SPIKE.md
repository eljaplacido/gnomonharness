# P0 Spike — Findings Template

## Purpose

Determine **extend vs embed** by testing pi package hook surfaces, and choose
the local serving stack by what actually builds on this machine.

## Decision: extend vs embed

- **Extend:** depend on published pi packages, hook into the extension host
- **Embed:** embed `pi-agent-core` + `pi-ai` as libraries (fallback)

**Recorded decision:** [extend | embed]
**Date:** _____
**Falsification condition:** hooks cannot reach tool definitions
**Actual result:** _____

## Test 1: Hook intercepts tool definitions

```
Test: attempt to intercept tool definition phase via extension hook
Expected: hook receives tool schema before it's sent to the agent
Result: _____
```

## Test 2: Hook intercepts tool results only

```
Test: attempt to intercept tool result phase via extension hook
Expected: hook receives result after tool execution
Result: _____
```

## Test 3: Build pi packages on aarch64/DGX OS

```
Test: pnpm install + build pi-agent-core + pi-ai on this machine
Expected: both packages build without errors
Result: _____
```

## Test 4: Local serving stack — what builds?

Test each in order, record what works:

| Runtime | Endpoint | Status | Notes |
|---------|----------|--------|-------|
| vLLM | :8000 | | |
| llama.cpp | :8080 | | |
| Ollama | :11434 | | |
| SGLang | :30000 | | |

**Chosen stack:** _____
**Chosen endpoint:** _____
**Date of reading:** _____

## Agent surface hash at first commit

```
Agent used to build gnomon: _____
Date: _____
Hash of agent's instruction files/settings: _____
```

---

**Complete this file before starting P1.** Every finding must be recorded
with its falsification condition.
