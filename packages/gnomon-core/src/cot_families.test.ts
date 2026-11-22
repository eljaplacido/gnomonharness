/**
 * The live trace (/cot) for every well-known model family's real wire shape.
 *
 * Each family answers one full turn over a fake chat-completions server on
 * 127.0.0.1: reasoning, one tool call (glob), its result, a final answer. The
 * checks are the same for all of them, at every /cot mode, /think level, and
 * width, and for the `┊` gutter of a delegated sub-turn:
 *
 *   - reasoning shows under `✻` only, never under `●`, never in the answer;
 *   - no raw reasoning markup is ever printed;
 *   - no printed row is wider than the terminal;
 *   - the tool row is there; the final answer is clean.
 *
 * Nothing reaches a network.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, cpSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, resolveUi } from "./config.js";
import { runAgenticTurn, nestedDeps } from "./prompt_loop.js";
import { splitThinking } from "./render.js";

const RSN1 = "rsn-step weighing whether to list the files first and then read what comes back from the tool";
const RSN2 = "rsn-final the listing shows the readme so the answer can name it plainly now";
const PROSE = "prose-step let me look at the directory";
const ANS = "ans-final the README is README.md";

type Delta = Record<string, unknown>;
interface Family {
  name: string;
  /** SSE deltas for the step that calls the tool */
  step: Delta[];
  /** SSE deltas for the closing answer */
  final: Delta[];
  /** Does the family's step carry prose beside the call? */
  prose?: boolean;
  /** This family's reasoning is not readable text (redacted, encrypted only) */
  opaque?: boolean;
  /** JSON (Ollama native /api/chat) instead of SSE */
  json?: { step: Record<string, unknown>; final: Record<string, unknown> };
  /** the step's tool call carries extra_content (Gemini thought signature) */
  extra?: boolean;
}

const call = (extra?: unknown): Delta => ({
  tool_calls: [
    {
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "glob", arguments: '{"pattern":' },
      ...(extra ? { extra_content: extra } : {}),
    },
  ],
});
const callRest: Delta = { tool_calls: [{ index: 0, function: { arguments: '"*.md"}' } }] };
/** Split text into 7-character pieces, so markup straddles chunk boundaries. */
const pieces = (s: string, key = "content"): Delta[] => {
  const out: Delta[] = [];
  for (let i = 0; i < s.length; i += 7) out.push({ [key]: s.slice(i, i + 7) });
  return out;
};
const toolStep = (before: Delta[], extra?: unknown): Delta[] => [...before, call(extra), callRest];
const part = (p: unknown[]): Delta => ({ content: p });
const detailText = (text: string, i = 0) => ({ type: "reasoning.text", text, index: i, format: "unknown" });

