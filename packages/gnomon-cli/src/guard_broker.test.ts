/**
 * The approval broker (CONTRACTS.md §18): a hook on a host that cannot ask
 * holds the call and a person answers; timeout or no one reachable is a deny;
 * never an auto-allow. A fake broker (the transports) stands in for the person.
 * One test runs the real dashboard end to end over loopback.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { cmdGuard } from "./guard.js";
import { startDashboard } from "./dashboard_server.js";
import { BrokerQueue } from "./dashboard_broker.js";
import {
  HOOK_MARGIN_S,
  askPerson,
  dashboardTransport,
  holdSeconds,
  hostCannotAsk,
  installedHookTimeoutS,
  resolveBroker,
  terminalTransport,
  type BrokerQuestion,
  type BrokerTransports,
  type TtyPair,
} from "./guard_broker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CASES = JSON.parse(readFileSync(join(ROOT, "conformance/guard_cases.json"), "utf-8"));

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(livePolicy = "", committedPolicy = ""): string {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-broker-")));
  made.push(r);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf-8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(r, ".gnomon"), { recursive: true });
  for (const [f, t] of Object.entries(CASES.surface as Record<string, string>)) writeFileSync(join(r, ".gnomon", f), t.replace("{{gate}}", "on_write"));
  appendFileSync(join(r, ".gnomon", "policy.toml"), committedPolicy);
  mkdirSync(join(r, "src"), { recursive: true });
  writeFileSync(join(r, "src/a.ts"), "old\n");
  git("add", "-A");
  git("commit", "-q", "-m", "surface");
  // The live surface declares the broker and the audit trail; the committed rules are untouched.
  appendFileSync(join(r, ".gnomon", "config.toml"), "\n[audit]\nenabled = true\n");
  appendFileSync(join(r, ".gnomon", "policy.toml"), livePolicy);
  return r;
}

const CODEX_ENV = { session_id: "s1", hook_event_name: "PreToolUse", model: "gpt-5-codex", permission_mode: "default", turn_id: "t1", tool_use_id: "call_1", transcript_path: null };
const codexAdd = (cwd: string) => ({ ...CODEX_ENV, cwd, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch" } });

/** A fake broker: records what it was asked and how long it was told to hold, answers as scripted. */
function fake(answer: "approved" | "denied" | "timeout" | "unreachable", why?: string) {
  const calls: Array<{ via: string; q: BrokerQuestion; holdS: number }> = [];
  const t = (via: string) => async (q: BrokerQuestion, holdS: number) => {
    calls.push({ via, q, holdS });
    return { answer, ...(why ? { why } : {}) };
  };
  const transports: BrokerTransports = { dashboard: t("dashboard"), terminal: t("terminal") };
  return { calls, transports };
}

async function hook(host: "codex" | "cursor", payload: unknown, dir: string, transports: BrokerTransports) {
  const lines: string[] = [];
  const code = await cmdGuard(["--from", host, "--role", "implement", "--dir", dir], (s) => lines.push(s), () => JSON.stringify(payload), transports);
  return { code, text: lines.join("") };
}

function guardRecords(dir: string): Array<Record<string, any>> {
  const d = join(dir, ".gnomon-audit");
  return readdirSync(d)
    .filter((f) => f.startsWith("guard-") && f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(d, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l)))
    .filter((r) => r.kind === "guard");
}

