/**
 * `gnomon update`, `gnomon uninstall` and the once-a-day newer-version notice.
 *
 * WHY THIS EXISTS. Until this file, an installed gnomon had no way to learn it
 * was old and no way to become new: the documented install was four tarball
 * URLs with the version typed into them, so updating meant finding the release
 * page, editing four URLs, and remembering that the native binaries were a
 * separate download again. In practice nobody updated.
 *
 * WHAT IT DECIDES WITH. How gnomon was installed is read from where this file
 * sits on disk, because that is the one fact no environment variable can get
 * wrong: a checkout updates with git, a global npm install updates by
 * re-running the installer, a project-local install updates with the project's
 * own package manager. Each gets told the command that fits it.
 *
 * WHAT IT NEVER DOES. It never touches `.gnomon/`. The cache lives in the
 * machine data dir beside the installed binaries: the surface has to hash the
 * same on every machine, and "when did this machine last look for a release"
 * is about as machine-specific as a fact gets.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { machineDataDir, installedBinDir } from "gnomon-natives";

export const REPO = "eljaplacido/gnomonharness";
export const PACKAGE = "gnomon-harness";
export const INSTALL_SH = `https://raw.githubusercontent.com/${REPO}/master/scripts/install.sh`;
export const INSTALL_PS1 = `https://raw.githubusercontent.com/${REPO}/master/scripts/install.ps1`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The four package names one install is made of. See uninstallSteps(). */
const ALL_PACKAGES = ["gnomon-harness", "gnomon-core", "gnomon-natives", "gnomon-tui"];

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const here = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] ?? process.cwd();
  }
})();

/** This package's own version, read from the package.json it ships in. */
export function currentVersion(from: string = dirname(here)): string {
  for (let d = from, i = 0; i < 6; i++, d = dirname(d)) {
    const p = join(d, "package.json");
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === PACKAGE && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* unreadable: keep walking */
    }
  }
  return "0.0.0";
}

/**
 * Compare two release versions. Negative, zero or positive, like a sort
 * comparator.
 *
 * Hand-rolled because a semver dependency is a third-party package inside the
 * process that decides what an agent may run, and gnomon has none. A
 * prerelease (`0.3.0-rc.1`) sorts below its release, which is the only part of
 * semver precedence a notice needs: nobody should be told to "update" from
 * 0.3.0 to 0.3.0-rc.1.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface Latest {
  version: string;
  /** Whether `npm i -g gnomon-harness@<version>` would resolve. */
  onRegistry: boolean;
}

/**
 * The newest release, from the npm registry and GitHub at once.
 *
 * Both, and the higher of the two, because they are published by separate
 * hands: a tag cuts a GitHub release automatically while `npm publish` is
 * still a person with credentials, so either can lead. Null when neither
 * answered within the timeout — the caller decides whether that matters.
 */
export async function fetchLatest(timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Latest | null> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const [npm, gh] = await Promise.allSettled([
    get(`https://registry.npmjs.org/${PACKAGE}/latest`),
    get(`https://api.github.com/repos/${REPO}/releases/latest`, { Accept: "application/vnd.github+json" }),
  ]);
  const npmVersion = npm.status === "fulfilled" && typeof npm.value.version === "string" ? npm.value.version : null;
  const ghVersion =
    gh.status === "fulfilled" && typeof gh.value.tag_name === "string" ? gh.value.tag_name.replace(/^v/, "") : null;
  if (!npmVersion && !ghVersion) return null;
  if (npmVersion && (!ghVersion || compareVersions(npmVersion, ghVersion) >= 0)) {
    return { version: npmVersion, onRegistry: true };
  }
  return { version: ghVersion!, onRegistry: false };
}

export function changelogUrl(version: string): string {
  return `https://github.com/${REPO}/blob/v${version.replace(/^v/, "")}/CHANGELOG.md`;
}

