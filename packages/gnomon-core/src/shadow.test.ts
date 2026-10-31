/**
 * The decision-model shadow (shadow.ts).
 *
 * Three things are pinned here, and each test would fail without the property
 * it names:
 *
 *   1. Bench parity. The state text, the call text and the secret scrub are
 *      ports of agentcenter's decisionbench, and PARITY below came from running
 *      that Python on a synthetic run -- so a drift in the port is a red test,
 *      not a quietly different question asked of the live runs.
 *   2. The record and its failure modes: both option orders, the calibration
 *      key without [shadow], a dead server stopping the shadow after three
 *      tries, a timeout written down rather than waited on.
 *   3. Log-only. The same scripted turn, shadow off and on, produces the same
 *      task record and the same audit trail. This is the test that caught the
 *      design before it shipped: records appended under the project root moved
 *      the worktree stamp, which drives the idle nudge.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig, recomputeManifest, resolveShadow, shadowFreeSurfaceHash, stripTomlTable } from "./config.js";
import {
  abortCheckpoint,
  abortStateText,
  approvalLive,
  benchScrub,
  callText,
  shadowDir,
  ShadowRecorder,
  SHADOW_QUESTIONS,
  type ShadowStep,
} from "./shadow.js";
import * as promptLoop from "./prompt_loop.js";

const REPO_SURFACE = join(process.cwd(), "..", "..", ".gnomon");
const SHADOW_URL = "http://shadow.test/v1/systemone";

// Generated 2026-10-31 by running agentcenter's own decisionbench code (abort.state_text,
// trajectory_scan.tool_text, tasks.scrub) on a synthetic run. Regenerate rather than edit:
// the point is that these strings came from the bench, not from this port.
const PARITY = {
 "steps": [
  {
   "t": 1002.5,
   "tool": "read",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "read src/lib.ts — 4 lines",
   "cmd": null,
   "tokens": 1234
  },
  {
   "t": 1005.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 1 (12 lines)",
   "cmd": "bash: pytest -q tests/test_x.py",
   "tokens": 4936
  },
  {
   "t": 1008.5,
   "tool": "grep",
   "target": "",
   "code": 3,
   "bucket": "refusal",
   "summary": "grep — denied",
   "cmd": null,
   "tokens": 11106
  },
  {
   "t": 1011.5,
   "tool": "write",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "write src/x.ts (+12 −3) — täsmälleen ✓",
   "cmd": null,
   "tokens": 19744
  },
  {
   "t": 1014.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 0",
   "cmd": "bash: export API_KEY=sk-abcdefghijklmnopqrstuv && make",
   "tokens": 30850
  },
  {
   "t": 1017.5,
   "tool": "edit",
   "target": "",
   "code": 11,
   "bucket": "apparatus_failure",
   "summary": "edit — timeout",
   "cmd": null,
   "tokens": 44424
  },
  {
   "t": 1020.5,
   "tool": "read",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "read src/lib.ts — 4 lines",
   "cmd": null,
   "tokens": 60466
  },
  {
   "t": 1023.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 1 (12 lines) xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
   "cmd": "bash: pytest -q tests/test_x.py",
   "tokens": 78976
  },
  {
   "t": 1026.5,
   "tool": "grep",
   "target": "",
   "code": 3,
   "bucket": "refusal",
   "summary": "grep — denied",
   "cmd": null,
   "tokens": 99954
  },
  {
   "t": 1029.5,
   "tool": "write",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "write src/x.ts (+12 −3) — täsmälleen ✓",
   "cmd": null,
   "tokens": 123400
  },
  {
   "t": 1032.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 0",
   "cmd": "bash: export API_KEY=sk-abcdefghijklmnopqrstuv && make",
   "tokens": 149314
  },
  {
   "t": 1035.5,
   "tool": "edit",
   "target": "",
   "code": 11,
   "bucket": "apparatus_failure",
   "summary": "edit — timeout",
   "cmd": null,
   "tokens": 177696
  },
  {
   "t": 1038.5,
   "tool": "read",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "read src/lib.ts — 4 lines",
   "cmd": null,
   "tokens": 208546
  },
  {
   "t": 1041.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 1 (12 lines)",
   "cmd": "bash: pytest -q tests/test_x.py",
   "tokens": 241864
  },
  {
   "t": 1044.5,
   "tool": "grep",
   "target": "",
   "code": 3,
   "bucket": "refusal",
   "summary": "grep — denied",
   "cmd": null,
   "tokens": 277650
  },
  {
   "t": 1047.5,
   "tool": "write",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "write src/x.ts (+12 −3) — täsmälleen ✓",
   "cmd": null,
   "tokens": 315904
  },
  {
   "t": 1050.5,
   "tool": "bash",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "bash — exit 0",
   "cmd": "bash: export API_KEY=sk-abcdefghijklmnopqrstuv && make",
   "tokens": 356626
  },
  {
   "t": 1053.5,
   "tool": "edit",
   "target": "",
   "code": 11,
   "bucket": "apparatus_failure",
   "summary": "edit — timeout",
   "cmd": null,
   "tokens": 399816
  },
  {
   "t": 1056.5,
   "tool": "read",
   "target": "",
   "code": 0,
   "bucket": "result",
   "summary": "read src/lib.ts — 4 lines",
   "cmd": null,
   "tokens": 445474
  }
 ],
 "t0": 1000.0,
 "state": {
  "1": "Coding-agent run in progress. Elapsed 2 s, 1 tool calls so far (0 errored, 0 refused), 1,234 tokens used.\nLast 1 tool calls, oldest first:\n1. read src/lib.ts — 4 lines",
  "3": "Coding-agent run in progress. Elapsed 8 s, 3 tool calls so far (2 errored, 1 refused), 11,106 tokens used.\nLast 3 tool calls, oldest first:\n1. read src/lib.ts — 4 lines\n2. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n3. grep — denied [harness: refusal]",
  "15": "Coding-agent run in progress. Elapsed 44 s, 15 tool calls so far (8 errored, 3 refused), 277,650 tokens used.\nLast 15 tool calls, oldest first:\n1. read src/lib.ts — 4 lines\n2. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n3. grep — denied [harness: refusal]\n4. write src/x.ts (+12 −3) — täsmälleen ✓\n5. bash — exit 0 | export [redacted] && make\n6. edit — timeout [harness: apparatus_failure]\n7. read src/lib.ts — 4 lines\n8. bash — exit 1 (12 lines) xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n9. grep — denied [harness: refusal]\n10. write src/x.ts (+12 −3) — täsmälleen ✓\n11. bash — exit 0 | export [redacted] && make\n12. edit — timeout [harness: apparatus_failure]\n13. read src/lib.ts — 4 lines\n14. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n15. grep — denied [harness: refusal]",
  "16": "Coding-agent run in progress. Elapsed 48 s, 16 tool calls so far (8 errored, 3 refused), 315,904 tokens used.\nLast 15 tool calls, oldest first:\n2. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n3. grep — denied [harness: refusal]\n4. write src/x.ts (+12 −3) — täsmälleen ✓\n5. bash — exit 0 | export [redacted] && make\n6. edit — timeout [harness: apparatus_failure]\n7. read src/lib.ts — 4 lines\n8. bash — exit 1 (12 lines) xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n9. grep — denied [harness: refusal]\n10. write src/x.ts (+12 −3) — täsmälleen ✓\n11. bash — exit 0 | export [redacted] && make\n12. edit — timeout [harness: apparatus_failure]\n13. read src/lib.ts — 4 lines\n14. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n15. grep — denied [harness: refusal]\n16. write src/x.ts (+12 −3) — täsmälleen ✓",
  "19": "Coding-agent run in progress. Elapsed 56 s, 19 tool calls so far (9 errored, 3 refused), 445,474 tokens used.\nLast 15 tool calls, oldest first:\n5. bash — exit 0 | export [redacted] && make\n6. edit — timeout [harness: apparatus_failure]\n7. read src/lib.ts — 4 lines\n8. bash — exit 1 (12 lines) xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n9. grep — denied [harness: refusal]\n10. write src/x.ts (+12 −3) — täsmälleen ✓\n11. bash — exit 0 | export [redacted] && make\n12. edit — timeout [harness: apparatus_failure]\n13. read src/lib.ts — 4 lines\n14. bash — exit 1 (12 lines) | pytest -q tests/test_x.py\n15. grep — denied [harness: refusal]\n16. write src/x.ts (+12 −3) — täsmälleen ✓\n17. bash — exit 0 | export [redacted] && make\n18. edit — timeout [harness: apparatus_failure]\n19. read src/lib.ts — 4 lines"
 },
 "tool_text": [
  [
   "Bash",
   {
    "command": "ls -la",
    "description": "list"
   },
   "Bash: ls -la"
  ],
  [
   "Read",
   {
    "file_path": "/a/b.py"
   },
   "Read: /a/b.py"
  ],
  [
   "Grep",
   {
    "pattern": "foo",
    "path": "src"
   },
   "Grep: foo"
  ],
  [
   "Weird",
   {
    "x": 1,
    "y": [
     1,
     2
    ]
   },
   "Weird: {\"x\": 1, \"y\": [1, 2]}"
  ]
 ],
 "scrub": [
  [
   "token=abc123 ok",
   "[redacted] ok"
  ],
  [
   "key sk-0123456789abcdefABCD end",
   "key [redacted] end"
  ],
  [
   "Password: hunter2",
   "[redacted]"
  ],
  [
   "AKIAABCDEFGHIJKLMNOP",
   "[redacted]"
  ]
 ]
} as const;

function surfaceWith(extra: string, opts: { audit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-shadow-"));
  cpSync(REPO_SURFACE, join(dir, ".gnomon"), { recursive: true });
  const cfg = join(dir, ".gnomon", "config.toml");
  let text = readFileSync(cfg, "utf8");
  if (opts.audit) text = text.replace(/(\[audit\][\s\S]*?\n)enabled = false/, "$1enabled = true");
  writeFileSync(cfg, text + extra);
  return dir;
}

const SHADOW_BLOCK = `
[shadow]
enabled = true
url = "${SHADOW_URL}"
abort = ["d1-3b"]
role = ["vllm-d3"]
approval = ["vllm-d3"]
orders = ["fwd", "rev"]
`;

/** A decision server that answers with the first label at 0.7. */
function decisionAnswer(body: string): Response {
  const req = JSON.parse(body) as { questions: { q: { criteria: Record<string, string> } } };
  const labels = Object.keys(req.questions.q.criteria);
  const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.7 : 0.3 / (labels.length - 1)]));
  return new Response(JSON.stringify({ answers: { q: { choice: labels[0], probabilities, confidence: 0.7 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readRecords(file: string): Array<Record<string, any>> {
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

let savedShadowDir: string | undefined;
beforeEach(() => {
  savedShadowDir = process.env.DECISION_SHADOW_DIR;
  delete process.env.DECISION_SHADOW_DIR;
});
afterEach(() => {
  if (savedShadowDir === undefined) delete process.env.DECISION_SHADOW_DIR;
  else process.env.DECISION_SHADOW_DIR = savedShadowDir;
});

describe("bench parity", () => {
  const steps = (k: number): ShadowStep[] =>
    PARITY.steps.slice(0, k).map((s) => ({
      tool: s.tool,
      code: s.code,
      bucket: s.bucket,
      summary: s.summary,
      cmd: s.cmd ?? undefined,
      at: s.t * 1000,
      tokens: s.tokens,
    }));

  it("builds the abort state text byte for byte as abort.state_text does", () => {
    for (const [k, expected] of Object.entries(PARITY.state)) {
      expect(abortStateText(steps(Number(k)), PARITY.t0 * 1000)).toBe(expected);
    }
  });

  it("renders a call as trajectory_scan.tool_text does", () => {
    for (const [name, args, expected] of PARITY.tool_text) {
      expect(callText(name as string, args as Record<string, unknown>)).toBe(expected);
    }
  });

  it("scrubs secrets as tasks.scrub does", () => {
    for (const [input, expected] of PARITY.scrub) expect(benchScrub(input)).toBe(expected);
  });

  it("scores every call up to 30, then every 5th", () => {
    const scored = Array.from({ length: 50 }, (_, i) => i + 1).filter(abortCheckpoint);
    expect(scored).toEqual([...Array.from({ length: 30 }, (_, i) => i + 1), 35, 40, 45, 50]);
  });

  it("asks the decisionbench questions verbatim", () => {
    expect(SHADOW_QUESTIONS.abort.instructions).toBe(
      "This is the log so far of a coding agent working on a programming task. " +
        "Automated tests check the code when the agent stops. Will the tests pass at the end?"
    );
    expect(Object.keys(SHADOW_QUESTIONS.abort.criteria)).toEqual(["will_pass", "will_fail"]);
    expect(Object.keys(SHADOW_QUESTIONS.role.criteria)).toEqual([
      "plan", "coordinator", "implement", "implementor", "verifier", "critique", "smol",
    ]);
    expect(Object.keys(SHADOW_QUESTIONS.approval.criteria)).toEqual(["proceed", "ask_first"]);
  });
});

describe("[shadow] in the surface", () => {
  it("is off unless declared, and off without a url", () => {
    const off = loadConfig(surfaceWith(""));
    expect(resolveShadow(off).enabled).toBe(false);
    const noUrl = loadConfig(surfaceWith('\n[shadow]\nenabled = true\nabort = ["d1-3b"]\n'));
    expect(resolveShadow(noUrl).enabled).toBe(false);
    expect(auditSurface(noUrl).some((p) => p.problem.includes("no usable url"))).toBe(true);
    expect(resolveShadow(loadConfig(surfaceWith(SHADOW_BLOCK))).enabled).toBe(true);
  });

  it("says so when a key, an order or a model list would make it record nothing", () => {
    const c = loadConfig(
      surfaceWith(`\n[shadow]\nenabled = true\nurl = "${SHADOW_URL}"\nabrot = ["d1-3b"]\norders = ["fwd", "back"]\n`)
    );
    const problems = auditSurface(c).filter((p) => p.where.includes("[shadow]"));
    expect(problems.some((p) => p.problem.includes('Did you mean "abort"'))).toBe(true);
    expect(problems.some((p) => p.problem.includes('"back" is not an order'))).toBe(true);
    expect(problems.some((p) => p.problem.includes("no model is named"))).toBe(true);
    expect(problems.every((p) => !p.fatal)).toBe(true);
    expect(resolveShadow(c).orders).toEqual(["fwd"]);
  });

  it("keys calibration on the surface without its [shadow] table", () => {
    const plain = surfaceWith("");
    const shadowed = surfaceWith(SHADOW_BLOCK);
    const plainHash = recomputeManifest(join(plain, ".gnomon")).surface_hash;
    // The table moves the surface hash -- Rule 1 -- and not the calibration key.
    expect(recomputeManifest(join(shadowed, ".gnomon")).surface_hash).not.toBe(plainHash);
    expect(shadowFreeSurfaceHash(join(shadowed, ".gnomon"))).toBe(plainHash);
    expect(shadowFreeSurfaceHash(join(plain, ".gnomon"))).toBe(plainHash);
    expect(stripTomlTable("a = 1\n[shadow]\nx = 2\n[shadow.more]\ny = 3\n[ui]\nz = 4\n", "shadow"))
      .toBe("a = 1\n[ui]\nz = 4\n");
  });
});

describe("approval, as gnomon actually decided it", () => {
  const base = { tool: "bash", args: {}, code: 0, bucket: "result", summary: "", tokens: 0 };
  it("keeps a person's decline apart from the flag, the default and a standing grant", () => {
    expect(approvalLive({ ...base, gated: false, standing: false }, "asked")).toBe("not_gated");
    const asked = { ...base, gated: true, standing: false, approval: { summary: "bash: x", approved: false } };
    expect(approvalLive(asked, "asked")).toBe("asked:declined");
    expect(approvalLive({ ...asked, approval: { summary: "bash: x", approved: true } }, "flag")).toBe("flag:approved");
    expect(approvalLive({ ...asked, standing: true, approval: { summary: "bash: x", approved: true } }, "asked"))
      .toBe("standing:approved");
    expect(approvalLive({ ...base, gated: true, standing: false, bucket: "refusal" }, "asked")).toBe("policy:refusal");
  });
});

describe("ShadowRecorder", () => {
  const info = (root: string) => ({
    sessionId: "sess",
    label: "t1",
    role: "implement",
    model: "qwen3.6-35b",
    endpointUrl: "http://127.0.0.1:18080/v1/chat/completions",
    t0: 0,
  });
  const call = {
    tool: "bash",
    args: { command: "pytest -q" },
    code: 0,
    bucket: "result",
    summary: "bash — exit 1 (3 lines)",
    gated: true,
    standing: false,
    approval: { summary: "bash: pytest -q", approved: true },
    tokens: 1200,
  };

  it("writes one contract record per model and order, in both orders", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const asked: string[][] = [];
    const rec = ShadowRecorder.create(loadConfig(root), {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        asked.push(Object.keys(JSON.parse(init.body as string).questions.q.criteria));
        return decisionAnswer(init.body as string);
      }) as unknown as typeof fetch,
    })!;
    rec.turn(info(root), "flag").call(call);
    await rec.flush();
    const records = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    const abort = records.filter((r) => r.decision === "abort");
    const byOrder = Object.fromEntries(abort.map((r) => [r.order, r]));
    expect(Object.keys(byOrder).sort()).toEqual(["fwd", "rev"]);
    expect(byOrder.fwd.labels).toEqual(["will_pass", "will_fail"]);
    expect(byOrder.rev.labels).toEqual(["will_fail", "will_pass"]);
    expect(asked).toContainEqual(["will_fail", "will_pass"]);
    const r = byOrder.fwd;
    expect(r).toMatchObject({
      v: 1, project: "gnomon", decision: "abort", subject_id: "sess.t1:1", model: "d1-3b",
      question: "gnomon_abort.v1", live: "continue", role: "implement", depth: 0,
      agent_model: "qwen3.6-35b", error: null,
    });
    expect(r.calib_key).toMatch(/^\d+\.\d+\.\d+:[0-9a-f]{64}$/);
    expect(r.cell).toMatch(/^[0-9a-f]{12}$/);
    expect(r.surface_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.probs.will_pass).toBeCloseTo(0.7);
    const approval = records.filter((x) => x.decision === "approval");
    expect(approval).toHaveLength(2);
    expect(approval[0]).toMatchObject({ live: "flag:approved", question: "needs_approval.v1", subject_id: "sess.t1:1" });
    expect(approval[0].excerpt).toBe("bash: pytest -q");
  });

  it("stamps DECISION_SHADOW_RUN on every record as run_label, and nothing when it is unset", async () => {
    // How a benchmark trial joins its verdict: the adapter already has a trial
    // id, and the gnomon session id is not in `task --json`.
    const end = { stop_reason: "answered", code: 0, bucket: "result", tool_steps: 1, tokens: 1, duration_ms: 1 };
    const records = async (env: NodeJS.ProcessEnv) => {
      const root = surfaceWith(SHADOW_BLOCK);
      const rec = ShadowRecorder.create(loadConfig(root), {
        env,
        fetchImpl: (async (_u: string, init: RequestInit) => decisionAnswer(init.body as string)) as any,
      })!;
      rec.turn(info(root), "flag").call(call);
      rec.turnEnd(info(root), end);
      await rec.flush();
      return readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    };
    const labelled = await records({ DECISION_SHADOW_RUN: "  tb-trial-7  " });
    expect(labelled.length).toBe(5);
    expect(labelled.every((r) => r.run_label === "tb-trial-7")).toBe(true);
    const plain = await records({});
    expect(plain.length).toBe(5);
    expect(plain.every((r) => !("run_label" in r))).toBe(true);
  });

  it("writes a model-free turn_end, so outcomes join without the audit trail", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const rec = ShadowRecorder.create(loadConfig(root), { fetchImpl: (async () => decisionAnswer("{}")) as any })!;
    rec.turnEnd(info(root), {
      stop_reason: "answered", code: 0, bucket: "result", verify: "failed", tool_steps: 4, tokens: 900, duration_ms: 12,
    });
    const [r] = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(r).toMatchObject({ decision: "turn_end", subject_id: "sess.t1", verify: "fail", tool_steps: 4, tokens: 900 });
    expect(r.model).toBeUndefined();
  });

  it("stops for the session after three connection failures, and says so once", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const warnings: string[] = [];
    let tries = 0;
    const rec = ShadowRecorder.create(loadConfig(root), {
      warn: (l) => warnings.push(l),
      fetchImpl: (async () => {
        tries++;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    })!;
    const t = rec.turn(info(root), "flag");
    for (let i = 0; i < 5; i++) t.call(call);
    await rec.flush();
    // Two requests are in flight at a time, so the third failure can find a
    // fourth already sent; nothing is sent after it.
    expect(tries).toBeGreaterThanOrEqual(3);
    expect(tries).toBeLessThanOrEqual(4);
    expect(warnings).toHaveLength(1);
    const records = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(records.filter((r) => r.decision === "shadow")).toHaveLength(1);
    expect(records.filter((r) => r.decision !== "shadow").length).toBeLessThanOrEqual(2);
  });

  it("writes a timeout down instead of waiting on it", async () => {
    const root = surfaceWith(SHADOW_BLOCK.replace("orders", 'abort_timeout_ms = 20\ntimeout_ms = 20\norders'));
    const rec = ShadowRecorder.create(loadConfig(root), {
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as any,
    })!;
    rec.turn(info(root), "flag").call(call);
    await rec.flush();
    const records = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(records.length).toBe(4);
    expect(records.every((r) => r.error === "timeout after 20ms" && r.probs === undefined)).toBe(true);
  });

  it("refuses a DECISION_SHADOW_DIR inside the project, where it would move the worktree stamp", () => {
    const warnings: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "gnomon-shadow-dir-"));
    expect(shadowDir(root, { DECISION_SHADOW_DIR: join(root, "logs") }, (l) => warnings.push(l)))
      .toBe(join(root, ".gnomon-shadow"));
    expect(warnings).toHaveLength(1);
    const outside = mkdtempSync(join(tmpdir(), "gnomon-shadow-out-"));
    expect(shadowDir(root, { DECISION_SHADOW_DIR: outside }, () => {})).toBe(outside);
    expect(shadowDir(root, {}, () => {})).toBe(join(root, ".gnomon-shadow"));
  });
});

describe("the record contract (CONTRACTS.md section 7)", () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "..", "..", "conformance", "shadow_record.json"), "utf8")
  ) as {
    v: number;
    decisions: string[];
    questions: Record<string, { id: string; labels: string[] }>;
    orders: string[];
    keys: Record<string, { required: string[]; optional: string[] }>;
    live: { approval: string[] };
  };
  const fits = (r: Record<string, unknown>, kind: string) => {
    const { required, optional } = fixture.keys[kind]!;
    expect(Object.keys(r).filter((k) => !required.includes(k) && !optional.includes(k))).toEqual([]);
    expect(required.filter((k) => !(k in r))).toEqual([]);
  };

  it("emits every kind of record with exactly the fixture's keys", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const turn = { sessionId: "s", label: "t1", role: "implement", model: "m", endpointUrl: "http://e", t0: 0 };
    const rec = ShadowRecorder.create(loadConfig(root), {
      env: { DECISION_SHADOW_RUN: "trial-1" },
      fetchImpl: (async (_u: string, init: RequestInit) => decisionAnswer(init.body as string)) as any,
    })!;
    rec.role(turn, "fix the parser");
    rec.turn(turn, "asked").call({
      tool: "read", args: { path: "a.ts" }, code: 0, bucket: "result", summary: "read a.ts — 3 lines",
      gated: false, standing: false, tokens: 10,
    });
    rec.turnEnd(turn, { stop_reason: "answered", code: 0, bucket: "result", tool_steps: 1, tokens: 10, duration_ms: 5 });
    await rec.flush();
    // The stop notice, from a recorder whose server is gone.
    const dead = ShadowRecorder.create(loadConfig(root), {
      fetchImpl: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    })!;
    for (let i = 0; i < 3; i++) dead.role(turn, "x");
    await dead.flush();

    const records = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(new Set(records.map((r) => r.decision))).toEqual(new Set(fixture.decisions));
    for (const r of records) {
      expect(r.v).toBe(fixture.v);
      const kind = r.decision === "turn_end" || r.decision === "shadow" ? r.decision : "question";
      fits(r, kind);
      if (kind !== "question") continue;
      const q = fixture.questions[r.decision]!;
      expect(r.question).toBe(q.id);
      expect(fixture.orders).toContain(r.order);
      expect(r.labels).toEqual(r.order === "fwd" ? q.labels : [...q.labels].reverse());
      if (r.decision === "approval") expect(fixture.live.approval).toContain(r.live);
    }
  });

  it("names the code's questions and labels, and CONTRACTS.md names the same decisions", () => {
    for (const [decision, q] of Object.entries(fixture.questions)) {
      const code = SHADOW_QUESTIONS[decision as keyof typeof SHADOW_QUESTIONS];
      expect(code.id).toBe(q.id);
      expect(Object.keys(code.criteria)).toEqual(q.labels);
    }
    const doc = readFileSync(join(process.cwd(), "..", "..", "docs", "CONTRACTS.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 7. Decision-shadow record"));
    for (const d of fixture.decisions) expect(section).toContain(`| \`${d}\` |`);
  });
});

