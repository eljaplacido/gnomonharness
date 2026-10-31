#!/usr/bin/env node
/**
 * gnomon launcher.
 *
 * This is the `bin` entry, so it must work from anywhere — a globally linked
 * install invoked inside someone else's project, not just from a checkout.
 * Three rules follow from that:
 *
 *   1. The harness is located relative to THIS file, by walking up to the
 *      checkout that contains it.
 *   2. The child inherits the caller's working directory. gnomon resolves
 *      `.gnomon/` from the cwd, so pinning cwd to the checkout — as this
 *      launcher used to — made it impossible to use on any other project.
 *   3. No `shell` on unix. `shell: true` re-splits the argv array through sh,
 *      which turned `task "fix the login bug & ship it"` into five arguments
 *      and backgrounded the remainder at the `&`.
 *
 * It runs the TypeScript sources, and it used to run them through `tsx` on
 * every invocation: ~200 ms of transpiling, in a second node process, before
 * gnomon did anything. Measured by UX1 (benchmarks/results/ux1-2026-11), the
 * checkout cost +217 ms wall and +310 ms CPU per invocation against the same
 * code compiled, and lost to goose on time-to-first-request because of it.
 *
 * So the launcher keeps a bundle of the same sources (esbuild, reached through
 * tsx's own dependency: no new package) in node_modules/.cache/gnomon-launch and
 * imports it in-process when it is current. "Current" is strict, because a
 * stale bundle would be changed behaviour with nothing to show it: every input
 * esbuild read, every workspace package.json and tsconfig, and this file must
 * have the size and mtime recorded at build time. Anything else rebuilds
 * (~0.3 s, once per change), and any failure falls back to tsx as before.
 * GNOMON_LAUNCH=tsx forces the old path; GNOMON_LAUNCH_DEBUG=1 says which ran.
 *
 * Nothing about the code changes: each module's `import.meta.url` is pinned to
 * its source file, so every file-relative lookup (native binaries, build info,
 * `update`, the loop installer) resolves exactly as it does under tsx. The
 * workspace's `exports` still point at src/, which is what tests resolve.
 *
 * ESM: the package declares "type": "module", so `require` is not available.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file to the checkout that holds the CLI source. */
function findHarnessRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "gnomon-cli", "src", "index.ts"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const root = findHarnessRoot(here);
if (!root) {
  console.error(
    "gnomon: could not locate the harness checkout from " + here + "\n" +
    "The launcher must live inside the gnomon repository."
  );
  process.exit(1);
}

const isWindows = process.platform === "win32";
const entry = join(root, "packages", "gnomon-cli", "src", "index.ts");
const tsx = join(root, "node_modules", ".bin", isWindows ? "tsx.cmd" : "tsx");

if (!existsSync(tsx)) {
  console.error(
    "gnomon: tsx not found at " + tsx + "\n" +
    "Run `pnpm install` in " + root
  );
  process.exit(1);
}

// ── The bundled fast path ───────────────────────────────────────────────────

// Bumped when how the bundle is built changes; an old bundle then rebuilds.
const RECIPE = 1;
const debug = !!process.env.GNOMON_LAUNCH_DEBUG;
const say = (m) => { if (debug) console.error("gnomon launch: " + m); };

/** Files whose change must invalidate the bundle beyond esbuild's own inputs. */
function extraInputs() {
  const files = [fileURLToPath(import.meta.url), join(root, "package.json")];
  for (const name of readdirSync(join(root, "packages"))) {
    for (const f of ["package.json", "tsconfig.json"]) {
      const p = join(root, "packages", name, f);
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

const fingerprint = (path) => {
  const st = statSync(path, { throwIfNoEntry: false });
  return st ? [path, st.size, st.mtimeMs] : [path, -1, -1];
};

function current(stampPath, bundlePath) {
  if (!existsSync(bundlePath) || !existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    if (stamp.recipe !== RECIPE) return false;
    for (const [path, size, mtimeMs] of stamp.inputs) {
      const [, s, m] = fingerprint(path);
      if (s !== size || m !== mtimeMs) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function rebuild(dir, bundlePath, stampPath) {
  // esbuild through tsx, which depends on it: the checkout already has it, and no
  // package gains a dependency (gnomon ships zero third-party runtime ones).
  // realpath: pnpm links node_modules/tsx to .pnpm/tsx@x/node_modules/tsx, and puts
  // tsx's own dependencies beside that real directory, not under the link.
  const tsxPkg = realpathSync(join(root, "node_modules", "tsx", "package.json"));
  const esbuild = createRequire(tsxPkg)("esbuild");
  const pin = {
    name: "pin-import-meta-url",
    setup(b) {
      b.onLoad({ filter: /\.[cm]?ts$/ }, (args) => {
        if (args.path.split(sep).includes("node_modules")) return undefined;
        const src = readFileSync(args.path, "utf8");
        // Each module keeps its own source location, so lookups relative to it
        // resolve as they do under tsx. (No source quotes `import.meta.url` in a
        // string; the launcher's tests check the bundle against tsx's output.)
        return {
          contents: src.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(args.path).href)),
          loader: "ts",
        };
      });
    },
  };
  mkdirSync(dir, { recursive: true });
  const tmp = `${bundlePath}.${process.pid}.tmp`;
  const r = await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node20",
    outfile: tmp, metafile: true, plugins: [pin], logLevel: "silent", absWorkingDir: root,
  });
  const inputs = Object.keys(r.metafile.inputs).map((p) => fingerprint(resolve(root, p)));
  const stampTmp = `${stampPath}.${process.pid}.tmp`;
  writeFileSync(stampTmp, JSON.stringify({ recipe: RECIPE, inputs: [...inputs, ...extraInputs().map(fingerprint)] }));
  // Bundle first, then its stamp: a reader that sees the new stamp must also see
  // the new bundle. The reverse (new bundle, old stamp) only rebuilds again.
  renameSync(tmp, bundlePath);
  renameSync(stampTmp, stampPath);
}

async function bundled() {
  if (process.env.GNOMON_LAUNCH === "tsx") return null;
  const dir = process.env.GNOMON_LAUNCH_CACHE || join(root, "node_modules", ".cache", "gnomon-launch");
  const bundlePath = join(dir, "gnomon.mjs");
  const stampPath = join(dir, "inputs.json");
  if (current(stampPath, bundlePath)) {
    say("bundle (current)");
    return bundlePath;
  }
  try {
    await rebuild(dir, bundlePath, stampPath);
    say("bundle (rebuilt)");
    return bundlePath;
  } catch (e) {
    say("tsx (bundle failed: " + (e && e.message ? e.message.split("\n")[0] : e) + ")");
    return null;
  }
}

const bundle = await bundled();
if (bundle) {
  // The CLI's main() runs on import and owns the process from here, exactly as it
  // did in tsx's child: same argv shape (arguments from index 2), same exits.
  await import(pathToFileURL(bundle).href);
} else {
  say("tsx");
  runTsx();
}

function runTsx() {
  // tsx's own entry run by this node, with no shell in between. On Windows the
  // .cmd shim needs `shell: true`, which joins argv unquoted for cmd.exe: a
  // checkout under a path with a space did not start, and `&`, `|`, `>` or `%X%`
  // in a prompt were read by cmd. The shim stays the fallback for a layout
  // without the entry file.
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const result = existsSync(tsxCli)
    ? spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: "inherit" })
    : spawnSync(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit", shell: isWindows });

  if (result.error) {
    console.error("gnomon: " + result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
