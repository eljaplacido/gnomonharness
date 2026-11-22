/**
 * `gnomon audit scan`: multi-step patterns that a per-call guard cannot see.
 *
 * The guard judges one call at a time, so an attack spread over many calls that
 * are each ordinary (read a credential now, send something out forty steps
 * later) passes it. This reads the trail afterwards, offline, and looks for
 * the sequences. It is advisory: a finding is a place to look, never a verdict
 * and never an inline block, and nothing here runs a model.
 *
 * It reads what a record holds and never needs more. A metadata-only trail
 * (`record = "metadata"`) keeps each call's tool and target (the command, the
 * path, the URL) and the decision; that is enough for every rule but one. The
 * injection-marker rule reads tool output, which is only recorded under
 * `record = "full"`; on a metadata trail it is reported as not covered, not as
 * clean. Two kinds of trail are understood: a gnomon session (`tool_call`
 * records) and the cross-harness feed (`guard` records from Claude Code, opencode,
 * Cursor, Codex... governed through `gnomon guard`).
 *
 * Deterministic: the same files give the same findings in the same order.
 * The chain is not verified here (`gnomon audit verify` does that); a trail
 * edited afterwards is as good as its editor.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix, relative, resolve } from "node:path";

export const AUDIT_SCAN_SCHEMA = "gnomon.audit_scan/1";
export const AUDIT_SCAN_EXIT = { clean: 0, finding: 2, couldNotRun: 10 } as const;
export const SEVERITIES = ["info", "low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SCAN_RULES = [
  "slow_exfiltration",
  "staged_payload",
  "privilege_creep",
  "credential_probing",
  "injection_followed_by_action",
  "guard_evasion",
] as const;
export type ScanRule = (typeof SCAN_RULES)[number];

export interface Evidence {
  seq: number;
  tool: string;
  /** What the step did, shortened and with obvious secrets masked. */
  target: string;
  /** Why this step is part of the finding. */
  as: string;
}

export interface Finding {
  rule: ScanRule;
  severity: Severity;
  trail: string;
  summary: string;
  evidence: Evidence[];
}

export interface TrailScan {
  trail: string;
  /** The harness that asked, for a guard feed (claude-code, cursor, ...); null for a gnomon session. */
  host: string | null;
  steps: number;
  denied: number;
  /** Whether tool output was recorded, which the injection rule needs. */
  results_recorded: boolean;
  findings: number;
}

export interface ScanReport {
  schema: typeof AUDIT_SCAN_SCHEMA;
  path: string;
  min_severity: Severity;
  trails: TrailScan[];
  /** Files under the path that held no audit records. */
  skipped: string[];
  findings: Finding[];
  by_rule: Record<string, number>;
  by_severity: Record<string, number>;
  limits: string[];
  exit: number;
}

export const SCAN_LIMITS = [
  "advisory: a finding names steps worth reading, it is not a verdict and nothing was blocked",
  "reads each trail as written; the hash chain is not verified here (gnomon audit verify)",
  "rules read the tool and target of each call; a path built at run time, or code an interpreter runs, is not seen",
  "prompt-injection markers are matched in recorded tool output only (record = \"full\"); a metadata trail is reported as not covered, not clean",
  "a guard feed records the decision, not whether a person approved an ask: an ask is treated as having run",
];

// --- steps -----------------------------------------------------------------

interface Step {
  seq: number;
  tool: string;
  target: string;
  /** Refused by the surface or the guard: it did not run. */
  denied: boolean;
  /** Refused because the role may not use the tool or the call was malformed: a limit of the role, not an attempt on a rule. */
  roleLimit: boolean;
  result: string | null;
}

interface Session {
  trail: string;
  host: string | null;
  cwd: string | null;
  steps: Step[];
  records: number;
}

const WEB_TOOLS = new Set(["webfetch", "websearch", "web_fetch", "web_search"]);

