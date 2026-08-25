/**
 * P0 Spike Test — Tool Definition Interception
 *
 * Run with: pi -e /home/eljaplacido/Desktop/gnomon/P0_test_extension.ts
 *
 * Tests:
 * 1. Can we read tool definitions via before_agent_start?
 * 2. Can we read tool definitions via pi.getAllTools()?
 * 3. Can we modify tool selection via before_agent_start?
 * 4. Can we block/modify tool calls via tool_call?
 * 5. Can we modify tool results via tool_result?
 * 6. Can we intercept tool execution before it runs?
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("P0 Spike: Test extension loaded", "info");
  });

  // TEST 1: Read tool definitions via before_agent_start
  pi.on("before_agent_start", async (event, ctx) => {
    // systemPromptOptions.selectedTools = tools currently active
    // systemPromptOptions.toolSnippets = one-line descriptions
    const selectedTools = event.systemPromptOptions?.selectedTools;
    const toolSnippets = event.systemPromptOptions?.toolSnippets;
    const promptGuidelines = event.systemPromptOptions?.promptGuidelines;

    ctx.ui.notify(
      `P0-T1: ${selectedTools?.length ?? 0} active tools. Snippets: ${toolSnippets?.length ?? 0} items`,
      "info"
    );

    // Log for debugging
    console.log("[P0-T1] Selected tools:", selectedTools);
    console.log("[P0-T1] Tool snippets:", toolSnippets);
    console.log("[P0-T1] Prompt guidelines:", promptGuidelines);

    // TEST 2: Also check getAllTools()
    const allTools = pi.getAllTools();
    console.log("[P0-T2] getAllTools() returned", allTools.length, "tools");
    console.log("[P0-T2] Tool metadata:", allTools.map(t => ({
      name: t.name,
      description: t.description?.substring(0, 100),
      hasParams: !!t.parameters,
      source: t.sourceInfo?.source,
    })));

    return {
      // We can modify the system prompt, but can we modify the tool definitions themselves?
      // The system prompt contains tool snippets but NOT full parameter schemas.
      // The full schemas are sent separately to the provider.
    };
  });

  // TEST 3: Check if we can change active tools during before_agent_start
  // (This tests whether we can modify the tool list before it reaches the provider)
  pi.on("turn_start", async (event, ctx) => {
    const active = pi.getActiveTools();
    const all = pi.getAllTools();
    console.log(`[P0-T3] Turn ${event.turnIndex}: active=${active.length}, total=${all.length}`);
    console.log(`[P0-T3] Active: ${JSON.stringify(active)}`);
    console.log(`[P0-T3] All names: ${all.map(t => t.name).join(", ")}`);
  });

  // TEST 4: Intercept tool_call — can we block/modify?
  pi.on("tool_call", async (event, ctx) => {
    console.log(`[P0-T4] tool_call: ${event.toolName}, id=${event.toolCallId}`);
    console.log(`[P0-T4] Input (mutable):`, JSON.stringify(event.input));

    // Test mutation of input
    if (isToolCallEventType("bash", event)) {
      console.log(`[P0-T4] Bash command: ${event.input.command}`);
      // Can we modify the command?
      // event.input.command = `echo "gnomon intercept" && ${event.input.command}`;
    }

    // Test blocking
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf /")) {
      console.log("[P0-T4] BLOCKED: rm -rf / detected");
      return { block: true, reason: "Blocked by P0 spike test" };
    }

    return undefined; // Continue normally
  });

  // TEST 5: Intercept tool_result — can we modify?
  pi.on("tool_result", async (event, ctx) => {
    console.log(`[P0-T5] tool_result: ${event.toolName}, isError=${event.isError}`);
    if (Array.isArray(event.content)) {
      const text = event.content.find(c => c.type === "text")?.text;
      if (text) {
        console.log(`[P0-T5] Result text (first 200 chars):`, text.substring(0, 200));
      }
    }

    if (isBashToolResult(event)) {
      console.log(`[P0-T5] Bash details: exitCode=${event.details?.exitCode}`);
    }

    // Can we patch the result?
    // return { content: [{ type: "text", text: "Patched!" }] };
  });

  // TEST 6: tool_execution_start — before the tool actually runs
  pi.on("tool_execution_start", async (event, ctx) => {
    console.log(`[P0-T6] tool_execution_start: ${event.toolName}, args=`, event.args);
  });

  // TEST 7: before_provider_request — can we see the full payload with tools?
  pi.on("before_provider_request", (event, ctx) => {
    console.log("[P0-T7] before_provider_request keys:", Object.keys(event.payload || {}));
    const payloadStr = JSON.stringify(event.payload);
    const hasTools = payloadStr.includes("tools");
    console.log(`[P0-T7] Payload contains 'tools': ${hasTools}`);
    if (hasTools) {
      // Extract the tool definitions from the provider payload
      const payload = event.payload as Record<string, unknown>;
      const tools = (payload as Record<string, unknown>)?.tools;
      if (Array.isArray(tools)) {
        console.log(`[P0-T7] Provider payload has ${tools.length} tool definitions`);
        (tools as Array<Record<string, unknown>>).forEach((t, i) => {
          console.log(`[P0-T7]   Tool ${i}: name=${(t as Record<string, unknown>)?.name}, has_params=${!!(t as Record<string, unknown>)?.parameters || !(t as Record<string, unknown>)?.function}`);
        });
      }
    }
  });
}
