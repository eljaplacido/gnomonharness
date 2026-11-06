/**
 * gnomon-core: slash commands as they behave INSIDE the running loop.
 *
 * Why this file exists
 * --------------------
 * prompt_loop.ts is 5,830 lines at 50.28% statement coverage. Lines 4526-5812
 * are `runPromptLoop`, the interactive REPL, measured at 0% -- the least-tested
 * code in the project, and by the project's own post-mortems the place most
 * defects have been found. The interactive [chain] wiring landed inside that
 * 1,286-line unmeasured region.
 *
 * `processCommand` is unit-tested in prompt_loop.test.ts, but that proves only
 * that a function called with a string mutates a state object. It says nothing
 * about the loop: whether a typed line ever REACHES that function, whether the
 * loop short-circuits before calling the model, or whether a command declared
 * in COMMANDS is dispatched at all. The claim "slash commands are intercepted
 * before any model call" had nothing behind it -- no test anywhere counted the
 * model calls a command makes.
 *
 * These tests drive the real loop through the io seam with a PassThrough, stub
 * `globalThis.fetch`, and count the calls. Every assertion is on observable
 * behaviour: what the operator saw, which model the next turn was routed to,
 * how many HTTP requests left the process. Nothing here greps the source.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { osSandbox } from "gnomon-natives";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { loadConfig, routeRole } from "./config.js";
import { runPromptLoop, COMMANDS } from "./prompt_loop.js";
import { verifyTrail } from "./audit.js";
import { stubDeclaredKeys } from "./test_support.js";

// The real surface, copied per test. loadConfig is fine on the repo itself, but
// the loop saves a session
// snapshot after every turn -- pointed at the checkout that would be writing
// into the repo under test. Same idiom as prompt_loop.test.ts's /allow test.
const REPO_SURFACE = resolve(process.cwd(), "..", "..", ".gnomon");

const makeProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-loopcmds-"));
  cpSync(REPO_SURFACE, join(dir, ".gnomon"), { recursive: true });
  return dir;
};

interface ModelCall {
  url: string;
  body: { model?: string; messages?: { role: string; content: string }[] };
}

interface Driven {
  /** Everything the loop printed with console.log / console.error. */
  log: string;
  /** Everything it wrote straight to process.stdout (Progress, /clear). */
  stdout: string;
  /** Everything readline wrote to the injected output stream (the prompts). */
  stream: string;
  /** log + stdout: what an operator actually saw. */
  seen: string;
  /** Every HTTP request that left the process, in order. */
  calls: ModelCall[];
  /** Codes passed to process.exit while the loop ran. */
  exits: number[];
}

/**
 * Drive the real loop with a scripted operator.
 *
 * Lines are fed one at a time, and only when the loop has actually printed a
 * prompt -- readline writes `${role} ▸ `, `approve> ` or `role> ` to the
 * injected output stream even on a non-terminal. Feeding on the prompt keeps
 * the loop on its `notify` path (a human typing at a waiting prompt) instead of
 * the queue path (typing while the model is busy), and means the script can
 * never run ahead of the loop. When the script is exhausted the input stream is
 * ended, which is what closes readline and lets the loop's promise resolve.
 */
