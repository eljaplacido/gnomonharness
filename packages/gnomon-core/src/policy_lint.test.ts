import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintPolicy, policyLintSummary, POLICY_LINT_KINDS, POLICY_LINT_SCHEMA } from "./policy_lint.js";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../conformance/policy_lint.json"), "utf-8"));
const key = (f: { kind: string; role?: string; rule: string; pattern?: string }) => JSON.stringify([f.kind, f.role ?? null, f.rule, f.pattern ?? null]);

describe("policy lint — conformance/policy_lint.json", () => {
  it("publishes the kinds and the schema the code uses", () => {
    expect([...POLICY_LINT_KINDS]).toEqual(fixture.kinds);
    expect(POLICY_LINT_SCHEMA).toBe(fixture.schema);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const found = lintPolicy({ policy: c.policy, roles: c.roles, tools: c.tools ?? {} } as never);
      expect(found.map(key).sort()).toEqual(c.expected.map(key).sort());
      for (const f of found) {
        for (const k of fixture.finding_keys.required) expect(f).toHaveProperty(k);
        expect(Object.keys(f).every((k) => [...fixture.finding_keys.required, ...fixture.finding_keys.optional].includes(k))).toBe(true);
      }
    });
  }

  it("summarises with counts by kind", () => {
    const s = policyLintSummary(lintPolicy({ policy: {}, roles: { r: { tools: ["read"], bash_deny: ["x"] } }, tools: {} } as never));
    expect(Object.keys(s).sort()).toEqual([...fixture.summary_keys.required].sort());
    expect(s.by_kind).toEqual({ unreachable: 1 });
  });
});