describe("log-only", () => {
  /** A model that runs two slow read-only commands and a read, then answers. */
  function scriptedModel() {
    let call = 0;
    const shadowed: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === SHADOW_URL) {
        shadowed.push(String(url));
        // Slow enough that answers land while the next bash call is running,
        // which is exactly when an append under the root moved the stamp.
        await new Promise((r) => setTimeout(r, 15));
        return decisionAnswer(init!.body as string);
      }
      call++;
      const tool_calls =
        call === 1 ? [{ function: { name: "bash", arguments: { command: "sleep 0.3 && echo one" } } }]
        : call === 2 ? [{ function: { name: "read", arguments: { path: "notes.txt" } } }]
        : call === 3 ? [{ function: { name: "bash", arguments: { command: "sleep 0.3 && echo two" } } }]
        : undefined;
      return {
        ok: true,
        json: async () => ({
          message: tool_calls ? { content: "", tool_calls } : { content: "looked around; nothing to change" },
          prompt_eval_count: 100 * call,
          eval_count: 10,
        }),
      };
    }) as unknown as typeof fetch;
    return { impl, shadowed };
  }

  function normalisedTrail(root: string): unknown[] {
    const dir = join(root, ".gnomon-audit");
    const file = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))[0]!;
    const drop = new Set(["ts", "hash", "prev", "surface_hash", "duration_ms", "session"]);
    return readRecords(join(dir, file)).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k)))
    );
  }

  it("leaves the task record and the audit trail as they are without it", async () => {
    const runs: Array<{ record: any; trail: unknown[]; root: string; shadowed: number }> = [];
    for (const extra of ["", SHADOW_BLOCK]) {
      const root = surfaceWith(extra, { audit: true });
      writeFileSync(join(root, "notes.txt"), "a note\n");
      const config = loadConfig(root);
      const { impl, shadowed } = scriptedModel();
      const original = globalThis.fetch;
      globalThis.fetch = impl;
      try {
        const record = await promptLoop.runTask(config, "look around", { role: "implement", yes: true });
        runs.push({ record, trail: normalisedTrail(root), root, shadowed: shadowed.length });
      } finally {
        globalThis.fetch = original;
      }
    }
    const [off, on] = runs;
    // The shadow really ran: a role question, abort and approval questions for
    // three calls in two orders each, and a turn_end.
    expect(off.shadowed).toBe(0);
    expect(on.shadowed).toBe(2 + 3 * 2 + 3 * 2);
    const records = readRecords(join(on.root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(records.filter((r) => r.decision === "turn_end")).toHaveLength(1);
    expect(existsSync(join(off.root, ".gnomon-shadow"))).toBe(false);

    const strip = (r: any) => {
      const { surface_hash, volatile, ...rest } = r;
      return rest;
    };
    expect(strip(on.record)).toEqual(strip(off.record));
    expect(on.record.counters.worktree_moves).toBe(0);
    expect(on.trail).toEqual(off.trail);
    for (const r of runs) rmSync(r.root, { recursive: true, force: true });
  }, 30000);
});

