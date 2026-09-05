/**
 * gnomon-natives: Surface bindings
 *
 * Wraps the gnomon-surface Rust binary. Provides type-safe access to
 * manifest generation, hash computation, and path listing.
 */
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = "0.1.0";
// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------
/**
 * The file name a built binary actually has on this platform.
 *
 * Cargo writes `gnomon-edit` on Unix and `gnomon-edit.exe` on Windows. Every
 * lookup below searched for the bare name, so on Windows nothing was ever
 * found and every native call failed at the point of spawn -- a whole-platform
 * outage from one missing suffix.
 */
function exeName(name) {
    return process.platform === "win32" && !name.endsWith(".exe") ? name + ".exe" : name;
}
export function findBinary(name) {
    // 1. Check GNOMON_BIN_OVERRIDE env var (for testing)
    //    Can be a full path to the binary OR a directory containing it
    const override = process.env.GNOMON_BIN_OVERRIDE;
    if (override) {
        const resolved = resolve(override);
        // If it looks like a directory (ends without .exe or known extension), append name
        const candidate = join(resolved, exeName(name));
        if (existsSync(candidate))
            return candidate;
        // The bare name too: an override directory populated by hand, or a
        // cross-built artefact, may not carry the platform suffix.
        const bare = join(resolved, name);
        if (existsSync(bare))
            return bare;
        // Otherwise use the override as-is — but only if it is a file. It used to
        // be returned whenever it existed, so an override pointing at a directory
        // that lacked this particular binary returned the directory, and spawning
        // it failed with EACCES. The diagnosis then blamed permissions instead of
        // the missing build, which is exactly what happened in CI when the
        // workflow built two of the four binaries.
        try {
            if (statSync(resolved).isFile())
                return resolved;
        }
        catch {
            // fall through to the search below
        }
    }
    // 2/3. target/debug and target/release — whichever is NEWER.
    //
    // debug used to be checked first and returned unconditionally, so a stale
    // debug build silently shadowed a fresh release one. `pnpm run build:native`
    // builds RELEASE, so the documented way to rebuild a native could be a no-op
    // on any machine that had ever run `cargo build` without --release: the fix
    // compiles, the binary on disk changes, and the harness keeps running the old
    // one. Cost an hour today, twice, on a panic that had already been fixed.
    //
    // Newest wins, which is what a person means by "I just rebuilt it".
    const candidates = ["debug", "release"]
        .map((profile) => join(__dirname, "..", "..", "..", "target", profile, exeName(name)))
        .map((path) => {
        try {
            const st = statSync(path);
            return st.isFile() ? { path, mtime: st.mtimeMs } : null;
        }
        catch {
            return null;
        }
    })
        .filter((c) => c !== null)
        .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0)
        return candidates[0].path;
    // 4. Check PATH (system install)
    try {
        // `where` on Windows, `which` everywhere else -- and `where` prints one
        // line per hit, so take the first.
        const lookup = process.platform === "win32" ? "where" : "which";
        const found = execSync(`${lookup} ${exeName(name)}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim().split(/\r?\n/)[0]?.trim();
        if (found)
            return found;
    }
    catch {
        // not in PATH
    }
    throw new Error(`gnomon native binary not found: "${name}".\n` +
        "It is built from the Rust crates in this checkout:\n" +
        `  cargo build --bin ${name}\n` +
        "  (or `pnpm run build:native` for all four)\n" +
        "Or set GNOMON_BIN_OVERRIDE to a directory containing it.");
}
/**
 * Resolve a native binary on first use, not at import.
 *
 * These used to be module-level constants, so importing this package threw
 * when the Rust binaries had not been built — which killed `gnomon --help`,
 * `gnomon init` and `gnomon launch`, none of which touch a native binary. On a
 * fresh clone that made the whole CLI unusable until someone happened to run
 * cargo. Resolving lazily means only the commands that genuinely need the
 * binaries can fail for want of them.
 */
const binCache = new Map();
/**
 * Explain a failed spawn.
 *
 * When the binary is missing, spawnSync leaves `status` null and puts the
 * reason in `error` — `stderr` is empty. Reporting "unknown error" for that
 * case sent a CI failure back saying nothing about the actual cause, which was
 * a workflow step that built two of the four binaries.
 */
function spawnDetail(result) {
    const stderr = result.stderr?.toString().trim();
    if (stderr)
        return stderr;
    if (result.error) {
        const code = result.error.code;
        if (code === "ENOENT") {
            return `${result.error.message} — the binary is not built. Run \`pnpm run build:native\` or \`cargo build --bin gnomon-edit\`.`;
        }
        return result.error.message;
    }
    return `exit ${result.status ?? "null"} with no output`;
}
function nativeBin(name) {
    const cached = binCache.get(name);
    if (cached)
        return cached;
    const resolved = findBinary(name);
    binCache.set(name, resolved);
    return resolved;
}
// ---------------------------------------------------------------------------
// Surface API
// ---------------------------------------------------------------------------
/**
 * Resolve the .gnomon/ tree and produce a manifest.
 * @param dir Path to the .gnomon/ directory (default: process.cwd() + "/.gnomon")
 * @returns Manifest with build version, surface_hash, and sorted sources
 */
