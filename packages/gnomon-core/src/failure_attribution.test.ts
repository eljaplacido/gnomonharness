import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_SCHEMA,
  ATTRIBUTION_THRESHOLDS,
  ETCLOVG_LAYERS,
  FAILURE_TAGS,
  attributeFailure,
  attributeTrail,
  attributionHistogram,
  describeAttribution,
  type AttributionInput,
} from "./failure_attribution.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "failure_attribution.json"), "utf-8")) as {
  schema: string;
  layers: string[];
  precedence: Array<{ tag: string; layer: string | null }>;
  thresholds: Record<string, number>;
  cases: Array<{ name: string; input: AttributionInput; expect: { tag: string; layer: string | null; secondary?: string[] } | null }>;
};

describe("failure attribution: the published contract", () => {
  it("the fixture's schema, layers, precedence and thresholds are the code's", () => {
    expect(FIXTURE.schema).toBe(ATTRIBUTION_SCHEMA);
    expect(FIXTURE.layers).toEqual([...ETCLOVG_LAYERS]);
    expect(FIXTURE.precedence.map((p) => [p.tag, p.layer])).toEqual(FAILURE_TAGS.map((t) => [t.tag, t.layer]));
    expect(FIXTURE.thresholds).toEqual({ ...ATTRIBUTION_THRESHOLDS });
  });

  it("every tag has a case that makes it primary", () => {
    const covered = new Set(FIXTURE.cases.flatMap((c) => (c.expect ? [c.expect.tag] : [])));
    for (const t of FAILURE_TAGS) expect(covered.has(t.tag), `no case for ${t.tag}`).toBe(true);
  });

  for (const c of FIXTURE.cases) {
    it(`case: ${c.name}`, () => {
      const got = attributeFailure(c.input);
      if (c.expect === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      expect(got!.tag).toBe(c.expect.tag);
      expect(got!.layer).toBe(c.expect.layer);
      expect(got!.secondary).toEqual(c.expect.secondary ?? []);
      expect(got!.rank).toBe(FAILURE_TAGS.findIndex((t) => t.tag === c.expect!.tag) + 1);
    });
  }
});

describe("failure attribution: shape", () => {
  it("is pure: the same input gives the same answer and the input is not changed", () => {
    const input: AttributionInput = { turn: { stop_reason: "deadline", tool_log: ["bash — timeout"] }, check: { passed: false } };
    const before = JSON.stringify(input);
    expect(attributeFailure(input)).toEqual(attributeFailure(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("names its signals from the record and never reads text", () => {
    const a = attributeFailure({ turn: { stop_reason: "endpoint_error", code: 12 }, check: { passed: false } })!;
    expect(a.signals).toEqual(["endpoint_error code 12"]);
    expect(describeAttribution(a)).toBe("execution / endpoint_error");
  });

  it("a histogram counts failures by tag and by layer, in contract order", () => {
    const h = attributionHistogram([
      attributeFailure({ turn: { stop_reason: "deadline" } }),
      attributeFailure({ turn: { stop_reason: "deadline" } }),
      attributeFailure({ turn: { stop_reason: "stall" } }),
      null,
    ]);
    expect(h.failed).toBe(3);
    expect(h.by_tag).toEqual({ budget_exhausted: 2, loop_stall: 1 });
    expect(Object.keys(h.by_layer)).toEqual(["execution", "lifecycle"]);
    expect(h.by_layer).toEqual({ execution: 1, lifecycle: 2 });
  });

  it("attributes a trail from its turn record and its other records", () => {
    const records = [
      { kind: "session_start", seq: 0 },
      { kind: "model_call", seq: 1, code: 0 },
      { kind: "model_call", seq: 2, code: 13 },
      { kind: "turn", seq: 3, stop_reason: "endpoint_error", code: 13, bucket: "apparatus_failure", tool_log: [] },
      { kind: "session_end", seq: 4 },
    ];
    expect(attributeTrail(records)?.tag).toBe("context_overflow");
    expect(attributeTrail([{ kind: "session_start" }])).toBeNull();
    // A clean trail shows no failure signal, and is not claimed to have succeeded.
    expect(attributeTrail([{ kind: "turn", stop_reason: "answered", bucket: "result", code: 0, tool_log: ["bash — exit 0"] }])).toBeNull();
  });

  it("a tool log across several turns is read as one session", () => {
    const records = [
      { kind: "turn", stop_reason: "answered", bucket: "result", code: 0, tool_log: ["bash — exit 1", "edit tests/test_a.py (+1 −1)"] },
      { kind: "turn", stop_reason: "answered", bucket: "result", code: 0, tool_log: ["bash — exit 0"], counters: { writes: 1 } },
    ];
    expect(attributeTrail(records, { passed: false })?.tag).toBe("wrong_thing_verified");
  });
});
