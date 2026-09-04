#!/usr/bin/env node
/**
 * surface-fidelity — does a change to the surface move the hash exactly when it
 * moves behaviour?
 *
 * Exhaustive and deterministic: every path, every run, no model, no sampling,
 * $0. See PRE-REGISTRATION.md for the scoring rule, which was fixed first.
 *
 *   node fidelity.mjs [--json out.json]
 *
 * Exit 1 if any false negative is found, or if the negative control does not
 * fire. A detector that has never detected anything is not evidence.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";


const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const core = (m) => import(`${REPO}/packages/gnomon-core/dist/${m}`);

const { loadConfig, recomputeManifest, resolveContext, resolveRouting, resolveUi,
        resolveVerify, resolveChain, resolveLoop, resolveResilience, resolveExec,
        resolveExtraRoots } = await core("config.js");
const { buildToolSet } = await core("tools.js");
const { buildSystemPrompt } = await core("prompt_loop.js");

/**
 * Everything the harness decides BEFORE the model is called.
 *
 * Deliberately excludes model output: it is nondeterministic, and including it
 * would turn an exact measurement into a noisy one. This is the part of
 * behaviour that is a pure function of the surface, which is the part the claim
 * under test is about.
 */
function fingerprint(root) {
  const c = loadConfig(root);
  const roles = Object.keys(c.roles).sort();
  return JSON.stringify({
    context: resolveContext(c),
    routing: resolveRouting(c),
    ui: resolveUi(c),
    verify: resolveVerify(c),
    chain: resolveChain(c),
    loop: resolveLoop(c),
    resilience: resolveResilience(c),
    extra_roots: resolveExtraRoots(c),
    defaults: c.config.defaults ?? {},
    policy: c.policy ?? {},
    roles: roles.map((r) => ({
      role: r,
      def: c.roles[r],
      exec: resolveExec(c, r),
      // The schemas actually offered — the model's real capability surface.
      tools: buildToolSet(c, r).schemas.map((s) => s.function.name),
    })),
    // Every profile the surface declares, resolved.
    //
    // Holding `role_profile` fixed made an unselected profile look inert: it
    // moved the hash and changed nothing, because nothing had selected it. But
    // it is not inert, it is CONDITIONALLY live — `--profile` or one line in
    // config.toml turns it on, and `loadConfig` takes that override. Resolving
    // each declared profile is what makes "behaviour" mean the surface's whole
    // decision space rather than one point in it.
    profiles: Object.keys(c.profiles ?? {}).sort().map((name) => {
      try {
        const pc = loadConfig(root, name);
        return { name, roles: Object.keys(pc.roles).sort().map((r) => [r, pc.roles[r]]) };
      } catch (e) {
        return { name, error: String(e).slice(0, 120) };
      }
    }),
    // Two fixed inputs: one that matches no skill, one that matches the
    // scaffolded ones. Both prompts are pure functions of the surface.
    prompts: roles.map((r) => [
      buildSystemPrompt({ config: c, exchanges: [], currentRole: r }, r, "rename a variable"),
      // `api_key`, not `api key`: the scaffolded skill matches `api[_-]?key`,
      // so the spaced form is dormant and a body edit would be invisible —
      // an apparatus weakness that read as a false positive until it was fixed.
      buildSystemPrompt({ config: c, exchanges: [], currentRole: r }, r, "where does the api_key go"),
    ]),
  });
}

function surfaceHash(root) {
  return recomputeManifest(join(root, ".gnomon")).surface_hash;
}

