/**
 * gnomon-core: Replay tests
 *
 * These do not mock the trail writer. Every trail here is produced by the real
 * `AuditTrail`, so a change to how records are written breaks these tests
 * rather than quietly making them test a shape nothing writes.
 *
 * `harness` is pinned through `ReplayOptions` throughout, because
 * `harnessBuild()` reads the git state of whatever tree the suite runs in — a
 * test that let it float would pass on a clean checkout and fail on a dirty
 * one, which is the machine-scoped behaviour this project exists to avoid.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail, AuditKind, AuditRecord, ResolvedAudit, recordHash } from "./audit.js";
import { loadConfig, recomputeManifest, GnomonConfig } from "./config.js";
import { replay, readTrail, formatReplay, HARNESS_DERIVED, MODEL_SUPPLIED, ReplayResult } from "./replay.js";

const HARNESS = "gnomon/0.1.0+testpin";

let root: string;
let savedModelUrl: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-replay-"));
  // routeRole consults this, so a value left in the environment would make the
  // route.url check uncheckable and silently hollow out half the suite.
  savedModelUrl = process.env.GNOMON_MODEL_URL;
  delete process.env.GNOMON_MODEL_URL;
});
afterEach(() => {
  if (savedModelUrl === undefined) delete process.env.GNOMON_MODEL_URL;
  else process.env.GNOMON_MODEL_URL = savedModelUrl;
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG_TOML = `
[defaults]
approval = "on_write"
sandbox = "confined"
`;

const ROLES_TOML = `
[roles.implement]
model = "local:large"
endpoint = "local"

[roles.review]
model = "local:small"
tools = ["read"]
`;

const TOOLS_TOML = `
[[tools]]
name = "read"
description = "Read a file"
enabled = true

[[tools]]
name = "bash"
description = "Run a command"
enabled = true

[[tools]]
name = "write"
description = "Write a file"
enabled = true

[[tools]]
name = "task"
description = "Delegate a sub-turn"
enabled = true
`;

/** Write a `.gnomon/` surface and return the loaded config. */
function surface(over: Partial<Record<string, string>> = {}): GnomonConfig {
  const dir = join(root, ".gnomon");
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "config.toml": CONFIG_TOML,
    "roles.toml": ROLES_TOML,
    "tools.toml": TOOLS_TOML,
    "policy.toml": "",
    "system.md": "be useful\n",
    ...over,
  };
  for (const [name, body] of Object.entries(files)) {
    if (body === undefined) continue;
    writeFileSync(join(dir, name), body);
  }
  return loadConfig(root);
}

function surfaceHash(config: GnomonConfig): string {
  return recomputeManifest(config.gnomonDir).surface_hash;
}

const auditSettings = (over: Partial<ResolvedAudit> = {}): ResolvedAudit => ({
  enabled: true,
  dir: join(root, ".gnomon-audit"),
  record: "metadata",
  redact: [],
  chain: true,
  invalid_redact: [],
  ...over,
});

/** Write a trail with the real writer. Returns its path. */
function trail(
  records: Array<[AuditKind, Record<string, unknown>]>,
  over: Partial<ResolvedAudit> = {}
): string {
  const t = new AuditTrail(auditSettings(over), `s${records.length}-${Math.random().toString(36).slice(2)}`);
  for (const [kind, fields] of records) t.write(kind, fields);
  return t.path!;
}

/** A clean single-turn session under the fixture surface. */
function cleanSession(hash: string): Array<[AuditKind, Record<string, unknown>]> {
  return [
    [
      "session_start",
      {
        surface_hash: hash,
        harness: HARNESS,
        cwd: root,
        roles: ["implement", "review"],
        record: "metadata",
      },
    ],
    [
      "tool_call",
      {
        role: "implement",
        tool: "read",
        target: "src/a.ts",
        gated: false,
        code: 0,
        bucket: "result",
        summary: "read — src/a.ts (12 lines)",
      },
    ],
    [
      "turn",
      {
        turn: 1,
        role: "implement",
        model: "local:large",
        endpoint: "local",
        endpoint_url: "http://127.0.0.1:11434/api/chat",
        bucket: "result",
        code: 0,
        duration_ms: 1234,
        tool_steps: 1,
        tool_log: ["read — src/a.ts (12 lines)"],
        stop_reason: "model_stopped",
        skills: [],
        surface_hash: hash,
      },
    ],
    ["session_end", { turns: 1, surface_hash: hash }],
  ];
}