// ---------------------------------------------------------------------------
// How was this copy installed?
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: "checkout"; root: string }
  | { kind: "npm-global"; nodeModules: string; prefix: string }
  | { kind: "npm-local"; project: string }
  | { kind: "other"; path: string };

/**
 * Classify an install from the path of a file inside it.
 *
 * Pure — the filesystem and npm's global root are passed in — because the
 * cases worth testing (Windows prefixes, the installer's ~/.local fallback, a
 * pnpm store) are not ones a test machine happens to have.
 *
 *   no node_modules in the path, a .git above it      → a checkout
 *   <global root>/gnomon-harness/…                     → npm -g (any prefix
 *                                                        the installer uses)
 *   <project>/node_modules/gnomon-harness/…            → a project dependency
 *   anything else (a pnpm or yarn global store, …)     → "other"
 */
export function detectInstall(
  file: string,
  globalRoots: string[],
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): InstallMethod {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" ? r.toLowerCase() : r;
  };
  const parts = resolve(file).split(/[\\/]/);
  const nm = parts.lastIndexOf("node_modules");
  if (nm < 0) {
    for (let d = dirname(resolve(file)), i = 0; i < 8; i++, d = dirname(d)) {
      if (exists(join(d, ".git")) && exists(join(d, "pnpm-workspace.yaml"))) return { kind: "checkout", root: d };
      if (dirname(d) === d) break;
    }
    return { kind: "other", path: file };
  }
  // A pnpm (or yarn-berry) store nests a package under `.pnpm/<name>@<v>/`;
  // npm commands would act on the wrong tree, so name it and stop.
  if (parts.includes(".pnpm") || parts[nm + 1] !== PACKAGE) return { kind: "other", path: file };
  const nodeModules = parts.slice(0, nm + 1).join(sep) || sep;
  if (globalRoots.some((g) => norm(g) === norm(nodeModules))) {
    // npm's layout: <prefix>/lib/node_modules on POSIX, <prefix>\node_modules
    // on Windows. The prefix is what `npm rm -g --prefix` needs.
    const up = dirname(nodeModules);
    const prefix = platform !== "win32" && basename(up) === "lib" ? dirname(up) : up;
    return { kind: "npm-global", nodeModules, prefix };
  }
  return { kind: "npm-local", project: dirname(nodeModules) };
}

/** Where the installer puts gnomon when npm's global prefix is not writable. */
export function userPrefix(): string {
  return join(homedir(), ".local");
}

/** Every node_modules a global install of gnomon could be living in. */
export function globalRoots(): string[] {
  const roots = [join(userPrefix(), "lib", "node_modules")];
  try {
    // `npm` is a .cmd shim on Windows, which execFile cannot start without a shell.
    const out = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      shell: process.platform === "win32",
    }).trim();
    if (out) roots.unshift(out);
  } catch {
    /* no npm on PATH: only the installer's own prefix can match */
  }
  return roots;
}

export function detectThisInstall(): InstallMethod {
  return detectInstall(here, globalRoots());
}

// ---------------------------------------------------------------------------
// The cache and the notice
// ---------------------------------------------------------------------------

export interface UpdateCache {
  /** When a release check was last started (ms since epoch). */
  checkedAt?: number;
  latest?: string;
  /** When the notice was last printed. */
  notifiedAt?: number;
  /** `gnomon update --notice off`. */
  disabled?: boolean;
}

export function updateCachePath(): string {
  return join(machineDataDir(), "update-check.json");
}

export function readUpdateCache(path = updateCachePath()): UpdateCache {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? (v as UpdateCache) : {};
  } catch {
    return {};
  }
}

export function writeUpdateCache(cache: UpdateCache, path = updateCachePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache) + "\n");
  } catch {
    /* a read-only home is not a reason to fail anything */
  }
}

export interface NoticeContext {
  command: string;
  json: boolean;
  env: NodeJS.ProcessEnv;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  method: InstallMethod["kind"];
  cache: UpdateCache;
}

