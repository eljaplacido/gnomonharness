/**
 * gnomon-cli: the `gnomon dashboard` HTTP server.
 *
 * `node:http` on 127.0.0.1 and nothing else: no framework, no dependency, no
 * remote asset. It serves a fixed set of files from `../dashboard/`, a JSON
 * API of reads over dashboard_data.ts, and the action table of
 * dashboard_actions.ts, each action one gnomon command. Design:
 * docs/design/SETUP-AND-COMMAND-CENTER.md, Part II (#105); contract:
 * CONTRACTS.md §17, fixture conformance/dashboard.json.
 *
 * Security, in the order a request meets it:
 *   1. `Host` must name this server on loopback (DNS rebinding).
 *   2. `Origin`, when sent, must be this server's own; an action's POST must
 *      send it (every browser does on a POST).
 *   3. API and /auth: `Sec-Fetch-Site`, when sent, must be same-origin or none.
 *      `localhost:3000` is same-SITE as this server, so same-site is refused too.
 *   4. API: `Authorization: Bearer <token>`. The token comes from a one-use
 *      bootstrap the terminal prints in the URL fragment, which no browser
 *      sends to any server; the page POSTs it once to /auth.
 *   5. An action that writes, downloads or may spend runs only with a one-use
 *      confirmation the server issued after stating what it will do.
 * No cookies, so nothing ambient for a cross-site request to ride on; no CORS
 * header on any response and no preflight answered, so a cross-site page can
 * neither set the Authorization header nor read a response.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessBuild, loadTrust, trustPath as defaultTrustPath } from "gnomon-core";
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
import {
  DASHBOARD_ACTIONS,
  ACTION_STATES,
  ACTION_CONFIRMS,
  TIMEOUT_MS,
  Confirmations,
  Jobs,
  actionNamed,
  argvFor,
  catalogInfo,
  cloudPresets,
  commandText,
  declaredEndpointNames,
  endpointFacts,
  jsonOf,
  keyStorePath,
  paramsKey,
  pullFacts,
  readParams,
  runCli,
  surfaceHashOf,
  type ActionParams,
  type DashboardAction,
  type Pending,
} from "./dashboard_actions.js";

// `node:http` is loaded when a server is made, not at import: in a bundle every
// static import is hoisted to startup, and on Node 22 `node:http` alone pulls
// in tls, http2, zlib and undici -- ~10 ms on every `gnomon --version` for a
// command most sessions never run (audit 2026-11-06, startup).
const loadHttp = (): typeof import("node:http") => createRequire(import.meta.url)("node:http") as typeof import("node:http");

export { DASHBOARD_ACTIONS, ACTION_STATES, ACTION_CONFIRMS };

/** Response schema of every /api answer. The page's own, not a published record (CONTRACTS §17). */
export const DASHBOARD_SCHEMA = "gnomon.dashboard/1";

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
    "GET /api/jobs/<id>",
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

/** The commands the Setup screen asks this CLI's --help about. */
const SETUP_COMMANDS = ["doctor", "setup", "key", "endpoint", "trust", "check", "launch"] as const;

/** Actions a project without a `.gnomon/` may run: setup is how it gets one. */
const WITHOUT_SURFACE = new Set(["doctor.scan", "setup.plan", "setup.pull", "setup.speed_check", "setup.apply", "key.set"]);

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
  /** How long a confirmation stays valid. */
  confirmTtlMs?: number;
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

