/**
 * gnomon-cli: the `gnomon dashboard` HTTP server.
 *
 * `node:http` on 127.0.0.1 and nothing else: no framework, no dependency, no
 * remote asset. It serves a fixed set of files from `../dashboard/` and a
 * read-only JSON API over dashboard_data.ts. Design:
 * docs/design/SETUP-AND-COMMAND-CENTER.md, Part II (#105); contract:
 * CONTRACTS.md §17, fixture conformance/dashboard.json.
 *
 * Security, in the order a request meets it:
 *   1. `Host` must name this server on loopback (DNS rebinding).
 *   2. `Origin`, when sent, must be this server's own.
 *   3. API and /auth: `Sec-Fetch-Site`, when sent, must be same-origin or none.
 *      `localhost:3000` is same-SITE as this server, so same-site is refused too.
 *   4. API: `Authorization: Bearer <token>`. The token comes from a one-use
 *      bootstrap the terminal prints in the URL fragment, which no browser
 *      sends to any server; the page POSTs it once to /auth.
 * No cookies, so nothing ambient for a cross-site request to ride on; no CORS
 * header on any response and no preflight answered, so a cross-site page can
 * neither set the Authorization header nor read a response.
 *
 * Everything the browser can ask to RUN is in DASHBOARD_ACTIONS, by name. The
 * browser never sends an argv, a path or a shell string: a project is named by
 * its id, a trail by a name that must be on disk.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessBuild } from "gnomon-core";
import {
  contractsView,
  governanceView,
  measurementsView,
  projectOverview,
  sessionsView,
  setupView,
  surfaceView,
  trailDetail,
  verifyProject,
  type DashboardProject,
} from "./dashboard_data.js";

/** Response schema of every /api answer. The page's own, not a published record (CONTRACTS §17). */
export const DASHBOARD_SCHEMA = "gnomon.dashboard/1";

/**
 * Every button that would run something, as data. `enabled` actions run now;
 * `planned` ones are shown, disabled, with the command they will map to.
 * `argv` is what the "Runs as" bar shows and what a spawned action runs:
 * `<…>` slots are filled by the server from typed parameters, never by text
 * from the browser. Published in CONTRACTS §17 and conformance/dashboard.json.
 */
export const DASHBOARD_ACTIONS = [
  // Read-only. Computed in-process by verifyTrail, the function `gnomon audit
  // verify` calls, because that command prints text and the page needs fields.
  { name: "audit.verify", argv: ["audit", "verify"], state: "enabled" },
  // Read-only by design (#105 Part I, step 2). Spawned, so it exists exactly
  // when the CLI it belongs to has it; on a build without it the page says so.
  { name: "doctor.scan", argv: ["doctor", "--json"], state: "enabled" },
  { name: "check.run", argv: ["check", "--base", "<rev>", "--json"], state: "planned" },
  { name: "trust.grant", argv: ["trust", "grant"], state: "planned" },
  { name: "trust.revoke", argv: ["trust", "revoke"], state: "planned" },
  { name: "init", argv: ["init"], state: "planned" },
  { name: "guard.install", argv: ["guard", "install", "<harness>"], state: "planned" },
  { name: "setup.pull", argv: ["setup", "--pull", "<tag>", "--yes", "--json"], state: "planned" },
  { name: "setup.speed_check", argv: ["setup", "--speed-check", "--json"], state: "planned" },
] as const;

export const ACTION_STATES = ["enabled", "planned"] as const;

/** The routes, as data: what the tests and CONTRACTS §17 hold the server to. */
export const DASHBOARD_ROUTES = {
  static: ["/", "/app.js", "/app.css", "/icon.svg", "/fonts/cinzel-wordmark.woff2", "/fonts/OFL.txt"],
  unauthenticated: ["POST /auth"],
  api: [
    "GET /api/meta",
    "GET /api/projects",
    "GET /api/setup",
    "GET /api/p/<id>/surface",
    "GET /api/p/<id>/sessions",
    "GET /api/p/<id>/trail?name=<trail>",
    "GET /api/p/<id>/governance",
    "GET /api/p/<id>/measurements",
    "GET /api/p/<id>/contracts",
    "POST /api/actions/<name>",
  ],
} as const;

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/fonts/cinzel-wordmark.woff2": { file: "fonts/cinzel-wordmark.woff2", type: "font/woff2" },
  "/fonts/OFL.txt": { file: "fonts/OFL.txt", type: "text/plain; charset=utf-8" },
};

/**
 * No inline script or style anywhere: the page builds its DOM with
 * textContent and sets styles through the CSSOM, which CSP does not gate.
 */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export function defaultAssetsDir(): string {
  return fileURLToPath(new URL("../dashboard/", import.meta.url));
}

