/**
 * The dashboard's half of the approval broker (guard_broker.ts, CONTRACTS.md
 * §10): a queue of calls a guard hook is HOLDING, each waiting for a person.
 *
 * Two kinds of caller, two kinds of secret:
 *   - the hook (a separate process) signs with the broker secret the dashboard
 *     wrote to a 0600 file in the user's gnomon data directory. That secret
 *     opens only `POST /api/broker/request`, `GET /api/broker/request/<id>`
 *     and `POST /api/broker/request/<id>/cancel`: a hook can ask, never decide.
 *   - the page signs with its session token, and DECIDES through the confirm
 *     nonce discipline every dashboard action uses: the first POST answers
 *     what the click will do and a one-use nonce; only the second, carrying
 *     that nonce for the same card and the same decision, decides.
 *
 * An unanswered card expires into "timeout". Nothing here ever approves by
 * itself: no path from a request to "approved" exists but a nonce the page
 * was given.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trustPath } from "gnomon-core";

export type BrokerState = "pending" | "approved" | "denied" | "timeout" | "cancelled";

export interface BrokerRequest {
  id: string;
  /** The host that asked: codex, cursor. */
  host: string;
  tool: string;
  /** The call, as the guard records it (a command or a path), truncated. */
  target: string;
  /** Why gnomon asked. */
  reason: string;
  /** The project the call is made in. */
  project: string;
  created: number;
  expires: number;
  state: BrokerState;
}

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");

/** Where a running dashboard says how to reach its broker (beside the trust store). */
export function brokerFile(): string {
  return join(dirname(trustPath()), "dashboard-broker.json");
}

export interface BrokerAdvert {
  port: number;
  secret: string;
  pid: number;
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class BrokerQueue {
  readonly secret = randomBytes(32).toString("base64url");
  private readonly items = new Map<string, BrokerRequest>();
  private readonly nonces = new Map<string, { id: string; decision: "allow" | "deny"; expires: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly nonceTtlMs = 2 * 60_000,
    private readonly maxPending = 20
  ) {}

  /** A hook asks. Returns null when too many cards are already waiting. */
  create(body: Record<string, unknown>, holdS: number): BrokerRequest | null {
    this.sweep();
    if ([...this.items.values()].filter((r) => r.state === "pending").length >= this.maxPending) return null;
    const created = this.now();
    const r: BrokerRequest = {
      id: randomBytes(9).toString("hex"),
      host: clip(body.host, 40) || "unknown",
      tool: clip(body.tool, 80),
      target: clip(body.target, 2000),
      reason: clip(body.reason, 1000),
      project: clip(body.project, 500),
      created,
      expires: created + Math.max(1, Math.min(holdS, 3600)) * 1000,
      state: "pending",
    };
    this.items.set(r.id, r);
    return r;
  }

  get(id: string): BrokerRequest | undefined {
    this.sweep();
    return this.items.get(id);
  }

  pending(): BrokerRequest[] {
    this.sweep();
    return [...this.items.values()].filter((r) => r.state === "pending");
  }

  cancel(id: string): boolean {
    const r = this.get(id);
    if (!r || r.state !== "pending") return false;
    r.state = "cancelled";
    return true;
  }

  /** The page's first step: what deciding will do, and a nonce for it. */
  prepare(id: string, decision: "allow" | "deny"): { nonce: string; expires_in_s: number; effect: string[] } | null {
    const r = this.get(id);
    if (!r || r.state !== "pending") return null;
    const nonce = randomBytes(18).toString("base64url");
    this.nonces.set(nonce, { id, decision, expires: this.now() + this.nonceTtlMs });
    return {
      nonce,
      expires_in_s: Math.round(this.nonceTtlMs / 1000),
      effect:
        decision === "allow"
          ? [`Lets ${r.host} run ${r.tool}${r.target ? `: ${r.target.slice(0, 200)}` : ""} once.`, "gnomon's guard records that a person approved it."]
          : [`Refuses the ${r.tool} call ${r.host} proposed.`, "gnomon's guard records that a person denied it."],
    };
  }

  /** The page's second step. One use: the nonce is gone whether or not it matched. */
  decide(id: string, decision: "allow" | "deny", nonce: string): boolean {
    this.sweep();
    const n = this.nonces.get(nonce);
    if (!n) return false;
    this.nonces.delete(nonce);
    if (n.id !== id || n.decision !== decision) return false;
    const r = this.items.get(id);
    if (!r || r.state !== "pending") return false;
    r.state = decision === "allow" ? "approved" : "denied";
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [n, v] of this.nonces) if (v.expires < now) this.nonces.delete(n);
    for (const [id, r] of this.items) {
      if (r.state === "pending" && r.expires < now) r.state = "timeout";
      // A finished card stays long enough for the hook's last poll, then goes.
      if (r.state !== "pending" && r.expires + 60_000 < now) this.items.delete(id);
    }
  }
}

/** Tell hooks where this dashboard's broker is. 0600; removed when the dashboard closes. */
export function writeBrokerAdvert(advert: BrokerAdvert, file: string = brokerFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(advert), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch {
    // No advert means the hook finds no broker and denies: the safe direction.
  }
}

export function removeBrokerAdvert(pid: number, file: string = brokerFile()): void {
  try {
    // Only our own advert: a newer dashboard's stays.
    const cur = JSON.parse(readFileSync(file, "utf-8")) as BrokerAdvert;
    if (cur.pid === pid) rmSync(file, { force: true });
  } catch {
    // gone already
  }
}

/** The wire shape of a request, for the hook's poll and the page's list. */
export function view(r: BrokerRequest, now: number = Date.now()): Record<string, unknown> {
  return {
    id: r.id,
    host: r.host,
    tool: r.tool,
    target: r.target,
    reason: r.reason,
    project: r.project,
    state: r.state,
    expires_in_s: Math.max(0, Math.round((r.expires - now) / 1000)),
  };
}