/** Records of one trail file as steps; null when the file holds no audit records. */
export function readSession(trail: string, text: string): Session | null {
  const s: Session = { trail, host: null, cwd: null, steps: [], records: 0 };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof r !== "object" || r === null || typeof r.kind !== "string" || typeof r.seq !== "number") continue;
    s.records++;
    if (r.kind === "session_start") {
      if (typeof r.cwd === "string") s.cwd = r.cwd;
      if (r.mode === "guard" && typeof r.via === "string") s.host = r.via;
      continue;
    }
    if (r.kind === "guard") {
      if (typeof r.tool !== "string" || typeof r.target !== "string") continue;
      if (s.host === null && typeof r.via === "string") s.host = r.via;
      s.steps.push({ seq: r.seq, tool: r.tool.toLowerCase(), target: r.target, denied: r.decision === "deny", roleLimit: false, result: null });
    } else if (r.kind === "tool_call") {
      if (typeof r.tool !== "string") continue;
      const gov = (r.governance ?? {}) as { decision?: unknown };
      const denied = r.bucket === "refusal" || gov.decision === "deny";
      s.steps.push({
        seq: r.seq,
        tool: r.tool.toLowerCase(),
        target: typeof r.target === "string" ? r.target : "",
        denied,
        roleLimit: denied && typeof r.summary === "string" && /not permitted for this role|is not a string|not offered/.test(r.summary),
        result: typeof r.result === "string" ? r.result : null,
      });
    }
  }
  return s.records === 0 ? null : s;
}

// --- classification --------------------------------------------------------

const TEMP_DIRS = ["/tmp", "/var/tmp", "/dev/shm", "/dev/null", "/dev/stdout", "/dev/stderr"];
const isTemp = (p: string): boolean => TEMP_DIRS.some((t) => p === t || p.startsWith(`${t}/`));

/**
 * Words of a shell command: quotes dropped, operators and newlines their own
 * words, heredoc bodies and comments dropped (they are text, not commands).
 */