/**
 * Rewrite a trail's lines and RE-CHAIN it, so the hashes hold.
 *
 * This is the forger a plain hash chain cannot catch: edit a record, recompute
 * every hash from there on, and `verifyTrail` reports a perfectly intact trail.
 * The tests that use it assert `chain_ok === true` first, so they are testing
 * something replay adds rather than something chaining already did.
 */
function tamperAndRechain(path: string, edit: (r: AuditRecord, i: number) => void): void {
  const records = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditRecord);
  records.forEach(edit);
  let prev: string | null = null;
  for (const r of records) {
    r.prev = prev;
    delete r.hash;
    r.hash = recordHash(r);
    prev = r.hash;
  }
  writeFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const check = (r: ReplayResult, kind: string, field: string) =>
  r.entries.filter((e) => e.kind === kind).flatMap((e) => e.checks).find((c) => c.field === field);

const checks = (r: ReplayResult, field: string) =>
  r.entries.flatMap((e) => e.checks).filter((c) => c.field === field);

// ---------------------------------------------------------------------------

describe("a trail replayed against its own surface", () => {
  it("replays clean", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    const r = replay(path, config, { harness: HARNESS });

    expect(r.surface.status).toBe("same");
    expect(r.harness.status).toBe("same");
    expect(r.integrity.chain_ok).toBe(true);
    expect(r.integrity.sealed).toBe(true);
    expect(r.totals.diverged).toBe(0);
    expect(r.totals.entries_diverged).toBe(0);
    expect(r.verdict).toBe("clean");
    // It actually compared something — a "clean" verdict over zero checks
    // would be the failure mode that matters most here.
    expect(r.totals.match).toBeGreaterThan(5);
  });

  it("re-derives the route, the offered tool set, the gate and the bucket", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    const r = replay(path, config, { harness: HARNESS });

    expect(check(r, "turn", "route.model")).toMatchObject({
      status: "match",
      recorded: "local:large",
      replayed: "local:large",
    });
    expect(check(r, "turn", "route.endpoint")).toMatchObject({ status: "match" });
    expect(check(r, "turn", "route.url")).toMatchObject({
      status: "match",
      replayed: "http://127.0.0.1:11434/api/chat",
    });
    expect(check(r, "turn", "bucket")).toMatchObject({ status: "match", replayed: "result" });
    expect(check(r, "tool_call", "offered")).toMatchObject({ status: "match", replayed: true });
    expect(check(r, "tool_call", "gated")).toMatchObject({ status: "match", replayed: false });
    expect(check(r, "session_end", "turns")).toMatchObject({ status: "match", replayed: 1 });
  });

  it("never claims to re-derive a field the model supplied", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    const r = replay(path, config, { harness: HARNESS });
    const fields = new Set(r.entries.flatMap((e) => e.checks).map((c) => c.field));
    // `output`, `input` and `code` sit OUTSIDE TaskRecord.volatile and are
    // still the model's, not the harness's. Replay reads them; it must never
    // produce a `replayed` value for one.
    for (const f of MODEL_SUPPLIED) expect(fields.has(f)).toBe(false);
  });
});