/** Every file under .gnomon/, plus one new file per directory that exists. */
function targets(root) {
  const g = join(root, ".gnomon");
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        // Same extension the directory actually uses: `profiles/` reads .toml,
        // so a probe.md there is inert by file type rather than by path, and
        // would be miscounted as a property of the hash.
        const exts = readdirSync(p).map((f) => f.replace(/^.*(\.[^.]+)$/, "$1")).filter((x) => x.startsWith("."));
        const ext = exts.length ? exts.sort((a, b) =>
          exts.filter((x) => x === b).length - exts.filter((x) => x === a).length)[0] : ".md";
        out.push({ path: relative(root, join(p, `probe${ext}`)), kind: "new-file-in-dir" });
        walk(p);
      }
      else out.push({ path: relative(root, p), kind: "edit" });
    }
  };
  walk(g);
  // Directories the scaffold does not create but the harness names, so an
  // inert-but-hashed one cannot hide by being absent.
  for (const d of ["extensions", "skills/proposed"]) {
    const p = join(".gnomon", d, "probe.md");
    if (!out.some((t) => t.path === p)) out.push({ path: p, kind: "new-file-in-dir" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every mutation worth trying on one path.
 *
 * The pre-registered rule classifies a PATH, not a single edit: a path is a
 * false positive only when NO change under it can move behaviour. A weak
 * mutation therefore proves nothing on its own, and the first version of this
 * script used only one — appending `[gnomon_fidelity_probe]` to a TOML file,
 * which adds a table nothing reads. It reported seven false positives that were
 * artifacts of the probe rather than properties of the hash. The number was too
 * dirty to believe, and the apparatus was what was wrong.
 *
 * So: a weak variant AND a strong one. The strong variant edits a value the
 * config actually reads, found generically by rewriting the first scalar
 * assignment in the file rather than by hard-coding each file's semantics.
 */
function variants(baseAbs, kind) {
  if (kind === "new-file-in-dir") {
    return [
      // Valid content for the file type. An invalid .toml in profiles/ makes
      // loadConfig refuse the surface — correct behaviour, and it measures the
      // parser rather than the hash, so the probe must be well-formed.
      { name: "new file", applyTo: (abs) => {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, abs.endsWith(".toml")
          ? 'name = "gnomon_fidelity_probe"\ndescription = "probe"\n'
          : "probe\n");
      } },
    ];
  }
  const before = readFileSync(baseAbs, "utf-8");
  const isToml = baseAbs.endsWith(".toml");
  const out = [
    { name: "append unread text", applyTo: (abs) => writeFileSync(abs,
        isToml ? `${before}\n[gnomon_fidelity_probe]\nvalue = 1\n` : `${before}\nGNOMON FIDELITY PROBE\n`) },
  ];
  if (isToml) {
    // Rewrite the first scalar the file assigns — a value something reads.
    // EVERY scalar, not just the first. `profiles/local_first.toml` assigns
    // `name` before it assigns any model, so rewriting only the first value
    // edited the profile's label and left every role untouched — which read as
    // the hash moving for nothing when it was the probe missing the point.
    const lines = before.split("\n");
    const scalars = lines
      .map((l, i) => [l, i])
      .filter(([l]) => /^\s*[A-Za-z_][\w.-]*\s*=\s*("[^"]*"|-?\d+|true|false)\s*(#.*)?$/.test(l));
    for (const [line, i] of scalars.slice(0, 12)) {
      out.push({ name: `rewrite ${line.split("=")[0].trim()}`, applyTo: (abs) => {
        const m = line.match(/^(\s*[A-Za-z_][\w.-]*\s*=\s*)(.*)$/);
        const v = m[2].trim().replace(/\s*#.*$/, "");
        const next = v.startsWith('"') ? '"gnomon_fidelity_probe"' : v === "true" ? "false" : v === "false" ? "true" : "999999";
        const copy = [...lines]; copy[i] = `${m[1]}${next}`;
        writeFileSync(abs, copy.join("\n"));
      }});
    }
  } else {
    // A skill body or system.md: appended text lands in the prompt.
    out.push({ name: "append instruction", applyTo: (abs) => writeFileSync(abs, `${before}\nAlways prefer tabs over spaces.\n`) });
  }
  return out;
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "gnomon-fidelity-"));
  execFileSync(`${REPO}/node_modules/.bin/tsx`,
    [`${REPO}/packages/gnomon-cli/src/index.ts`, "init"],
    { cwd: root, stdio: "pipe" });
  return root;
}

function measure() {
  const base = scaffold();
  const baseHash = surfaceHash(base);
  const baseFp = fingerprint(base);
  const rows = [];
  for (const t of targets(base)) {
    if (t.kind === "edit" && !existsSync(join(base, t.path))) continue;
    // A path is live if ANY mutation under it moves behaviour, and its hash
    // moves if any moves the hash. Per-path, exactly as pre-registered.
    let hashMoved = false, fpMoved = false, error = false;
    const tried = [];
    for (const v of variants(join(base, t.path), t.kind)) {
      const root = scaffold();
      const abs = join(root, t.path);
      // `variants` closed over the base copy to read the original content;
      // apply it to this run's own copy so nothing mutates the baseline.
      v.applyTo(abs);
      tried.push(v.name);
      try { if (surfaceHash(root) !== baseHash) hashMoved = true; } catch { error = true; }
      try { if (fingerprint(root) !== baseFp) fpMoved = true; } catch { error = true; }
      rmSync(root, { recursive: true, force: true });
    }
    const behaviour = error && !fpMoved ? "error" : fpMoved;
    rows.push({
      path: t.path,
      kind: t.kind,
      variants: tried,
      hash_moved: hashMoved,
      behaviour_moved: behaviour,
      verdict:
        behaviour === "error" ? "unmeasurable"
        : hashMoved === Boolean(behaviour) ? "faithful"
        : hashMoved ? "false-positive"
        : "false-negative",
    });
  }
  rmSync(base, { recursive: true, force: true });
  return { baseHash, rows };
}

/**
 * Prove the detector detects, before any clean run is believed.
 *
 * A benchmark that has only ever returned "faithful" is indistinguishable from
 * one that cannot return anything else, and 12/12 is exactly the shape that
 * should be distrusted. Two synthetic faults, one in each direction:
 *
 *  - FALSE POSITIVE control: `.gnomon/notes.txt`. The walk hashes every file
 *    under the surface and nothing reads a .txt, so it is hashed and inert.
 *  - FALSE NEGATIVE control: a fingerprint that reads `.gnomon/extensions/`.
 *    That directory is excluded from the hash, so a fingerprint depending on it
 *    models exactly the trap the exclusion creates — an extension host built
 *    later, with nobody re-including the directory. This is the control that
 *    guards the change made on 2026-09-04, and it must fire.
 */
function negativeControl() {
  const base = scaffold();
  const baseHash = surfaceHash(base);
  const results = {};

  // FP: hashed, inert.
  {
    const root = scaffold();
    writeFileSync(join(root, ".gnomon", "notes.txt"), "nothing reads this\n");
    results.false_positive =
      surfaceHash(root) !== baseHash && fingerprint(root) === fingerprint(base);
    rmSync(root, { recursive: true, force: true });
  }
  // FN: behaviour-bearing, unhashed.
  {
    const extFp = (r) => {
      const d = join(r, ".gnomon", "extensions");
      const files = existsSync(d) ? readdirSync(d).sort() : [];
      return fingerprint(r) + files.map((f) => readFileSync(join(d, f), "utf-8")).join("");
    };
    const root = scaffold();
    mkdirSync(join(root, ".gnomon", "extensions"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "extensions", "hook.ts"), "export const hook = 1;\n");
    results.false_negative =
      surfaceHash(root) === baseHash && extFp(root) !== extFp(base);
    rmSync(root, { recursive: true, force: true });
  }
  rmSync(base, { recursive: true, force: true });
  return results;
}

const control = negativeControl();
console.log("negative control (must both be true before any result is believed):");
console.log(`  false-positive detector fires: ${control.false_positive}`);
console.log(`  false-negative detector fires: ${control.false_negative}\n`);
if (!control.false_positive || !control.false_negative) {
  console.error("NEGATIVE CONTROL DID NOT FIRE — the measurement below is void.");
  process.exit(2);
}

const { baseHash, rows } = measure();
const by = (v) => rows.filter((r) => r.verdict === v);
const fn = by("false-negative"), fp = by("false-positive"), un = by("unmeasurable");

console.log(`surface-fidelity — ${rows.length} paths, base hash ${baseHash.slice(0, 16)}…\n`);
for (const r of rows) {
  const mark = r.verdict === "faithful" ? "  ok " : r.verdict === "false-positive" ? "  FP " : r.verdict === "unmeasurable" ? "  ?? " : "  FN ";
  console.log(`${mark} ${r.path.padEnd(38)} hash=${String(r.hash_moved).padEnd(5)} behaviour=${r.behaviour_moved}`);
}
console.log(`\n  faithful       ${by("faithful").length}`);
console.log(`  false positive ${fp.length}   (hash moved, behaviour did not)`);
console.log(`  FALSE NEGATIVE ${fn.length}   (behaviour moved, hash did not) — must be 0`);
console.log(`  unmeasurable   ${un.length}`);
// Buckets assert-sum to n, as the pre-registration requires.
const sum = by("faithful").length + fp.length + fn.length + un.length;
if (sum !== rows.length) { console.error(`\nBUCKETS DO NOT SUM: ${sum} != ${rows.length}`); process.exit(2); }

const out = process.argv.indexOf("--json");
if (out > -1 && process.argv[out + 1]) {
  writeFileSync(process.argv[out + 1], JSON.stringify({ baseHash, rows, summary: {
    faithful: by("faithful").length, false_positive: fp.length, false_negative: fn.length, unmeasurable: un.length,
  } }, null, 2));
}
process.exit(fn.length === 0 ? 0 : 1);
