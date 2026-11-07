/**
 * Deliverable-first time notes (`[turn] deliverable_first`) and the
 * first-token stall watchdog (`[resilience] first_token_timeout_ms`),
 * docs/CONTRACTS.md §35, conformance/deliverable_first.json.
 *
 * - The fixture and the code agree.
 * - The extractor: each rule on a sentence of its own, and the 29 P2G41 task
 *   instructions against hand-labelled deliverables (where the dataset is on
 *   this machine; the instructions are not in the repository).
 * - Byte-identity: off, and on without a deadline or with a far one, a
 *   scripted turn sends master's request bodies (sweep_knobs.test.ts's
 *   hashes, ae17a1ae). The watchdog declared changes no body either.
 * - Under --deadline: the note names what is missing at 40% and 70%, on the
 *   steering channel, and stops naming what was written; the trail records
 *   both checks.
 * - The watchdog: a stream that sends keep-alives but no token is aborted and
 *   asked again; a stream that has produced a token is never cut by it; all
 *   attempts stalled is a timeout; off, nothing is cut; unstreamed calls never
 *   read it; the turn records each stall.
 *
 * Every server here is a fake on 127.0.0.1; no model is called.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { callEndpointWithRetry, platformBlock, runTask, wireOf } from "./prompt_loop.js";
import { auditSurface, BLOCK_KEYS, loadConfig, resolveResilience, routeRole } from "./config.js";
import {
  DELIVERABLE_FIRST_AT,
  DELIVERABLE_FIRST_EVENTS,
  DELIVERABLE_FIRST_MAX_NAMED,
  DELIVERABLE_VERBS,
  DEPENDENCY_WORDS,
  deliverableNote,
  extractDeliverables,
  missingDeliverables,
  resolveDeliverableFirst,
} from "./deliverable_first.js";
import { withMasterRefusal } from "./test_support.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/deliverable_first.json"), "utf-8"));

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

describe("conformance/deliverable_first.json", () => {
  it("the code's constants and keys are the fixture's", () => {
    expect([...DELIVERABLE_FIRST_AT]).toEqual(FIXTURE.at);
    expect(DELIVERABLE_FIRST_MAX_NAMED).toBe(FIXTURE.max_named);
    expect([...DELIVERABLE_VERBS]).toEqual(FIXTURE.verbs);
    expect([...DELIVERABLE_FIRST_EVENTS]).toEqual(FIXTURE.audit.events);
    expect(deliverableNote(["a", "b"])).toBe(FIXTURE.note.replace("{paths}", "a, b"));
    expect(deliverableNote(["a", "b"], "plan")).toBe(FIXTURE.note.replace("{paths}", "a, b"));
    expect(deliverableNote(["a", "b"], "continue")).toBe(FIXTURE.continue_note.replace("{paths}", "a, b"));
    expect([...DEPENDENCY_WORDS]).toEqual(FIXTURE.dependency_words);
    expect(resolveResilience({ config: {} } as never).first_token_timeout_ms).toBe(FIXTURE.first_token.default);
    const known = (block: string) => BLOCK_KEYS.find(([, b]) => b === block)![2];
    expect(known("turn")).toContain("deliverable_first");
    expect(known("resilience")).toContain("first_token_timeout_ms");
  });

  it("CONTRACTS §35 names the keys, events, fields and counters", () => {
    const contracts = readFileSync(join(REPO, "docs/CONTRACTS.md"), "utf-8");
    const s35 = contracts.split("\n## 35.")[1]!.split("\n## 36.")[0]!;
    for (const w of [
      "deliverable_first",
      "first_token_timeout_ms",
      FIXTURE.counter,
      FIXTURE.first_token.counter,
      FIXTURE.audit.kind,
      FIXTURE.first_token.audit.kind,
      ...FIXTURE.audit.events,
      ...FIXTURE.audit.check_fields,
      ...FIXTURE.first_token.audit.fields,
      "conformance/deliverable_first.json",
    ]) {
      expect(s35, w).toContain(w);
    }
  });
});

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

describe("extractDeliverables", () => {
  it.each([
    ["Write the final results to `/app/output/report.json` as a single JSON object that conforms to the schema.", ["/app/output/report.json"]],
    ["Create a python file /app/filter.py that removes JavaScript.", ["/app/filter.py"]],
    ["Write the solution as /app/harmony.mxl.", ["/app/harmony.mxl"]],
    ["Write the secret to `/app/out/flag.txt` and your analysis to `/app/out/analysis.json` with fields a, b.", ["/app/out/flag.txt", "/app/out/analysis.json"]],
    ["Write the ERP, MES, and WMS writebacks as standalone SQL files at `/o/a.sql`, `/o/b.sql`, and `/o/c.sql`, then apply them so `/o/audit.log` records it.", ["/o/a.sql", "/o/b.sql", "/o/c.sql"]],
    ["Implement a generator at `/app/s/solve.py` and produce the files `/app/r/walk.npz`, `/app/r/jump.npz`, and `/app/r/run.npz`.", ["/app/s/solve.py", "/app/r/walk.npz", "/app/r/jump.npz", "/app/r/run.npz"]],
    ["Create the following files:\n\n- `/app/pipeline.py`\n- `/app/q.rq`\n- `/app/requirements.txt`\n", ["/app/pipeline.py", "/app/q.rq", "/app/requirements.txt"]],
    ["Provide your answers as a CSV file named `Answers.csv` and save it inside `/results/`.", ["/results/Answers.csv"]],
    ["Train it and save it to `/app/output/checkpoint.pt`. You must write exactly one `.pt` file under `/app/output/`, named `checkpoint.pt`.", ["/app/output/checkpoint.pt"]],
    ["Create a file called `hello.txt` with a greeting.", ["hello.txt"]],
    ["Write `notes.md` summarising the repository.", ["notes.md"]],
    ["Save the plot as `plot.png` and the data to /tmp/data.csv.", ["plot.png", "/tmp/data.csv"]],
    ["3. Tracebacks must still resolve. Emit the source map as an external file at `/app/dist/a.js.map`.", ["/app/dist/a.js.map"]],
    // Windows forms, read the same on every OS: a task given on Windows names
    // its outputs that way, and the --deadline tests below use the OS's own
    // temp paths.
    ["Write the log to `D:\\a\\_temp\\logs\\run.log` and the summary to `C:/out/summary.md`.", ["D:\\a\\_temp\\logs\\run.log", "C:/out/summary.md"]],
    ["Save the report as C:\\Users\\RUNNER~1\\out\\report.json.", ["C:\\Users\\RUNNER~1\\out\\report.json"]],
    ["Provide a CSV file named `Answers.csv` and save it inside `C:\\results\\`.", ["C:\\results\\Answers.csv"]],
    ["Write the summary to `.\\out\\summary.md`.", [".\\out\\summary.md"]],
    // The outputs a named command must leave (v0.4.6, research note 13 finding 3).
    ["The command `/app/rebuild.sh` should rebuild the packet and write `/app/output/scores.csv`.", ["/app/output/scores.csv"]],
    ["Fix the planning tool so that running `python /app/dispatch.py --output /output/flight_plan.json` produces a correct flight plan.", ["/output/flight_plan.json"]],
    ["Build `/app/cracker.py`. Write any Python dependencies to `/app/requirements.txt` (may be empty).", ["/app/cracker.py"]],
  ])("names the deliverable: %s", (task, expected) => {
    expect(extractDeliverables(task)).toEqual(expected);
  });

  it.each([
    // A program's output, described: third person, or a modal with another subject.
    "The harness at `/app/pretrain.py` writes a loss trace to `/app/output/loss.pt`.",
    "Accepted leads should write `/app/output/submission.json` and `/app/output/crm.json`.",
    "For each directory, it should read the files and write the generated `unified.ttl` into it.",
    // Dependency manifests are not outputs (v0.4.6, research note 13 finding 3).
    "Write any Python dependencies needed to run your code to `/app/requirements.txt`.",
    "Write any apt packages needed to run your code to `/app/apt-packages.txt`, one per line.",
    "Add any extra Python packages to `/app/src/worker/requirements.txt`.",
    // A command line run without "running"/"run" before it, or a flag that is not an output.
    "Use `python /app/x.py --output /o/a.json` as a reference.",
    "Fix it so running `python /app/x.py --input /o/a.json` works.",
    // A verb used as a noun or an adjective.
    "The output config, rendered through the provided `/app/render.py`, must match.",
    "Repair it from the output contract in `/app/docs/ticket.md`.",
    // Negated.
    "Do not write to `/etc/passwd`.",
    "Never create `/app/tmp.bin`.",
    // An input, not an output.
    "Use `/app/in.csv` to produce a report.",
    "Build a CLI at a place of your choice according to `/app/policy.yaml`.",
    // Not a path: unquoted relative names, directories, code, placeholders, URLs.
    "Fix the bug in src/foo.ts.",
    "Write a Node.js script.",
    "Write the files to `/app/output/`.",
    "Implement `fnx.Graph` and `fnx.DiGraph`.",
    "Write it to `/app/<name>.json`.",
    "Save it to https://example.com/a.json.",
    "Write the pair `key:value.txt` out.",
    "Write it to `C:\\out\\`.",
    "Run it as:\n\n```bash\npython /app/x.py --output /app/out.json\n```\n",
  ])("names nothing: %s", (task) => {
    expect(extractDeliverables(task)).toEqual([]);
  });

  it("each path once, in order", () => {
    expect(extractDeliverables("Write `/a/x.txt`. Then write `/a/y.txt` and save `/a/x.txt` again.")).toEqual(["/a/x.txt", "/a/y.txt"]);
  });

  it("missingDeliverables reads relative paths against the root, absolute ones as written", () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-df-"));
    roots.push(root);
    writeFileSync(join(root, "there.txt"), "x");
    const abs = join(root, "abs.txt");
    expect(missingDeliverables(["there.txt", "gone.txt", abs], root)).toEqual(["gone.txt", abs]);
    writeFileSync(abs, "x");
    expect(missingDeliverables(["there.txt", abs], root)).toEqual([]);
  });

  it("the note names at most max_named paths and says how many more", () => {
    const many = Array.from({ length: 15 }, (_, i) => `/o/f${i}.txt`);
    const note = deliverableNote(many);
    expect(note).toContain("/o/f11.txt");
    expect(note).not.toContain("/o/f12.txt");
    expect(note).toContain("(and 3 more)");
  });
});

/**
 * The 29 P2G41 task instructions, against deliverables labelled by hand
 * before the extractor was run on them. The instructions carry a benchmark
 * canary and are not in this repository: GNOMON_P2G_DATASET names the
 * directory holding `<task>/instruction.md`, else the path the peers worktree
 * keeps them at (beside this checkout, or under the user's home, read from the
 * account because the test setup points HOME elsewhere); none present, this
 * is skipped.
 */