describe("a changed surface", () => {
  it("is reported first, and no behaviour is compared across it", () => {
    const config = surface();
    const recorded = surfaceHash(config);
    const path = trail(cleanSession(recorded));

    // Move the surface. system.md is hashed, so this is a real drift.
    writeFileSync(join(root, ".gnomon", "system.md"), "be useful, and terse\n");
    const moved = loadConfig(root);
    expect(surfaceHash(moved)).not.toBe(recorded);

    const r = replay(path, moved, { harness: HARNESS });

    expect(r.verdict).toBe("not_comparable");
    expect(r.surface.status).toBe("different");
    expect(r.surface.recorded).toBe(recorded);
    expect(r.surface.current).toBe(surfaceHash(moved));
    // FIRST. Not buried under the verdict.
    expect(r.notes[0]).toMatch(/^SURFACE DIFFERS/);

    // Every surface-derived check is suppressed with the reason, not answered.
    for (const c of r.entries.flatMap((e) => e.checks)) {
      if (c.source !== "surface") continue;
      if (c.field === "surface_hash") continue; // that check IS the question
      expect(c.status).toBe("uncheckable");
      expect(c.note).toMatch(/SURFACE DIFFERS/);
    }
    expect(check(r, "turn", "route.model")!.status).toBe("uncheckable");
  });

  it("still runs the checks that never consult the surface", () => {
    const config = surface();
    const recorded = surfaceHash(config);
    const path = trail(cleanSession(recorded));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "turn") rec.bucket = "refusal";
    });
    writeFileSync(join(root, ".gnomon", "system.md"), "moved\n");
    const moved = loadConfig(root);

    const r = replay(path, moved, { harness: HARNESS });
    // The verdict still leads with the surface — a divergence between two
    // surfaces is not a finding — but the trail-only divergence is not lost.
    expect(r.verdict).toBe("not_comparable");
    expect(check(r, "turn", "bucket")).toMatchObject({ status: "diverged", recorded: "refusal" });
    expect(r.notes.some((n) => /without consulting the surface/.test(n))).toBe(true);
  });

  it("reports a harness difference separately from the surface", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    const r = replay(path, config, { harness: "gnomon/0.1.0+someotherbuild" });
    expect(r.harness.status).toBe("different");
    expect(r.notes.some((n) => /^HARNESS DIFFERS/.test(n))).toBe(true);
    // Different code, same surface, same decisions: the decisions still stand.
    expect(r.verdict).toBe("clean");
  });
});

describe("a tampered trail", () => {
  it("diverges on a tool log the hash chain accepts", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "turn") rec.tool_log = ["read — src/somewhere-else.ts (12 lines)"];
    });

    const r = replay(path, config, { harness: HARNESS });
    // The chain is intact. This is exactly the forgery verifyTrail cannot see.
    expect(r.integrity.chain_ok).toBe(true);
    expect(r.verdict).toBe("diverged");
    expect(check(r, "turn", "tool_log")).toMatchObject({
      status: "diverged",
      recorded: ["read — src/somewhere-else.ts (12 lines)"],
      replayed: ["read — src/a.ts (12 lines)"],
    });
  });

  it("diverges when a tool call is deleted from the log but left in the trail", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "turn") {
        rec.tool_log = [];
        rec.tool_steps = 0;
      }
    });
    const r = replay(path, config, { harness: HARNESS });
    expect(r.verdict).toBe("diverged");
    expect(check(r, "turn", "tool_steps")).toMatchObject({ status: "diverged", recorded: 0, replayed: 1 });
  });

  it("diverges when a gated call is recorded as ungated", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ...cleanSession(hash).slice(0, 2),
      [
        "tool_call",
        {
          role: "implement",
          tool: "write",
          target: "src/b.ts",
          // `write` is mutating and the gate is on_write, so the harness
          // could not have recorded this.
          gated: false,
          code: 0,
          bucket: "result",
          summary: "write — src/b.ts",
        },
      ],
      [
        "turn",
        {
          turn: 1,
          role: "implement",
          model: "local:large",
          bucket: "result",
          code: 0,
          tool_steps: 2,
          tool_log: ["read — src/a.ts (12 lines)", "write — src/b.ts"],
          surface_hash: hash,
        },
      ],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);

    const r = replay(path, config, { harness: HARNESS });
    expect(r.verdict).toBe("diverged");
    const gated = checks(r, "gated").find((c) => c.recorded === false && c.status === "diverged");
    expect(gated).toMatchObject({ status: "diverged", recorded: false, replayed: true });
  });

  it("diverges when a call this role was never offered is recorded as having run", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      // `review` declares tools = ["read"]. bash was withheld from it.
      ["tool_call", { role: "review", tool: "bash", gated: true, code: 0, bucket: "result", summary: "bash — exit 0" }],
      ["turn", { turn: 1, role: "review", model: "local:small", bucket: "result", code: 0, tool_steps: 1, tool_log: ["bash — exit 0"], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);

    const r = replay(path, config, { harness: HARNESS });
    expect(r.verdict).toBe("diverged");
    expect(check(r, "tool_call", "offered")).toMatchObject({
      status: "diverged",
      recorded: true,
      replayed: false,
    });
  });

  it("diverges when the session_end turn count does not match the turns recorded", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "session_end") rec.turns = 4;
    });
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "session_end", "turns")).toMatchObject({ status: "diverged", recorded: 4, replayed: 1 });
  });

  it("reports a broken chain alongside the decision comparison, not instead of it", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    // Edit WITHOUT re-chaining: the ordinary tamper.
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const turn = JSON.parse(lines[2]) as AuditRecord;
    turn.bucket = "apparatus_failure";
    lines[2] = JSON.stringify(turn);
    writeFileSync(path, lines.map((l) => `${l}\n`).join(""));

    const r = replay(path, config, { harness: HARNESS });
    expect(r.integrity.chain_ok).toBe(false);
    expect(r.notes.some((n) => /hash chain does not hold/.test(n))).toBe(true);
    expect(check(r, "turn", "bucket")!.status).toBe("diverged");
  });
});

