/**
 * The approval broker (CONTRACTS.md §18): a person answers an `ask` on a host
 * that cannot ask.
 *
 * Codex documents `permissionDecision: "ask"` as "parsed but not supported",
 * and Cursor does not enforce it at `preToolUse` (nor at `beforeReadFile`,
 * which takes allow or deny only). Without a broker gnomon answers such an ask
 * with a deny (or, for the [approval] gate's own ask, leaves it to the host's
 * flow). With `[guard] broker = "dashboard" | "terminal"` the hook HOLDS the
 * call and puts it to a person:
 *
 *   dashboard  a pending-approval card in the running `gnomon dashboard`, over
 *              its loopback API (dashboard_broker.ts, the confirm-nonce
 *              discipline); found through the 0600 advert file the dashboard
 *              writes.
 *   terminal   a prompt on /dev/tty, when the hook has one.
 *
 * Rules that do not bend:
 *   - Never an auto-allow. Only a person's "yes" allows. A timeout, a dashboard
 *     that is not running, no terminal, an unreadable answer: deny, with why.
 *   - The hold stays under the host's own hook timeout (the one the install
 *     wrote, read back from the hook file; 30 s when it cannot be read),
 *     minus a margin. A hook the host kills may let the call run, which is the
 *     one outcome a broker exists to prevent.
 *   - The answer is recorded: the guard record carries `broker` {via, outcome,
 *     waited_s} and the decision the person made.
 */

import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from "node:tty";
import { loadConfig } from "gnomon-core";
import type { GuardBrokerOutcome, GuardVerdict } from "gnomon-core/guard";
import { brokerFile, type BrokerAdvert } from "./dashboard_broker.js";

export const BROKER_VIAS = ["dashboard", "terminal"] as const;
export type BrokerVia = (typeof BROKER_VIAS)[number];
export const BROKER_DEFAULT_TIMEOUT_S = 60;
/** What `guard install` writes as a hook's timeout without a broker. */
export const HOOK_TIMEOUT_DEFAULT_S = 30;
/** Seconds kept between the end of a hold and the host's own kill. */
export const HOOK_MARGIN_S = 5;
/** What a broker install adds to the broker's own timeout to make the host's. */
export const HOOK_BROKER_HEADROOM_S = 15;

export interface BrokerSettings {
  via: BrokerVia;
  timeoutS: number;
}

/** `[guard] broker` / `broker_timeout_s` of the project's live surface; null when none is declared (or it is misspelt: no broker, so a deny). */
export function resolveBroker(project: string): BrokerSettings | null {
  try {
    const g = loadConfig(project).policy?.guard;
    if (g?.broker !== "dashboard" && g?.broker !== "terminal") return null;
    const t = g.broker_timeout_s;
    const timeoutS = typeof t === "number" && Number.isFinite(t) && t >= 1 && t <= 3600 ? Math.floor(t) : BROKER_DEFAULT_TIMEOUT_S;
    return { via: g.broker, timeoutS };
  } catch {
    return null;
  }
}

/** The hook timeout `guard install` writes for a host when a broker is declared. */
export const brokerHookTimeoutS = (brokerTimeoutS: number): number => brokerTimeoutS + HOOK_BROKER_HEADROOM_S;

/** Hosts (and events) where an ask cannot reach a person through the host. */
export function hostCannotAsk(from: string, event?: string): boolean {
  if (from === "codex") return true;
  return from === "cursor" && (event === "preToolUse" || event === "beforeReadFile");
}

/** How long to hold: the broker's timeout, never past the host's hook timeout minus the margin. */
export function holdSeconds(timeoutS: number, hookTimeoutS: number): number {
  return Math.max(1, Math.min(timeoutS, hookTimeoutS - HOOK_MARGIN_S));
}

/** The timeout the project's installed hook for `from` carries, or the default when it cannot be read. */
export function installedHookTimeoutS(project: string, from: string): number {
  const file = from === "codex" ? join(project, ".codex", "hooks.json") : from === "cursor" ? join(project, ".cursor", "hooks.json") : null;
  if (!file || !existsSync(file)) return HOOK_TIMEOUT_DEFAULT_S;
  try {
    const hooks = (JSON.parse(readFileSync(file, "utf-8")) as { hooks?: Record<string, unknown[]> }).hooks ?? {};
    const seen: number[] = [];
    for (const list of Object.values(hooks)) {
      for (const e of Array.isArray(list) ? list : []) {
        const slots = [e, ...(Array.isArray((e as { hooks?: unknown[] }).hooks) ? (e as { hooks: unknown[] }).hooks : [])] as Array<{ command?: unknown; timeout?: unknown }>;
        for (const s of slots) {
          if (typeof s?.command === "string" && /guard --from (codex|cursor)\b/.test(s.command) && typeof s.timeout === "number") seen.push(s.timeout);
        }
      }
    }
    // The shortest guard hook is the one that binds.
    return seen.length ? Math.min(...seen) : HOOK_TIMEOUT_DEFAULT_S;
  } catch {
    return HOOK_TIMEOUT_DEFAULT_S;
  }
}

export interface BrokerQuestion {
  host: string;
  tool: string;
  target: string;
  reason: string;
  project: string;
}

type Answer = "approved" | "denied" | "timeout" | "unreachable";