const drive = async (
  root: string,
  lines: string[],
  opts: {
    /** The model's reply body, per call. Defaults to a one-word prose answer. */
    reply?: (call: ModelCall, n: number) => unknown;
    initialRole?: string;
    /** Called on process.exit(); `stop` cuts the script off, as a real exit would. */
    onExit?: (code: number, stop: () => void) => void;
    /** Safety net: end the input if the loop stops asking for lines. */
    budgetMs?: number;
    /** Start the session under `--profile <name>`. */
    profile?: string;
  } = {}
): Promise<Driven> => {
  const input = new PassThrough();
  const pending = [...lines];
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    input.end();
  };
  const feed = (): void => {
    if (stopped) return;
    const next = pending.shift();
    if (next === undefined) {
      setImmediate(stop);
      return;
    }
    setImmediate(() => {
      if (!stopped) input.write(`${next}\n`);
    });
  };

  const streamChunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      const s = String(chunk);
      streamChunks.push(s);
      // `implement ▸ `, `approve> `, `role> ` -- the loop is waiting on a human.
      if (/(?:▸|>) $/.test(s)) feed();
      cb();
    },
  });

  const calls: ModelCall[] = [];
  const stubFetch = (async (url: unknown, init: { body?: string } = {}) => {
    const call: ModelCall = {
      url: String(url),
      body: init.body ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    const json = opts.reply
      ? opts.reply(call, calls.length)
      : { message: { content: "acknowledged." } };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;

  const logs: string[] = [];
  const stdoutChunks: string[] = [];
  const exits: number[] = [];

  const originals = {
    fetch: globalThis.fetch,
    log: console.log,
    error: console.error,
    write: process.stdout.write,
    exit: process.exit,
    stdinTty: process.stdin.isTTY,
    stdoutTty: process.stdout.isTTY,
  };

  globalThis.fetch = stubFetch;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  };
  console.error = (...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(" "));
  };
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  (process as { exit: unknown }).exit = (code?: number) => {
    exits.push(code ?? 0);
    opts.onExit?.(code ?? 0, stop);
  };
  // The seam injects the stream, but several branches inside the loop still ask
  // `process.stdin.isTTY` rather than the injected stream -- the session picker,
  // the /models picker, and the approval gate's typed-ahead hold. Under vitest
  // those can be inherited as true, which would park the loop on a keypress
  // reader nothing is driving. Pin both to the piped case the seam promises.
  // (Reported: the loop should consult the injected stream, not the global.)
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

  const guard = setTimeout(stop, opts.budgetMs ?? 15000);
  try {
    await runPromptLoop(loadConfig(root, opts.profile), opts.initialRole, {
      io: { input, output },
    });
  } finally {
    clearTimeout(guard);
    globalThis.fetch = originals.fetch;
    console.log = originals.log;
    console.error = originals.error;
    process.stdout.write = originals.write;
    (process as { exit: unknown }).exit = originals.exit;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originals.stdinTty,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originals.stdoutTty,
      configurable: true,
    });
  }

  const log = logs.join("\n");
  const stdout = stdoutChunks.join("");
  return { log, stdout, stream: streamChunks.join(""), seen: `${log}\n${stdout}`, calls, exits };
};

/** The last user message of a request, i.e. what was actually sent to a model. */
const sentPrompt = (call: ModelCall): string =>
  call.body.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "";