describe("a metadata-only trail", () => {
  it("reports skill selection uncheckable rather than diverged", () => {
    mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
    const config = surface();
    writeFileSync(
      join(root, ".gnomon", "skills", "shell.md"),
      `+++\nname = "Shell notes"\nmatch = "deploy"\n+++\nUse setsid.\n`
    );
    const reloaded = loadConfig(root);
    const path = trail(cleanSession(surfaceHash(reloaded)));

    const r = replay(path, reloaded, { harness: HARNESS });
    expect(r.detail).toBe("metadata");
    const skills = check(r, "turn", "skills")!;
    expect(skills.status).toBe("uncheckable");
    expect(skills.note).toMatch(/records no input text/);
    expect(skills.note).toMatch(/not a divergence/);
    // The whole point: recording less must not read as a failure.
    expect(r.verdict).toBe("clean");
    expect(r.notes.some((n) => /BY DESIGN/.test(n))).toBe(true);
  });

  it("does check skill selection when the text is there", () => {
    mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "skills", "deploys.md"), `+++\nname = "Deploys"\nmatch = "deploy"\n+++\nbody\n`);
    const config = surface();
    const hash = surfaceHash(config);
    const session = cleanSession(hash);
    (session[0][1] as Record<string, unknown>).record = "full";
    (session[2][1] as Record<string, unknown>).input = "please deploy the thing";
    (session[2][1] as Record<string, unknown>).output = "done";
    (session[2][1] as Record<string, unknown>).skills = ["deploys"];
    const path = trail(session, { record: "full" });

    const r = replay(path, config, { harness: HARNESS });
    expect(r.detail).toBe("full");
    expect(check(r, "turn", "skills")).toMatchObject({
      status: "match",
      recorded: ["deploys"],
      replayed: ["deploys"],
    });
  });

  it("diverges when a full trail claims a skill the surface would not select", () => {
    mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "skills", "deploys.md"), `+++\nname = "Deploys"\nmatch = "deploy"\n+++\nbody\n`);
    const config = surface();
    const hash = surfaceHash(config);
    const session = cleanSession(hash);
    (session[0][1] as Record<string, unknown>).record = "full";
    (session[2][1] as Record<string, unknown>).input = "please tidy the README";
    (session[2][1] as Record<string, unknown>).skills = ["deploys"];
    const path = trail(session, { record: "full" });

    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "turn", "skills")).toMatchObject({ status: "diverged", replayed: [] });
    expect(r.verdict).toBe("diverged");
  });

  it("will not check skills when the surface redacts, because the recorded input is not what ran", () => {
    const config = surface({
      "config.toml": `${CONFIG_TOML}\n[audit]\nenabled = true\nrecord = "full"\nredact = ["deploy"]\n`,
    });
    const hash = surfaceHash(config);
    const session = cleanSession(hash);
    (session[0][1] as Record<string, unknown>).record = "full";
    (session[2][1] as Record<string, unknown>).input = "please [redacted] the thing";
    const path = trail(session, { record: "full", redact: ["deploy"] });

    const r = replay(path, config, { harness: HARNESS });
    const skills = check(r, "turn", "skills")!;
    expect(skills.status).toBe("uncheckable");
    expect(skills.note).toMatch(/post-redaction/);
  });
});