const tail = (s: string, n: number): string => (s.length > n ? s.slice(-n) : s);

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
  const confirms = new Confirmations(opts.confirmTtlMs);
  const jobs = new Jobs();
  const children = new Set<ChildProcess>();
  /** Projects with a spawned action running: one at a time each. */
  const busy = new Set<string>();
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
  const fail = (res: ServerResponse, status: number, error: string, more: object = {}): void => json(res, status, { error, ...more });

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
          // Never echo the body: it may hold a key.
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

  /** `.gnomon/` can appear while the server runs: setup writes one. */
  const refresh = (p: DashboardProject): DashboardProject => {
    p.hasSurface = existsSync(join(p.root, ".gnomon"));
    return p;
  };
  const projectById = (id: string): DashboardProject | undefined => {
    const p = projects.find((x) => x.id === id);
    return p ? refresh(p) : undefined;
  };

  const cliCommands = (): Promise<Set<string>> => {
    if (!commands) {
      commands = opts.cliEntry
        ? runCli(opts.cliEntry, ["--help"], process.cwd(), 20_000).then((r) => listedCommands(r.stdout))
        : Promise.resolve(new Set<string>());
    }
    return commands;
  };

  const trustFile = (): string => opts.trustPath ?? defaultTrustPath();

  /** Run one action's command and answer with its exit and output, as it printed them. */
  async function execute(
    res: ServerResponse,
    action: DashboardAction,
    p: DashboardProject,
    params: ActionParams,
    pending: Pending | null,
    secret?: string
  ): Promise<void> {
    const argv = argvFor(action, p, params, pending?.digest);
    const command = commandText(argv);
    const entry = opts.cliEntry!;

    if (action.name === "setup.pull") {
      // A download outlives a request: answered at once with a job the page
      // polls, its progress the lines setup prints to stderr.
      const job = jobs.start(action.name, p.id, command, (progress) =>
        runCli(entry, argv, p.root, TIMEOUT_MS[action.name], { onStderr: progress, track: children })
      );
      return json(res, 202, { action: action.name, command, job });
    }

    busy.add(p.id);
    let r;
    try {
      r = await runCli(entry, argv, p.root, TIMEOUT_MS[action.name], {
        ...(secret !== undefined ? { stdin: secret } : {}),
        track: children,
      });
    } finally {
      busy.delete(p.id);
    }
    refresh(p);
    const doc = jsonOf(r.stdout);
    const out: Record<string, unknown> = {
      action: action.name,
      command,
      exit: r.exit,
      timed_out: r.timedOut,
      ...(doc ? { json: doc } : { output: tail(r.stdout, 8000) }),
      stderr: tail(r.stderr, 4000),
    };
    // The Setup screen reads doctor's report as `doctor`.
    if (action.name === "doctor.scan") Object.assign(out, { available: true, doctor: doc });
    if (action.name === "trust.grant" && pending?.surfaceHash) {
      // Read back what the command recorded: the surface that was confirmed,
      // and no other, is now trusted here.
      out.trusted = loadTrust(trustFile()).entries.some((e) => e.root === p.root && e.surface_hash === pending.surfaceHash);
    }
    return json(res, 200, out);
  }

  /** The first request of a confirmed action: run nothing, say what it will do. */
  async function prepare(res: ServerResponse, action: DashboardAction, p: DashboardProject, params: ActionParams): Promise<void> {
    const key = paramsKey(action.name, p.id, params);
    const ask = (details: Record<string, unknown>, effect: string[], bind: { surfaceHash?: string; digest?: string } = {}) => {
      const issued = confirms.issue({ action: action.name, key, ...bind });
      return json(res, 428, {
        action: action.name,
        confirm: { ...issued, command: commandText(argvFor(action, p, params, bind.digest ?? "<digest>")), effect },
        ...details,
      });
    };
    switch (action.name) {
      case "setup.pull": {
        const f = pullFacts(params.tag!);
        const size = f.download_gb !== null ? `~${f.download_gb} GB` : "a size the catalog does not know";
        return ask({ tag: params.tag, ...f }, [
          `Downloads ${params.tag} through Ollama on this machine: ${size}.`,
          f.disk_free.bytes !== null
            ? `Free disk where Ollama keeps models (${f.disk_free.path}): ${Math.floor(f.disk_free.bytes / 1e9)} GB.`
            : "Free disk where Ollama keeps models: gnomon could not tell.",
          "Nothing in .gnomon/ is written: the change is shown to you afterwards, and written only when you accept it.",
        ]);
      }
      case "key.set":
        return ask({ variable: params.variable, key_store: keyStorePath() }, [
          `Stores the key you paste as ${params.variable} in ${keyStorePath()} (mode 0600), by \`gnomon key set\` reading it on stdin.`,
          "The key is not put on a command line, in .gnomon/, in a log or anywhere in this dashboard. The surface holds only the name.",
        ]);
      case "setup.apply": {
        // The confirmation IS the diff: setup without --yes says what it
        // would write, and its digest is what the Accept will insist on.
        busy.add(p.id);
        let r;
        try {
          r = await runCli(opts.cliEntry!, argvFor(actionNamed("setup.plan")!, p, params), p.root, TIMEOUT_MS["setup.plan"], { track: children });
        } finally {
          busy.delete(p.id);
        }
        const report = jsonOf(r.stdout);
        const proposal = report?.proposal as { digest?: unknown } | null | undefined;
        if (!report || typeof proposal?.digest !== "string") {
          const why = typeof report?.why === "string" ? report.why : typeof report?.error === "string" ? report.error : "setup proposed no change";
          return fail(res, 422, why, { action: action.name, exit: r.exit, report, stderr: tail(r.stderr, 4000) });
        }
        return ask(
          { report },
          [
            "Writes the change below to .gnomon/ (the surface hash moves), this machine's facts to .gnomon-setup.json, and that file's name to .gitignore if it is not there.",
            "If .gnomon/ or this machine changed since this was planned, setup writes nothing and says so (exit 3).",
            "Trust is not granted: a surface that now grants more than the defaults is shown for trust at the next launch.",
          ],
          { digest: proposal.digest }
        );
      }
      case "trust.grant":
      case "trust.revoke": {
        const hash = surfaceHashOf(p);
        if (!hash) return fail(res, 409, "this .gnomon/ does not load, so there is no surface to trust");
        const trust = (surfaceView(p, { trustPath: opts.trustPath }) as { trust: Record<string, unknown> }).trust;
        const grants = (trust.grants as unknown[]) ?? [];
        const effect =
          action.name === "trust.grant"
            ? grants.length
              ? [
                  `Trusts ${p.root} at surface ${hash.slice(0, 12)} on this machine: the ${grants.length} grant${grants.length === 1 ? "" : "s"} below, beyond gnomon's defaults.`,
                  `Recorded in ${trustFile()} and, when [audit] is on, as a \`trust\` record. Never in the repository. A later change to .gnomon/ is a new surface and asks again.`,
                ]
              : [`This surface (${hash.slice(0, 12)}) grants nothing beyond gnomon's defaults: there is nothing to trust, and the command will say so.`]
            : [
                `Removes every surface trusted for ${p.root} from ${trustFile()}; the next launch asks again.`,
                "Recorded as a `trust` record when [audit] is on.",
              ];
        return ask({ surface_hash: hash, trust }, effect, { surfaceHash: hash });
      }
      case "endpoint.test": {
        const f = endpointFacts(p, params.endpoint!);
        return ask({ endpoint: params.endpoint, ...f }, [
          `Sends one completion of one token to ${params.endpoint} (${f.url})${f.model ? ` with model ${f.model}` : ""}.`,
          f.local ? "It runs on this machine: nothing is billed." : "It is a cloud endpoint: the token is billed, a fraction of a cent.",
        ]);
      }
      default:
        return fail(res, 409, `${action.name} has no confirmation in this build`);
    }
  }

  async function act(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const action = actionNamed(name);
    // Unknown: 404, and nothing runs.
    if (!action) return fail(res, 404, "no such action");
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return fail(res, 415, "send JSON");
    // A browser sends Origin on every POST; its absence means a client that is
    // not this page. (A foreign Origin was refused before routing.)
    if (req.headers.origin === undefined) return fail(res, 403, "an action must come from this page (no Origin)");
    let body: Record<string, unknown>;
    try {
      const b = await readBody(req);
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("body is not a JSON object");
      body = b as Record<string, unknown>;
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : "bad body");
    }
    if (action.state !== "enabled") return fail(res, 409, `${action.name} is planned, not in this build`);
    const p = projectById(typeof body.project === "string" ? body.project : "");
    if (!p || !p.exists) return fail(res, 404, "no such project");
    if (!p.hasSurface && !WITHOUT_SURFACE.has(action.name)) return fail(res, 404, "this project has no .gnomon/");
    const read = readParams(action.name, body, p);
    if ("error" in read) return fail(res, 400, read.error);

    if (action.name === "audit.verify") {
      const trail = read.params.trail;
      const r = verifyProject(p, trail);
      if (trail && (r.trails as unknown[]).length === 0) return fail(res, 404, "no such trail");
      return json(res, 200, { action: action.name, ...r });
    }

    // Everything else is the CLI's own command, so it exists exactly when the
    // CLI this dashboard belongs to has it.
    const have = await cliCommands();
    if (!opts.cliEntry || !have.has(action.argv[0])) {
      if (action.name === "doctor.scan") return json(res, 200, { action: action.name, available: false, command: "gnomon doctor --json" });
      return fail(res, 409, `this gnomon build has no \`gnomon ${action.argv[0]}\``);
    }
    if (busy.has(p.id) || jobs.running(p.id)) return fail(res, 409, "another action is running in this project; wait for it to finish");

    if (action.confirm === "required") {
      const nonce = typeof body.confirm === "string" ? body.confirm : "";
      if (!nonce) {
        // The key travels once, with the confirmation, and not before.
        if (read.value !== undefined) return fail(res, 400, "send the key only with the confirmation");
        return prepare(res, action, p, read.params);
      }
      if (action.name === "key.set" && read.value === undefined) return fail(res, 400, 'key.set needs the key as "value"');
      const pending = confirms.take(nonce, action.name, paramsKey(action.name, p.id, read.params));
      if (!pending) return fail(res, 409, "this confirmation is not for this action, or it was used or has expired: review it again");
      if (pending.surfaceHash !== undefined && surfaceHashOf(p) !== pending.surfaceHash) {
        return fail(res, 409, "the surface changed since you reviewed it: review it again");
      }
      return execute(res, action, p, read.params, pending, read.value);
    }
    return execute(res, action, p, read.params, null);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/meta") {
      projects.forEach(refresh);
      return json(res, 200, {
        harness: harnessBuild(),
        // Which shell the Start step writes its launch command for (`cd <path> && gnomon launch`, or `gnomon launch --dir <path>` on Windows).
        platform: process.platform,
        read_only: false,
        projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root, source: p.source, hasSurface: p.hasSurface })),
        actions: DASHBOARD_ACTIONS,
      });
    }
    if (req.method === "GET" && path === "/api/projects") {
      projects.forEach(refresh);
      return json(res, 200, { projects: projects.map((p) => projectOverview(p, { trustPath: opts.trustPath })) });
    }
    if (req.method === "GET" && path === "/api/setup") {
      const have = await cliCommands();
      projects.forEach(refresh);
      const p = projectById(url.searchParams.get("project") ?? "") ?? projects.find((x) => x.hasSurface) ?? projects[0];
      return json(res, 200, {
        commands: Object.fromEntries(SETUP_COMMANDS.map((c) => [c, have.has(c)])),
        declared: setupView(p),
        project: p?.id ?? null,
        has_surface: p?.hasSurface ?? false,
        endpoints: p ? declaredEndpointNames(p) : [],
        catalog: catalogInfo(),
        cloud_presets: cloudPresets(),
        key_store: keyStorePath(),
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
    const j = /^\/api\/jobs\/([A-Za-z0-9_-]{12})$/.exec(path);
    if (req.method === "GET" && j) {
      const job = jobs.get(j[1]!);
      return job ? json(res, 200, { job }) : fail(res, 404, "no such job");
    }
    const a = /^\/api\/actions\/([a-z_.]+)$/.exec(path);
    if (req.method === "POST" && a) return act(req, res, a[1]!);
    return fail(res, 404, "not found");
  }

  const server = loadHttp().createServer((req, res) => {
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
        const given = typeof body?.bootstrap === "string" ? body.bootstrap : "";
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
        // A download or a check still running is stopped with the server.
        for (const c of children) c.kill();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
