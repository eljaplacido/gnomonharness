/**
 * Which harness produced a record.
 *
 * An independent audit put this first among thirteen findings, and it is the
 * only one that touches the thesis. The surface hash answers "what rules was
 * this run under". Nothing answered "what CODE read those rules" — so two
 * people with identical surface hashes on different gnomon builds get
 * different behaviour and no record says so. CONTRACTS.md is explicit that the
 * manifest's `build` field is not a revision and "a consumer must not read
 * provenance from it", so neither half of the pair identified the binary.
 *
 * Resolution order, most trustworthy first:
 *
 *   1. GNOMON_BUILD — stamped by a release or CI job. The only one that
 *      survives `npm install`, where there is no repository to ask.
 *   2. `git rev-parse --short HEAD` in the package's own tree, with a `-dirty`
 *      suffix when the tree has uncommitted changes. A build made from an
 *      edited tree must not claim to be its last commit.
 *   3. "unknown" — said plainly rather than guessed. A wrong provenance string
 *      is worse than an absent one, because it is the kind of thing a reader
 *      believes.
 *
 * Resolved once and cached: this is stamped on every record, and shelling out
 * per turn to learn something that cannot change mid-process would be a cost
 * for nothing.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
let cached = null;
/** package.json version, read from the package this module ships in. */
function packageVersion(dir) {
    for (let d = dir, i = 0; i < 6; i++, d = dirname(d)) {
        const p = join(d, "package.json");
        if (existsSync(p)) {
            try {
                const v = JSON.parse(readFileSync(p, "utf8")).version;
                if (typeof v === "string" && v)
                    return v;
            }
            catch {
                /* unreadable: fall through and keep walking */
            }
        }
    }
    return "0.0.0";
}
/**
 * A string identifying the harness build that produced a record, e.g.
 * `gnomon/0.1.0+abf40c0` or `gnomon/0.1.0+abf40c0-dirty`.
 */
export function harnessBuild() {
    if (cached !== null)
        return cached;
    const here = (() => {
        try {
            return dirname(fileURLToPath(import.meta.url));
        }
        catch {
            return process.cwd();
        }
    })();
    const version = packageVersion(here);
    const stamped = process.env.GNOMON_BUILD;
    if (stamped && stamped.trim()) {
        cached = `gnomon/${version}+${stamped.trim()}`;
        return cached;
    }
    try {
        const git = (args) => execFileSync("git", args, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const sha = git(["rev-parse", "--short", "HEAD"]);
        // A tree with uncommitted changes is not the commit it sits on, and a
        // benchmark record that says otherwise is the exact under-identification
        // this field exists to end.
        const dirty = git(["status", "--porcelain"]).length > 0 ? "-dirty" : "";
        cached = `gnomon/${version}+${sha}${dirty}`;
    }
    catch {
        cached = `gnomon/${version}+unknown`;
    }
    return cached;
}
//# sourceMappingURL=build.js.map