const P2G_REL = "benchmarks/results/p2g-2026-11/datasets/terminal-bench";
const P2G_DATASET = [
  process.env.GNOMON_P2G_DATASET,
  join(REPO, "..", "peers", P2G_REL),
  (() => {
    try {
      return join(userInfo().homedir, "gnomon-wt", "peers", P2G_REL);
    } catch {
      return undefined;
    }
  })(),
].find((d): d is string => !!d && existsSync(d));

describe("the 29 P2G41 task instructions", () => {
  // Always run, so the suite's count does not depend on the machine: the
  // fixture's own totals are checked everywhere, the instructions where present.
  it("each instruction is the one labelled, and its deliverables are extracted exactly", () => {
    const tasks = FIXTURE.p2g_tasks as Record<string, { sha256_16: string; expected: string[] }>;
    expect(Object.keys(tasks)).toHaveLength(29);
    const total = Object.values(tasks).reduce((n, t) => n + t.expected.length, 0);
    expect(total).toBe(FIXTURE.p2g_score.labelled);
    if (!P2G_DATASET) return;
    let labelled = 0;
    let extracted = 0;
    let correct = 0;
    for (const [name, t] of Object.entries(tasks)) {
      const text = readFileSync(join(P2G_DATASET!, name, "instruction.md"));
      expect(createHash("sha256").update(text).digest("hex").slice(0, 16), name).toBe(t.sha256_16);
      const got = extractDeliverables(text.toString("utf-8"));
      labelled += t.expected.length;
      extracted += got.length;
      correct += got.filter((p) => t.expected.includes(p)).length;
      expect(got, name).toEqual(t.expected);
    }
    expect({ labelled, extracted, correct }).toEqual({
      labelled: FIXTURE.p2g_score.labelled,
      extracted: FIXTURE.p2g_score.extracted,
      correct: FIXTURE.p2g_score.correct,
    });
  });
});

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