describe("an empty, truncated or malformed trail", () => {
  it("does not throw on a path that does not exist", () => {
    const config = surface();
    const r = replay(join(root, "nope.jsonl"), config, { harness: HARNESS });
    expect(r.verdict).toBe("empty");
    expect(r.entries).toEqual([]);
    expect(r.notes.some((n) => /No such trail/.test(n))).toBe(true);
  });

  it("does not throw on an empty file", () => {
    const config = surface();
    const path = join(root, "empty.jsonl");
    writeFileSync(path, "");
    const r = replay(path, config, { harness: HARNESS });
    expect(r.verdict).toBe("empty");
    expect(r.totals.checks).toBe(0);
  });

  it("does not throw on a half-written last line", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)).slice(0, 3));
    appendFileSync(path, '{"seq":3,"kind":"session_e');
    const r = replay(path, config, { harness: HARNESS });
    expect(r.integrity.malformed).toEqual([3]);
    expect(r.integrity.sealed).toBe(false);
    expect(r.entries.some((e) => e.kind === "(unparseable)")).toBe(true);
    expect(r.notes.some((n) => /would not parse/.test(n))).toBe(true);
    expect(r.notes.some((n) => /does not close with session_end/.test(n))).toBe(true);
  });

  it("says so when the trail ends mid-turn, rather than attributing the calls to nothing", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)).slice(0, 2));
    const r = replay(path, config, { harness: HARNESS });
    const unclosed = r.entries.find((e) => e.kind === "(unclosed)");
    expect(unclosed).toBeDefined();
    expect(unclosed!.checks[0].note).toMatch(/ends mid-turn/);
    expect(unclosed!.status).toBe("uncheckable");
  });

  it("reports a record kind it has no rules for instead of passing it silently", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      ["something_new" as AuditKind, { note: "from a later build" }],
      ["session_end", { turns: 0, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    const unknown = r.entries.find((e) => e.kind === "something_new")!;
    expect(unknown.status).toBe("uncheckable");
    expect(unknown.checks[0].note).toMatch(/no replay rules/);
  });

  it("names sequence numbers that are missing from the file", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    lines.splice(1, 1); // remove seq 1
    writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
    const r = replay(path, config, { harness: HARNESS });
    expect(r.integrity.seq_gaps).toEqual([1]);
    expect(r.notes.some((n) => /are absent from the file/.test(n))).toBe(true);
  });

  it("does not throw on a file that is entirely unparseable", () => {
    const config = surface();
    const path = join(root, "garbage.jsonl");
    writeFileSync(path, "not json\nalso not json\n");
    const r = replay(path, config, { harness: HARNESS });
    expect(r.entries.every((e) => e.kind === "(unparseable)")).toBe(true);
    expect(r.surface.recorded).toBeNull();
    // No surface hash to compare against is not "the same surface".
    expect(r.verdict).toBe("not_comparable");
    expect(r.notes[0]).toMatch(/records no surface hash/);
  });

  it("handles a trail written with chaining off", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)), { chain: false });
    const r = replay(path, config, { harness: HARNESS });
    expect(r.integrity.chain_ok).toBe(true);
    // Nothing to chain, so nothing to be truncated relative to. Replay still
    // compares every decision — chaining and replay answer different questions.
    expect(r.verdict).toBe("clean");
    expect(r.totals.match).toBeGreaterThan(5);
  });

  it("readTrail reports malformed lines without losing the good ones", () => {
    const path = join(root, "mixed.jsonl");
    writeFileSync(path, `{"seq":0,"kind":"turn"}\nnot json\n[1,2,3]\n{"seq":3,"kind":"session_end"}\n`);
    const read = readTrail(path);
    expect(read.records.map((r) => r.seq)).toEqual([0, 3]);
    expect(read.malformed).toEqual([1, 2]);
    expect(read.problem).toBeUndefined();
  });
});