const FAMILIES: Family[] = [
  {
    name: "DeepSeek/Kimi/GLM reasoning_content",
    step: toolStep([...pieces(RSN1, "reasoning_content"), ...pieces(PROSE)]),
    final: [...pieces(RSN2, "reasoning_content"), ...pieces(ANS)],
    prose: true,
  },
  {
    name: "vLLM reasoning",
    step: toolStep([...pieces(RSN1, "reasoning"), ...pieces(PROSE)]),
    final: [...pieces(RSN2, "reasoning"), ...pieces(ANS)],
    prose: true,
  },
  {
    name: "OpenRouter reasoning + reasoning_details (text + encrypted)",
    step: toolStep([
      { reasoning: RSN1, reasoning_details: [detailText(RSN1)] },
      { reasoning_details: [{ type: "reasoning.encrypted", data: "gAAAAABencryptedblob==", id: "rs_1", index: 1, format: "openai-responses-v1" }] },
      ...pieces(PROSE),
    ]),
    final: [{ reasoning: RSN2, reasoning_details: [detailText(RSN2)] }, ...pieces(ANS)],
    prose: true,
  },
  {
    name: "OpenRouter reasoning_details, encrypted only on the step",
    step: toolStep([{ reasoning_details: [{ type: "reasoning.encrypted", data: "gAAAAABopaque==", index: 0 }] }]),
    final: [{ reasoning_details: [detailText(RSN2)] }, ...pieces(ANS)],
    opaque: true,
  },
  {
    name: "Ollama thinking (native JSON)",
    step: [],
    final: [],
    prose: true,
    json: {
      step: {
        content: PROSE,
        thinking: RSN1,
        tool_calls: [{ function: { name: "glob", arguments: { pattern: "*.md" } } }],
      },
      final: { content: ANS, thinking: RSN2 },
    },
  },
  {
    name: "Anthropic-shaped thinking parts (string, signature)",
    step: toolStep([part([{ type: "thinking", thinking: RSN1, signature: "sig123" }]), part([{ type: "text", text: PROSE }])]),
    final: [part([{ type: "thinking", thinking: RSN2, signature: "sig456" }]), part([{ type: "text", text: ANS }])],
    prose: true,
  },
  {
    name: "Anthropic redacted_thinking part",
    step: toolStep([part([{ type: "redacted_thinking", data: "opaque" }]), part([{ type: "text", text: PROSE }])]),
    final: [part([{ type: "redacted_thinking", data: "opaque" }]), part([{ type: "text", text: ANS }])],
    prose: true,
    opaque: true,
  },
  {
    name: "Mistral Magistral ThinkChunk (list)",
    step: toolStep([part([{ type: "thinking", thinking: [{ type: "text", text: RSN1 }] }, { type: "text", text: PROSE }])]),
    final: [part([{ type: "thinking", thinking: [{ type: "text", text: RSN2 }] }]), part([{ type: "text", text: ANS }])],
    prose: true,
  },
  {
    name: "Cohere thinking",
    step: toolStep([part([{ type: "thinking", thinking: RSN1 }]), part([{ type: "text", text: PROSE }])]),
    final: [part([{ type: "thinking", thinking: RSN2 }]), part([{ type: "text", text: ANS }])],
    prose: true,
  },
  {
    name: "inline <think> (split across chunks)",
    step: toolStep(pieces(`<think>${RSN1}</think>${PROSE}`)),
    final: pieces(`<think>${RSN2}</think>${ANS}`),
    prose: true,
  },
  {
    name: "inline <thinking>",
    step: toolStep(pieces(`<thinking>${RSN1}</thinking>${PROSE}`)),
    final: pieces(`<thinking>${RSN2}</thinking>${ANS}`),
    prose: true,
  },
  {
    name: "lone </think> (opener in the prompt)",
    step: toolStep(pieces(`${RSN1}</think>${PROSE}`)),
    final: pieces(`${RSN2}</think>${ANS}`),
    prose: true,
  },
  {
    name: "<seed:think> (Seed-OSS)",
    step: toolStep(pieces(`<seed:think>${RSN1}</seed:think>${PROSE}`)),
    final: pieces(`<seed:think>${RSN2}</seed:think>${ANS}`),
    prose: true,
  },
  {
    name: "<thought> (Gemini OpenAI-compat)",
    step: toolStep(pieces(`<thought>${RSN1}</thought>${PROSE}`)),
    final: pieces(`<thought>${RSN2}</thought>${ANS}`),
    prose: true,
  },
  {
    name: "[THINK] (Magistral raw)",
    step: toolStep(pieces(`[THINK]${RSN1}[/THINK]${PROSE}`)),
    final: pieces(`[THINK]${RSN2}[/THINK]${ANS}`),
    prose: true,
  },
  {
    name: "Gemma 4 thought channel",
    step: toolStep(pieces(`<|channel>thought\n${RSN1}<channel|>${PROSE}`)),
    final: pieces(`<|channel>thought\n${RSN2}<channel|>${ANS}`),
    prose: true,
  },
  {
    name: "Kimi-VL think brackets",
    step: toolStep(pieces(`◁think▷${RSN1}◁/think▷${PROSE}`)),
    final: pieces(`◁think▷${RSN2}◁/think▷${ANS}`),
    prose: true,
  },
  {
    name: "gpt-oss Harmony raw",
    step: toolStep(
      pieces(`<|channel|>analysis<|message|>${RSN1}<|end|><|start|>assistant<|channel|>commentary<|message|>${PROSE}<|end|>`)
    ),
    final: pieces(`<|channel|>analysis<|message|>${RSN2}<|end|><|start|>assistant<|channel|>final<|message|>${ANS}<|return|>`),
    prose: true,
  },
  {
    name: "Hunyuan <answer> wrapper",
    step: toolStep(pieces(`<think>${RSN1}</think>${PROSE}`)),
    final: pieces(`<think>${RSN2}</think>\n<answer>${ANS}</answer>`),
    prose: true,
  },
  {
    name: "Granite <response> wrapper",
    step: toolStep(pieces(`<think>${RSN1}</think>${PROSE}`)),
    final: pieces(`<think>${RSN2}</think><response>${ANS}</response>`),
    prose: true,
  },
  {
    name: "Apriel [BEGIN FINAL RESPONSE]",
    step: toolStep(pieces(`<think>${RSN1}</think>${PROSE}`)),
    final: pieces(`${RSN2}\n[BEGIN FINAL RESPONSE]\n${ANS}\n[END FINAL RESPONSE]<|end|>`),
    prose: true,
  },
  {
    name: "Gemini thought signature in extra_content",
    step: toolStep([...pieces(RSN1, "reasoning_content"), ...pieces(PROSE)], { google: { thought_signature: "c2lnbmF0dXJl" } }),
    final: [...pieces(RSN2, "reasoning_content"), ...pieces(ANS)],
    prose: true,
    extra: true,
  },
  {
    name: "leaked tool-tag stub beside the call (nemotron via vLLM)",
    step: toolStep([...pieces(RSN1, "reasoning"), { content: "<t" }]),
    final: [...pieces(RSN2, "reasoning"), ...pieces(ANS)],
  },
  {
    name: "content-only (reasoning off)",
    step: toolStep(pieces(PROSE)),
    final: pieces(ANS),
    prose: true,
    opaque: true,
  },
];