describe("the surface", () => {
  const withTurn = (turn: Record<string, unknown>, resilience: Record<string, unknown> = {}) =>
    ({ gnomonDir: "/nowhere", config: { turn, resilience }, roles: {}, policy: {}, profiles: {}, tools: {}, system: { content: "", version: "0.1" } }) as never;

  it("deliverable_first: only true is on; a value that is not a boolean is fatal", () => {
    expect(resolveDeliverableFirst(withTurn({}))).toBe(false);
    expect(resolveDeliverableFirst(withTurn({ deliverable_first: false }))).toBe(false);
    expect(resolveDeliverableFirst(withTurn({ deliverable_first: true }))).toBe(true);
    expect(auditSurface(withTurn({ deliverable_first: true }))).toEqual([]);
    for (const bad of ["yes", 1, "true"]) {
      const p = auditSurface(withTurn({ deliverable_first: bad })).find((x) => x.where.includes("deliverable_first"));
      expect(p?.fatal, String(bad)).toBe(true);
    }
  });

  it("first_token_timeout_ms: 0 by default; declared, on streamed targets and the wire record only", () => {
    expect(resolveResilience(withTurn({}, {})).first_token_timeout_ms).toBe(0);
    expect(resolveResilience(withTurn({}, { first_token_timeout_ms: 90_000 })).first_token_timeout_ms).toBe(90_000);
    expect(resolveResilience(withTurn({}, { first_token_timeout_ms: -1 })).first_token_timeout_ms).toBe(0);
    const root = mkdtempSync(join(tmpdir(), "gnomon-ftt-"));
    roots.push(root);
    mkdirSync(join(root, ".gnomon"));
    const write = (res: string) =>
      writeFileSync(
        join(root, ".gnomon", "config.toml"),
        `${res}\n[endpoints.x]\nurl = "https://example.invalid/v1/chat/completions"\nkind = "openai"\nstream = true\n`
      );
    writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.a]\nmodel = "m"\nendpoint = "x"\n`);
    write("");
    const off = routeRole(loadConfig(root), "a").target;
    expect(off).not.toHaveProperty("firstTokenMs");
    expect(wireOf(off)).not.toHaveProperty("first_token_timeout_ms");
    write("[resilience]\nfirst_token_timeout_ms = 90000\n");
    const on = routeRole(loadConfig(root), "a").target;
    expect(on.firstTokenMs).toBe(90_000);
    expect(wireOf(on)).toMatchObject({ stream: true, [FIXTURE.first_token.wire_field]: 90_000 });
    expect(wireOf({ ...on, stream: false })).not.toHaveProperty("first_token_timeout_ms");
  });
});

// ---------------------------------------------------------------------------
// Byte-identity with master
// ---------------------------------------------------------------------------

type Kind = "openai" | "ollama";
type Step = { answer: string } | [string, Record<string, unknown>];

/** sweep_knobs.test.ts's script: the six steps master was hashed on. */
const STEPS: Step[] = [
  [
    "todo",
    {
      todos: [
        { content: "read the file", status: "completed" },
        { content: "edit the file", status: "in_progress" },
        { content: "report back", status: "pending" },
      ],
    },
  ],
  ["read", { path: "f1.txt" }],
  ["edit", { path: "f1.txt", old_text: "hello 1", new_text: "hello one" }],
  ["bash", { command: "echo hi" }],
  ["bash", { command: "curl -s https://pypi.org/simple/numpy/" }],
];

function reply(kind: Kind, n: number): unknown {
  const step = STEPS[n - 1] ?? { answer: "done" };
  if ("answer" in step) {
    return kind === "openai"
      ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
      : { message: { role: "assistant", content: step.answer }, done: true, done_reason: "stop" };
  }
  const [name, args] = step;
  return kind === "openai"
    ? {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }
    : { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: "stop" };
}

function hashOf(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  // The network refusal was reworded on purpose (CONTRACTS §39): master's
  // text goes back in, so every other byte is still checked against master.
  const body = withMasterRefusal(raw);
  return createHash("sha256").update(note ? body.split(note).join("") : body).digest("hex").slice(0, 12);
}

function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

/** The surface master was hashed on, with `turn` and `resilience` lines added. */
async function scripted(kind: Kind, turn = "", resilience = "", deadline?: number) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(kind, raws.length)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = kind === "openai" ? `http://127.0.0.1:${port}/v1/chat/completions` : `http://127.0.0.1:${port}/api/chat`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-df-bytes-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 32768\n\n[turn]\nmax_steps = 40\n${turn}\n[context]\n\n[audit]\nenabled = true\n\n` +
      (resilience ? `[resilience]\n${resilience}\n` : "") +
      `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["bash", "edit", "read", "todo"]\nmax_steps = 40\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n`);
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n\n` +
      `[[tools]]\nname = "edit"\ndescription = "Replace one exact string in a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "todo"\ndescription = "Keep a checklist."\nenabled = true\n`
  );
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  const rec = await runTask(loadConfig(root), "read f1.txt, fix its greeting and report", {
    role: "smol",
    yes: true,
    stderr: { write() {} },
    ...(deadline ? { deadline: { at: Date.now() + deadline, source: "flag" as const } } : {}),
  });
  return { raws, hashes: raws.map(hashOf), rec, audit: trail(root) };
}

