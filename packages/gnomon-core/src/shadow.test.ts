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
 *   4. Accounted for. A shadow that cannot be reached -- at the start, or
 *      partway through -- is the declared degradation `shadow_unreachable`:
 *      said once, recorded in the trail and on the task record, and its
 *      coverage reads 0 of N rather than nothing. And the turn it watched is
 *      byte-for-byte the turn it would have been with no shadow at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { auditSurface, loadConfig, recomputeManifest, resolveShadow, shadowFreeSurfaceHash, stripTomlTable } from "./config.js";
import {
  abortCheckpoint,
  abortStateText,
  approvalLive,
  benchScrub,
  callText,
  shadowDir,
  shadowUrlForRecord,
  ShadowRecorder,
  SHADOW_QUESTIONS,
  sumCoverage,
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

/** What undici throws when nothing listens on the port. */
function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

/** A live shadow server's answer to the start check: something is listening. */
const listening = () => new Response(null, { status: 405 });

/** An audit trail that only collects, shaped like the sink the loop hands over. */
function trailSink() {
  const records: Array<Record<string, any>> = [];
  return { records, write: (kind: "degradation", fields: Record<string, unknown>) => void records.push({ kind, ...fields }) };
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
    coverage: { keys: string[] };
    degradation: { id: string; detail: string[]; phase: string[] };
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

  it("gives coverage and the stop's degradation exactly the fixture's keys, and section 7 names them", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const audit = trailSink();
    const rec = ShadowRecorder.create(loadConfig(root), {
      audit,
      fetchImpl: (async () => {
        throw refused();
      }) as unknown as typeof fetch,
    })!;
    rec.start();
    const coverage = await rec.close();
    expect(Object.keys(coverage)).toEqual(fixture.coverage.keys);
    expect(audit.records).toHaveLength(1);
    const [d] = audit.records;
    expect(d!.id).toBe(fixture.degradation.id);
    expect(Object.keys(d!.detail)).toEqual(fixture.degradation.detail);
    expect(fixture.degradation.phase).toContain(d!.detail.phase);

    const doc = readFileSync(join(process.cwd(), "..", "..", "docs", "CONTRACTS.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 7. Decision-shadow record"), doc.indexOf("## 8. "));
    expect(section).toContain(`\`${fixture.degradation.id}\``);
    for (const k of [...fixture.coverage.keys, ...fixture.degradation.detail, ...fixture.degradation.phase]) {
      expect(section, `section 7 does not name ${k}`).toContain(`\`${k}\``);
    }
  });
});