/** A private copy of the surface, in a git repository of its own: the turn runs a real tool and checks the worktree. */
let privateRoot: string | undefined;
function privateConfig(): any {
  if (!privateRoot) {
    privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-cot-families-")));
    cpSync(resolve("../../.gnomon"), join(privateRoot, ".gnomon"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: privateRoot, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "surface");
  }
  return loadConfig(privateRoot);
}
afterAll(() => {
  if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
});

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
});

async function serve(fam: Family): Promise<{ url: string; bodies: Record<string, any>[] }> {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies.push(body);
      const afterTool = (body.messages ?? []).some((m: any) => m.role === "tool");
      if (fam.json) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: afterTool ? fam.json.final : fam.json.step }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const deltas = afterTool ? fam.final : fam.step;
      deltas.forEach((d, i) => {
        const last = i === deltas.length - 1;
        const fin = last ? (afterTool ? "stop" : "tool_calls") : null;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: fin }] })}\n\n`);
      });
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

async function withWidth<T>(columns: number, fn: () => Promise<T>): Promise<T> {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    return await fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as any).isTTY;
    if (cols) Object.defineProperty(process.stdout, "columns", cols);
    else delete (process.stdout as any).columns;
  }
}

const RAW_MARKUP = [
  /<\/?think(?:ing)?>/i, /<\/?seed:think>/i, /<\/?thought>/i, /\[\/?THINK\]/, /<\|channel/, /<channel\|>/,
  /◁\/?think▷/, /<\|(?:start|end|message|return|call)\|>/, /<\/?(?:answer|response)>/i, /\[(?:BEGIN|END) FINAL RESPONSE\]/,
  /reasoning\.(?:text|encrypted)/, /gAAAAAB/, /thought_signature/, /redacted_thinking/,
];

interface Run {
  rows: string[];
  text: string;
  answer: string;
  code: number;
  bodies: Record<string, any>[];
}

async function run(fam: Family, cot: string, think: string, columns: number, nested = false): Promise<Run> {
  const { url, bodies } = await serve(fam);
  const config: any = privateConfig();
  const ui = { ...resolveUi(config), cot, think, color: false } as any;
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const rows: string[] = [];
  const base: any = {
    approve: async () => true,
    progress: { start() {}, update() {}, stop() {} },
    ui,
    say: (s: string) => rows.push(...s.split("\n")),
  };
  const deps = nested ? nestedDeps(base) : base;
  const target: any = {
    model: "m", temperature: 0, top_p: 1, url,
    kind: fam.json ? "ollama" : "openai", stream: !fam.json,
  };
  const result = await withWidth(columns, () =>
    runAgenticTurn(
      state, "implement", { model: "m", temperature: 0, top_p: 1, target } as any,
      [{ role: "user", content: "list the files and name the README" }], deps, nested ? 1 : 0
    )
  );
  return { rows, text: rows.join("\n"), answer: splitThinking(result.content).answer, code: result.code, bodies };
}

/** Rows that are reasoning: a `✻` row and its indented continuation. */
function reasoningRows(rows: string[]): Set<number> {
  const set = new Set<number>();
  let inside = false;
  rows.forEach((r, i) => {
    const body = r.replace(/^\s*┊/, "");
    if (/^ {2}✻ /.test(body)) inside = true;
    else if (inside && /^ {4}[^\s⎿•│]/.test(body)) {
      /* continuation */
    } else inside = false;
    if (inside) set.add(i);
  });
  return set;
}

function check(fam: Family, r: Run, cot: string, think: string, columns: number, nested: boolean) {
  const where = `${fam.name} cot=${cot} think=${think} w=${columns}${nested ? " nested" : ""}`;
  expect(r.code, `${where}: turn ok\n${r.text}`).toBe(0);
  expect(r.answer, where).toContain("ans-final");
  expect(r.answer, `${where}: answer has reasoning`).not.toMatch(/rsn-/);
  for (const re of RAW_MARKUP) {
    expect(r.answer, `${where}: markup ${re} in the answer`).not.toMatch(re);
    expect(r.text, `${where}: markup ${re} printed\n${r.text}`).not.toMatch(re);
  }
  for (const row of r.rows) {
    expect([...row].length, `${where}: row over width: ${JSON.stringify(row)}`).toBeLessThanOrEqual(columns);
  }
  const inR = reasoningRows(r.rows);
  r.rows.forEach((row, i) => {
    if (/rsn-/.test(row)) expect(inR.has(i), `${where}: reasoning outside ✻: ${JSON.stringify(row)}\n${r.text}`).toBe(true);
    if (/●/.test(row)) expect(row, `${where}: reasoning under ●`).not.toMatch(/rsn-/);
    if (inR.has(i)) expect(row, `${where}: prose or answer under ✻`).not.toMatch(/prose-step|ans-final/);
  });
  const hasReasoningRow = r.rows.some((x) => /✻/.test(x));
  if (["full", "work", "think"].includes(cot) && think !== "hide" && !fam.opaque) {
    expect(hasReasoningRow, `${where}: no ✻ row\n${r.text}`).toBe(true);
  }
  if (["tools", "brief", "off"].includes(cot)) expect(hasReasoningRow, `${where}: ✻ at cot=${cot}`).toBe(false);
  if (think === "hide") expect(hasReasoningRow, `${where}: ✻ at think=hide`).toBe(false);
  if (think === "show" && cot === "full" && !fam.opaque) {
    const flat = r.rows.join(" ").replace(/[┊✻]/g, " ").replace(/\s+/g, " ");
    for (const w of RSN1.split(" ")) expect(flat, `${where}: show lost "${w}"`).toContain(w);
  }
  if (cot === "tools" || cot === "full") expect(r.text, `${where}: no tool row\n${r.text}`).toMatch(/⚙ glob/);
  if (cot === "work") expect(r.text, `${where}: no tool row\n${r.text}`).toMatch(/⚙ glob|steps? folded|⎿/);
  if (cot === "brief") expect(r.text, `${where}: no brief row\n${r.text}`).toMatch(/•/);
  if (cot === "think" || cot === "off") expect(r.text, `${where}: tool row at ${cot}`).not.toMatch(/⚙ glob/);
  if (nested) for (const row of r.rows) if (row) expect(row, `${where}: no gutter`).toMatch(/┊/);
  if (fam.name.startsWith("leaked tool-tag")) expect(r.text, `${where}: stub shown as prose`).not.toMatch(/● <t/);
  if (fam.prose && cot === "full") expect(r.text, `${where}: prose lost`).toContain("prose-step");
}

describe("live trace per model family", () => {
  for (const fam of FAMILIES) {
    describe(fam.name, () => {
      for (const cot of ["brief", "tools", "think", "work", "full"]) {
        it(`/cot ${cot}, /think collapse, 60 cols`, async () => {
          check(fam, await run(fam, cot, "collapse", 60, false), cot, "collapse", 60, false);
        });
      }
      for (const think of ["collapse", "wrap", "show"]) {
        for (const columns of [60, 100]) {
          it(`/cot work, /think ${think}, ${columns} cols`, async () => {
            check(fam, await run(fam, "work", think, columns, false), "work", think, columns, false);
          });
          it(`/cot full, /think ${think}, ${columns} cols, delegated gutter`, async () => {
            check(fam, await run(fam, "full", think, columns, true), "full", think, columns, true);
          });
        }
      }
      it("/think hide: no reasoning row", async () => {
        check(fam, await run(fam, "full", "hide", 60, false), "full", "hide", 60, false);
      });
    });
  }

  it("Gemini's thought signature and OpenRouter's encrypted reasoning are replayed on the next call", async () => {
    const gem = FAMILIES.find((f) => f.extra)!;
    const g = await run(gem, "full", "collapse", 100);
    const second = g.bodies[1]!.messages.find((m: any) => m.tool_calls);
    expect(JSON.stringify(second.tool_calls)).toContain("thought_signature");
    const or = FAMILIES.find((f) => f.name.startsWith("OpenRouter reasoning + "))!;
    const o = await run(or, "full", "collapse", 100);
    expect(JSON.stringify(o.bodies[1]!.messages)).toContain("reasoning.encrypted");
  });
});