/** sweep_knobs.test.ts MASTER_AE17A1AE: taken before either mechanism existed. */
const MASTER_AE17A1AE = {
  openai: ["99fa84abca6c", "ed0f266ead9a", "da81bfcd7c48", "903bfa0d4076", "934714e4c9d5", "145ade5b8635"],
  ollama: ["2a0a56c23277", "dc51e4a3c514", "68087d37eaa5", "cfa3853a6119", "e7a9a7ad3902", "489462142adb"],
};

describe("byte-identity with master (ae17a1ae)", () => {
  for (const kind of ["openai", "ollama"] as const) {
    it(`${kind}: undeclared, every request body is master's`, async () => {
      const r = await scripted(kind);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.audit.some((a) => a.kind === "deliverable_first" || a.kind === "first_token_stall")).toBe(false);
    });
    it(`${kind}: deliverable_first = false, every request body is master's`, async () => {
      const r = await scripted(kind, "deliverable_first = false\n");
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.rec.surface_problems ?? []).toEqual([]);
    });
    it(`${kind}: deliverable_first = true without --deadline is not read: master's bodies, no record`, async () => {
      const r = await scripted(kind, "deliverable_first = true\n");
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.audit.some((a) => a.kind === "deliverable_first")).toBe(false);
      expect(r.rec.counters).not.toHaveProperty("deliverable_first_notes");
    });
    it(`${kind}: deliverable_first = true under a far --deadline: master's bodies, the names recorded`, async () => {
      const r = await scripted(kind, "deliverable_first = true\n", "", 600_000);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      const named = r.audit.filter((a) => a.kind === "deliverable_first");
      expect(named).toHaveLength(1);
      expect(named[0]).toMatchObject({ event: "named", named: [], at: FIXTURE.at });
      expect(Object.keys(named[0]!).filter((k) => FIXTURE.audit.named_fields.includes(k)).sort()).toEqual(
        [...FIXTURE.audit.named_fields].sort()
      );
    });
    it(`${kind}: first_token_timeout_ms declared, every request body is master's`, async () => {
      const r = await scripted(kind, "", "first_token_timeout_ms = 1000\n");
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.rec.counters).not.toHaveProperty("first_token_stalls");
    });
  }
});

