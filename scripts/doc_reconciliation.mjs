#!/usr/bin/env node
/**
 * doc_reconciliation — mark a document for re-reading when its subject moves.
 *
 * THE PROBLEM THIS IS FOR. Structured claims in the docs are pinned by tests:
 * the tool table, the role table, the command registry, the exit codes, the
 * stop_reason enumeration, and every `file.ts:line` citation. Prose is not, and
 * prose is the half that actually rots. Three instances, all real:
 *
 *   - POSITIONING.md said gnomon "has not been run against Terminal-Bench ...
 *     and no score is claimed here" while three campaigns sat committed in the
 *     same repository. The project's own post-mortem called it the highest
 *     embarrassment-per-line in the corpus, and it survived five more days.
 *   - README claimed 954 TypeScript and 46 Rust tests. It was 1023 and 57.
 *   - HARNESS-RESEARCH-RECONCILIATION.md asserted "TaskRecord carries no
 *     stop_reason" for days after it gained one.
 *
 * None of these is mechanically checkable as a sentence. What IS mechanical is
 * the question "has the thing this document describes changed since anybody
 * last read it against the code?" -- which is what the ROADMAP asked for:
 * scheduled rather than remembered.
 *
 * WHAT IT DOES NOT DO, said plainly so nobody reads more into a green tick.
 * It cannot tell whether a document is true. It tells you which documents are
 * OWED a reading. A doc whose subjects have not moved can still be wrong, and a
 * doc this flags can turn out to be fine -- in which case you re-bless it, and
 * the record says a human looked on that commit.
 *
 * Usage:
 *   node scripts/doc_reconciliation.mjs             # report
 *   node scripts/doc_reconciliation.mjs --check     # exit 1 if any doc is owed
 *   node scripts/doc_reconciliation.mjs --bless docs/POSITIONING.md [...]
 *   node scripts/doc_reconciliation.mjs --bless-all
 *
 * `--bless` is the forcing function, not a lock: anybody can run it without
 * reading anything. The point is that the claim "this was checked at <sha>"
 * ends up in a file a reviewer can see, the same way the contract gate's
 * exemption trailer works.
 *
 * Bless in its OWN commit, after the work, and never inside one you go on to
 * amend or rebase: the marker names a commit, and amending orphans it. Done
 * once on 2026-09-05 -- the manifest pointed at a SHA that existed only in the
 * local reflog, so the script resolved it here and would have exited 2 on a
 * fresh clone. It fails loudly rather than skipping the document, which is the
 * right direction, but the cheaper fix is not to do it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const MANIFEST = join(ROOT, "docs/reconciliation.json");

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();

const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const blessAll = argv.includes("--bless-all");
const blessIdx = argv.indexOf("--bless");
const blessing = blessAll
  ? Object.keys(manifest.docs)
  : blessIdx > -1
    ? argv.slice(blessIdx + 1).filter((a) => !a.startsWith("--"))
    : [];

if (blessing.length > 0) {
  const head = git(["rev-parse", "HEAD"]);
  for (const doc of blessing) {
    if (!manifest.docs[doc]) {
      console.error(`not in the manifest: ${doc}`);
      process.exit(2);
    }
    manifest.docs[doc].last_checked = head;
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`blessed ${blessing.length} doc(s) at ${head.slice(0, 7)}`);
  process.exit(0);
}

// A shallow clone has no history to resolve `last_checked` against, and
// `actions/checkout` defaults to depth 1 -- as does the `git clone --depth 1`
// a contributor reasonably reaches for. In that state every doc's lookup
// raises, and this used to abort on the FIRST one with a raw git fatal printed
// inside an otherwise green ci.sh run. Say what is wrong once, and say what
// fixes it, rather than failing eight times in a language only git speaks.
let shallow = false;
try {
  shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
} catch {
  // Not a git repo, or a git too old for the flag. Fall through to the
  // per-document handling below, which reports rather than assumes.
}
if (shallow) {
  console.log(
    "doc reconciliation: skipped — this is a shallow clone, so the recorded\n" +
      "last_checked commits are not present. Run `git fetch --unshallow` (or\n" +
      "check out with fetch-depth: 0) to get the report."
  );
  process.exit(0);
}

const owed = [];
const unresolved = [];
for (const [doc, spec] of Object.entries(manifest.docs)) {
  const since = spec.last_checked;
  let commits;
  try {
    // What moved in this doc's SUBJECTS since it was last read against them.
    // Not the doc itself: editing a document does not make it true, and a doc
    // that is merely reworded is still owed a reading against code that moved.
    commits = git(["log", "--oneline", `${since}..HEAD`, "--", ...spec.subjects])
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    // One unreadable ref is not a reason to stop reading the other documents.
    // Collect it and carry on; the exit code below still reports the failure.
    unresolved.push(`${doc}: cannot resolve last_checked "${since}" — ${String(e).slice(0, 120)}`);
    continue;
  }
  if (commits.length > 0) owed.push({ doc, since, commits, why: spec.why });
}

if (unresolved.length > 0) {
  for (const u of unresolved) console.error(u);
  console.error(
    `\n${unresolved.length} document(s) could not be checked. If this is a shallow\n` +
      "clone, `git fetch --unshallow` fixes it; otherwise the recorded commit is gone."
  );
}

if (owed.length === 0) {
  const n = Object.keys(manifest.docs).length - unresolved.length;
  console.log(`doc reconciliation: all ${n} readable document(s) current.`);
  // An unreadable ref is a failure of the check, not a clean bill of health —
  // reporting "all current" over documents nothing could read is exactly the
  // false green this script exists to prevent.
  process.exit(unresolved.length > 0 ? 2 : 0);
}

console.log(`doc reconciliation — ${owed.length} document(s) owed a reading\n`);
for (const o of owed) {
  console.log(`  ${o.doc}`);
  console.log(`    last read against the code at ${o.since.slice(0, 7)}`);
  console.log(`    ${o.why}`);
  console.log(`    ${o.commits.length} commit(s) have touched its subjects since:`);
  for (const c of o.commits.slice(0, 5)) console.log(`      ${c}`);
  if (o.commits.length > 5) console.log(`      … and ${o.commits.length - 5} more`);
  console.log(
    `    when you have read it:  node scripts/doc_reconciliation.mjs --bless ${o.doc}\n`
  );
}

// Reporting by default and gating only on --check is deliberate. A hard failure
// on every commit that touches prompt_loop.ts would fire on nearly every change
// and be switched off within a month -- which is the reasoning
// conformance/contract_fixture_gate.sh already wrote down for its own scope.
process.exit(unresolved.length > 0 ? 2 : check ? 1 : 0);
