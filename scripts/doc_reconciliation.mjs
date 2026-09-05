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

const owed = [];
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
    console.error(
      `${doc}: cannot resolve last_checked "${since}" — ${String(e).slice(0, 120)}`
    );
    process.exit(2);
  }
  if (commits.length > 0) owed.push({ doc, since, commits, why: spec.why });
}

if (owed.length === 0) {
  console.log(
    `doc reconciliation: all ${Object.keys(manifest.docs).length} documents current.`
  );
  process.exit(0);
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
process.exit(check ? 1 : 0);