// ---------------------------------------------------------------------------
// Under --deadline
// ---------------------------------------------------------------------------

type Reply = { body: unknown; delayMs?: number };
const toolCall = (n: number, name: string, args: Record<string, unknown>): Reply => ({
  body: {
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: "tool_calls",
      },
    ],
  },
});
const answer = (content: string): Reply => ({ body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] } });

async function serveJson(next: (n: number, body: Record<string, any>) => Reply) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const r = next(raws.length, JSON.parse(raw || "{}"));
      const send = () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

function deadlineSurface(url: string, turn: string, endpoint = "") {
  const root = mkdtempSync(join(tmpdir(), "gnomon-df-run-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[turn]\n${turn}\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\nreplay_reasoning = false\n${endpoint}`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read", "write"]\nmax_steps = 200\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    ["read", "write"].map((t) => `[[tools]]\nname = "${t}"\ndescription = "${t}"\nenabled = true\n`).join("\n")
  );
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  return root;
}

/** The text of every message a request carried. */
const texts = (raw: string): string[] =>
  (JSON.parse(raw).messages as Array<{ role: string; content: unknown }>).map((m) => `${m.role}:${String(m.content)}`);
const MISSING = /These required outputs do not exist yet: ([^\n]*?)\. Write a first complete version now, then improve it\./;