/**
 * May this run look for, or mention, a newer release?
 *
 * Only a person at a terminal starting a session. Never `task` (scripted, and
 * its output is a record), never `--json`, never under CI, never when either
 * end is not a terminal — a line on stderr there is a line in someone's log
 * that changes between two otherwise identical runs. And never in a checkout,
 * whose version is "whatever is on this branch".
 */
export function noticeAllowed(c: NoticeContext): boolean {
  if (!["launch", "prompt", "run"].includes(c.command)) return false;
  if (c.json || !c.stdinTTY || !c.stdoutTTY) return false;
  const off = c.env.GNOMON_NO_UPDATE_CHECK;
  if (off && off !== "0" && off.toLowerCase() !== "false") return false;
  if (c.env.CI && c.env.CI !== "0" && c.env.CI.toLowerCase() !== "false") return false;
  if (c.cache.disabled) return false;
  return c.method === "npm-global" || c.method === "npm-local";
}

/**
 * The notice line, if one is due. Pure: given the cache and the clock it says
 * what to print and whether a fresh check should start.
 *
 * Both halves are rate-limited to once per 24h. The check runs in the
 * background and lands in the cache for the NEXT launch to report, so a slow
 * or absent network never adds a millisecond to this one.
 */
export function noticePlan(
  cache: UpdateCache,
  current: string,
  now: number
): { message: string | null; startCheck: boolean } {
  const due = (t?: number) => typeof t !== "number" || now - t >= DAY_MS || t > now;
  let message: string | null = null;
  if (cache.latest && compareVersions(cache.latest, current) > 0 && due(cache.notifiedAt)) {
    message =
      `gnomon ${cache.latest} is available (this is ${current}) — run \`gnomon update\`.\n` +
      `  What changed: ${changelogUrl(cache.latest)}\n` +
      `  (Once a day at most. Silence it: gnomon update --notice off, or GNOMON_NO_UPDATE_CHECK=1.)`;
  }
  return { message, startCheck: due(cache.checkedAt) };
}

/**
 * Print the notice if one is due and start a background check if one is due.
 * Never throws, never awaits the network.
 */
export function maybeNotifyUpdate(command: string, json: boolean): void {
  try {
    const cache = readUpdateCache();
    const ctx: NoticeContext = {
      command,
      json,
      env: process.env,
      stdinTTY: !!process.stdin.isTTY,
      stdoutTTY: !!process.stdout.isTTY,
      // Cheap on purpose: no `npm root -g` spawn on the way into a session.
      // A path under node_modules is an install; anything else is not.
      method: here.split(/[\\/]/).includes("node_modules") ? "npm-global" : "checkout",
      cache,
    };
    if (!noticeAllowed(ctx)) return;
    const now = Date.now();
    const plan = noticePlan(cache, currentVersion(), now);
    if (plan.message) {
      console.error(plan.message + "\n");
      cache.notifiedAt = now;
    }
    if (plan.message) writeUpdateCache(cache);
    if (plan.startCheck) {
      // checkedAt is stamped when the check FINISHES, answer or not. Stamped
      // at the start, a session ended within the 1.5s — `/exit` straight away
      // — abandoned the request and still counted as today's check, so the
      // cache could stay wrong for a day per quick exit. Measured in a
      // container: it did.
      fetchLatest(1500)
        .then((latest) => {
          const next: UpdateCache = { ...readUpdateCache(), checkedAt: Date.now() };
          if (latest) next.latest = latest.version;
          writeUpdateCache(next);
        })
        .catch(() => {});
    }
  } catch {
    /* a notice must never be why a session failed to start */
  }
}

// ---------------------------------------------------------------------------
// gnomon update
// ---------------------------------------------------------------------------