describe("shadow_unreachable: a shadow that cannot be reached is declared, said and recorded", () => {
  const TURN = {
    sessionId: "sess",
    label: "t1",
    role: "implement",
    model: "qwen3.6-35b",
    endpointUrl: "http://127.0.0.1:18080/v1/chat/completions",
    t0: 0,
  };
  const CALL = {
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
  const BARE = shadowUrlForRecord(SHADOW_URL);
  const degradations = (records: Array<Record<string, any>>) => records.filter((r) => r.kind === "degradation");

  it("unreachable at session start: one check, one line, one record, nothing sent after it", async () => {
    // Credentials in the url, the way somebody's tunnel might carry them. The
    // record says where the shadow was pointed, never how it authenticated.
    const secretUrl = "http://shadowuser:hunter2@shadow.test/v1/systemone?token=abc123";
    const root = surfaceWith(SHADOW_BLOCK.replace(SHADOW_URL, secretUrl));
    const warnings: string[] = [];
    const audit = trailSink();
    let tries = 0;
    const rec = ShadowRecorder.create(loadConfig(root), {
      warn: (l) => warnings.push(l),
      audit,
      fetchImpl: (async () => {
        tries++;
        throw refused();
      }) as unknown as typeof fetch,
    })!;
    rec.start();
    await rec.ready(1000);
    rec.role(TURN, "fix the parser");
    const t = rec.turn(TURN, "flag");
    t.call(CALL);
    t.call(CALL);
    await rec.flush();

    expect(tries, "the start check, and no question after it").toBe(1);
    expect(warnings).toEqual([
      `  [shadow] unreachable at session start: ${BARE} (ECONNREFUSED). Off for this session; nothing is recorded.`,
    ]);
    expect(degradations(audit.records)).toEqual([
      {
        kind: "degradation",
        id: "shadow_unreachable",
        declared: `[shadow] url = ${BARE}`,
        actual: "unreachable (ECONNREFUSED); the shadow stopped and records nothing this session",
        detail: { url: BARE, phase: "start", failures: 1, cause: "ECONNREFUSED" },
      },
    ]);
    expect(JSON.stringify(audit.records) + warnings.join("\n")).not.toMatch(/hunter2|abc123|shadowuser/);
    // A role question in two orders, then abort and approval in two orders for
    // each of two calls: ten asked for, none recorded.
    expect(rec.coverage()).toEqual({ attempted: 2 + 2 * 4, recorded: 0, pending: 0, stopped: true });
    const log = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(log.map((r) => r.decision)).toEqual(["shadow"]);
    expect(log[0]!.error).toBe("unreachable at session start (ECONNREFUSED): shadow stopped for this session");
  });

  it("never writes a credential, even when the error quotes the url whole", async () => {
    // Node's fetch refuses a url with userinfo before connecting, and its
    // message names the url: credentials, query and all. That message is the
    // cause of the stop, so it is the one place a secret could leak.
    const secretUrl = "http://shadowuser:hunter2@shadow.test/v1/systemone?token=abc123";
    const root = surfaceWith(SHADOW_BLOCK.replace(SHADOW_URL, secretUrl));
    const warnings: string[] = [];
    const audit = trailSink();
    const rec = ShadowRecorder.create(loadConfig(root), {
      warn: (l) => warnings.push(l),
      audit,
      fetchImpl: (async (u: string) => {
        throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${u}`);
      }) as unknown as typeof fetch,
    })!;
    rec.start();
    await rec.close();
    const everything = [
      ...warnings,
      JSON.stringify(audit.records),
      readFileSync(join(root, ".gnomon-shadow", "gnomon.jsonl"), "utf8"),
    ].join("\n");
    expect(everything).not.toMatch(/hunter2|abc123|shadowuser/);
    expect(degradations(audit.records)[0]!.detail.cause).toBe(
      `Request cannot be constructed from a URL that includes credentials: ${BARE}`
    );
  });

  it("failing mid-session: it answered, then three refused connections stop it, said once with the count", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const warnings: string[] = [];
    const audit = trailSink();
    let down = false;
    let posts = 0;
    const rec = ShadowRecorder.create(loadConfig(root), {
      warn: (l) => warnings.push(l),
      audit,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        if (init.method === "HEAD") return listening();
        posts++;
        if (down) throw refused();
        return decisionAnswer(init.body as string);
      }) as unknown as typeof fetch,
    })!;
    rec.start();
    await rec.ready(1000);
    const t = rec.turn(TURN, "flag");
    t.call(CALL);
    await rec.flush();
    expect(rec.coverage()).toEqual({ attempted: 4, recorded: 4, pending: 0, stopped: false });
    expect(audit.records).toEqual([]);

    down = true;
    for (let i = 0; i < 3; i++) t.call(CALL);
    await rec.flush();
    // Counted, never sent: the shadow had stopped.
    t.call(CALL);
    await rec.flush();

    expect(warnings).toEqual([
      `  [shadow] unreachable after 3 failed connections: ${BARE} (ECONNREFUSED). ` +
        "Off for the rest of this session; 4 of 16 decisions recorded.",
    ]);
    expect(degradations(audit.records)).toEqual([
      expect.objectContaining({
        id: "shadow_unreachable",
        detail: { url: BARE, phase: "mid_session", failures: 3, cause: "ECONNREFUSED" },
      }),
    ]);
    // Two in flight at a time, so the third failure can find a fourth already sent.
    expect(posts).toBe(4 + 4);
    expect(rec.coverage()).toEqual({ attempted: 20, recorded: 4, pending: 0, stopped: true });
    const log = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    // The stop line keeps its published wording: agentcenter's readout reads it.
    expect(log.filter((r) => r.decision === "shadow").map((r) => r.error)).toEqual([
      "unreachable (ECONNREFUSED): shadow stopped for this session after 3 connection failures",
    ]);
    expect(log.filter((r) => r.probs).length).toBe(4);
  });

  it("recovering: failures short of three in a row are written down, and it carries on undeclared", async () => {
    const root = surfaceWith(SHADOW_BLOCK);
    const warnings: string[] = [];
    const audit = trailSink();
    let posts = 0;
    const rec = ShadowRecorder.create(loadConfig(root), {
      warn: (l) => warnings.push(l),
      audit,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        if (init.method === "HEAD") return listening();
        // Two refused, two answered, two refused, two answered. Four failures
        // in all -- only a counter that resets on an answer survives them.
        if ([1, 2, 5, 6].includes(++posts)) throw refused();
        return decisionAnswer(init.body as string);
      }) as unknown as typeof fetch,
    })!;
    rec.start();
    const t = rec.turn(TURN, "flag");
    t.call(CALL);
    await rec.flush();
    t.call(CALL);
    await rec.flush();

    expect(warnings).toEqual([]);
    expect(audit.records).toEqual([]);
    expect(rec.coverage()).toEqual({ attempted: 8, recorded: 4, pending: 0, stopped: false });
    const log = readRecords(join(root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(log.filter((r) => r.error === "unreachable (ECONNREFUSED)")).toHaveLength(4);
    expect(log.filter((r) => r.probs)).toHaveLength(4);
  });

  it("a start check that times out decides nothing: a busy server is not an absent one", async () => {
    const root = surfaceWith(SHADOW_BLOCK.replace("orders", "timeout_ms = 20\norders"));
    const audit = trailSink();
    const rec = ShadowRecorder.create(loadConfig(root), {
      audit,
      fetchImpl: ((_u: string, init: RequestInit) =>
        init.method === "HEAD"
          ? new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
          : Promise.resolve(decisionAnswer(init.body as string))) as unknown as typeof fetch,
    })!;
    rec.start();
    await rec.flush();
    rec.turn(TURN, "flag").call(CALL);
    const coverage = await rec.close();
    expect(audit.records).toEqual([]);
    expect(coverage).toEqual({ attempted: 4, recorded: 4, pending: 0, stopped: false });
  });

  it("sums coverage over the recorders of one session", () => {
    expect(
      sumCoverage([
        { attempted: 4, recorded: 4, pending: 0, stopped: false },
        { attempted: 6, recorded: 0, pending: 1, stopped: true },
      ])
    ).toEqual({ attempted: 10, recorded: 4, pending: 1, stopped: true });
    expect(shadowUrlForRecord("https://u:p@h.example:8443/v1/x?k=v#f")).toBe("https://h.example:8443/v1/x");
  });

  it("interactive: says so under the banner, before the first prompt, and the trail records it", async () => {
    const root = surfaceWith(SHADOW_BLOCK, { audit: true });
    const input = new PassThrough();
    input.write("say hello\n/quit\n");
    input.end();
    const printed: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        printed.push(String(chunk));
        cb();
      },
    });
    let shadowTries = 0;
    const real = { log: console.log, error: console.error, fetch: globalThis.fetch, exit: process.exit };
    console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
    process.exit = (() => {}) as unknown as typeof process.exit;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url) === SHADOW_URL) {
        shadowTries++;
        throw refused();
      }
      return { ok: true, json: async () => ({ message: { content: "hello from the model" } }) };
    }) as unknown as typeof fetch;
    try {
      await promptLoop.runPromptLoop(loadConfig(root), "implement", { io: { input, output } });
    } finally {
      console.log = real.log;
      console.error = real.error;
      globalThis.fetch = real.fetch;
      process.exit = real.exit;
    }

    // eslint-disable-next-line no-control-regex
    const lines = printed.join("\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
    const said = lines.filter((l) => l.includes("[shadow]"));
    expect(said).toEqual([
      `  [shadow] unreachable at session start: ${BARE} (ECONNREFUSED). Off for this session; nothing is recorded.`,
    ]);
    const answeredAt = lines.findIndex((l) => l.includes("hello from the model"));
    expect(answeredAt).toBeGreaterThan(-1);
    expect(lines.indexOf(said[0]!), "under the banner, before the first turn").toBeLessThan(answeredAt);
    expect(shadowTries, "the start check only").toBe(1);

    const dir = join(root, ".gnomon-audit");
    const trail = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readRecords(join(dir, f)));
    expect(degradations(trail).map((d) => [d.id, d.detail.phase])).toEqual([["shadow_unreachable", "start"]]);
    const dead = { attempted: 2, recorded: 0, pending: 0, stopped: true };
    expect(trail.find((r) => r.kind === "turn")!.shadow).toEqual(dead);
    expect(trail.at(-1)).toMatchObject({ kind: "session_end", shadow: dead });
  }, 30000);
});

describe("log-only", () => {
  /**
   * A model that runs two slow read-only commands and a read, then answers.
   *
   * `shadow` is the decision server: `up` answers everything; `down` refuses
   * every connection, the start check included; `drops` answers the check and
   * the first ten questions (the role question and the first two calls'
   * four each), then refuses. Ten, not six: the third call's questions go out
   * after its 0.3 s command, when every earlier answer has landed, so the
   * count at the stop does not depend on timing.
   */
  function scriptedModel(shadow: "up" | "down" | "drops" = "up") {
    let call = 0;
    const shadowed: string[] = [];
    let probes = 0;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === SHADOW_URL) {
        if (init?.method === "HEAD") {
          probes++;
          if (shadow === "down") throw refused();
          return listening();
        }
        shadowed.push(String(url));
        if (shadow === "down" || (shadow === "drops" && shadowed.length > 10)) throw refused();
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
    return { impl, shadowed, probes: () => probes };
  }

  function trailOf(root: string): Array<Record<string, any>> {
    const dir = join(root, ".gnomon-audit");
    const file = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))[0]!;
    return readRecords(join(dir, file));
  }

  /**
   * The trail with what varies between runs taken out, and the shadow's own
   * accounting: its coverage field and its degradation record. `seq` goes too
   * when a degradation was taken out, since every record after it moved one.
   */
  function normalisedTrail(records: Array<Record<string, any>>, opts: { seq?: boolean } = {}): unknown[] {
    // The clock, wherever a record carries it: `duration_ms` on the turn, and
    // per model request `ms` and `first_byte_ms` -- on each `model_call`
    // record and in the turn record's `model_calls` (§29).
    // What each request SENT (counters.model_calls) is compared.
    const drop = new Set(["ts", "hash", "prev", "surface_hash", "duration_ms", "session", "shadow", "ms", "first_byte_ms"]);
    if (opts.seq === false) drop.add("seq");
    const unclocked = (m: any) =>
      m ? { ...m, calls: m.calls.map(({ ms, first_byte_ms, ...c }: any) => c) } : m;
    return records
      .filter((r) => !(r.kind === "degradation" && r.id === "shadow_unreachable"))
      .map((r) =>
        Object.fromEntries(
          Object.entries(r)
            .filter(([k]) => !drop.has(k))
            .map(([k, v]) => [k, k === "model_calls" ? unclocked(v) : v])
        )
      );
  }

  type Run = { record: any; trail: Array<Record<string, any>>; root: string; shadowed: number; probes: number; stderr: string };

  async function runOnce(extra: string, shadow: "up" | "down" | "drops" = "up"): Promise<Run> {
    const root = surfaceWith(extra, { audit: true });
    writeFileSync(join(root, "notes.txt"), "a note\n");
    const config = loadConfig(root);
    const { impl, shadowed, probes } = scriptedModel(shadow);
    const original = globalThis.fetch;
    const realWrite = process.stderr.write;
    const stderr: string[] = [];
    globalThis.fetch = impl;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const record = await promptLoop.runTask(config, "look around", { role: "implement", yes: true });
      return { record, trail: trailOf(root), root, shadowed: shadowed.length, probes: probes(), stderr: stderr.join("") };
    } finally {
      globalThis.fetch = original;
      process.stderr.write = realWrite;
    }
  }

  /** The record as the turn made it: no surface hash, no volatile, no degradations. */
  const turnOf = (r: any) => {
    const { surface_hash, volatile, degradations, ...rest } = r;
    return rest;
  };

  it("leaves the task record and the audit trail as they are without it", async () => {
    const off = await runOnce("");
    const on = await runOnce(SHADOW_BLOCK);
    // The shadow really ran: a role question, abort and approval questions for
    // three calls in two orders each, and a turn_end.
    expect(off.shadowed).toBe(0);
    expect(on.shadowed).toBe(2 + 3 * 2 + 3 * 2);
    expect(on.probes).toBe(1);
    const records = readRecords(join(on.root, ".gnomon-shadow", "gnomon.jsonl"));
    expect(records.filter((r) => r.decision === "turn_end")).toHaveLength(1);
    expect(existsSync(join(off.root, ".gnomon-shadow"))).toBe(false);

    expect(turnOf(on.record)).toEqual(turnOf(off.record));
    expect(on.record.degradations).toBeUndefined();
    expect(on.record.counters.worktree_moves).toBe(0);
    // One field more, and only where a shadow is declared: its coverage.
    const full = { attempted: 14, recorded: 14, pending: 0, stopped: false };
    expect(on.record.volatile.shadow).toEqual(full);
    expect(off.record.volatile.shadow).toBeUndefined();
    expect(on.trail.find((r) => r.kind === "turn")!.shadow).toEqual(full);
    expect(on.trail.find((r) => r.kind === "session_end")!.shadow).toEqual(full);
    expect(off.trail.some((r) => "shadow" in r)).toBe(false);
    expect(normalisedTrail(on.trail)).toEqual(normalisedTrail(off.trail));
    for (const r of [off, on]) rmSync(r.root, { recursive: true, force: true });
  }, 30000);

  it("a shadow that fails, at the start or partway, leaves the turn and its exit code byte-identical", async () => {
    const off = await runOnce("");
    const up = await runOnce(SHADOW_BLOCK, "up");
    const down = await runOnce(SHADOW_BLOCK, "down");
    const drops = await runOnce(SHADOW_BLOCK, "drops");
    const runs = { off, up, down, drops };

    // Byte-identical, not deep-equal: the record as the turn made it, in the
    // order its keys were written, is the same string in all four runs.
    const bytes = JSON.stringify(turnOf(off.record));
    for (const [name, r] of Object.entries(runs)) {
      expect(JSON.stringify(turnOf(r.record)), name).toBe(bytes);
      // The CLI's exit code is the bucket's (gnomon-cli index.ts); same bucket, same code.
      expect([r.record.bucket, r.record.code], name).toEqual([off.record.bucket, off.record.code]);
      expect(r.record.counters.worktree_moves, name).toBe(0);
    }
    expect(off.record.bucket).toBe("result");

    // Declared, with the url and the count and nothing else, on the record a
    // script reads and in the trail.
    const declared = (r: Run) => (r.record.degradations ?? []).map((d: any) => [d.id, d.detail.phase, d.detail.failures]);
    expect(declared(up)).toEqual([]);
    expect(declared(down)).toEqual([["shadow_unreachable", "start", 1]]);
    expect(declared(drops)).toEqual([["shadow_unreachable", "mid_session", 3]]);
    for (const r of [down, drops]) {
      expect(r.record.degradations[0].detail.url).toBe(SHADOW_URL);
      expect(r.trail.filter((x) => x.kind === "degradation")).toEqual([
        expect.objectContaining({ id: "shadow_unreachable", detail: r.record.degradations[0].detail }),
      ]);
      // Recorded inside the session: after its start, before its turn.
      const kinds = r.trail.map((x) => x.kind);
      expect(kinds.indexOf("degradation")).toBeGreaterThan(kinds.indexOf("session_start"));
      expect(kinds.indexOf("degradation")).toBeLessThan(kinds.indexOf("turn"));
      expect(normalisedTrail(r.trail, { seq: false })).toEqual(normalisedTrail(off.trail, { seq: false }));
    }

    // Said once, on stderr, where a `--json` run still shows it.
    const said = (r: Run) => r.stderr.split("\n").filter((l) => l.includes("[shadow]"));
    expect(said(up)).toEqual([]);
    expect(said(down)).toEqual([
      `  [shadow] unreachable at session start: ${SHADOW_URL} (ECONNREFUSED). Off for this session; nothing is recorded.`,
    ]);
    expect(said(drops)).toEqual([
      `  [shadow] unreachable after 3 failed connections: ${SHADOW_URL} (ECONNREFUSED). ` +
        "Off for the rest of this session; 10 of 14 decisions recorded.",
    ]);

    // Coverage: what a dashboard reads. Fourteen asked for in every shadowed run.
    expect(up.record.volatile.shadow).toEqual({ attempted: 14, recorded: 14, pending: 0, stopped: false });
    expect(down.record.volatile.shadow).toEqual({ attempted: 14, recorded: 0, pending: 0, stopped: true });
    expect(drops.record.volatile.shadow).toEqual({ attempted: 14, recorded: 10, pending: 0, stopped: true });
    for (const r of Object.values(runs)) rmSync(r.root, { recursive: true, force: true });
  }, 60000);
});

