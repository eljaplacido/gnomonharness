/**
 * Check the file:line citations in an answer against the tree it describes.
 *
 * An independent review of a real gnomon audit run reached this verdict:
 *
 *   "claims about the code are accurate and well-cited; claims about its own
 *    tree state are asserted, not measured"
 *
 * `counters.tree_delta` answered the second half — the turn now measures what it
 * changed. This is the first half. A citation is the load-bearing part of any
 * audit answer: it is what lets a reader check the argument against the code,
 * and a reader who follows one to a line that does not exist has been told
 * something false in the most confidence-inspiring format available.
 *
 * Checking one costs a stat and a line count, and nothing was doing it.
 *
 * DELIBERATELY CONSERVATIVE. This reports; it never edits the model's answer,
 * and it never calls a citation broken when the evidence is ambiguous. A checker
 * that manufactures false accusations trains a reader to ignore it, which is
 * worse than no checker. An early version of the standalone tool called two
 * CORRECT citations "file not found" because one filename occurred twice in the
 * repository; that path is `ambiguous` here, not `broken`.
 */
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface CitationCheck {
  /** `path.ts:435`, as written in the answer. */
  raw: string;
  path: string;
  line: number;
  verdict: "ok" | "broken" | "ambiguous";
  /** Why it is broken, or the cited line's text when it is ok. */
  detail: string;
}

export interface CitationReport {
  checked: number;
  ok: number;
  broken: CitationCheck[];
  ambiguous: number;
}

/**
 * Extensions worth checking. Restricted on purpose: an answer mentioning
 * `1.5:1` or `08:30` must not be read as a citation and reported broken.
 */
const CITED = /\b([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|sh|toml|yaml|yml|json|md|sql|c|h|cpp|hpp))[:#](\d{1,6})\b/g;

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__"]);

/** Files matching a basename, bounded so a huge tree cannot stall a turn. */
function findByName(root: string, name: string, cap = 12): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= cap || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
      } else if (e.name === name) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Verify every citation in `answer` against `root`.
 *
 * Best-effort by construction: anything that throws is simply not reported,
 * because a turn must not fail over its own bookkeeping.
 */
export function checkCitations(answer: string, root: string): CitationReport {
  const report: CitationReport = { checked: 0, ok: 0, broken: [], ambiguous: 0 };
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CITED.lastIndex = 0;
  while ((m = CITED.exec(answer)) !== null) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const rel = m[1]!;
    const line = Number(m[2]);
    report.checked++;

    let file = resolve(root, rel);
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        const base = rel.split("/").pop()!;
        const cands = findByName(root, base);
        // Prefer one whose path ends with the whole cited fragment.
        const exact = cands.filter((c) => c.split(sep).join("/").endsWith(rel));
        const pool = exact.length > 0 ? exact : cands;
        if (pool.length === 1) {
          file = pool[0]!;
        } else if (pool.length === 0) {
          report.broken.push({ raw, path: rel, line, verdict: "broken", detail: "no such file" });
          continue;
        } else {
          report.ambiguous++;
          continue;
        }
      }
      const count = readFileSync(file, "utf8").split("\n").length;
      if (line < 1 || line > count) {
        report.broken.push({
          raw, path: rel, line, verdict: "broken",
          detail: `line ${line} is past the end (${count} lines)`,
        });
      } else {
        report.ok++;
      }
    } catch {
      // Unreadable: not the model's fault, and not evidence of anything.
      report.ambiguous++;
    }
  }
  return report;
}