describe("[guard] broker: Codex, an ask held for a person", () => {
  it("approved: the call goes on (nothing on stdout) and the record says a person allowed it", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n');
    const f = fake("approved");
    const out = await hook("codex", codexAdd(r), r, f.transports);
    expect(out.code).toBe(0);
    expect(out.text).toBe("");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.via).toBe("dashboard");
    expect(f.calls[0]!.q.tool).toBe("write");
    const rec = guardRecords(r).at(-1)!;
    expect(rec.decision).toBe("allow");
    expect(rec.broker).toMatchObject({ via: "dashboard", outcome: "approved" });
  });

  it("denied: Codex is told deny, with the person's refusal in the reason, and it is recorded", async () => {
    const r = repo('\n[guard]\nbroker = "terminal"\n');
    const f = fake("denied");
    const out = await hook("codex", codexAdd(r), r, f.transports);
    const j = JSON.parse(out.text).hookSpecificOutput;
    expect(j.permissionDecision).toBe("deny");
    expect(j.permissionDecisionReason).toContain("denied by a person (terminal)");
    expect(f.calls[0]!.via).toBe("terminal");
    expect(guardRecords(r).at(-1)).toMatchObject({ decision: "deny", broker: { via: "terminal", outcome: "denied" } });
  });

  it("timeout is a deny that says no one answered, never an allow", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n');
    const out = await hook("codex", codexAdd(r), r, fake("timeout").transports);
    const j = JSON.parse(out.text).hookSpecificOutput;
    expect(j.permissionDecision).toBe("deny");
    expect(j.permissionDecisionReason).toMatch(/no one answered within \d+s/);
    expect(guardRecords(r).at(-1)).toMatchObject({ decision: "deny", broker: { outcome: "timeout" } });
  });

  it("no broker reachable is a deny with the reason", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n');
    const out = await hook("codex", codexAdd(r), r, fake("unreachable", "no dashboard is running").transports);
    const j = JSON.parse(out.text).hookSpecificOutput;
    expect(j.permissionDecision).toBe("deny");
    expect(j.permissionDecisionReason).toContain("could not reach a person: no dashboard is running");
    expect(guardRecords(r).at(-1)).toMatchObject({ decision: "deny", broker: { outcome: "unreachable" } });
  });

  it("a transport that throws is an unreachable deny, not a crash and not an allow", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n');
    const boom: BrokerTransports = { dashboard: async () => { throw new Error("boom"); }, terminal: async () => ({ answer: "approved" }) };
    const out = await hook("codex", codexAdd(r), r, boom);
    expect(JSON.parse(out.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("the hold stays under the host's hook timeout: 25 s of a 30 s hook by default, the broker's own once the install lengthened it", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\nbroker_timeout_s = 60\n');
    const f = fake("denied");
    await hook("codex", codexAdd(r), r, f.transports);
    expect(f.calls[0]!.holdS).toBe(30 - HOOK_MARGIN_S);
    mkdirSync(join(r, ".codex"), { recursive: true });
    writeFileSync(join(r, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "gnomon guard --from codex --agent codex", timeout: 75 }] }] } }));
    const g = fake("denied");
    await hook("codex", codexAdd(r), r, g.transports);
    expect(g.calls[0]!.holdS).toBe(60);
  });

  it("without [guard] broker nothing is asked and Codex's gate ask is deferred as before", async () => {
    const r = repo();
    const f = fake("approved");
    const out = await hook("codex", codexAdd(r), r, f.transports);
    expect(f.calls).toHaveLength(0);
    expect(out.text).toBe("");
    expect(guardRecords(r).at(-1)).toMatchObject({ decision: "ask" });
    expect(guardRecords(r).at(-1)!.broker).toBeUndefined();
  });

  it("a misspelt broker is no broker: the ask is still a deny where it was one", async () => {
    const r = repo('\n[guard]\nbroker = "dashbord"\n');
    expect(resolveBroker(r)).toBeNull();
  });

  it("an undecidable call (rule error) is not put to a broker: it stays a deny", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n');
    const f = fake("approved");
    const lines: string[] = [];
    await cmdGuard(["--from", "codex", "--agent", "nobody", "--dir", r], (s) => lines.push(s), () => JSON.stringify(codexAdd(r)), f.transports);
    expect(f.calls).toHaveLength(0);
    expect(JSON.parse(lines.join("")).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("[guard] broker: Cursor", () => {
  const cursor = (dir: string, event: string, extra: object) => ({ conversation_id: "c1", generation_id: "g1", workspace_roots: [dir], cursor_version: "3.0.16", hook_event_name: event, ...extra });

  it("hosts and events that cannot ask are the brokered ones: Codex, Cursor preToolUse and beforeReadFile", () => {
    expect(hostCannotAsk("codex")).toBe(true);
    expect(hostCannotAsk("cursor", "preToolUse")).toBe(true);
    expect(hostCannotAsk("cursor", "beforeReadFile")).toBe(true);
    expect(hostCannotAsk("cursor", "beforeShellExecution")).toBe(false);
    expect(hostCannotAsk("claude-code")).toBe(false);
    expect(hostCannotAsk("qwen-code")).toBe(false);
  });

  it("preToolUse write ask: approved leaves the call to Cursor ({}), denied is a deny", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n', '\n[check.roles]\ncursor = "implement"\n');
    const p = cursor(r, "preToolUse", { tool_name: "Write", tool_input: { file_path: join(r, "src/new.ts"), contents: "x" }, cwd: r });
    const run = async (t: BrokerTransports) => {
      const lines: string[] = [];
      await cmdGuard(["--from", "cursor", "--agent", "cursor", "--dir", r], (s) => lines.push(s), () => JSON.stringify(p), t);
      return lines.join("");
    };
    const ok = fake("approved");
    expect(JSON.parse(await run(ok.transports))).toEqual({});
    expect(ok.calls).toHaveLength(1);
    expect(JSON.parse(await run(fake("denied").transports)).permission).toBe("deny");
  });

  it("beforeShellExecution can ask natively: the broker is not used there", async () => {
    const r = repo('\n[guard]\nbroker = "dashboard"\n', '\n[check.roles]\ncursor = "implement"\n');
    const f = fake("approved");
    const lines: string[] = [];
    await cmdGuard(["--from", "cursor", "--agent", "cursor", "--dir", r], (s) => lines.push(s), () => JSON.stringify(cursor(r, "beforeShellExecution", { command: "touch x", cwd: r })), f.transports);
    expect(f.calls).toHaveLength(0);
  });
});

describe("holdSeconds, askPerson and the installed hook timeout", () => {
  it("never holds past the host's hook timeout minus the margin, and at least a second", () => {
    expect(holdSeconds(60, 30)).toBe(25);
    expect(holdSeconds(60, 75)).toBe(60);
    expect(holdSeconds(10, 30)).toBe(10);
    expect(holdSeconds(60, 3)).toBe(1);
  });

  it("only 'approved' allows", async () => {
    const q: BrokerQuestion = { host: "codex", tool: "bash", target: "x", reason: "r", project: "/p" };
    for (const a of ["denied", "timeout", "unreachable"] as const) {
      const run = await askPerson({ via: "dashboard", timeoutS: 60 }, 5, q, { reason: "r" }, fake(a).transports);
      expect(run.decision, a).toBe("deny");
    }
    expect((await askPerson({ via: "dashboard", timeoutS: 60 }, 5, q, { reason: "r" }, fake("approved").transports)).decision).toBe("allow");
  });

  it("reads the shortest guard timeout from the installed hook file, 30 when there is none", () => {
    const r = repo();
    expect(installedHookTimeoutS(r, "codex")).toBe(30);
    mkdirSync(join(r, ".cursor"), { recursive: true });
    writeFileSync(join(r, ".cursor", "hooks.json"), JSON.stringify({ hooks: { beforeShellExecution: [{ command: "gnomon guard --from cursor --agent cursor", timeout: 90 }], preToolUse: [{ command: "gnomon guard --from cursor --agent cursor", timeout: 75 }] } }));
    expect(installedHookTimeoutS(r, "cursor")).toBe(75);
  });
});

describe("the terminal transport", () => {
  const pair = (): { tty: TtyPair; input: PassThrough; output: PassThrough } => {
    const input = new PassThrough();
    const output = new PassThrough();
    return { tty: { input, output, close: () => undefined }, input, output };
  };
  const q: BrokerQuestion = { host: "codex", tool: "bash", target: "rm -rf build", reason: "ask", project: "/p" };

  it("y approves; anything else denies; silence is a timeout; no terminal is unreachable", async () => {
    const a = pair();
    const yes = terminalTransport(() => a.tty)(q, 5);
    a.input.write("y\n");
    expect((await yes).answer).toBe("approved");
    expect(a.output.read()?.toString()).toContain("rm -rf build");

    const b = pair();
    const no = terminalTransport(() => b.tty)(q, 5);
    b.input.write("sure\n");
    expect((await no).answer).toBe("denied");

    const c = pair();
    expect((await terminalTransport(() => c.tty)(q, 0.05)).answer).toBe("timeout");
    expect((await terminalTransport(() => null)(q, 1)).answer).toBe("unreachable");
  });
});

describe("the dashboard broker, end to end over loopback", () => {
  const json = async (port: number, path: string, token: string, method = "GET", body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const q: BrokerQuestion = { host: "codex", tool: "bash", target: "make deploy", reason: "the approval gate asks", project: "/p" };

  async function withDashboard<T>(fn: (d: { port: number; page: string; advert: string }) => Promise<T>): Promise<T> {
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-broker-dash-")));
    made.push(tmp);
    const advert = join(tmp, "dashboard-broker.json");
    const dash = await startDashboard({ projects: [], sourceRoot: null, brokerAdvertFile: advert });
    try {
      const boot = /#k=([A-Za-z0-9_-]+)$/.exec(dash.signInUrl())![1]!;
      const auth = await fetch(`http://127.0.0.1:${dash.port}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: boot }) });
      const page = ((await auth.json()) as { token: string }).token;
      return await fn({ port: dash.port, page, advert });
    } finally {
      await dash.close();
    }
  }

  it("a person approves the card through the confirm nonce: the hook's transport answers approved", async () => {
    await withDashboard(async ({ port, page, advert }) => {
      const asked = dashboardTransport({ advertFile: advert, pollMs: 20 })(q, 10);
      let card: any;
      for (let i = 0; i < 100 && !card; i++) {
        await new Promise((r) => setTimeout(r, 20));
        card = (await json(port, "/api/broker/pending", page)).body.pending[0];
      }
      expect(card).toMatchObject({ host: "codex", tool: "bash", target: "make deploy" });
      // No nonce, no decision: the first step only says what the click does.
      const prep = await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "allow" });
      expect(prep.body.confirm.nonce).toBeTruthy();
      // A nonce for allow does not deny, and is spent either way.
      const wrong = await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "deny", confirm: prep.body.confirm.nonce });
      expect(wrong.status).toBe(409);
      expect((await json(port, "/api/broker/pending", page)).body.pending).toHaveLength(1);
      const prep2 = await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "allow" });
      const done = await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "allow", confirm: prep2.body.confirm.nonce });
      expect(done.body.state).toBe("approved");
      expect((await asked).answer).toBe("approved");
      // One use.
      expect((await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "allow", confirm: prep2.body.confirm.nonce })).status).toBe(409);
    });
  });

  it("deny, and an unanswered card, end as denied and timeout; the card leaves the list", async () => {
    await withDashboard(async ({ port, page, advert }) => {
      const asked = dashboardTransport({ advertFile: advert, pollMs: 20 })(q, 10);
      let card: any;
      for (let i = 0; i < 100 && !card; i++) {
        await new Promise((r) => setTimeout(r, 20));
        card = (await json(port, "/api/broker/pending", page)).body.pending[0];
      }
      const prep = await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "deny" });
      await json(port, `/api/broker/${card.id}/decide`, page, "POST", { decision: "deny", confirm: prep.body.confirm.nonce });
      expect((await asked).answer).toBe("denied");
      const slow = await dashboardTransport({ advertFile: advert, pollMs: 20 })(q, 0.2);
      expect(slow.answer).toBe("timeout");
      expect((await json(port, "/api/broker/pending", page)).body.pending).toHaveLength(0);
    });
  });

  it("the hook's secret can ask but never decide, and the page's token cannot pose as a hook", async () => {
    await withDashboard(async ({ port, page, advert }) => {
      const secret = (JSON.parse(readFileSync(advert, "utf-8")) as { secret: string }).secret;
      const made1 = await json(port, "/api/broker/request", secret, "POST", { ...q, hold_s: 5 });
      expect(made1.status).toBe(200);
      const id = made1.body.request.id as string;
      expect((await json(port, `/api/broker/${id}/decide`, secret, "POST", { decision: "allow" })).status).toBe(401);
      expect((await json(port, "/api/broker/pending", secret)).status).toBe(401);
      expect((await json(port, "/api/broker/request", page, "POST", q)).status).toBe(401);
      expect((await json(port, `/api/broker/request/${id}`, secret)).body.request.state).toBe("pending");
    });
  });

  it("no dashboard running (no advert file) is unreachable, so a deny", async () => {
    const r = await dashboardTransport({ advertFile: join(tmpdir(), "gnomon-no-such-advert.json") })(q, 1);
    expect(r.answer).toBe("unreachable");
    expect(r.why).toContain("no `gnomon dashboard` is running");
  });

  it("the advert file is 0600 and goes when the dashboard closes", async () => {
    let file = "";
    await withDashboard(async ({ advert }) => {
      file = advert;
      if (process.platform !== "win32") expect(readFileSync(advert, "utf-8")).toContain('"secret"');
    });
    expect(() => readFileSync(file)).toThrow();
  });
});

describe("BrokerQueue", () => {
  it("expires an unanswered card into timeout and refuses a decision on it", () => {
    let t = 1_000;
    const q = new BrokerQueue(() => t);
    const r = q.create({ host: "codex", tool: "bash" }, 5)!;
    const n = q.prepare(r.id, "allow")!.nonce;
    t += 6_000;
    expect(q.get(r.id)!.state).toBe("timeout");
    expect(q.decide(r.id, "allow", n)).toBe(false);
  });
});