export interface BrokerTransports {
  /** Ask the running dashboard; resolves with how it ended. `why` explains an unreachable. */
  dashboard(q: BrokerQuestion, holdS: number): Promise<{ answer: Answer; why?: string }>;
  terminal(q: BrokerQuestion, holdS: number): Promise<{ answer: Answer; why?: string }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The real dashboard transport: the advert file, then POST and poll over loopback. */
export function dashboardTransport(opts: { advertFile?: string; pollMs?: number; fetchImpl?: typeof fetch } = {}): BrokerTransports["dashboard"] {
  const f = opts.fetchImpl ?? fetch;
  return async (q, holdS) => {
    let advert: BrokerAdvert;
    try {
      advert = JSON.parse(readFileSync(opts.advertFile ?? brokerFile(), "utf-8")) as BrokerAdvert;
      if (!Number.isInteger(advert.port) || typeof advert.secret !== "string") throw new Error("malformed");
    } catch {
      return { answer: "unreachable", why: "no `gnomon dashboard` is running for this user (start one, or use broker = \"terminal\")" };
    }
    const base = `http://127.0.0.1:${advert.port}`;
    const headers = { Authorization: `Bearer ${advert.secret}`, "Content-Type": "application/json", Host: `127.0.0.1:${advert.port}` };
    const deadline = Date.now() + holdS * 1000;
    let id = "";
    try {
      const r = await f(`${base}/api/broker/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...q, hold_s: holdS }),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(5000, deadline - Date.now()))),
      });
      if (!r.ok) return { answer: "unreachable", why: `the dashboard refused the request (HTTP ${r.status})` };
      id = ((await r.json()) as { request?: { id?: string } }).request?.id ?? "";
      if (!id) return { answer: "unreachable", why: "the dashboard's answer named no request" };
    } catch (e) {
      return { answer: "unreachable", why: `the dashboard did not answer (${e instanceof Error ? e.message : String(e)})` };
    }
    while (Date.now() < deadline) {
      await sleep(Math.min(opts.pollMs ?? 400, Math.max(0, deadline - Date.now())));
      try {
        const r = await f(`${base}/api/broker/request/${id}`, { headers, signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const st = ((await r.json()) as { request?: { state?: string } }).request?.state;
          if (st === "approved") return { answer: "approved" };
          if (st === "denied") return { answer: "denied" };
          if (st === "timeout" || st === "cancelled") return { answer: "timeout" };
        }
      } catch {
        // one missed poll is not an answer; the deadline decides
      }
    }
    try {
      await f(`${base}/api/broker/request/${id}/cancel`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(2000) });
    } catch {
      // the card expires on its own
    }
    return { answer: "timeout" };
  };
}

export interface TtyPair {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  close(): void;
}

/** /dev/tty, opened for the hook (its own stdin carries the host's payload). */
export function openDevTty(): TtyPair | null {
  if (process.platform === "win32") return null;
  try {
    const rfd = openSync("/dev/tty", "r");
    const wfd = openSync("/dev/tty", "w");
    const input = new TtyReadStream(rfd);
    const output = new TtyWriteStream(wfd);
    return { input, output, close: () => (input.destroy(), output.destroy()) };
  } catch {
    return null;
  }
}

/** The real terminal transport; `open` is injectable for tests. */
export function terminalTransport(open: () => TtyPair | null = openDevTty): BrokerTransports["terminal"] {
  return async (q, holdS) => {
    const tty = open();
    if (!tty) return { answer: "unreachable", why: "this hook has no terminal to ask on (/dev/tty is not available)" };
    return new Promise((resolve) => {
      let buf = "";
      let done = false;
      const finish = (answer: Answer, why?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          tty.close();
        } catch {
          // already closed
        }
        resolve(why ? { answer, why } : { answer });
      };
      const timer = setTimeout(() => finish("timeout"), holdS * 1000);
      tty.input.on("data", (d: Buffer | string) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl).trim().toLowerCase();
        finish(line === "y" || line === "yes" ? "approved" : "denied");
      });
      tty.input.on("error", () => finish("unreachable", "the terminal could not be read"));
      tty.input.on("end", () => finish("unreachable", "the terminal closed before an answer"));
      tty.output.write(
        `\ngnomon: ${q.host} wants to run ${q.tool}${q.target ? `: ${q.target.slice(0, 300)}` : ""}\n` +
          `gnomon: ${q.reason}\n` +
          `Allow this one call? [y/N] (denied after ${holdS}s) `
      );
    });
  };
}

export interface BrokerRun {
  decision: "allow" | "deny";
  reason: string;
  broker: GuardBrokerOutcome;
}

/**
 * Put one ask to a person. The reason names what gnomon asked, then what
 * happened; an allow is only ever "approved".
 */
export async function askPerson(
  settings: BrokerSettings,
  holdS: number,
  q: BrokerQuestion,
  verdict: Pick<GuardVerdict, "reason">,
  transports: BrokerTransports
): Promise<BrokerRun> {
  const started = Date.now();
  let res: { answer: Answer; why?: string };
  try {
    res = await transports[settings.via](q, holdS);
  } catch (e) {
    res = { answer: "unreachable", why: e instanceof Error ? e.message : String(e) };
  }
  const waited_s = Math.round((Date.now() - started) / 1000);
  const broker: GuardBrokerOutcome = { via: settings.via, outcome: res.answer, waited_s };
  const asked = `What a person was asked: ${verdict.reason}`;
  switch (res.answer) {
    case "approved":
      return { decision: "allow", reason: `approved by a person (${settings.via}). ${asked}`, broker };
    case "denied":
      return { decision: "deny", reason: `denied by a person (${settings.via}). ${asked}`, broker };
    case "timeout":
      return { decision: "deny", reason: `no one answered within ${holdS}s (${settings.via}), so the call is refused. ${asked}`, broker };
    default:
      return { decision: "deny", reason: `the approval broker could not reach a person: ${res.why ?? "unreachable"}. The call is refused. ${asked}`, broker };
  }
}