describe("approvals", () => {
  it("checks that the surface would still ask, and refuses to guess the answer", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      ["approval", { tool: "write", summary: "write src/b.ts", decision: "approved", by: "human", interactive: true }],
      ["tool_call", { role: "implement", tool: "write", gated: true, code: 0, bucket: "result", summary: "write — src/b.ts" }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 1, tool_log: ["write — src/b.ts"], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "approval", "gate.asks")).toMatchObject({ status: "match", replayed: true });
    const decision = check(r, "approval", "decision")!;
    expect(decision.status).toBe("uncheckable");
    expect(decision.recorded).toBe("approved");
    expect(decision.note).toMatch(/operator input/);
    expect(r.verdict).toBe("clean");
  });

  it("diverges on an approval this surface would never have asked for", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      // `read` is not mutating and the gate is on_write: nothing would ask.
      ["approval", { tool: "read", summary: "read src/a.ts", decision: "approved", by: "human", interactive: true }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 0, tool_log: [], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "approval", "gate.asks")).toMatchObject({
      status: "diverged",
      recorded: true,
      replayed: false,
    });
  });
});

describe("chains", () => {
  const CHAINED = `${CONFIG_TOML}\n[chain]\nstages = ["implement", "review"]\n`;

  const chainedTrail = (hash: string): Array<[AuditKind, Record<string, unknown>]> => [
    ["session_start", { surface_hash: hash, harness: HARNESS, mode: "task", role: "implement", record: "metadata", approvals: "refused" }],
    ["tool_call", { role: "implement", tool: "read", gated: false, code: 0, bucket: "result", summary: "read — a" }],
    ["chain_stage", { stage: 1, of: 2, role: "implement", bucket: "result", code: 0, stop_reason: "model_stopped", tool_steps: 1, surface_hash: hash }],
    ["chain_stage", { stage: 2, of: 2, role: "review", bucket: "result", code: 0, stop_reason: "model_stopped", tool_steps: 0, surface_hash: hash }],
    ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 0, tool_log: [], surface_hash: hash }],
    ["session_end", { turns: 1, surface_hash: hash }],
  ];

  it("re-derives each stage's role and the stage count", () => {
    const config = surface({ "config.toml": CHAINED });
    const path = trail(chainedTrail(surfaceHash(config)));
    const r = replay(path, config, { harness: HARNESS });
    const roles = checks(r, "chain.role");
    expect(roles.map((c) => c.status)).toEqual(["match", "match"]);
    expect(roles.map((c) => c.replayed)).toEqual(["implement", "review"]);
    expect(checks(r, "chain.of").every((c) => c.status === "match")).toBe(true);
    expect(r.verdict).toBe("clean");
  });

  it("diverges when a stage names a role the declared chain does not run there", () => {
    const config = surface({ "config.toml": CHAINED });
    const path = trail(chainedTrail(surfaceHash(config)));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "chain_stage" && rec.stage === 2) rec.role = "implement";
    });
    const r = replay(path, config, { harness: HARNESS });
    expect(r.verdict).toBe("diverged");
    expect(checks(r, "chain.role")[1]).toMatchObject({
      status: "diverged",
      recorded: "implement",
      replayed: "review",
    });
  });

  it("says the turn record's counts came from the last stage rather than pretending to attribute calls twice", () => {
    const config = surface({ "config.toml": CHAINED });
    const path = trail(chainedTrail(surfaceHash(config)));
    const r = replay(path, config, { harness: HARNESS });
    const turnSteps = r.entries.filter((e) => e.kind === "turn").flatMap((e) => e.checks).filter((c) => c.field === "tool_steps");
    expect(turnSteps.some((c) => c.status === "uncheckable" && /chain ran/.test(c.note ?? ""))).toBe(true);
    expect(turnSteps.some((c) => c.status === "match" && /last chain_stage/.test(c.note ?? ""))).toBe(true);
  });
});

