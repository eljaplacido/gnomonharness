/**
 * gnomon-core: a task graph whose every step carries its own external check
 * (`gnomon task --graph <file>`, docs/CONTRACTS.md §64)
 *
 * The idea is borrowed from quantum error correction: detect an error in the
 * middle of the computation, at the step that made it, without throwing away
 * the steps that already finished. Each node of the graph declares what it may
 * change (`files`) and how it is judged (`check`); the coordinator in
 * gnomon-cli (graph_run.ts) runs ready nodes in clones of their own, judges
 * each one on its own, and merges the finished ones. What is here is the pure
 * part: reading and validating the graph file, the allow-list, the order.
 *
 * The graph file is TOML in gnomon's subset (CONTRACTS §5), one table per node:
 *
 *   [nodes.parser]
 *   instruction = "make the parser accept trailing commas"
 *   files = ["src/parser.ts", "test/parser/"]
 *   check = "npm test -- parser"
 *   deps = []            # optional: ids that must finish first
 *   role = "coder"       # optional: the role this node runs as
 */

import { posix } from "node:path";
import { parseToml } from "./config.js";

/** The keys a node table may hold. Anything else is refused: a misspelt `check` would leave a node unjudged. */
export const GRAPH_NODE_KEYS = ["instruction", "files", "check", "deps", "role"] as const;

export interface GraphNode {
  id: string;
  instruction: string;
  /** Repository-relative paths the node may change: a file, or a directory (everything under it). */
  files: string[];
  /** The node's external check, run in its clone and again on the merged tree. */
  check: string;
  deps: string[];
  role?: string;
}

export interface TaskGraph {
  /** In the file's order. */
  nodes: GraphNode[];
}

const ID = /^[A-Za-z0-9_-]+$/;

/** The graph, or every reason it cannot be run. Nothing is started on an error. */
export function parseTaskGraph(text: string): { graph: TaskGraph } | { errors: string[] } {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch (e) {
    return { errors: [(e as Error).message] };
  }
  const errors: string[] = [];
  for (const k of Object.keys(doc)) if (k !== "nodes") errors.push(`unknown top-level key or table "${k}" (a graph holds only [nodes.<id>] tables)`);
  const raw = doc.nodes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    errors.push("no nodes: declare at least one [nodes.<id>] table");
    return { errors };
  }
  const nodes: GraphNode[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const where = `[nodes.${id}]`;
    if (!ID.test(id)) errors.push(`${where}: an id is letters, digits, "_" and "-" only`);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`${where}: not a table`);
      continue;
    }
    const t = v as Record<string, unknown>;
    for (const k of Object.keys(t)) {
      if (!(GRAPH_NODE_KEYS as readonly string[]).includes(k)) errors.push(`${where}: unknown key "${k}" (known: ${GRAPH_NODE_KEYS.join(", ")})`);
    }
    const str = (k: string): string => (typeof t[k] === "string" ? (t[k] as string).trim() : "");
    const list = (k: string): string[] | null => {
      if (t[k] === undefined) return [];
      if (!Array.isArray(t[k]) || !(t[k] as unknown[]).every((x) => typeof x === "string" && x.trim() !== "")) return null;
      return (t[k] as string[]).map((x) => x.trim());
    };
    const instruction = str("instruction");
    const check = str("check");
    const files = list("files");
    const deps = list("deps");
    if (!instruction) errors.push(`${where}: needs an instruction`);
    if (!check) errors.push(`${where}: needs a check, the command that judges this node (a node with no check of its own is never run)`);
    if (files === null) errors.push(`${where}: files must be a list of paths`);
    else if (files.length === 0) errors.push(`${where}: needs files, the paths this node may change`);
    else
      for (const f of files) {
        if (!safeRelPath(f)) errors.push(`${where}: files entry "${f}" must be a path inside the repository (relative, no "..")`);
        else if (/^\.gnomon/.test(normalPath(f)) || normalPath(f) === ".tmp" || normalPath(f).startsWith(".tmp/")) {
          errors.push(`${where}: files entry "${f}" names gnomon's own files (.gnomon/, .gnomon-*, .tmp), which a node's change never includes`);
        }
      }
    if (deps === null) errors.push(`${where}: deps must be a list of node ids`);
    if (t.role !== undefined && !str("role")) errors.push(`${where}: role must be a role name`);
    nodes.push({ id, instruction, files: (files ?? []).map(normalPath), check, deps: deps ?? [], ...(str("role") ? { role: str("role") } : {}) });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) errors.push(`[nodes.${n.id}]: deps names "${d}", which the graph does not declare`);
      if (d === n.id) errors.push(`[nodes.${n.id}]: depends on itself`);
    }
  }
  if (errors.length === 0) {
    const order = topoOrder({ nodes });
    if (order.length !== nodes.length) {
      const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
      errors.push(`the deps form a cycle through: ${stuck.join(", ")}`);
    }
  }
  return errors.length > 0 ? { errors } : { graph: { nodes } };
}

