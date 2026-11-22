/**
 * The window lookup is off the request's critical path: started in the
 * background, bounded by one deadline, and remembered across processes.
 * UX4 (2026-11-22) measured the first request held for the listing (+276 ms at
 * 200 ms, +10 s for an endpoint that never answers) on every new process.
 * Every server here is a fake on 127.0.0.1.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WINDOW_CACHE_NEGATIVE_TTL_MS,
  WINDOW_CACHE_TTL_MS,
  WINDOW_LOOKUP_DEADLINE_MS,
  forgetContextWindows,
  resolveContextWindow,
  startWindowLookup,
  windowCachePath,
} from "./context_window.js";
import { settleContextWindows, type WindowHooks } from "./prompt_loop.js";
import { loadConfig, resolveUi, routeRole, type GnomonConfig } from "./config.js";

let servers: Server[] = [];
const roots: string[] = [];
beforeEach(() => {
  delete process.env.GNOMON_WINDOW_LOOKUP;
  forgetContextWindows();
});
afterEach(async () => {
  process.env.GNOMON_WINDOW_LOOKUP = "off";
  forgetContextWindows();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** An endpoint whose /models answers after `delay` ms (never: delay < 0) with `window` tokens (none: undefined). */
async function fake(o: { delay?: number; window?: number }) {
  const hits: Array<{ path: string; at: number }> = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/\?.*$/, "");
    hits.push({ path, at: Date.now() });
    req.resume();
    if (path.endsWith("/models")) {
      if ((o.delay ?? 0) < 0) return; // never answers
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1", ...(o.window ? { limit: { context: o.window } } : {}) }] }));
      }, o.delay ?? 0);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${base}/v1/chat/completions`, hits, count: (p: string) => hits.filter((h) => h.path.endsWith(p)).length };
}

/** A surface that declares no window on its endpoint, the init default. */
function surface(url: string): GnomonConfig {
  const root = mkdtempSync(join(tmpdir(), "gnomon-winlookup-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(join(root, ".gnomon", "config.toml"), `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`);
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 3\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  return loadConfig(root);
}

function hooks(config: GnomonConfig, estimate?: () => number) {
  const said: string[] = [];
  const warned: string[] = [];
  const h: WindowHooks = {
    ui: { ...resolveUi(config), color: false },
    say: (l) => said.push(l),
    warn: (l) => warned.push(l),
    ...(estimate ? { estimate } : {}),
  };
  return { h, said, warned };
}

const settle = (c: GnomonConfig, h: WindowHooks) => settleContextWindows(c, routeRole(c, "smol"), h);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a lookup that is slow does not delay a request that does not need it", () => {
  it("a small first request is sent on the default at once; the listing's window is used once it lands", async () => {
    const f = await fake({ delay: 1000, window: 262_144 });
    const config = surface(f.url);
    const { h, said } = hooks(config, () => 500);
    const t0 = Date.now();
    const early = await settle(config, h);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(early.target).toMatchObject({ contextTokens: 65_536, contextSource: "default" });
    await sleep(1300);
    const later = await settle(config, h);
    expect(later.target).toMatchObject({ contextTokens: 262_144, contextSource: "listing:opencode" });
    expect(said.join("")).toContain("window 262144 tokens");
    expect(f.count("/models")).toBe(1);
  });

  it("a request large enough for the window to matter waits for the lookup, and gets its answer", async () => {
    const f = await fake({ delay: 300, window: 200_000 });
    const config = surface(f.url);
    const { h } = hooks(config, () => 60_000);
    const t0 = Date.now();
    const r = await settle(config, h);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.target).toMatchObject({ contextTokens: 200_000, contextSource: "listing:opencode" });
  });

  it("is the same value as before when the listing is fast", async () => {
    const f = await fake({ delay: 0, window: 131_072 });
    const config = surface(f.url);
    const r = await settle(config, hooks(config).h); // no estimate: awaited, as before
    expect(r.target).toMatchObject({ contextTokens: 131_072, contextSource: "listing:opencode" });
  });
});

describe("a dead endpoint costs one bounded wait", () => {
  it("waits at most the deadline for a large request, then ~0 in the next process, and asks again after a day", async () => {
    const f = await fake({ delay: -1 });
    const config = surface(f.url);
    const t0 = Date.now();
    const r1 = await settle(config, hooks(config, () => 60_000).h);
    const first = Date.now() - t0;
    expect(first).toBeGreaterThanOrEqual(WINDOW_LOOKUP_DEADLINE_MS - 100);
    expect(first).toBeLessThan(WINDOW_LOOKUP_DEADLINE_MS + 700);
    expect(r1.target).toMatchObject({ contextTokens: 65_536, contextSource: "default" });
    expect(existsSync(windowCachePath())).toBe(true);

    forgetContextWindows({ keepFile: true }); // a new process
    const t1 = Date.now();
    const r2 = await settle(config, hooks(config, () => 60_000).h);
    expect(Date.now() - t1).toBeLessThan(100);
    expect(r2.target).toMatchObject({ contextSource: "default" });
    expect(f.count("/models")).toBe(1);

    forgetContextWindows({ keepFile: true });
    const realNow = Date.now;
    Date.now = () => realNow() + WINDOW_CACHE_NEGATIVE_TTL_MS + 60_000;
    try {
      startWindowLookup({ url: f.url, model: "m1" });
      await sleep(250);
      expect(f.count("/models")).toBe(2); // asked again, in the background
    } finally {
      Date.now = realNow;
    }
  }, 15_000);
});

describe("the persistent cache", () => {
  const target = (url: string) => ({ url, model: "m1" });

  it("keeps a listing's window across processes under the same source label, 0600, and expires it after a week", async () => {
    const f = await fake({ delay: 0, window: 262_144 });
    const a = await resolveContextWindow(target(f.url));
    expect(a.resolution).toMatchObject({ tokens: 262_144, source: "listing:opencode" });
    expect(a.resolution?.cached).toBeUndefined();
    // POSIX permission bits only: Windows reports 0o666 for any writable file.
    if (process.platform !== "win32") expect(statSync(windowCachePath()).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(windowCachePath(), "utf8"));
    expect(Object.values(body.entries)[0]).toMatchObject({ tokens: 262_144, source: "listing:opencode" });

    forgetContextWindows({ keepFile: true });
    const b = await resolveContextWindow(target(f.url));
    expect(b.resolution).toMatchObject({ tokens: 262_144, source: "listing:opencode", cached: true });
    expect(f.count("/models")).toBe(1);

    forgetContextWindows({ keepFile: true });
    const realNow = Date.now;
    Date.now = () => realNow() + WINDOW_CACHE_TTL_MS + 60_000;
    try {
      const c = await resolveContextWindow(target(f.url));
      expect(c.resolution?.cached).toBeUndefined();
      expect(f.count("/models")).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("a corrupt or unreadable file is ignored, never fatal", async () => {
    const f = await fake({ delay: 0, window: 99_000 });
    for (const junk of ["{not json", "[]", '{"entries":{"x":1}}', '{"entries":[1,2]}', ""]) {
      forgetContextWindows();
      mkdirSync(dirname(windowCachePath()), { recursive: true });
      writeFileSync(windowCachePath(), junk);
      const r = await resolveContextWindow(target(f.url));
      expect(r.resolution).toMatchObject({ tokens: 99_000, source: "listing:opencode" });
    }
    // a directory where the file should be: unreadable and unwritable
    forgetContextWindows();
    rmSync(windowCachePath(), { force: true });
    mkdirSync(windowCachePath(), { recursive: true });
    const r = await resolveContextWindow(target(f.url));
    expect(r.resolution?.tokens).toBe(99_000);
    rmSync(windowCachePath(), { recursive: true, force: true });
  });

  it("GNOMON_WINDOW_LOOKUP=off disables the lookup and the cache", async () => {
    const f = await fake({ delay: 0, window: 99_000 });
    process.env.GNOMON_WINDOW_LOOKUP = "off";
    const r = await resolveContextWindow(target(f.url));
    expect(r.resolution?.tokens).toBeUndefined();
    expect(f.hits).toHaveLength(0);
    expect(existsSync(windowCachePath())).toBe(false);
  });

  it("a listing with no window is cached as a negative result for a day; the default stands", async () => {
    const f = await fake({ delay: 0 });
    const a = await resolveContextWindow(target(f.url));
    expect(a.resolution).toMatchObject({ source: "default" });
    forgetContextWindows({ keepFile: true });
    const b = await resolveContextWindow(target(f.url));
    expect(b.resolution).toMatchObject({ source: "default", negative: true });
    expect(f.count("/models")).toBe(1);
  });
});