/**
 * A deadline clock driven by the script, not the runner: each request the
 * server has received moves it on by STEP of the BUDGET, so the turn reads
 * `used = requests × 5%` before each call, on any machine at any load. The
 * real stop timer is a BUDGET away and never fires in these runs.
 */
const BUDGET = 100_000;
const STEP = 5_000;
function scriptClock(raws: string[]) {
  const base = Date.now();
  return { at: base + BUDGET, clock: () => base + raws.length * STEP };
}

/**
 * The model reads files until a request carries the first deliverable note,
 * then writes result.txt, then reads again until a request carries a second
 * note, then answers. The deadline clock moves with the requests, so the note
 * at 40% is on request 9 (8 × 5% used before it) and the one at 70% on 15.
 */
async function deliverableRun(turn: string, endpoint = "") {
  let phase = 0;
  const { url, raws } = await serveJson((n, body) => {
    const notes = (body.messages as Array<{ content: unknown }>).filter((m) => MISSING.test(String(m.content))).length;
    if (notes >= 2 || phase === 2) {
      phase = 2;
      return answer("done");
    }
    if (notes === 1 && phase === 0) {
      phase = 1;
      return toolCall(n, "write", { path: "result.txt", content: "first version\n" });
    }
    if (n > 30) return answer("gave up");
    return toolCall(n, "read", { path: `f${(n % 6) + 1}.txt` });
  });
  const root = deadlineSurface(url, turn, endpoint);
  const { at, clock } = scriptClock(raws);
  const log = join(root, "logs", "run.log");
  const task = `Summarise the files. Write the summary to \`result.txt\` and the log to \`${log}\`.`;
  const rec = await runTask(loadConfig(root), task, {
    role: "smol",
    yes: true,
    stderr: { write() {} },
    deadline: { at, source: "flag" },
    clock,
  });
  return { rec, raws, root, log, audit: trail(root) };
}