describe("verify records", () => {
  it("re-derives the declared command and the verdict the exit status implies", () => {
    const config = surface({ "policy.toml": `[verify]\ncommand = "npm test"\n` });
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      ["verify", { role: "implement", command: "npm test", exit: 0, passed: true }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 0, tool_log: ["verify — bash — exit 0"], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "verify", "verify.command")).toMatchObject({ status: "match", replayed: "npm test" });
    expect(check(r, "verify", "verify.passed")).toMatchObject({ status: "match", replayed: true });
    expect(r.verdict).toBe("clean");
  });

  it("diverges when a check that could not run was recorded as a pass", () => {
    const config = surface({ "policy.toml": `[verify]\ncommand = "npm test"\n` });
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      // 127 is "not found". The harness reports that unrunnable and does NOT
      // count it against the work; a record claiming otherwise is not one it wrote.
      ["verify", { role: "implement", command: "npm test", exit: 127, passed: true, unrunnable: false }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 0, tool_log: [], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "verify", "verify.passed")).toMatchObject({ status: "diverged", recorded: true, replayed: false });
    expect(check(r, "verify", "verify.unrunnable")).toMatchObject({ status: "diverged", recorded: false, replayed: true });
  });
});

describe("limits replay publishes rather than papering over", () => {
  it("will not claim to know whether an MCP tool was offered or gated", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      ["tool_call", { role: "implement", tool: "mcp__notes__append", gated: false, code: 0, bucket: "result", summary: "mcp__notes__append — ok" }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 1, tool_log: ["mcp__notes__append — ok"], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "tool_call", "offered")).toMatchObject({ status: "uncheckable" });
    expect(check(r, "tool_call", "offered")!.note).toMatch(/live server/);
    const gated = check(r, "tool_call", "gated")!;
    expect(gated.status).toBe("uncheckable");
    expect(gated.note).toMatch(/misleading/);
    expect(r.verdict).toBe("clean");
  });

  it("weakens the tool-log check when a task call delegated a sub-turn, and says it did", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      // The sub-turn's own call lands in the trail first — delegate.run passes
      // the same `deps` (and so the same trail) down.
      ["tool_call", { role: "review", tool: "read", gated: false, code: 0, bucket: "result", summary: "read — sub" }],
      ["tool_call", { role: "implement", tool: "task", gated: true, code: 0, bucket: "result", summary: "task — review (1 step)" }],
      ["turn", { turn: 1, role: "implement", model: "local:large", bucket: "result", code: 0, tool_steps: 1, tool_log: ["task — review (1 step)"], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    const log = check(r, "turn", "tool_log")!;
    expect(log.status).toBe("match");
    expect(log.note).toMatch(/ordered subsequence/);
    const steps = check(r, "turn", "tool_steps")!;
    expect(steps.status).toBe("match");
    expect(steps.note).toMatch(/recorded <= records/);
    expect(r.verdict).toBe("clean");
  });

  it("will not check the endpoint url the run reached when the run overrode it", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const session = cleanSession(hash);
    (session[2][1] as Record<string, unknown>).endpoint_url = "http://elsewhere:9999/api/chat";
    (session[2][1] as Record<string, unknown>).endpoint_overridden = true;
    const path = trail(session);
    const r = replay(path, config, { harness: HARNESS });
    const url = check(r, "turn", "route.url")!;
    expect(url.status).toBe("uncheckable");
    expect(url.note).toMatch(/machine-scoped/);
  });

  it("will not check the endpoint url when the REPLAYING process carries an override", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    process.env.GNOMON_MODEL_URL = "http://replayer:1/api/chat";
    const r = replay(path, config, { harness: HARNESS });
    const url = check(r, "turn", "route.url")!;
    expect(url.status).toBe("uncheckable");
    expect(url.note).toMatch(/replaying process/);
  });

  it("reports a role this surface no longer defines as uncheckable routing, not a wrong model", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, mode: "task", role: "ghost", record: "metadata" }],
      ["turn", { turn: 1, role: "ghost", model: "local:large", bucket: "result", code: 0, tool_steps: 0, tool_log: [], surface_hash: hash }],
      ["session_end", { turns: 1, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "session_start", "roles")).toMatchObject({
      status: "diverged",
      recorded: "ghost",
      replayed: "(not defined by this surface)",
    });
    const model = check(r, "turn", "route.model")!;
    expect(model.status).toBe("uncheckable");
    expect(model.note).toMatch(/could not be re-derived/);
  });

  it("says when a trail names no harness build at all", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, roles: ["implement", "review"], record: "metadata" }],
      ["session_end", { turns: 0, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(r.harness.status).toBe("unknown");
    expect(r.notes.some((n) => /names no harness build/.test(n))).toBe(true);
  });
});

