/**
 * gnomon-core: Role inference tests
 */

import { describe, it, expect } from "vitest";
import { inferRole } from "./config.js";

describe("gnomon-core inference", () => {
  describe("inferRole", () => {
    it("infers plan role from /plan prefix", () => {
      expect(inferRole("/plan implement this feature")).toBe("plan");
    });

    it("infers plan role from /plan: prefix", () => {
      expect(inferRole("/plan: do the thing")).toBe("plan");
    });

    it("infers critique role from /critique prefix", () => {
      expect(inferRole("/critique this code")).toBe("critique");
    });

    it("infers critique role from /critique: prefix", () => {
      expect(inferRole("/critique: review this")).toBe("critique");
    });

    it("infers smol role from /smol prefix", () => {
      expect(inferRole("/smol summarize")).toBe("smol");
    });

    it("infers implement role by default", () => {
      expect(inferRole("implement this feature")).toBe("implement");
      expect(inferRole("write a function")).toBe("implement");
      expect(inferRole("")).toBe("implement");
    });

    it("handles case-insensitive prefixes", () => {
      expect(inferRole("/PLAN do something")).toBe("plan");
      expect(inferRole("/plan SOMETHING")).toBe("plan");
    });
  });
});