describe("--deadline with deliverable_first = true", () => {
  it("at 40% names both missing outputs; at 70% only the one still missing; the trail records both checks", async () => {
    const r = await deliverableRun("deliverable_first = true\ndeadline_notes = []\ndeadline_margin_ms = 200\nnudge_after_idle = 0");
    expect(r.rec.stop_reason).toBe("answered");
    // The notes, as they went out: system messages on the steering channel.
    const notes = [...new Set(r.raws.flatMap(texts).filter((t) => MISSING.test(t)))];
    expect(notes).toHaveLength(2);
    // Where each note first went out: 1-based request numbers, by the script clock.
    const firstWith = (note: string) => r.raws.findIndex((raw) => texts(raw).includes(note)) + 1;
    expect(firstWith(notes[0]!)).toBe(9);
    expect(firstWith(notes[1]!)).toBe(15);
    // The request carrying the second note is answered: the run ends there.
    expect(r.raws).toHaveLength(15);
    expect(notes[0]).toMatch(/^system:Time check: about .* remain before it is stopped\./);
    expect(notes[0]!.match(MISSING)![1]).toBe(`result.txt, ${r.log}`);
    expect(notes[1]!.match(MISSING)![1]).toBe(r.log);
    expect(r.rec.counters.deliverable_first_notes).toBe(2);
    // deadline_notes = []: no plain time note was counted.
    expect(r.rec.counters.deadline_notes).toBeUndefined();

    const recs = r.audit.filter((a) => a.kind === FIXTURE.audit.kind);
    expect(recs.map((a) => a.event)).toEqual(["named", "check", "check"]);
    expect(recs[0]).toMatchObject({ named: ["result.txt", r.log], at: FIXTURE.at });
    expect(recs[1]).toMatchObject({ at: 0.4, missing: ["result.txt", r.log], noted: true });
    expect(recs[2]).toMatchObject({ at: 0.7, missing: [r.log], noted: true });
    for (const c of recs.slice(1)) {
      expect(Object.keys(c).filter((k) => FIXTURE.audit.check_fields.includes(k)).sort()).toEqual([...FIXTURE.audit.check_fields].sort());
    }
    expect(existsSync(join(r.root, "result.txt"))).toBe(true);
  }, 20_000);

  it("steer_role = \"user\": the note goes out as a user message marked [gnomon]", async () => {
    const r = await deliverableRun("deliverable_first = true\ndeadline_notes = []\ndeadline_margin_ms = 200\nnudge_after_idle = 0", 'steer_role = "user"\n');
    const notes = [...new Set(r.raws.flatMap(texts).filter((t) => MISSING.test(t)))];
    expect(notes.length).toBe(2);
    // gnomon's messages in a row share one user message, so the note may follow
    // another of them; it is the steering channel either way.
    for (const n of notes) expect(n).toMatch(/^user:\[gnomon\] [\s\S]*Time check: about /);
  }, 20_000);

  it("off under the same deadline: the notes are the plain time notes, nothing named, no record", async () => {
    // Reads past 70% of the script clock, then answers; never told what is missing.
    const { url, raws } = await serveJson((n) => (n > 16 ? answer("done") : toolCall(n, "read", { path: `f${(n % 6) + 1}.txt` })));
    const root = deadlineSurface(url, "deadline_notes = [0.4]\ndeadline_margin_ms = 200\nnudge_after_idle = 0");
    const { at, clock } = scriptClock(raws);
    const rec = await runTask(loadConfig(root), "Write the summary to `result.txt`.", {
      role: "smol",
      yes: true,
      stderr: { write() {} },
      deadline: { at, source: "flag" },
      clock,
    });
    expect(rec.stop_reason).toBe("answered");
    expect(rec.counters.deadline_notes).toBe(1);
    expect(raws.join("")).toContain("Time check");
    expect(raws.join("")).not.toContain("do not exist yet");
    expect(rec.counters).not.toHaveProperty("deliverable_first_notes");
    expect(trail(root).some((a) => a.kind === "deliverable_first")).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The first-token watchdog
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;
async function serveSse(handler: Handler) {
  let n = 0;
  const seen: { bodies: string[] } = { bodies: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.bodies.push(raw);
      handler(req, res, ++n);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, seen };
}
const sse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
const chunk = (res: ServerResponse, obj: unknown) => !res.destroyed && res.write(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
/** A reply that is all there, at once. */
const whole = (res: ServerResponse, text: string) => {
  chunk(res, delta({ role: "assistant", content: "" }));
  chunk(res, delta({ content: text }, "stop"));
  chunk(res, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  res.end("data: [DONE]\n\n");
};
/** Keep-alives and an empty role chunk, and never a token: a queued request. */
const stall = (res: ServerResponse) => {
  sse(res);
  chunk(res, delta({ role: "assistant", content: "" }));
  const t = setInterval(() => !res.destroyed && res.write(": keep-alive\n\n"), 30);
  res.on("close", () => clearInterval(t));
};
const target = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  model: "m",
  kind: "openai" as const,
  temperature: 0,
  top_p: 1,
  stream: true,
  ...extra,
});
const hi = [{ role: "user" as const, content: "hi" }];

describe("[resilience] first_token_timeout_ms", () => {
  it("a stream with keep-alives but no token is aborted at the watchdog and asked again; the retry answers", async () => {
    const { url, seen } = await serveSse((_req, res, n) => {
      if (n === 1) return stall(res);
      sse(res);
      whole(res, "hello");
    });
    const t0 = Date.now();
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 300 }), hi, [], 20_000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.content).toBe("hello");
    expect(seen.bodies).toHaveLength(2);
    // The same request, asked again.
    expect(seen.bodies[1]).toBe(seen.bodies[0]);
    expect(r.firstTokenStalls).toHaveLength(1);
    expect(r.firstTokenStalls![0]!.attempt).toBe(1);
    expect(r.firstTokenStalls![0]!.waited_ms).toBeGreaterThanOrEqual(250);
    // Not waited out to the 20 s request timeout.
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("a reply that has produced a token is never cut by it, however long it pauses after", async () => {
    const { url, seen } = await serveSse((_req, res) => {
      sse(res);
      chunk(res, delta({ role: "assistant", reasoning_content: "thinking" }));
      setTimeout(() => {
        chunk(res, delta({ content: "late but whole" }, "stop"));
        res.end("data: [DONE]\n\n");
      }, 700);
    });
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 200 }), hi, [], 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.content).toBe("late but whole");
    expect(seen.bodies).toHaveLength(1);
    expect(r.firstTokenStalls).toBeUndefined();
  });

  it("a first tool-call chunk counts as the first token", async () => {
    const { url, seen } = await serveSse((_req, res) => {
      sse(res);
      chunk(res, delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "" } }] }));
      setTimeout(() => {
        chunk(res, delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }, "tool_calls"));
        res.end("data: [DONE]\n\n");
      }, 500);
    });
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 200 }), hi, [], 5000, { attempts: 2, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.toolCalls[0]?.name).toBe("read");
    expect(seen.bodies).toHaveLength(1);
  });

  it("every attempt stalled: a timeout (11, first_token) after `attempts` requests, each recorded", async () => {
    const { url, seen } = await serveSse((_req, res) => stall(res));
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 150 }), hi, [], 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(FIXTURE.first_token.code);
    expect(r.timedOut).toBe(FIXTURE.first_token.timed_out);
    expect(r.content).toMatch(/no first token within 0\.2s \(\[resilience\] first_token_timeout_ms\)/);
    expect(seen.bodies).toHaveLength(3);
    expect(r.firstTokenStalls!.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  it("headers that never come are a first-token stall too", async () => {
    const { url, seen } = await serveSse((_req, res, n) => {
      if (n === 1) return; // never answers
      sse(res);
      whole(res, "ok");
    });
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 200 }), hi, [], 5000, { attempts: 2, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(seen.bodies).toHaveLength(2);
    expect(r.firstTokenStalls).toHaveLength(1);
  });

  it("off (absent): the same slow first token is waited for, one request", async () => {
    const { url, seen } = await serveSse((_req, res) => {
      stall(res);
      setTimeout(() => whole(res, "slow"), 600);
    });
    const r = await callEndpointWithRetry(target(url), hi, [], 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.content).toBe("slow");
    expect(seen.bodies).toHaveLength(1);
  });

  it("a streamed call answered with one JSON body is timed as it always was", async () => {
    const { url, seen } = await serveSse((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      setTimeout(
        () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "one body" }, finish_reason: "stop" }] })),
        500
      );
    });
    const r = await callEndpointWithRetry(target(url, { firstTokenMs: 150 }), hi, [], 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(r.content).toBe("one body");
    expect(seen.bodies).toHaveLength(1);
  });

  it("an unstreamed call never reads it", async () => {
    const { url, seen } = await serveSse((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "whole" }, finish_reason: "stop" }] }));
      }, 500);
    });
    const r = await callEndpointWithRetry(target(url, { stream: false, firstTokenMs: 100 }), hi, [], 5000, { attempts: 3, backoff_ms: 1 }, undefined, undefined);
    expect(r.code).toBe(0);
    expect(seen.bodies).toHaveLength(1);
  });

  it("through a task: the stall is announced, counted and on the trail; the turn answers", async () => {
    const { url } = await serveSse((_req, res, n) => {
      if (n === 1) return stall(res);
      sse(res);
      whole(res, "done");
    });
    const root = mkdtempSync(join(tmpdir(), "gnomon-ftt-run-"));
    roots.push(root);
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      `[audit]\nenabled = true\n\n[resilience]\nfirst_token_timeout_ms = 300\nbackoff_ms = 1\n\n` +
        `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = true\nreplay_reasoning = false\n`
    );
    writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\n`);
    writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
    writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "read"\nenabled = true\n`);
    const said: string[] = [];
    const rec = await runTask(loadConfig(root), "hi", { role: "smol", stderr: { write: (s: string) => (said.push(s), true) } });
    expect(rec.stop_reason).toBe("answered");
    expect(rec.output).toContain("done");
    expect(rec.counters[FIXTURE.first_token.counter as "first_token_stalls"]).toBe(1);
    expect(said.join("")).toMatch(/\[retry\] no first token in 300ms \(first_token_timeout_ms\)/);
    const stalls = trail(root).filter((a) => a.kind === FIXTURE.first_token.audit.kind);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ role: "smol", attempt: 1, recovered: true });
    expect(Object.keys(stalls[0]!).filter((k) => FIXTURE.first_token.audit.fields.includes(k)).sort()).toEqual(
      [...FIXTURE.first_token.audit.fields].sort()
    );
  }, 15_000);
});