/** The release the installed native binaries came from, if the installer wrote one. */
export function installedNativeVersion(): string | null {
  try {
    return readFileSync(join(installedBinDir(), "VERSION"), "utf8").trim().replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

/** The installer, fetched and run as a child with the terminal attached. */
async function runInstaller(env: Record<string, string>): Promise<number> {
  const win = process.platform === "win32";
  // GNOMON_INSTALLER: a local copy or a mirror's URL. For testing an installer
  // change before it reaches master, and for networks that cannot reach
  // raw.githubusercontent.com.
  const chosen = process.env.GNOMON_INSTALLER?.trim();
  const url = chosen || (win ? INSTALL_PS1 : INSTALL_SH);
  let text: string;
  if (existsSync(url)) {
    text = readFileSync(url, "utf8");
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`could not download the installer (${url}: HTTP ${res.status})`);
    text = await res.text();
  }
  const dir = mkdtempSync(join(tmpdir(), "gnomon-update-"));
  try {
    const script = join(dir, win ? "install.ps1" : "install.sh");
    writeFileSync(script, text);
    const r = win
      ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
          stdio: "inherit",
          env: { ...process.env, ...env },
        })
      : spawnSync("sh", [script], { stdio: "inherit", env: { ...process.env, ...env } });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function describeInstall(m: InstallMethod): string {
  switch (m.kind) {
    case "checkout":
      return `a git checkout at ${m.root}`;
    case "npm-global":
      return `a global npm install under ${m.prefix}`;
    case "npm-local":
      return `a project dependency of ${m.project}`;
    default:
      return `an install this command does not recognise (${m.path})`;
  }
}

export interface UpdateOptions {
  check: boolean;
  force: boolean;
  notice?: string;
}

export async function cmdUpdate(opts: UpdateOptions): Promise<number> {
  if (opts.notice) {
    const v = opts.notice.toLowerCase();
    if (v !== "on" && v !== "off") {
      console.error("Usage: gnomon update --notice on|off");
      return 1;
    }
    writeUpdateCache({ ...readUpdateCache(), disabled: v === "off" });
    console.log(
      v === "off"
        ? `The newer-version notice is off on this machine (${updateCachePath()}).`
        : "The newer-version notice is on: at most once a day, on an interactive launch or prompt."
    );
    return 0;
  }

  const current = currentVersion();
  const method = detectThisInstall();
  console.log(`This is gnomon ${current}, ${describeInstall(method)}.`);

  const latest = await fetchLatest(10_000);
  if (!latest) {
    console.error("Could not reach the npm registry or GitHub to find the latest release.");
    console.error(`Check by hand: https://github.com/${REPO}/releases/latest`);
    return 1;
  }
  writeUpdateCache({ ...readUpdateCache(), checkedAt: Date.now(), latest: latest.version });

  const newer = compareVersions(latest.version, current) > 0;
  const native = installedNativeVersion();
  const nativeStale = native !== null && compareVersions(latest.version, native) > 0;
  if (newer) {
    console.log(`Latest release: ${latest.version}  (${current} → ${latest.version})`);
    console.log(`What changed:   ${changelogUrl(latest.version)}`);
  } else {
    console.log(`Latest release: ${latest.version} — up to date.`);
  }
  if (native === null) {
    console.log(`Native binaries: not installed in ${installedBinDir()}`);
  } else {
    console.log(`Native binaries: ${native}${nativeStale ? ` (older than ${latest.version})` : ""}`);
  }

  if (opts.check) return 0;

  switch (method.kind) {
    case "checkout":
      // Not run for you: a checkout is where someone works, and a pull can
      // conflict with what they have not committed.
      console.log("\nA checkout updates with git:");
      console.log(`  cd ${method.root}`);
      console.log("  git pull && pnpm install && pnpm run build:native && pnpm run build");
      return 0;
    case "npm-local":
      console.log("\nThis copy is a dependency of a project; update it there:");
      console.log(`  cd ${method.project}`);
      if (latest.onRegistry) {
        console.log(`  npm i ${PACKAGE}@${latest.version}`);
      } else {
        // Not on the registry yet, so its three libraries cannot be resolved
        // by name either: all four tarballs, or npm 404s on the first one.
        const base = `https://github.com/${REPO}/releases/download/v${latest.version}`;
        console.log(`  npm i ${ALL_PACKAGES.map((p) => `${base}/${p}-${latest.version}.tgz`).join(" ")}`);
      }
      return 0;
    case "other":
      console.log("\nUpdate it with the tool that installed it, or replace it with the installer:");
      console.log(
        process.platform === "win32" ? `  irm ${INSTALL_PS1} | iex` : `  curl -fsSL ${INSTALL_SH} | sh`
      );
      return 0;
    case "npm-global":
      break;
  }

  if (!newer && !nativeStale && native !== null && !opts.force) {
    console.log("\nNothing to do. (--force reinstalls anyway.)");
    return 0;
  }

  // The installer, not `npm i -g` from here: it is the one place that knows
  // registry-vs-release-tarball, checks SHA256SUMS, and refreshes the native
  // binaries in the same run — and running it is exactly what a new user did,
  // so the update path cannot drift from the install path. The prefix is
  // passed so it updates THIS copy rather than installing a second one.
  console.log(`\nRunning the installer for ${latest.version}…\n`);
  const code = await runInstaller({ GNOMON_VERSION: latest.version, GNOMON_NPM_PREFIX: method.prefix });
  if (code !== 0) console.error(`\nThe installer exited ${code}; the copy you have is unchanged or partly updated.`);
  return code;
}

// ---------------------------------------------------------------------------
// gnomon uninstall
// ---------------------------------------------------------------------------

/**
 * The commands that remove this install, for the reader to run.
 *
 * Printed, not executed: removing the program that is currently running is a
 * poor thing to do from inside it, and on Windows npm cannot delete files the
 * running process has open.
 *
 * All four packages are named, always. A registry install nests the three
 * libraries inside gnomon-harness, but a release-tarball install makes each a
 * separate global — `npm rm -g gnomon-harness` alone left three behind — and
 * `npm rm` of a package that is not there is a no-op, so naming them costs
 * nothing.
 */
export function uninstallSteps(m: InstallMethod, platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === "win32";
  const steps: string[] = [];
  if (m.kind === "checkout") {
    steps.push(`cd ${m.root} && pnpm run unlink:global   # then delete the checkout if you like`);
  } else if (m.kind === "npm-local") {
    steps.push(`cd ${m.project} && npm rm ${ALL_PACKAGES.join(" ")}`);
  } else {
    const prefix = m.kind === "npm-global" ? ` --prefix "${m.prefix}"` : "";
    steps.push(`npm rm -g${prefix} ${ALL_PACKAGES.join(" ")}`);
  }
  const bin = installedBinDir();
  const cache = updateCachePath();
  steps.push(
    win
      ? `Remove-Item -Recurse -Force "${bin}", "${cache}" -ErrorAction SilentlyContinue`
      : `rm -rf "${bin}" "${cache}"`
  );
  return steps;
}

export function cmdUninstall(credentials: string, loops: { name: string; root: string | null }[]): number {
  const m = detectThisInstall();
  console.log(`This is gnomon ${currentVersion()}, ${describeInstall(m)}. To remove it:\n`);
  if (loops.length > 0) {
    // First: a cron entry outlives the program it calls, and fails every
    // minute afterwards with nothing left to explain why.
    console.log("  # first, the scheduled loops this machine still runs:");
    for (const l of loops) {
      console.log(`  gnomon loop uninstall ${l.name}${l.root ? ` --dir "${l.root}"` : ""}`);
    }
  }
  for (const s of uninstallSteps(m)) console.log(`  ${s}`);
  console.log(`
Left in place on purpose:
  ${credentials}
    your stored API keys — delete it too if you want them gone.
  .gnomon/ in each project
    part of that repository, not of the install.`);
  return 0;
}
