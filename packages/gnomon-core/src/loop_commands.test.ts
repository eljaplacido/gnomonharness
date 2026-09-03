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
import { mkdtempSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, routeRole } from "./config.js";
import { runPromptLoop, COMMANDS } from "./prompt_loop.js";
import { stubDeclaredKeys } from "./test_support.js";

// The real surface, copied per test. loadConfig is fine on the repo itself, but
// the loop APPENDS to `<root>/.gnomon-sessions/history` and saves a session
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
    await runPromptLoop(loadConfig(root), opts.initialRole, {
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
    // Honest limit, stated rather than papered over: /quit terminates via
    // process.exit(0) inside processCommand, so an in-process test must stub
    // process.exit. The stub does what a real exit does to the loop -- stops
    // feeding it input -- and the promise below is genuinely awaited.
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
});
