import { describe, it, expect } from "vitest";
import {
  SessionManager,
  validateSession,
  hashSteps,
  defaultExitCodeMap,
  mapBucket,
  isRefusal,
  isApparatusFailure,
  Bucket,
  SessionStep,
} from "./session.js";

describe("gnomon-core session", () => {
  describe("defaultExitCodeMap", () => {
    it("has expected_count of 9", () => {
      const map = defaultExitCodeMap();
      expect(map.expected_count).toBe(9);
    });

    it("has exactly 3 buckets", () => {
      const map = defaultExitCodeMap();
      expect(map.buckets).toEqual(
        expect.arrayContaining(["result", "refusal", "apparatus_failure"])
      );
      expect(map.buckets).toHaveLength(3);
    });

    it("maps codes correctly", () => {
      const map = defaultExitCodeMap();
      expect(map.exit_codes["0"]).toBe("result");
      expect(map.exit_codes["1"]).toBe("refusal");
      expect(map.exit_codes["10"]).toBe("apparatus_failure");
    });
  });

  describe("mapBucket", () => {
    it("maps known codes", () => {
      expect(mapBucket(0)).toBe("result");
      expect(mapBucket(1)).toBe("refusal");
      expect(mapBucket(10)).toBe("apparatus_failure");
    });

    it("defaults unknown codes to result", () => {
      expect(mapBucket(99)).toBe("result");
      expect(mapBucket(-1)).toBe("result");
    });

    it("uses custom map when provided", () => {
      const customMap = {
        exit_codes: { "42": "refusal" },
        buckets: ["result", "refusal", "apparatus_failure"] as Bucket[],
        expected_count: 1,
      };
      expect(mapBucket(42, customMap)).toBe("refusal");
    });
  });

  describe("bucket predicates", () => {
    it("isRefusal", () => {
      expect(isRefusal("refusal")).toBe(true);
      expect(isRefusal("result")).toBe(false);
    });

    it("isApparatusFailure", () => {
      expect(isApparatusFailure("apparatus_failure")).toBe(true);
      expect(isApparatusFailure("result")).toBe(false);
    });
  });

  describe("SessionManager", () => {
    const mockManifest = {
      build: "0.1.0+test",
      surface_hash: "abc123",
      sources: [{ path: ".gnomon/config.toml", sha256: "sha123" }],
    };

    it("creates empty session", () => {
      const sm = new SessionManager(mockManifest);
      expect(sm.record.session.steps).toHaveLength(0);
      expect(sm.stepCount).toBe(0);
    });

    it("adds steps", () => {
      const sm = new SessionManager(mockManifest);
      sm.addStep(0, "output", "err", 100);
      expect(sm.stepCount).toBe(1);
      expect(sm.record.session.steps).toHaveLength(1);
      expect(sm.record.session.steps[0].bucket).toBe("result");
    });

    it("records outcomes", () => {
      const sm = new SessionManager(mockManifest);
      sm.addStep(0);
      sm.addStep(1);
      sm.addStep(10);
      expect(sm.outcomes).toEqual(
        expect.arrayContaining(["result", "refusal", "apparatus_failure"])
      );
    });

    it("serializes to JSON", () => {
      const sm = new SessionManager(mockManifest);
      sm.addStep(0, "hello");
      const json = sm.toJSON();
      const parsed = JSON.parse(json);
      expect(parsed.session.steps).toHaveLength(1);
    });
  });

  describe("validateSession", () => {
    const baseRecord = {
      session: {
        manifest: {
          build: "0.1.0+test",
          surface_hash: "abc",
          sources: [],
        },
        version: "1",
        steps: [
          {
            native_code: 0,
            bucket: "result",
            duration_ms: 100,
            stdout: "",
            stderr: "",
          },
        ],
      },
      metadata: {
        created: new Date().toISOString(),
        runtime_version: "v20",
        driver_version: "0.1.0",
      },
    };

    it("validates good session", () => {
      expect(
        validateSession(baseRecord, { version: "1", steps: 1 })
      ).toBe(true);
    });

    it("rejects bad version", () => {
      expect(
        validateSession(baseRecord, { version: "2", steps: 1 })
      ).toBe(false);
    });

    it("rejects wrong step count", () => {
      expect(
        validateSession(baseRecord, { version: "1", steps: 5 })
      ).toBe(false);
    });

    it("rejects invalid bucket", () => {
      const badRecord = {
        ...baseRecord,
        session: {
          ...baseRecord.session,
          steps: [{ ...baseRecord.session.steps[0], bucket: "bogus" }],
        },
      };
      expect(validateSession(badRecord)).toBe(false);
    });
  });

  describe("hashSteps", () => {
    function makeStep(code: number, bucket: Bucket): SessionStep {
      return {
        native_code: code,
        bucket,
        duration_ms: 0,
        stdout: "",
        stderr: "",
      };
    }

    it("produces deterministic hash", () => {
      const steps = [makeStep(0, "result"), makeStep(1, "refusal")];
      const h1 = hashSteps(steps);
      const h2 = hashSteps(steps);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("changes with reordered steps", () => {
      const a = [makeStep(0, "result"), makeStep(1, "refusal")];
      const b = [makeStep(1, "refusal"), makeStep(0, "result")];
      expect(hashSteps(a)).not.toBe(hashSteps(b));
    });
  });
});