describe("session_resume", () => {
  it("checks the surface_changed flag against the two hashes beside it", () => {
    const config = surface();
    const hash = surfaceHash(config);
    const path = trail([
      ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "metadata" }],
      ["session_resume", { resumed: "s1", turns: 2, surface_hash: hash, surface_hash_at_save: "deadbeef", surface_changed: false }],
      ["session_end", { turns: 0, surface_hash: hash }],
    ]);
    const r = replay(path, config, { harness: HARNESS });
    expect(check(r, "session_resume", "surface_changed")).toMatchObject({
      status: "diverged",
      recorded: false,
      replayed: true,
    });
  });
});

describe("the published partition", () => {
  it("checks every field it lists as harness-derived", () => {
    // One trail that exercises the lot. If a name is added to HARNESS_DERIVED
    // with no check behind it, this fails rather than the list quietly
    // becoming a promise the code does not keep.
    const config = surface({
      "config.toml": `${CONFIG_TOML}\n[chain]\nstages = ["implement", "review"]\n`,
      "policy.toml": `[verify]\ncommand = "npm test"\n`,
    });
    mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "skills", "deploys.md"), `+++\nname = "D"\nmatch = "deploy"\n+++\nb\n`);
    const reloaded = loadConfig(root);
    const hash = surfaceHash(reloaded);

    const path = trail(
      [
        ["session_start", { surface_hash: hash, harness: HARNESS, roles: ["implement", "review"], record: "full" }],
        ["session_resume", { resumed: "s0", turns: 1, surface_hash: hash, surface_hash_at_save: hash, surface_changed: false }],
        ["approval", { tool: "write", summary: "w", decision: "approved", by: "human", interactive: true }],
        ["tool_call", { role: "implement", tool: "write", gated: true, code: 0, bucket: "result", summary: "write — x" }],
        ["verify", { role: "implement", command: "npm test", exit: 127, passed: false, unrunnable: true }],
        ["chain_stage", { stage: 1, of: 2, role: "implement", bucket: "result", code: 0, tool_steps: 1, surface_hash: hash }],
        ["chain_stage", { stage: 2, of: 2, role: "review", bucket: "result", code: 0, tool_steps: 0, surface_hash: hash }],
        [
          "turn",
          {
            turn: 1,
            role: "implement",
            model: "local:large",
            endpoint: "local",
            endpoint_url: "http://127.0.0.1:11434/api/chat",
            bucket: "result",
            code: 0,
            tool_steps: 0,
            tool_log: [],
            input: "deploy it",
            output: "ok",
            skills: ["deploys"],
            surface_hash: hash,
          },
        ],
        ["session_end", { turns: 1, surface_hash: hash }],
      ],
      { record: "full" }
    );

    const r = replay(path, reloaded, { harness: HARNESS });
    const seen = new Set(r.entries.flatMap((e) => e.checks).map((c) => c.field));
    const missing = HARNESS_DERIVED.filter((f) => !seen.has(f));
    expect(missing).toEqual([]);
  });
});

describe("formatReplay", () => {
  it("leads with the surface question, not the verdict", () => {
    const config = surface();
    const recorded = surfaceHash(config);
    const path = trail(cleanSession(recorded));
    writeFileSync(join(root, ".gnomon", "system.md"), "moved\n");
    const lines = formatReplay(replay(path, loadConfig(root), { harness: HARNESS }));
    const surfaceLine = lines.findIndex((l) => /SURFACE DIFFERS/.test(l));
    const verdictLine = lines.findIndex((l) => /verdict:/.test(l));
    expect(surfaceLine).toBeGreaterThanOrEqual(0);
    expect(surfaceLine).toBeLessThan(verdictLine);
  });

  it("names the field and both values for every divergence", () => {
    const config = surface();
    const path = trail(cleanSession(surfaceHash(config)));
    tamperAndRechain(path, (rec) => {
      if (rec.kind === "turn") rec.bucket = "refusal";
    });
    const lines = formatReplay(replay(path, config, { harness: HARNESS }));
    expect(lines.some((l) => /bucket: recorded "refusal" · replayed "result"/.test(l))).toBe(true);
  });
});