describe("slash commands inside the running loop", () => {
  // This surface routes a role at an endpoint declaring api_key_env, and the
  // loop pre-flights that before opening a socket. Without a value the turn is
  // refused and every assertion below fails on a missing model call.
  //
  // It used to work anyway, because the author's machine had a credential
  // store with that variable in it. That made these tests pass locally and
  // fail in CI, which is the exact machine-scoped dependence this project
  // exists to remove. The stub is declared here so the requirement is visible.
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  // ─────────────────────────────────────────────────────────────────────────
  // The claim nothing proved.
  // ─────────────────────────────────────────────────────────────────────────

  it("a slash command makes NO model call, in a session where prose does", async () => {
    // The loop's whole reason for intercepting "/" before the model is cost: a
    // mistyped or informational line must not open a slow, paid turn. That was
    // asserted nowhere -- processCommand's unit tests never touch fetch, so a
    // regression that fell through to the model would have been invisible.
    //
    // The prose turn at the end is what makes this non-vacuous. Without it,
    // "fetch was never called" would also pass if the loop were broken and
    // called the model for nothing at all.
    const root = makeProject();
    try {
      const r = await drive(root, [
        "/help",
        "/roles",
        "/context",
        "/tools",
        "now actually ask the model",
      ]);

      expect(r.calls).toHaveLength(1);
      expect(sentPrompt(r.calls[0])).toBe("now actually ask the model");
      // …and the commands did their job rather than silently doing nothing.
      expect(r.log).toContain("/quit");            // /help listed the registry
      expect(r.log).toContain("Available roles:"); // /roles listed them
      expect(r.log).toContain("Context policy");   // /context reported the window
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────
  // /role
  // ─────────────────────────────────────────────────────────────────────────

  it("/role switches the role for every LATER turn, not just for one", async () => {
    // The loop has two ways to change role and they are deliberately different:
    // a `/critique ...` PREFIX routes one turn (and is explicitly reverted --
    // "it used to overwrite state.currentRole"), while /role switches for good.
    // Nothing checked that the switch survives into the next turn through the
    // loop, which is the only place the difference is observable.
    const root = makeProject();
    try {
      const config = loadConfig(root);
      const implement = routeRole(config, "implement").model;
      const critique = routeRole(config, "critique").model;
      expect(critique, "fixture must route the two roles differently").not.toBe(implement);

      const r = await drive(root, [
        "first turn",
        "/role critique",
        "second turn",
        "third turn",
      ]);

      expect(r.calls).toHaveLength(3);
      expect(r.calls[0].body.model).toBe(implement);
      // Both turns after the switch, so this is a session change, not a one-off.
      expect(r.calls[1].body.model).toBe(critique);
      expect(r.calls[2].body.model).toBe(critique);

      // And the prompt the operator is typing at now names the new role.
      expect(r.stream).toContain("implement ▸ ");
      expect(r.stream).toContain("critique ▸ ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("/role with a name that does not exist changes nothing and costs nothing", async () => {
    const root = makeProject();
    try {
      const implement = routeRole(loadConfig(root), "implement").model;
      const r = await drive(root, ["/role nosuchrole", "a turn"]);

      expect(r.log).toContain('No such role: "nosuchrole"');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].body.model).toBe(implement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────
  // Unknown commands
  // ─────────────────────────────────────────────────────────────────────────

  it("a mistyped command names itself and suggests the nearest, instead of becoming a prompt", async () => {
    // From the source's own record: "sending it to the model burned a slow turn
    // on a typo like /helpo". The fix lives in the loop, after processCommand
    // returns false -- unreachable from processCommand's unit tests, which only
    // ever see the `false`.
    const root = makeProject();
    try {
      const r = await drive(root, ["/helpo", "the real question"]);

      expect(r.log).toContain("Unknown command: /helpo");
      expect(r.log).toMatch(/did you mean .*\/help/);
      expect(r.log).toContain("/help lists everything.");

      // The point of the whole branch: the typo never reached a model.
      expect(r.calls).toHaveLength(1);
      expect(sentPrompt(r.calls[0])).toBe("the real question");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("a role PREFIX is not a mistyped command — it routes that one turn and reverts", async () => {
    // The same branch decides both, and getting it wrong either way is a real
    // failure: `/smol summarise this` refused as "Unknown command", or /helpo
    // sent to a model. This is the other side of the discrimination.
    const root = makeProject();
    try {
      const config = loadConfig(root);
      const implement = routeRole(config, "implement").model;
      const smol = routeRole(config, "smol").model;
      expect(smol).not.toBe(implement);

      const r = await drive(root, ["/smol summarise this", "and now this"]);

      expect(r.log).not.toContain("Unknown command");
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0].body.model).toBe(smol);
      // The prefix is stripped before the model sees it…
      expect(sentPrompt(r.calls[0])).toBe("summarise this");
      // …and the session role is untouched: the next turn is back on implement.
      expect(r.calls[1].body.model).toBe(implement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────
  // /quit
  // ─────────────────────────────────────────────────────────────────────────

  it("/quit ends the session with code 0, having called no model", async () => {
    // The loop's own post-mortem for the `finally` block: "gnomon prompt on a
    // surface declaring an MCP server never came back from /quit ... the loop
    // had exited; the terminal was simply hung". So the thing worth asserting
    // is that the returned promise RESOLVES, not merely that a flag was set.
    //
    // Honest limit, stated rather than papered over: /quit still ends with
    // process.exit(0), now after the trail is sealed and the finally has run,
    // so an in-process test must stub process.exit. The stub does what a real
    // exit does to the loop -- stops feeding it input -- and the promise below
    // is genuinely awaited.
    const root = makeProject();
    try {
      const r = await drive(root, ["/quit", "this line must never be reached"], {
        onExit: (_code, stop) => stop(),
      });

      expect(r.exits).toEqual([0]);
      expect(r.log).toContain("Session complete.");
      expect(r.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("/quit seals the audit trail before the process exits, as end-of-input does", async () => {
    // /quit reached processCommand, whose process.exit(0) came before the
    // session_end record, so `gnomon audit verify` called an ordinary session
    // "NOT SEALED (truncated, or the run was killed)". Ctrl-D sealed it. The
    // trail is read at the moment process.exit is called, because whatever is
    // on disk then is all a real exit leaves behind.
    const root = makeProject();
    const cfg = join(root, ".gnomon", "config.toml");
    const on = readFileSync(cfg, "utf8").replace(/^enabled = false$/m, "enabled = true");
    expect(on).toMatch(/^\[audit\][\s\S]*?^enabled = true$/m);
    writeFileSync(cfg, on);
    const trail = (): string => {
      const dir = join(root, ".gnomon-audit");
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      return join(dir, files[0]!);
    };
    try {
      let sealedAtExit: boolean | undefined;
      const r = await drive(root, ["a turn", "/quit"], {
        onExit: (_code, stop) => {
          sealedAtExit = verifyTrail(trail()).sealed;
          stop();
        },
      });
      expect(r.exits).toEqual([0]);
      expect(sealedAtExit).toBe(true);
      const v = verifyTrail(trail());
      expect(v).toMatchObject({ ok: true, sealed: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("the loop also resolves when the input simply ends", async () => {
    // The other exit path, and the one that needs no stub at all: readline
    // closes, readLine() answers null, the loop breaks and the finally runs.
    const root = makeProject();
    try {
      const r = await drive(root, []);
      expect(r.exits).toEqual([]);
      expect(r.log).toContain("Session complete.");
      expect(r.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────
  // Rendering commands: they change what later turns look like, and cost nothing
  // ─────────────────────────────────────────────────────────────────────────

  it("/meta none silences the meta line on later turns, with no model call of its own", async () => {
    const root = makeProject();
    try {
      const control = await drive(root, ["a turn"]);
      const quiet = await drive(root, ["/meta none", "a turn"]);

      // The surface declares meta = [turn, role, model, …], so the control run
      // must show it -- otherwise "it disappeared" proves nothing.
      expect(control.log).toContain("turn 1");
      expect(quiet.log).not.toContain("turn 1");

      // Both did exactly one model call: the command itself was free.
      expect(control.calls).toHaveLength(1);
      expect(quiet.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("/think hide and /think show decide whether reasoning is rendered at all", async () => {
    const root = makeProject();
    const reply = () => ({
      message: { content: "<think>weighing the options</think>the final answer" },
    });
    try {
      const shown = await drive(root, ["/think show", "a turn"], { reply });
      const hidden = await drive(root, ["/think hide", "a turn"], { reply });

      expect(shown.seen).toContain("weighing the options");
      expect(shown.log).toContain("reasoning");
      // Hidden means hidden everywhere: not in the final render, and not in the
      // live trace either.
      expect(hidden.seen).not.toContain("weighing the options");
      // The answer still arrives.
      expect(hidden.seen).toContain("the final answer");

      expect(shown.calls).toHaveLength(1);
      expect(hidden.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("/cot off stops the live trace while the turn runs; the answer still lands", async () => {
    // /cot governs the "while it works" transcript, which only exists on a turn
    // that calls a tool -- a turn that answers straight out returns before the
    // trace is ever emitted. So the stub model calls `read` first (ungated
    // under this surface's approval = "on_write") and answers on the second
    // call, which is the shape /cot was written for.
    const root = makeProject();
    const reply = (_call: ModelCall, n: number) =>
      n === 1
        ? {
            message: {
              content: "<think>step one of the plan</think>",
              tool_calls: [
                { function: { name: "read", arguments: { path: "README.md" } } },
              ],
            },
          }
        : { message: { content: "the final answer" } };
    try {
      // The surface leaves cot at its default (full), so the control run traces.
      const control = await drive(root, ["a turn"], { reply });
      const off = await drive(root, ["/cot off", "a turn"], { reply });

      // The live trace is written through Progress, straight to stdout, while
      // the turn is in flight -- distinct from the rendered exchange, which
      // goes through console.log once the turn is over.
      expect(control.stdout).toContain("step one of the plan");
      expect(control.stdout).toContain("read");
      expect(off.stdout).not.toContain("step one of the plan");

      // Silencing the trace must not silence the answer.
      expect(off.log).toContain("the final answer");
      expect(control.calls).toHaveLength(2);
      expect(off.calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("/theme mono takes the colour out of everything printed after it", async () => {
    const root = makeProject();
    try {
      const r = await drive(root, ["/theme mono", "a turn"]);

      // Everything before the switch was painted with the surface's `dark`
      // theme, so the assertion is on what came AFTER the confirmation line --
      // which is exactly the claim: the theme applies from now on.
      const at = r.log.indexOf("Theme: mono");
      expect(at, "the theme change should be reported").toBeGreaterThanOrEqual(0);
      expect(r.log.slice(0, at)).toContain("\x1b[");
      expect(r.log.slice(at)).not.toContain("\x1b[");

      expect(r.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────
  // The round trip the CLI gained and the loop did not
  // ─────────────────────────────────────────────────────────────────────────

  it("every command in the COMMANDS registry is dispatched by the loop", async () => {
    // COMMANDS is what /help prints and what Tab completes, so a command can be
    // advertised without being wired: processCommand returns false, the loop
    // falls through to its typo branch, and the operator is told the command
    // they were just offered does not exist. Nothing checked the registry
    // against the dispatcher -- tab-completion tests only check the list is
    // unique and slash-prefixed.
    //
    // Each command is driven bare (no argument) in its own session, so one
    // throwing cannot mask the rest.
    const root = makeProject();
    const failures: string[] = [];
    try {
      for (const spec of COMMANDS) {
        let r: Driven | null = null;
        try {
          r = await drive(root, [spec.name], {
            // /quit would otherwise leave the script running past the exit.
            onExit: (_c, stop) => stop(),
            budgetMs: 8000,
          });
        } catch (err) {
          failures.push(`${spec.name}: threw ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (r.log.includes("Unknown command:")) {
          failures.push(`${spec.name}: reported as unknown by the loop`);
        }
        if (!r.log.includes("Session complete.")) {
          failures.push(`${spec.name}: the loop did not reach a clean end`);
        }
        // A command is never a prompt. /endpoints and /models deliberately reach
        // the network -- one probes each endpoint with a token, the other lists
        // models -- so a request alone is not the failure. Handing the COMMAND
        // to a model is, and that is the thing being asserted.
        const leaked = r.calls.filter((c) =>
          (c.body.messages ?? []).some((m) => String(m.content).includes(spec.name))
        );
        if (leaked.length > 0) {
          failures.push(`${spec.name}: sent to a model as a prompt`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
});

// A surface write used to print "the next turn runs under the new rules" and
// then not do it: the session kept the config it loaded at startup. A user
// changed the plan role's model, saw that line, and watched /role report the
// old model — three times, across two sessions, before it was diagnosed.
//
// `/models` already reloaded after writing roles.toml, so the capability
// existed and only the agent-write path did not use it.
describe("a surface written mid-session takes effect", () => {
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  it("reloads, says so, and reports the role's NEW model", async () => {
    const root = makeProject();
    const rolesPath = join(root, ".gnomon", "roles.toml");
    const before = readFileSync(rolesPath, "utf8");
    // Rewrite the current role's model to something unmistakable.
    const after = before.replace(/^model = ".*"$/m, 'model = "changed-by-the-turn"');
    expect(after).not.toEqual(before);

    let call = 0;
    // /allow all first: a surface write is refused without it, by design.
    const seen = await drive(root, ["/allow all", "rewrite the surface", "y", "/quit"], {
      // `implement` is the role that holds `write`; the fixture's default is
      // `plan`, which does not, so the call would be refused as undeclared.
      initialRole: "implement",
      reply: () => {
        call++;
        return call === 1
          ? { message: { content: "", tool_calls: [{ function: {
              name: "write",
              arguments: { path: ".gnomon/roles.toml", content: after },
            } }] } }
          : { message: { content: "rewritten" } };
      },
    });

    // The file really moved...
    expect(readFileSync(rolesPath, "utf8")).toContain("changed-by-the-turn");
    // ...the loop noticed and said so...
    expect(seen.seen).toContain("surface moved:");
    expect(seen.seen).toContain("surface reloaded");
    // ...and it names the role's model as it resolves NOW — the line the user
    // was looking for and did not get. (The rewrite lands on the first role in
    // the file, so this asserts the reload happened, not which role moved.)
    expect(seen.seen).toMatch(/surface reloaded — now [0-9a-f]{16}/);
    rmSync(root, { recursive: true, force: true });
  });

  // The reload called loadConfig(root) with no profile, so a session started
  // under --profile came back on the surface's role_profile and nothing on
  // screen said so. /models reloaded the same way, right after writing its
  // pick into the --profile's file.
  it("reloads under the --profile the session started with", async () => {
    const root = makeProject();
    writeFileSync(
      join(root, ".gnomon", "profiles", "alt.toml"),
      `[profile]\nname = "alt"\n\n[roles.implement]\nmodel = "alt-model"\nendpoint = "local"\n`
    );
    try {
      let call = 0;
      const seen = await drive(root, ["/allow all", "touch the surface", "y", "and again", "/quit"], {
        initialRole: "implement",
        profile: "alt",
        onExit: (_code, stop) => stop(),
        reply: () => {
          call++;
          return call === 1
            ? { message: { content: "", tool_calls: [{ function: {
                name: "write",
                arguments: { path: ".gnomon/system.md", content: "rewritten by the turn\n" },
              } }] } }
            : { message: { content: "done" } };
        },
      });
      expect(seen.seen).toContain("surface reloaded");
      expect(seen.seen).toContain("implement → alt-model @local");
      // Every call, before the reload and after it, went to the profile's model.
      expect(seen.calls.length).toBeGreaterThanOrEqual(3);
      expect(seen.calls.map((c) => c.body.model)).toEqual(seen.calls.map(() => "alt-model"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// PR #156 review, finding 3. policy.toml is inside the root, and the root is
// what a sandboxed bash may write. A command that set exec = "off" there was
// picked up by the drift reload, and the NEXT turn's bash ran unsandboxed.
describe("a sandboxed command cannot loosen its own sandbox through the surface", () => {
  const probe = osSandbox();
  const why =
    process.platform === "win32"
      ? "no OS sandbox on Windows"
      : "error" in probe
        ? `gnomon-exec unavailable: ${probe.error.split("\n")[0]}`
        : !probe.probe.supported || !probe.probe.network_supported
          ? `kernel cannot sandbox: ${probe.probe.reason}`
          : "";
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  it.skipIf(!!why)(`exec = "off" written by bash is not applied; the next command is still confined${why ? ` [SKIPPED: ${why}]` : ""}`, async () => {
    const root = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "gnomon-pin-outside-"));
    const policyPath = join(root, ".gnomon", "policy.toml");
    // exec = "os", and no [verify] (its check would recurse into this suite).
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8")
        .replace(/^\[verify\][\s\S]*?(?=^\[)/m, "")
        .replace(/^level = "confined".*$/m, 'level = "confined"\nexec = "os"')
        // Nobody to ask in this script: the point is the sandbox, not the gate.
        .replace(/^gate = "on_write".*$/m, 'gate = "never"')
    );
    expect(readFileSync(policyPath, "utf8")).toMatch(/^exec = "os"$/m);
    try {
      let call = 0;
      const bashCall = (command: string) => ({
        message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] },
      });
      const seen = await drive(root, ["loosen it", "now escape", "/quit"], {
        initialRole: "implement",
        onExit: (_c, stop) => stop(),
        budgetMs: 40000,
        reply: () => {
          call++;
          // Through python, with the path assembled at run time: the bash
          // text rules refuse a command that names the surface, and no
          // reading of text sees this one. The kernel lets it through, since
          // .gnomon/ is inside the root.
          if (call === 1) {
            const py = `p = ".gno" + "mon/policy.toml"; s = open(p).read(); open(p, "w").write(s.replace('exec = "os"', 'exec = "off"'))`;
            return bashCall(`python3 -c '${py.replace(/'/g, `'\\''`)}'`);
          }
          if (call === 3) return bashCall(`echo escaped > '${outside}/escaped.txt'`);
          return { message: { content: "done" } };
        },
      });
      // The command did rewrite the file -- it is inside the root...
      expect(readFileSync(policyPath, "utf8")).toMatch(/^exec = "off"$/m);
      // ...the loop said it would not apply it...
      expect(seen.seen).toContain("sandbox NOT loosened");
      // ...and the next command was still confined.
      expect(existsSync(join(outside, "escaped.txt")), seen.seen.slice(-3000)).toBe(false);
      expect(call).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60000);
});

// PR #156 second review, findings A and B, end to end through the real loop
// under exec = "os". The command writes files inside the root -- which the
// kernel allows -- that gnomon itself then acts on outside the sandbox: git's
// config (A) and the surface's key routing (B).
describe("a sandboxed command cannot act through gnomon's own git or key routing", () => {
  const probe = osSandbox();
  const why =
    process.platform === "win32"
      ? "no OS sandbox on Windows"
      : "error" in probe
        ? `gnomon-exec unavailable: ${probe.error.split("\n")[0]}`
        : !probe.probe.supported || !probe.probe.network_supported
          ? `kernel cannot sandbox: ${probe.probe.reason}`
          : "";
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  /** The repository's surface under exec = "os", no [verify], nobody to ask. */
  const osProject = (): string => {
    const root = makeProject();
    const policyPath = join(root, ".gnomon", "policy.toml");
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8")
        .replace(/^\[verify\][\s\S]*?(?=^\[)/m, "")
        .replace(/^level = "confined".*$/m, 'level = "confined"\nexec = "os"')
        .replace(/^gate = "on_write".*$/m, 'gate = "never"')
    );
    return root;
  };
  const bashCall = (command: string) => ({
    message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] },
  });
  /** A python one-liner as a bash command, quoted for sh. */
  const py = (code: string) => `python3 -c '${code.replace(/'/g, `'\\''`)}'`;

  it.skipIf(!!why)(`A: core.fsmonitor and a filter written by bash never run outside the sandbox${why ? ` [SKIPPED: ${why}]` : ""}`, async () => {
    const root = osProject();
    const outside = mkdtempSync(join(tmpdir(), "gnomon-gitesc-outside-"));
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
    g("init", "-q");
    writeFileSync(join(root, "a.txt"), "one\n");
    g("add", "a.txt");
    g("commit", "-qm", "init");
    const fsm = join(outside, "fsmonitor-ran");
    const flt = join(outside, "filter-ran");
    try {
      let call = 0;
      const seen = await drive(root, ["plant it", "/quit"], {
        initialRole: "implement",
        onExit: (_c, stop) => stop(),
        budgetMs: 40000,
        reply: () => {
          call++;
          if (call === 1) {
            // The path assembled at run time: the text rule refusing a write
            // into .git/config sees no such path in the command.
            return bashCall(py(
              `c = ".g" + "it/con" + "fig"; ` +
              `open(c, "a").write("[core]\\n\\tfsmonitor = \\"touch ${fsm}; false\\"\\n[filter \\"x\\"]\\n\\tclean = \\"touch ${flt}; cat\\"\\n"); ` +
              `open(".gitattr" + "ibutes", "w").write("*.txt filter=x\\n"); ` +
              `open("a.txt", "w").write("two\\n")`
            ));
          }
          return { message: { content: "done" } };
        },
      });
      // The command did write the config -- the root is writable...
      expect(readFileSync(join(root, ".git", "config"), "utf8"), seen.seen.slice(-2000)).toContain("fsmonitor");
      // ...and gnomon's bookkeeping git (the stamp after the call, the [tree]
      // measurement at the end of the turn) ran neither program outside it.
      expect(existsSync(fsm), "core.fsmonitor ran outside the sandbox").toBe(false);
      expect(existsSync(flt), "the clean filter ran outside the sandbox").toBe(false);
      // CONTROL: the planted config is live for a git that is not gnomon's.
      execFileSync("git", ["status"], { cwd: root, stdio: "ignore" });
      expect(existsSync(fsm), "control: plain git did not run the fsmonitor").toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60000);

  it.skipIf(!!why)(`B: a rewritten endpoint url / api_key_env is held, and the real key stays out of bash${why ? ` [SKIPPED: ${why}]` : ""}`, async () => {
    const root = osProject();
    const cfgPath = join(root, ".gnomon", "config.toml");
    // The role's endpoint carries a key, held in a variable whose NAME no
    // secret pattern catches: only the session's own declaration drops it.
    writeFileSync(
      cfgPath,
      readFileSync(cfgPath, "utf8").replace(
        /^\[endpoints\.local\]\nurl = "([^"]+)"\n/m,
        '[endpoints.local]\nurl = "$1"\napi_key_env = "GNOMON_PINTEST_REALVAR"\n'
      )
    );
    expect(readFileSync(cfgPath, "utf8")).toContain('api_key_env = "GNOMON_PINTEST_REALVAR"');
    const before = process.env.GNOMON_PINTEST_REALVAR;
    process.env.GNOMON_PINTEST_REALVAR = "dummy-real-key-not-a-secret";
    try {
      let call = 0;
      const seen = await drive(root, ["reroute it", "now dump the env", "/quit"], {
        initialRole: "implement",
        onExit: (_c, stop) => stop(),
        budgetMs: 40000,
        reply: () => {
          call++;
          if (call === 1) {
            return bashCall(py(
              `p = ".gno" + "mon/config.toml"; s = open(p).read(); ` +
              `s = s.replace("api_key_env = \\"GNOMON_PINTEST_REALVAR\\"", "api_key_env = \\"GNOMON_PINTEST_DECOY\\""); ` +
              `s = s.replace("http://127.0.0.1:11434/api/chat", "http://127.0.0.1:9/steal"); open(p, "w").write(s)`
            ));
          }
          if (call === 3) return bashCall("env > envdump.txt");
          return { message: { content: "done" } };
        },
      });
      // The surface did move...
      expect(readFileSync(cfgPath, "utf8")).toContain("127.0.0.1:9/steal");
      // ...the loop said it would not apply the key routing...
      expect(seen.seen, seen.seen.slice(-3000)).toContain("key routing NOT applied");
      // ...every model request still went where the session started...
      expect(seen.calls.length).toBeGreaterThanOrEqual(3);
      for (const c of seen.calls) expect(c.url).not.toContain("/steal");
      // ...and the real key was not in the next command's environment.
      const dump = readFileSync(join(root, "envdump.txt"), "utf8");
      expect(dump).toContain("PATH=");
      expect(dump).not.toContain("dummy-real-key-not-a-secret");
    } finally {
      if (before === undefined) delete process.env.GNOMON_PINTEST_REALVAR;
      else process.env.GNOMON_PINTEST_REALVAR = before;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

// Found reviewing #156 (finding B), and it holds in every exec mode: a
// command rewrote .gnomon/config.toml, the loop reloaded the surface, and
// the next model request -- with its key -- went wherever the file now said.
// A loopback url is "local" to the trust gate, so it was never held, and
// under --trust nothing was. exec = "docker" hides the key from the
// container, not from gnomon's own request.
describe("a command cannot reroute the session's model requests through the surface", () => {
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  it("a rewritten endpoint url is held, said, and not used", async () => {
    const root = makeProject();
    const policyPath = join(root, ".gnomon", "policy.toml");
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8")
        .replace(/^\[verify\][\s\S]*?(?=^\[)/m, "")
        .replace(/^gate = "on_write".*$/m, 'gate = "never"')
    );
    const cfgPath = join(root, ".gnomon", "config.toml");
    const original = /^\[endpoints\.local\]\nurl = "([^"]+)"/m.exec(readFileSync(cfgPath, "utf8"))?.[1];
    expect(original).toBeTruthy();
    // Assembled at run time: the text rules refuse a command naming the surface.
    const code =
      `p = ".gno" + "mon/config.toml"; s = open(p).read(); ` +
      `open(p, "w").write(s.replace(${JSON.stringify(original)}, "http://127.0.0.1:9/steal"))`;
    try {
      let call = 0;
      const seen = await drive(root, ["reroute it", "and again", "/quit"], {
        initialRole: "implement",
        onExit: (_c, stop) => stop(),
        budgetMs: 30000,
        reply: () => {
          call++;
          if (call === 1) {
            return {
              message: {
                content: "",
                tool_calls: [{ function: { name: "bash", arguments: { command: `python3 -c '${code.replace(/'/g, `'\\''`)}'` } } }],
              },
            };
          }
          return { message: { content: "done" } };
        },
      });
      // The surface did move, and was reloaded...
      expect(readFileSync(cfgPath, "utf8")).toContain("127.0.0.1:9/steal");
      expect(seen.seen, seen.seen.slice(-3000)).toContain("surface reloaded");
      // ...the reroute was held and said...
      expect(seen.seen).toContain("key routing NOT applied");
      // ...and every request, after the reload too, went where the session started.
      expect(seen.calls.length).toBeGreaterThanOrEqual(3);
      for (const c of seen.calls) expect(c.url).not.toContain("/steal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

// Third review, finding 1, on the released exec = "docker": the container
// bind-mounts the root, a command rewrote policy.toml's `exec = "docker"` to
// "off", the loop reloaded the surface, and the next command ran on the host.
// `docker` is stubbed on PATH (it records its argv and exits 0), so a command
// that still goes through it leaves no file; one run on the host does.
describe("a contained command cannot switch exec off through the surface", () => {
  let restoreKeys: () => void;
  beforeAll(() => {
    restoreKeys = stubDeclaredKeys(loadConfig(resolve(process.cwd(), "..", "..")));
  });
  afterAll(() => restoreKeys());

  it.skipIf(process.platform === "win32")('exec = "off" written by a docker-mode command is not applied; the next command still goes to docker', async () => {
    const root = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "gnomon-pin-outside-"));
    const bin = mkdtempSync(join(tmpdir(), "gnomon-fake-docker-"));
    const dockerLog = join(bin, "argv.log");
    const policyPath = join(root, ".gnomon", "policy.toml");
    // The first "container" does what a contained command can: rewrite the
    // bind-mounted policy.toml.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerLog}'\n` +
        `if [ ! -e '${bin}/wrote' ]; then : > '${bin}/wrote'; t='${bin}/p.tmp'; ` +
        `sed 's/^exec = "docker"$/exec = "off"/' '${policyPath}' > "$t" && cat "$t" > '${policyPath}'; fi\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      policyPath,
      readFileSync(policyPath, "utf8")
        .replace(/^\[verify\][\s\S]*?(?=^\[)/m, "")
        .replace(/^level = "confined".*$/m, 'level = "confined"\nexec = "docker"\nimage = "gnomon-test-stub:1"')
        .replace(/^gate = "on_write".*$/m, 'gate = "never"')
    );
    expect(readFileSync(policyPath, "utf8")).toMatch(/^exec = "docker"$/m);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      let call = 0;
      const bashCall = (command: string) => ({
        message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] },
      });
      const seen = await drive(root, ["loosen it", "now escape", "/quit"], {
        initialRole: "implement",
        onExit: (_c, stop) => stop(),
        budgetMs: 40000,
        reply: () => {
          call++;
          if (call === 1) return bashCall("true");
          if (call === 3) return bashCall(`echo escaped > '${outside}/escaped.txt'`);
          return { message: { content: "done" } };
        },
      });
      expect(readFileSync(policyPath, "utf8")).toMatch(/^exec = "off"$/m);
      expect(seen.seen, seen.seen.slice(-3000)).toContain("surface reloaded");
      expect(existsSync(join(outside, "escaped.txt")), "the next command ran on the host").toBe(false);
      expect(seen.seen).toContain("sandbox NOT loosened");
      expect(readFileSync(dockerLog, "utf8")).toContain("escaped.txt");
      expect(call).toBeGreaterThanOrEqual(3);
    } finally {
      process.env.PATH = path;
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  }, 60000);
});