export function manifest(dir) {
    const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
    const result = spawnSync(nativeBin("gnomon-surface"), ["manifest", "--dir", target], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "unknown error";
        throw new Error(`gnomon-surface failed: ${stderr}`);
    }
    const output = result.stdout?.toString().trim() ?? "";
    if (!output)
        throw new Error("gnomon-surface returned empty output");
    return JSON.parse(output);
}
/**
 * Compute the surface hash for the given .gnomon/ tree.
 */
export function surfaceHash(dir) {
    const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
    const result = spawnSync(nativeBin("gnomon-surface"), ["hash", "--dir", target], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "unknown error";
        throw new Error(`gnomon-surface hash failed: ${stderr}`);
    }
    const output = result.stdout?.toString().trim() ?? "";
    if (!output)
        throw new Error("gnomon-surface hash returned empty");
    return output;
}
/**
 * List all paths in the .gnomon/ tree.
 */
export function listPaths(dir) {
    const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
    const result = spawnSync(nativeBin("gnomon-surface"), ["paths", "--dir", target], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "unknown error";
        throw new Error(`gnomon-surface paths failed: ${stderr}`);
    }
    const output = result.stdout?.toString().trim() ?? "";
    if (!output)
        return [];
    return output.split("\n").filter((p) => p.trim().length > 0);
}
// ---------------------------------------------------------------------------
// Enumerations API
// ---------------------------------------------------------------------------
/**
 * Load the enumerations contract from the gnomon-enums binary.
 * Returns the 4 top-level keys: edit_format, sandbox, approval, role_profile.
 */
export function enumerations() {
    const result = spawnSync(nativeBin("gnomon-enums"), [], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "unknown error";
        throw new Error(`gnomon-enums failed: ${stderr}`);
    }
    const output = result.stdout?.toString().trim() ?? "";
    if (!output)
        throw new Error("gnomon-enums returned empty output");
    return JSON.parse(output);
}
/**
 * Apply a patch set (JSON file) to a target directory.
 * @param patchsetPath Path to patchset JSON file
 * @param targetDir Target directory (default: process.cwd())
 * @returns PatchSetResult with per-file results
 */
export function applyPatchset(patchsetPath, targetDir) {
    const target = targetDir ? resolve(targetDir) : process.cwd();
    const patch = resolve(patchsetPath);
    const result = spawnSync(findBinary("gnomon-edit"), ["apply", patch, "--dir", target], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
    });
    // Exit 2 means the run completed and some patches did not apply — a result,
    // not a failure of the apparatus, and the caller inspects `all_applied` for
    // exactly that. Throwing on it turned an ordinary finding into an exception
    // with an empty message.
    if (result.status !== 0 && result.status !== 2) {
        throw new Error(`gnomon-edit failed: ${spawnDetail(result)}`);
    }
    const output = result.stdout?.toString().trim() ?? "{}";
    return JSON.parse(output);
}
/**
 * Simulate a patch (dry-run preview) without writing to disk.
 * @param patchsetPath Path to patchset JSON file
 * @param targetDir Target directory for context
 * @returns PatchSetResult with simulated new content
 */
export function simulatePatch(patchsetPath, targetDir) {
    const target = targetDir ? resolve(targetDir) : process.cwd();
    const patch = resolve(patchsetPath);
    const result = spawnSync(findBinary("gnomon-edit"), ["simulate", patch, "--dir", target], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
    });
    // Exit 2 means the run completed and some patches did not apply — a result,
    // not a failure of the apparatus, and the caller inspects `all_applied` for
    // exactly that. Throwing on it turned an ordinary finding into an exception
    // with an empty message.
    if (result.status !== 0 && result.status !== 2) {
        throw new Error(`gnomon-edit simulate failed: ${spawnDetail(result)}`);
    }
    const output = result.stdout?.toString().trim() ?? "{}";
    return JSON.parse(output);
}
/**
 * Run a command and capture the result as a session step.
 * @param command Shell command to execute
 * @returns SessionStep with outcome bucket
 */
export function runSessionStep(command, env) {
    // We don't have a full gnomon-exec binary API yet — this is a shim
    // that will call gnomon-exec when the binary is available.
    const execBin = findBinary("gnomon-exec");
    const result = spawnSync(execBin, ["step", "--cmd", command], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "unknown error";
        throw new Error(`gnomon-exec step failed: ${stderr}`);
    }
    const output = result.stdout?.toString().trim() ?? "{}";
    return JSON.parse(output);
}
// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
/**
 * Return the gnomon version string.
 */
export function version() {
    return VERSION;
}
// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------
export const GNONOM_VERSION = VERSION;
//# sourceMappingURL=surface.js.map