/** "/"-separated, with "./", "//" and "." segments resolved and no trailing "/" ("" for the root). */
function normalPath(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "");
  return n === "." ? "" : n.replace(/^\.\//, "");
}

/** Whether paths compare without case: the default file systems of Windows and macOS do. */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function safeRelPath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return false;
  if (normalPath(n).split("/").some((s) => s === "..")) return false;
  return normalPath(n) !== "";
}

/**
 * True when `path` (repository-relative) is one of `files` or under one of
 * them. Without case on Windows and macOS, whose file systems fold it.
 */
export function pathAllowed(path: string, files: readonly string[], foldCase: boolean = FOLD_CASE): boolean {
  const fold = (s: string): string => (foldCase ? s.toLowerCase() : s);
  const p = fold(normalPath(path));
  return files.some((f0) => {
    const f = fold(normalPath(f0));
    return f !== "" && (p === f || p.startsWith(`${f}/`));
  });
}

/** The paths in `changed` that `files` does not allow, in the given order. */
export function outsideAllowList(changed: readonly string[], files: readonly string[], foldCase: boolean = FOLD_CASE): string[] {
  return changed.filter((p) => !pathAllowed(p, files, foldCase));
}

/**
 * Dependency order: Kahn's algorithm, ties broken by the file's order, so the
 * merge order is the same on every run. A node on a cycle is left out.
 */
export function topoOrder(graph: TaskGraph): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const n of graph.nodes) {
      if (done.has(n.id)) continue;
      if (n.deps.every((d) => done.has(d))) {
        done.add(n.id);
        out.push(n.id);
        progressed = true;
        break;
      }
    }
  }
  return out;
}

/** Every node that depends on `id`, directly or not, in the file's order. */
export function dependentsOf(graph: TaskGraph, id: string): string[] {
  const hit = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of graph.nodes) {
      if (!hit.has(n.id) && n.deps.some((d) => hit.has(d))) {
        hit.add(n.id);
        grew = true;
      }
    }
  }
  return graph.nodes.filter((n) => n.id !== id && hit.has(n.id)).map((n) => n.id);
}

/**
 * The instruction a failed node's one retry gets: the original, then what the
 * external judges said. Only outside evidence: the check's own output and the
 * paths the allow-list refused, never the model's account of itself.
 */
export function retryInstruction(node: GraphNode, failure: { outside: string[]; check_exit: number | null; output: string }): string {
  const parts = [node.instruction, "", "Your previous attempt at this step was checked and did not pass."];
  if (failure.outside.length > 0) {
    parts.push(
      `It changed files this step may not change: ${failure.outside.join(", ")}. Put them back as they were. This step may change only: ${node.files.join(", ")}.`
    );
  }
  if (failure.check_exit !== 0) {
    const out = failure.output.trim();
    parts.push(
      `The check \`${node.check}\` ${failure.check_exit === null ? "could not run to an exit code" : `exited ${failure.check_exit}`}.${out ? ` Its output (the last lines):\n\n\`\`\`\n${out}\n\`\`\`` : ""}`
    );
  }
  parts.push("Fix what the check found; keep the rest of your change.");
  return parts.join("\n");
}