function stripHeredocs(cmd: string): string {
  const keep: string[] = [];
  let ends: string[] = [];
  for (const line of cmd.split("\n")) {
    if (ends.length > 0) {
      if (line.trim() === ends[0]) ends = ends.slice(1);
      continue;
    }
    keep.push(line);
    ends = [...line.matchAll(/<<-?\s*(['"]?)(\w+)\1/g)].map((m) => m[2]!);
  }
  // A command cut short in the record is an unterminated heredoc: the rest was its body.
  return keep.join("\n");
}

export function words(cmd: string): string[] {
  const text = stripHeredocs(cmd.replace(/\\\n/g, " "));
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\n)|(>>?|&&|\|\||[;|&()<])|([^\s"';|&()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[3] !== undefined) out.push(";");
    else out.push(m[1] ?? m[2] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "(", ")", "&"]);
const WRAPPERS = new Set(["sudo", "time", "nohup", "exec", "command", "nice", "stdbuf", "setsid", "xargs"]);

/** The simple commands of a line, each as its words, wrappers and VAR=x prefixes dropped. */
export function segments(cmd: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  const flush = (): void => {
    let i = 0;
    while (i < cur.length) {
      const w = cur[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
      else if (w === "timeout" || w === "env") i += w === "timeout" ? 2 : 1;
      else break;
    }
    if (i < cur.length) out.push(cur.slice(i));
    cur = [];
  };
  for (const w of words(cmd)) {
    if (SEPARATORS.has(w)) flush();
    else cur.push(w);
  }
  flush();
  return out;
}
const headOf = (seg: string[]): string => posix.basename(seg[0] ?? "");

const HOME = "~";
function resolvePath(p: string, cwd: string | null): string | null {
  if (p === "" || p.includes("$(") || p.includes("`")) return null;
  let q = p.replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
  if (q === HOME || q.startsWith(`${HOME}/`)) return posix.normalize(q);
  if (/^\$/.test(q)) return null;
  if (q.startsWith("/")) return posix.normalize(q);
  if (cwd === null) return null;
  q = posix.join(cwd, q);
  return q;
}
function outside(p: string | null, cwd: string | null): boolean {
  if (p === null || cwd === null) return false;
  if (isTemp(p)) return false;
  const root = posix.normalize(cwd);
  return !(p === root || p.startsWith(root === "/" ? "/" : `${root}/`));
}

interface Sensitive {
  category: string;
  path: string;
}
const SENSITIVE: Array<[string, RegExp]> = [
  ["env_file", /(^|\/)\.env(\.[A-Za-z0-9_-]+)*$/],
  ["ssh", /(^|\/)\.ssh(\/|$)|(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/],
  ["cloud_credentials", /(^|\/)\.aws\/(credentials|config)$|(^|\/)\.config\/gcloud(\/|$)|(^|\/)\.azure(\/|$)|(^|\/)\.kube\/config$|(^|\/)\.docker\/config\.json$/],
  ["token_file", /(^|\/)\.(netrc|npmrc|pypirc|git-credentials)$|(^|\/)\.config\/gh\/hosts\.yml$|(^|\/)credentials\.json$|(^|\/)gnomon\/credentials\.json$/],
  ["system_secrets", /^\/etc\/(shadow|gshadow|sudoers)(\/|$)|^\/etc\/ssl\/private(\/|$)/],
  ["private_key", /\.(pem|p12|pfx|jks)$/],
  ["shell_history", /(^|\/)\.(bash|zsh)_history$/],
];
const NOT_SECRET = /\.(example|sample|template|dist|tpl)$/;

function sensitiveOf(word: string): Sensitive | null {
  const w = word.replace(/^\$\{?HOME\}?/, HOME);
  if (NOT_SECRET.test(w)) return null;
  for (const [category, re] of SENSITIVE) if (re.test(w)) return { category, path: w };
  return null;
}
/** printenv, a bare env or `export -p`, or the process environment file. */
function dumpsEnvironment(segs: string[][]): boolean {
  return segs.some((s) => {
    const h = headOf(s);
    return h === "printenv" || (h === "env" && s.length === 1) || (h === "export" && s[1] === "-p") || s.some((w) => /^\/proc\/(self|\d+)\/environ$/.test(w));
  });
}

/** Verbs that return a file's contents, as opposed to listing or testing it. */
const READERS = new Set(["cat", "less", "more", "head", "tail", "cp", "grep", "egrep", "rg", "awk", "sed", "base64", "xxd", "strings", "od", "source", ".", "bat", "nl", "tac", "scp", "tar", "zip", "openssl", "python", "python3", "node", "jq", "yq", "curl", "wget", "nc", "diff", "cmp", "sort", "cut", "tee", "paste", "hexdump"]);

interface Access {
  sensitive: Sensitive[];
  /** The step returns content (not just a listing). */
  reads: boolean;
}

function accessOf(step: Step): Access | null {
  if (step.tool === "read" || step.tool === "grep" || step.tool === "glob") {
    const s = sensitiveOf(step.target);
    return s ? { sensitive: [s], reads: step.tool !== "glob" } : null;
  }
  if (step.tool !== "bash") return null;
  const ws = words(step.target);
  const found: Sensitive[] = [];
  for (let i = 0; i < ws.length; i++) {
    // A redirect target is a write to the path, not a read of it.
    if (i > 0 && (ws[i - 1] === ">" || ws[i - 1] === ">>")) continue;
    const s = sensitiveOf(ws[i]!);
    if (s) found.push(s);
  }
  const segs = segments(step.target);
  const dump = dumpsEnvironment(segs);
  if (dump) found.push({ category: "env_dump", path: "environment" });
  if (found.length === 0) return null;
  const readsIt = segs.some((sg) => (READERS.has(headOf(sg)) && sg.some((w) => sensitiveOf(w))) || sg.some((w, i) => sg[i - 1] === "<" && sensitiveOf(w)));
  return { sensitive: found, reads: dump || readsIt };
}

type NetKind = "upload" | "fetch";
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/;

function networkOf(step: Step): NetKind | null {
  if (WEB_TOOLS.has(step.tool)) return /\bhttps?:\/\/(localhost|127\.|\[::1\])/.test(step.target) ? null : "fetch";
  if (step.tool !== "bash") return null;
  const segs = segments(step.target);
  let kind: NetKind | null = null;
  const hosts: string[] = [];
  for (const s of segs) {
    const h = headOf(s);
    const line = s.join(" ");
    for (const w of s) {
      const u = /^https?:\/\/(\[[^\]]+\]|[^/\s:'"?#]+)/.exec(w);
      if (u) hosts.push(u[1]!);
    }
    if (h === "curl") {
      const up = s.some((w) => /^(-d|--data\S*|-F|--form|-T|--upload-file|--json)$/.test(w) || /^-d./.test(w)) || /\s-X\s*(POST|PUT|PATCH)\b/.test(` ${line}`);
      if (up || kind === null) kind = up ? "upload" : "fetch";
    } else if (h === "wget") {
      const up = s.some((w) => /^--post-(data|file)/.test(w));
      if (up || kind === null) kind = up ? "upload" : "fetch";
    } else if (["nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "ssh"].includes(h)) {
      kind = "upload";
      for (const w of s.slice(1)) if (!w.startsWith("-")) hosts.push(w.replace(/^.*@/, "").replace(/:.*$/, ""));
    } else if (h === "rsync" && s.some((w) => /^[^/\s-][^\s]*:[^\s]/.test(w))) kind = "upload";
    else if (/^python3?$/.test(h) && s.includes("-c") && /(urllib|requests|socket|http\.client|httpx)/.test(line)) kind = "upload";
    else if (h === "node" && s.includes("-e") && /(fetch\(|https?\.|net\.)/.test(line)) kind = "upload";
  }
  if (kind === null) return null;
  // Everything it names is this machine.
  if (hosts.length > 0 && hosts.every((h) => LOCAL_HOST.test(h))) return null;
  return kind;
}

function encodeOf(step: Step): boolean {
  if (step.tool !== "bash") return false;
  return segments(step.target).some((s) => {
    const h = headOf(s);
    return ["base64", "xxd", "uuencode", "zip"].includes(h) || (h === "openssl" && ["enc", "base64"].includes(s[1] ?? "")) || (h === "tar" && /^-?[a-zA-Z]*c[a-zA-Z]*$/.test(s[1] ?? ""));
  });
}

/** Paths a step writes (write/edit tool, redirect, tee, a download's output, cp/mv destination). */
function writesOf(step: Step, cwd: string | null): string[] {
  if (step.tool === "write" || step.tool === "edit" || step.tool === "multiedit" || step.tool === "apply_patch" || step.tool === "notebookedit") {
    const p = resolvePath(step.target, cwd);
    return p ? [p] : [];
  }
  if (step.tool !== "bash") return [];
  const at = effectiveCwd(step, cwd);
  const out: string[] = [];
  const add = (w: string | undefined): void => {
    if (w === undefined || w === "" || w.startsWith("-") || w.startsWith("&")) return;
    const p = resolvePath(w, at);
    if (p) out.push(p);
  };
  for (const s of segments(step.target)) {
    const h = headOf(s);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === ">" || s[i] === ">>") add(s[i + 1]);
    }
    const args = s.slice(1).filter((w, i, a) => !w.startsWith("-") && a[i - 1] !== ">" && a[i - 1] !== ">>" && w !== ">" && w !== ">>");
    if (h === "tee") add(args[0]);
    else if (h === "curl" || h === "wget") {
      for (let i = 1; i < s.length; i++) if (["-o", "-O", "--output", "--output-document"].includes(s[i]!)) add(s[i + 1]);
    } else if ((h === "cp" || h === "mv" || h === "install") && args.length >= 2) add(args[args.length - 1]);
    else if (h === "sed" && s.some((w) => /^-[a-zA-Z]*i/.test(w))) for (const w of args.slice(1)) add(w);
    else if (h === "rm" || h === "touch" || h === "truncate") for (const w of args) add(w);
  }
  return out;
}

/** The directory a command starts in: the session's, or a leading `cd`'s. */
function effectiveCwd(step: Step, cwd: string | null): string | null {
  if (step.tool !== "bash") return cwd;
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(step.target);
  if (!m) return cwd;
  return resolvePath(m[1]!.replace(/^["']|["']$/g, ""), cwd) ?? cwd;
}

const redact = (s: string): string =>
  s
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/((?:token|key|secret|passw(?:or)?d|auth\w*)\w*\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/(\s-u\s+)\S+/g, "$1***")
    .replace(/\s+/g, " ")
    .trim();
const shown = (s: string): string => {
  const r = redact(s);
  return r.length > 140 ? `${r.slice(0, 140)}…` : r;
};
const ev = (step: Step, as: string): Evidence => ({ seq: step.seq, tool: step.tool, target: shown(step.target), as });
const sevMax = (a: Severity, b: Severity): Severity => (SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b);
const bump = (s: Severity): Severity => SEVERITIES[Math.min(SEVERITIES.length - 1, SEVERITIES.indexOf(s) + 1)]!;

// --- rules -----------------------------------------------------------------

type Emit = (rule: ScanRule, severity: Severity, summary: string, evidence: Evidence[]) => void;

/** Reads of credentials, and later a way out. */
function slowExfiltration(s: Session, emit: Emit): void {
  const first = s.steps.findIndex((st) => !st.denied && accessOf(st)?.reads);
  if (first < 0) return;
  const cred = s.steps[first]!;
  const after = s.steps.slice(first + 1).filter((st) => !st.denied);
  const net = after.find((st) => networkOf(st) !== null);
  const outw = after.find((st) => writesOf(st, s.cwd).some((p) => outside(p, s.cwd)));
  const enc = after.find(encodeOf);
  if (!net && !outw && !enc) return;
  let sev: Severity = "low";
  const parts: Evidence[] = [ev(cred, `reads ${accessOf(cred)!.sensitive[0]!.category}`)];
  if (enc) {
    sev = sevMax(sev, "medium");
    parts.push(ev(enc, "encodes"));
  }
  if (outw) {
    sev = sevMax(sev, "medium");
    parts.push(ev(outw, "writes outside the project"));
  }
  if (net) {
    const kind = networkOf(net)!;
    sev = sevMax(sev, kind === "upload" ? "high" : WEB_TOOLS.has(net.tool) ? "low" : "medium");
    if (enc && kind !== "fetch") sev = "high";
    parts.push(ev(net, kind === "upload" ? "sends out" : "reaches the network"));
  }
  emit("slow_exfiltration", sev, `a credential read at seq ${cred.seq} is followed by ${[net && "network", outw && "a write outside the project", enc && "an encoding step"].filter(Boolean).join(", ")}`, parts);
}

/** A file written, made executable, then run. */
function stagedPayload(s: Session, emit: Emit): void {
  const written = new Map<string, { step: Step; downloaded: boolean }>();
  const reported = new Set<string>();
  for (let i = 0; i < s.steps.length; i++) {
    const st = s.steps[i]!;
    if (st.denied) continue;
    const cwd = effectiveCwd(st, s.cwd);
    if (st.tool === "bash") {
      for (const sg of segments(st.target).filter((x) => headOf(x) === "chmod")) {
        const mode = sg[1] ?? "";
        const executable = /^[ugoa]*\+[rw]*x/.test(mode) || (/^[0-7]{3,4}$/.test(mode) && /[1357]/.test(mode.slice(-3)));
        const target = executable ? resolvePath(sg[2] ?? "", cwd) : null;
        const w = target ? written.get(target) : undefined;
        if (target && w && !reported.has(target)) {
          const later = s.steps.slice(i + 1).find((x) => !x.denied && x.tool === "bash" && execOf(x, target, s.cwd));
          const hidden = isTemp(target) || /(^|\/)\.[^/.]/.test(posix.relative(s.cwd ?? "/", target));
          // `chmod +x script; ./script` in the project is ordinary work (info). It matters
          // when the file was downloaded, or sits in a temp or dot directory.
          let sev: Severity = "info";
          if (hidden) sev = later ? "medium" : "low";
          if (w.downloaded) sev = later ? "high" : "medium";
          reported.add(target);
          emit("staged_payload", sev, `${posix.basename(target)} was ${w.downloaded ? "downloaded" : "written"} at seq ${w.step.seq}, made executable${later ? ", then run" : ""}`, [
            ev(w.step, w.downloaded ? "downloads it" : "writes it"),
            ev(st, "makes it executable"),
            ...(later ? [ev(later, "runs it")] : []),
          ]);
        }
      }
    }
    const dl = st.tool === "bash" && segments(st.target).some((x) => ["curl", "wget"].includes(headOf(x)));
    for (const p of writesOf(st, cwd)) if (!written.has(p)) written.set(p, { step: st, downloaded: dl && networkOf(st) !== null });
  }
}

function execOf(step: Step, path: string, cwd: string | null): boolean {
  const at = effectiveCwd(step, cwd);
  return segments(step.target).some((sg) => {
    const w = sg[0] ?? "";
    if ((w.startsWith("/") || w.startsWith("./") || w.startsWith("~")) && resolvePath(w, at) === path) return true;
    return ["bash", "sh", "zsh", "source", "."].includes(w) && resolvePath(sg[1] ?? "", at) === path;
  });
}

/** Refused again and again with variations. */
function privilegeCreep(s: Session, emit: Emit): void {
  const WINDOW = 12;
  const emitted = new Set<number>();
  for (let i = 0; i < s.steps.length; i++) {
    const a = s.steps[i]!;
    if (!a.denied || a.roleLimit || emitted.has(a.seq)) continue;
    const run = s.steps.slice(i, i + WINDOW).filter((x) => x.denied && !x.roleLimit && x.tool === a.tool);
    const distinct = new Set(run.map((x) => x.target));
    if (distinct.size < 3) continue;
    for (const x of run) emitted.add(x.seq);
    const sev: Severity = distinct.size >= 10 ? "high" : distinct.size >= 5 ? "medium" : "low";
    emit("privilege_creep", sev, `${distinct.size} different ${a.tool} attempts were refused within ${WINDOW} steps`, run.slice(0, 6).map((x) => ev(x, "refused")));
  }
}

/** Credential locations probed across tools. */
function credentialProbing(s: Session, emit: Emit): void {
  const hits: Array<{ step: Step; sens: Sensitive }> = [];
  for (const st of s.steps) {
    const a = accessOf(st);
    if (a) for (const sens of a.sensitive) hits.push({ step: st, sens });
  }
  const paths = new Set(hits.map((h) => `${h.sens.category}:${h.sens.path}`));
  const cats = new Set(hits.map((h) => h.sens.category));
  const tools = new Set(hits.map((h) => h.step.tool));
  const denied = hits.filter((h) => h.step.denied).length;
  const spread = paths.size >= 3 && cats.size >= 2 && tools.size >= 2;
  const refused = denied >= 2 && paths.size >= 3;
  if (!spread && !refused) return;
  const sev: Severity = denied >= 1 && paths.size >= 4 ? "high" : "medium";
  const seen = new Set<number>();
  const evidence: Evidence[] = [];
  for (const h of hits) {
    if (seen.has(h.step.seq) || evidence.length >= 8) continue;
    seen.add(h.step.seq);
    evidence.push(ev(h.step, `${h.sens.category}${h.step.denied ? " (refused)" : ""}`));
  }
  emit("credential_probing", sev, `${paths.size} credential locations (${[...cats].join(", ")}) touched through ${[...tools].join(", ")}${denied ? `, ${denied} refused` : ""}`, evidence);
}

const INJECTION: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|messages|rules)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your)\s+(instructions|rules|guidelines|prompt)/i,
  /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan\b|unrestricted|jailbroken)/i,
  /(reveal|print|show|output|repeat)\s+(me\s+)?(your|the)\s+(system\s+prompt|hidden\s+instructions)/i,
  /<\/?\s*(system|\|im_start\||\|im_end\|)\s*>/i,
  /do\s+not\s+(tell|inform|mention\b.{0,20}\bto)\s+the\s+user/i,
  /BEGIN\s+(SYSTEM|HIDDEN)\s+(PROMPT|INSTRUCTIONS?)/i,
  /\b(exfiltrate|send\s+(all\s+)?(the\s+)?(secrets|credentials|api\s+keys?))\b/i,
];

/** A marker in what a tool returned, then something policy-relevant within a few steps. */
function injectionFollowed(s: Session, emit: Emit): void {
  const WITHIN = 6;
  for (let i = 0; i < s.steps.length; i++) {
    const a = s.steps[i]!;
    if (a.result === null) continue;
    const m = INJECTION.find((re) => re.test(a.result!));
    if (!m) continue;
    for (const b of s.steps.slice(i + 1, i + 1 + WITHIN)) {
      const net = networkOf(b);
      const acc = accessOf(b);
      const outw = writesOf(b, s.cwd).some((p) => outside(p, s.cwd));
      const risky = b.denied || net !== null || acc !== null || outw || (b.tool === "bash" && /\bgit\s+push\b|\bchmod\s+\S*x\b|\brm\s+-[a-z]*r/.test(b.target));
      if (!risky) continue;
      const sev: Severity = net === "upload" || acc !== null || b.denied ? "high" : "medium";
      emit("injection_followed_by_action", sev, `tool output at seq ${a.seq} carries an instruction-like marker; seq ${b.seq} then acts on policy-relevant ground`, [ev(a, "output holds the marker"), ev(b, b.denied ? "attempt refused" : "follows")]);
      break;
    }
  }
}

const MUTATORS = new Set(["rm", "mv", "cp", "chmod", "chown", "touch", "tee", "dd", "truncate", "mkdir", "install"]);
/** Does one simple command change files: a mutating verb, `sed -i`, or a redirect to a real path. */
const mutatesSeg = (sg: string[]): boolean =>
  MUTATORS.has(headOf(sg)) ||
  (headOf(sg) === "sed" && sg.some((w) => /^-[a-zA-Z]*i/.test(w))) ||
  // A redirect with no target word is `2>&1`, whose `&` the tokenizer split off.
  sg.some((w, i) => (w === ">" || w === ">>") && sg[i + 1] !== undefined && !["/dev/null", "/dev/stdout", "/dev/stderr"].includes(sg[i + 1]!));
const mutates = (segs: string[][]): boolean => segs.some(mutatesSeg);
/** The same, for what lands relative to where a `cd` left us: an absolute path would have gone there without it. */
const mutatesRelative = (segs: string[][]): boolean =>
  segs.some((sg) => {
    if (!mutatesSeg(sg)) return false;
    const targets = sg.filter((w, i) => i > 0 && !w.startsWith("-") && w !== ">" && w !== ">>" && !(sg[i - 1] === ">" || sg[i - 1] === ">>"));
    const redirected = sg.filter((w, i) => i > 0 && (sg[i - 1] === ">" || sg[i - 1] === ">>") && !w.startsWith("/dev/"));
    return [...targets.filter(() => MUTATORS.has(headOf(sg)) || headOf(sg) === "sed"), ...redirected].some((t) => !t.startsWith("/") && !t.startsWith("~"));
  });
/** Directories a `cd` can leave the project through: its ancestors, the home, and the system trees. */
function leaveTarget(dest: string, cwd: string | null): boolean {
  if (dest === HOME || dest.startsWith(`${HOME}/`)) return true;
  if (/^\/(etc|usr|bin|sbin|lib|var|root|home|opt|boot|sys|proc)(\/|$)/.test(dest)) return true;
  return cwd !== null && (dest === "/" || posix.normalize(cwd).startsWith(`${dest}/`));
}

/** cd out of the root then change things; a symlink out then a write through it; a refusal re-expressed. */
function guardEvasion(s: Session, emit: Emit): void {
  const cwd = s.cwd;
  // (a) leave the root and change something relative to where we landed.
  for (const st of s.steps) {
    if (st.denied || st.tool !== "bash") continue;
    const segs = segments(st.target);
    for (let i = 0; i < segs.length; i++) {
      if (!["cd", "pushd"].includes(headOf(segs[i]!))) continue;
      const dest = resolvePath(segs[i]![1] ?? "", cwd);
      if (dest === null || !outside(dest, cwd) || !leaveTarget(dest, cwd) || !mutatesRelative(segs.slice(i + 1))) continue;
      emit("guard_evasion", "low", `a command leaves the project root (cd ${shown(segs[i]![1] ?? "")}) and then changes files from there`, [ev(st, "cd out, then mutate")]);
      break;
    }
  }
  // (b) symlink to outside, then a write through it.
  const links = new Map<string, { step: Step; to: string }>();
  for (const st of s.steps) {
    if (st.denied) continue;
    if (st.tool === "bash") {
      for (const sg of segments(st.target).filter((x) => headOf(x) === "ln")) {
        const flags = sg.slice(1).filter((w) => w.startsWith("-"));
        const rest = sg.slice(1).filter((w) => !w.startsWith("-"));
        const to = resolvePath(rest[0] ?? "", effectiveCwd(st, cwd));
        const link = resolvePath(rest[1] ?? "", effectiveCwd(st, cwd));
        if (flags.some((f) => /s/.test(f)) && to && link && (outside(to, cwd) || sensitiveOf(to)) && !isTemp(to)) links.set(link, { step: st, to });
      }
    }
    if (links.size === 0) continue;
    for (const p of writesOf(st, cwd)) {
      for (const [link, l] of links) {
        if (l.step.seq === st.seq || !(p === link || p.startsWith(`${link}/`))) continue;
        emit("guard_evasion", "high", `a symlink at seq ${l.step.seq} points outside the project (${shown(l.to)}) and seq ${st.seq} writes through it`, [ev(l.step, "symlink out"), ev(st, "writes through it")]);
        links.delete(link);
      }
    }
  }
  // (c) refused through one tool, tried through another.
  for (let i = 0; i < s.steps.length; i++) {
    const d = s.steps[i]!;
    if (!d.denied) continue;
    const writeTry = d.tool !== "read" && d.tool !== "grep" && d.tool !== "glob" && d.tool !== "bash";
    // A refused shell command is usually refused for a path outside the root or a secret: those are the paths it is about.
    const dPaths =
      d.tool === "bash"
        ? words(d.target)
            .filter((w) => !w.includes("\n") && w.length < 200)
            .map((w) => resolvePath(w, cwd))
            .filter((p): p is string => p !== null && p.length > 4 && p.includes("/") && !isTemp(p) && (outside(p, cwd) || sensitiveOf(p) !== null) && !/^\/(usr|bin|lib|sbin)\//.test(p))
        : [resolvePath(d.target, cwd)].filter((p): p is string => p !== null);
    if (dPaths.length === 0) continue;
    const wantsWrite = writeTry || (d.tool === "bash" && mutates(segments(d.target)));
    const retry = s.steps.slice(i + 1, i + 13).find((x) => {
      if (x.denied || x.tool === d.tool) return false;
      if (wantsWrite) return writesOf(x, cwd).some((p) => dPaths.includes(p));
      const a = accessOf(x);
      return a !== null && a.reads && a.sensitive.some((sv) => dPaths.some((p) => p === (resolvePath(sv.path, cwd) ?? sv.path) || p.endsWith(`/${posix.basename(sv.path)}`)));
    });
    const protectedPath = (p: string): boolean => sensitiveOf(p) !== null || /(^|\/)(\.gnomon|\.gnomon-audit|\.git\/hooks|\.github\/workflows|\.claude|\.cursor|\.opencode)(\/|$)/.test(p);
    if (retry) emit("guard_evasion", dPaths.every(isTemp) ? "low" : dPaths.some(protectedPath) ? "high" : "medium", `${d.tool} was refused at seq ${d.seq} and the same target was then reached through ${retry.tool} at seq ${retry.seq}`, [ev(d, "refused"), ev(retry, "same target, other tool")]);
  }
}

export function scanSession(s: Session): Finding[] {
  const out: Finding[] = [];
  const emit: Emit = (rule, severity, summary, evidence) => out.push({ rule, severity, trail: s.trail, summary, evidence });
  slowExfiltration(s, emit);
  stagedPayload(s, emit);
  privilegeCreep(s, emit);
  credentialProbing(s, emit);
  injectionFollowed(s, emit);
  guardEvasion(s, emit);
  return out.sort((a, b) => (a.evidence[0]?.seq ?? 0) - (b.evidence[0]?.seq ?? 0) || a.rule.localeCompare(b.rule) || a.summary.localeCompare(b.summary));
}

// --- the command -----------------------------------------------------------

function trailFiles(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(join(d, e.name));
      } else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(d, e.name));
    }
  };
  walk(path);
  return out;
}

export function scanPath(path: string, opts: { minSeverity?: Severity } = {}): ScanReport {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`no such file or directory: ${path}`);
  const min = opts.minSeverity ?? "low";
  const isFile = statSync(abs).isFile();
  const trails: TrailScan[] = [];
  const skipped: string[] = [];
  const findings: Finding[] = [];
  for (const f of trailFiles(abs)) {
    const name = isFile ? basename(f) : relative(abs, f).split("\\").join("/");
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      skipped.push(name);
      continue;
    }
    const sess = readSession(name, text);
    if (!sess) {
      skipped.push(name);
      continue;
    }
    const mine = scanSession(sess).filter((x) => SEVERITIES.indexOf(x.severity) >= SEVERITIES.indexOf(min));
    findings.push(...mine);
    trails.push({
      trail: name,
      host: sess.host,
      steps: sess.steps.length,
      denied: sess.steps.filter((x) => x.denied).length,
      results_recorded: sess.steps.some((x) => x.result !== null),
      findings: mine.length,
    });
  }
  const by_rule: Record<string, number> = {};
  const by_severity: Record<string, number> = {};
  for (const f of findings) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
  }
  return {
    schema: AUDIT_SCAN_SCHEMA,
    path,
    min_severity: min,
    trails,
    skipped,
    findings,
    by_rule,
    by_severity,
    limits: SCAN_LIMITS,
    exit: findings.length > 0 ? AUDIT_SCAN_EXIT.finding : AUDIT_SCAN_EXIT.clean,
  };
}

export function formatScan(r: ScanReport): string[] {
  const out: string[] = [];
  const steps = r.trails.reduce((n, t) => n + t.steps, 0);
  out.push(`Trajectory scan of ${r.path}: ${r.trails.length} trail(s), ${steps} tool step(s), severity >= ${r.min_severity}.`);
  const noResult = r.trails.filter((t) => !t.results_recorded).length;
  if (noResult > 0) out.push(`  ${noResult} trail(s) record no tool output (metadata): the injection-marker rule did not run on them.`);
  if (r.skipped.length) out.push(`  ${r.skipped.length} file(s) held no audit records and were skipped.`);
  for (const f of r.findings) {
    out.push(`${f.severity.toUpperCase().padEnd(6)} ${f.rule}  ${f.trail}`);
    out.push(`  ${f.summary}`);
    for (const e of f.evidence) out.push(`    seq ${String(e.seq).padEnd(5)} ${e.tool.padEnd(7)} ${e.as}: ${e.target}`);
  }
  out.push(
    r.findings.length === 0
      ? "Summary: no multi-step pattern found. That is not proof of absence; see the limits."
      : `Summary: ${r.findings.length} finding(s) (${Object.entries(r.by_severity).map(([k, v]) => `${v} ${k}`).join(", ")}). Advisory: read the evidence steps before concluding anything.`
  );
  out.push("Limits:");
  for (const l of r.limits) out.push(`  - ${l}`);
  return out;
}