export interface DashboardOptions {
  projects: DashboardProject[];
  /** 0 (the default) asks the OS for a free port. */
  port?: number;
  assetsDir?: string;
  /** The script that runs the CLI, for spawned actions: process.execPath + this. */
  cliEntry?: string;
  trustPath?: string;
  /** The gnomon source checkout, for Contracts; undefined = find it, null = none. */
  sourceRoot?: string | null;
  /** How long an unused bootstrap stays valid. */
  bootstrapTtlMs?: number;
}

export interface DashboardServer {
  server: Server;
  port: number;
  /** A fresh one-use sign-in link. */
  signInUrl(): string;
  close(): Promise<void>;
}

const b64 = (n: number): string => randomBytes(n).toString("base64url");

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The gnomon commands this CLI dispatches, read from its own --help. */
function listedCommands(help: string): Set<string> {
  const body = help.slice(help.indexOf("Commands:"));
  return new Set([...body.matchAll(/\n {2}([a-z][a-z-]*)[ [\n]/g)].map((m) => m[1]!));
}

interface SpawnResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCli(entry: string, argv: string[], cwd: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((done) => {
    // process.execPath plus the CLI's own entry script, never a shell and never
    // a .cmd shim: Node will not spawn one on Windows without a shell.
    const child = spawn(process.execPath, [entry, ...argv], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", GNOMON_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, more: Buffer) => (s.length < 1 << 20 ? s + more.toString("utf-8") : s);
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ exit: null, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exit: code, stdout, stderr, timedOut });
    });
  });
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardServer> {
  const assetsDir = opts.assetsDir ?? defaultAssetsDir();
  // Read once, at start: a request never touches the package directory.
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, { file, type }] of Object.entries(STATIC)) {
    const path = join(assetsDir, file);
    if (!existsSync(path)) throw new Error(`dashboard asset missing: ${path}`);
    assets.set(route, { body: readFileSync(path), type });
  }
  const projects = opts.projects;
  const ttl = opts.bootstrapTtlMs ?? 5 * 60_000;
  const bootstraps = new Map<string, number>();
  const tokens: string[] = [];
  let port = 0;
  let commands: Promise<Set<string>> | null = null;

  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const allowedOrigins = (): string[] => allowedHosts().map((h) => `http://${h}`);

  const send = (res: ServerResponse, status: number, body: Buffer | string, type: string): void => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown): void =>
    send(res, status, JSON.stringify({ schema: DASHBOARD_SCHEMA, ...(value as object) }), "application/json; charset=utf-8");
  const fail = (res: ServerResponse, status: number, error: string): void => json(res, status, { error });

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((done, reject) => {
      let size = 0;
      const parts: Buffer[] = [];
      req.on("data", (d: Buffer) => {
        size += d.length;
        if (size > 8192) {
          reject(new Error("body too large"));
          req.destroy();
        } else parts.push(d);
      });
      req.on("end", () => {
        try {
          done(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf-8")) : {});
        } catch {
          reject(new Error("body is not JSON"));
        }
      });
      req.on("error", reject);
    });

  const authorized = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h);
    return Boolean(m && tokens.some((t) => sameSecret(t, m[1]!)));
  };

  const projectById = (id: string): DashboardProject | undefined => projects.find((p) => p.id === id);

  const cliCommands = (): Promise<Set<string>> => {
    if (!commands) {
      commands = opts.cliEntry
        ? runCli(opts.cliEntry, ["--help"], process.cwd(), 20_000).then((r) => listedCommands(r.stdout))
        : Promise.resolve(new Set<string>());
    }
    return commands;
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/meta") {
      return json(res, 200, {
        harness: harnessBuild(),
        read_only: true,
        projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root, source: p.source, hasSurface: p.hasSurface })),
        actions: DASHBOARD_ACTIONS,
      });
    }
    if (req.method === "GET" && path === "/api/projects") {
      return json(res, 200, { projects: projects.map((p) => projectOverview(p, { trustPath: opts.trustPath })) });
    }
    if (req.method === "GET" && path === "/api/setup") {
      const have = await cliCommands();
      const p = projectById(url.searchParams.get("project") ?? "") ?? projects.find((x) => x.hasSurface);
      return json(res, 200, {
        commands: { doctor: have.has("doctor"), setup: have.has("setup"), proposal: have.has("proposal") },
        declared: setupView(p),
        project: p?.id ?? null,
      });
    }
    const m = /^\/api\/p\/([0-9a-f]{12})\/(surface|sessions|trail|governance|measurements|contracts)$/.exec(path);
    if (req.method === "GET" && m) {
      const p = projectById(m[1]!);
      if (!p) return fail(res, 404, "no such project");
      if (!p.hasSurface && m[2] !== "contracts") return fail(res, 404, "this project has no .gnomon/");
      const t = { trustPath: opts.trustPath };
      switch (m[2]) {
        case "surface":
          return json(res, 200, surfaceView(p, t));
        case "sessions":
          return json(res, 200, sessionsView(p));
        case "trail": {
          const d = trailDetail(p, url.searchParams.get("name") ?? "");
          return d ? json(res, 200, d) : fail(res, 404, "no such trail");
        }
        case "governance":
          return json(res, 200, governanceView(p, t));
        case "measurements":
          return json(res, 200, measurementsView(p));
        case "contracts":
          return json(res, 200, contractsView(p, { sourceRoot: opts.sourceRoot }));
      }
    }
    const a = /^\/api\/actions\/([a-z_.]+)$/.exec(path);
    if (req.method === "POST" && a) {
      const action = DASHBOARD_ACTIONS.find((x) => x.name === a[1]);
      // Unknown: 404, and nothing runs.
      if (!action) return fail(res, 404, "no such action");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return fail(res, 415, "send JSON");
      let body: { project?: unknown; trail?: unknown };
      try {
        body = (await readBody(req)) as typeof body;
      } catch (err) {
        return fail(res, 400, err instanceof Error ? err.message : "bad body");
      }
      if (action.state !== "enabled") return fail(res, 409, `${action.name} is planned, not in this build`);
      const p = projectById(typeof body.project === "string" ? body.project : "");
      if (!p || !p.hasSurface) return fail(res, 404, "no such project");
      if (action.name === "audit.verify") {
        const trail = typeof body.trail === "string" && body.trail ? body.trail : undefined;
        const r = verifyProject(p, trail);
        if (trail && (r.trails as unknown[]).length === 0) return fail(res, 404, "no such trail");
        return json(res, 200, { action: action.name, ...r });
      }
      if (action.name === "doctor.scan") {
        const have = await cliCommands();
        if (!have.has("doctor") || !opts.cliEntry) {
          return json(res, 200, { action: action.name, available: false, command: "gnomon doctor --json" });
        }
        const r = await runCli(opts.cliEntry, [...action.argv], p.root, 60_000);
        let doc: unknown = null;
        try {
          doc = JSON.parse(r.stdout);
        } catch {
          doc = null;
        }
        return json(res, 200, {
          action: action.name,
          available: true,
          command: "gnomon doctor --json",
          exit: r.exit,
          timed_out: r.timedOut,
          doctor: doc,
          stderr: r.stderr.slice(-2000),
        });
      }
    }
    return fail(res, 404, "not found");
  }

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? "";
      if (!allowedHosts().includes(host)) return fail(res, 403, "Host is not this dashboard");
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().includes(origin)) return fail(res, 403, "cross-origin");
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://${host}`);
      } catch {
        return fail(res, 400, "bad URL");
      }
      const isApi = url.pathname.startsWith("/api/") || url.pathname === "/auth";
      if (isApi) {
        const site = req.headers["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin" && site !== "none") return fail(res, 403, "cross-site");
      }
      // No preflight is ever answered, so no cross-origin request can carry
      // the Authorization header.
      if (req.method === "OPTIONS") return fail(res, 405, "no preflight");

      if (url.pathname === "/auth") {
        if (req.method !== "POST") return fail(res, 405, "POST");
        let body: { bootstrap?: unknown };
        try {
          body = (await readBody(req)) as typeof body;
        } catch {
          return fail(res, 400, "bad body");
        }
        const given = typeof body.bootstrap === "string" ? body.bootstrap : "";
        const now = Date.now();
        let ok = false;
        for (const [b, expires] of bootstraps) {
          if (expires < now) bootstraps.delete(b);
          else if (sameSecret(b, given)) {
            bootstraps.delete(b); // one use
            ok = true;
          }
        }
        if (!ok) return fail(res, 401, "this sign-in link was used or has expired; press Enter in the terminal for a new one");
        const token = b64(32);
        tokens.push(token);
        return json(res, 200, { token });
      }

      if (isApi) {
        if (!authorized(req)) return fail(res, 401, "sign in with the link the terminal printed");
        try {
          return await api(req, res, url);
        } catch (err) {
          return fail(res, 500, err instanceof Error ? err.message : String(err));
        }
      }

      const asset = req.method === "GET" || req.method === "HEAD" ? assets.get(url.pathname) : undefined;
      if (!asset) return fail(res, 404, "not found");
      return send(res, 200, asset.body, asset.type);
    })().catch((err) => {
      if (!res.headersSent) fail(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    // Loopback only. There is no flag that widens this in this build.
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", bad);
      ok();
    });
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    port,
    signInUrl(): string {
      const b = b64(24);
      bootstraps.set(b, Date.now() + ttl);
      return `http://127.0.0.1:${port}/#k=${b}`;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
