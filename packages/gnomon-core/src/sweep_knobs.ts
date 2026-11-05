/**
 * Sweep knobs: six opt-in surface settings, one per long-task hypothesis, so
 * an adaptive benchmark sweep can test each as a change to the hashed surface
 * rather than as a code branch. docs/CONTRACTS.md §32,
 * conformance/sweep_knobs.json.
 *
 * Where they come from: the P2G41 root causes (2026-11-05) and the graded
 * long-task research notes of the same day.
 *
 * | knob | key | absent means |
 * |---|---|---|
 * | reasoning effort | `[endpoints.<name>] reasoning_effort`, `[roles.<r>] reasoning_effort` | no field is sent |
 * | sampling passthrough | `[endpoints.<name>] sampling = "provider"`, `[roles.<r>] temperature`/`top_p = "provider"` | the role's numbers are sent |
 * | environment snapshot | `[context] env_snapshot = true` | nothing runs before the first call |
 * | enforced todos | `[turn] todo_gate = true` | an answer with open todos ends the turn |
 * | edit variant | tools.toml `[[tools]] name = "edit"`, `variant = "compat"` | `old_text`/`new_text`, exact match only |
 * | package-index allowlist | `[sandbox] allow_package_index = [hosts]` | `network = false` refuses every URL |
 *
 * Each knob's absent value, and its default value declared, leave every
 * request body byte-identical to master's (sweep_knobs.test.ts pins the
 * hashes taken on ae17a1ae before this file existed).
 *
 * Everything here is pure: the loop, the tools and the shell reader own the
 * effects, and ask this module what a setting resolves to and what to say.
 */
import type { BootstrapPlatform, EndpointKind, GnomonConfig } from "./config.js";

/** A surface finding, in auditSurface's shape. */
export interface KnobProblem {
  where: string;
  problem: string;
  fix: string;
  fatal: boolean;
}

/**
 * The value a role or endpoint declares to leave a request field to the
 * provider: the field is not sent, so the provider's own default applies.
 */
export const PROVIDER_DEFAULT = "provider";

// ---------------------------------------------------------------------------
// 1. Reasoning effort
// ---------------------------------------------------------------------------

/**
 * The effort values gnomon sends. A published enumeration (Rule 6 in spirit:
 * the fixture, this list and CONTRACTS.md §32 are one set).
 *
 * The union of what the hosts gnomon is run against document: DeepSeek takes
 * `low`, `high`, `max` and maps `medium` to `high` (api-docs.deepseek.com,
 * thinking mode, read 2026-11-03); OpenCode Go's listing names
 * `capabilities.reasoning.effort` = low/high/max for DeepSeek V4.1 Flash; GLM
 * and Kimi K3 take low/medium/high/max and low/high/max. Validated because GLM
 * accepts any string without an error, so a typo would run at its default and
 * the record would claim otherwise.
 */
export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The request field an OpenAI-shaped endpoint is sent the effort in. */
export const REASONING_EFFORT_FIELD = "reasoning_effort";

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/**
 * The effort a role's calls to an endpoint carry: the role's own
 * `reasoning_effort` when it declares one, else the endpoint's. `"provider"`,
 * a value outside REASONING_EFFORTS (reported by the surface audit), or an
 * Ollama `/api/chat` endpoint (which takes `think`, not an effort) send
 * nothing, which is the request as it was before the key existed.
 */
export function resolveReasoningEffort(
  role: { reasoning_effort?: unknown } | undefined,
  endpoint: { reasoning_effort?: unknown } | undefined,
  kind: EndpointKind | undefined
): ReasoningEffort | undefined {
  if ((kind ?? "ollama") === "ollama") return undefined;
  const declared = role && role.reasoning_effort !== undefined ? role.reasoning_effort : endpoint?.reasoning_effort;
  return isReasoningEffort(declared) ? declared : undefined;
}

// ---------------------------------------------------------------------------
// 2. Sampling passthrough
// ---------------------------------------------------------------------------

/** `[endpoints.<name>] sampling`: `harness` (the default) sends the role's numbers. */
export const SAMPLING_MODES = ["harness", "provider"] as const;
export type SamplingMode = (typeof SAMPLING_MODES)[number];

/** The sampling fields gnomon sends, and so the ones that can be left out. */
export const SAMPLING_PARAMS = ["temperature", "top_p"] as const;
export type SamplingParam = (typeof SAMPLING_PARAMS)[number];

/**
 * The sampling fields NOT sent to this endpoint for this role, in
 * SAMPLING_PARAMS order. Empty is the default: both are sent, as before.
 *
 * `sampling = "provider"` on the endpoint leaves out both, whatever the role
 * declares: it says what this provider is to be sent, and DeepSeek in thinking
 * mode ignores `temperature` while Kimi refuses a change to it. A role's
 * `temperature = "provider"` or `top_p = "provider"` leaves out that one.
 */
export function samplingOmitted(
  role: { temperature?: unknown; top_p?: unknown } | undefined,
  endpoint: { sampling?: unknown } | undefined
): SamplingParam[] {
  if (endpoint?.sampling === PROVIDER_DEFAULT) return [...SAMPLING_PARAMS];
  return SAMPLING_PARAMS.filter((p) => role?.[p] === PROVIDER_DEFAULT);
}

// ---------------------------------------------------------------------------
// 3. Environment snapshot
// ---------------------------------------------------------------------------

/** The id the built-in snapshot runs and records under (counters.bootstrap.id). */
export const ENV_SNAPSHOT_ID = "env_snapshot";

/**
 * Its fixed bounds. ~2 s for the whole probe (the bash tool kills it at the
 * limit, and the turn then runs without a snapshot, recorded as `failed`);
 * 6000 bytes is ~1500 tokens at gnomon's 4 characters a token.
 */
export const ENV_SNAPSHOT_LIMITS = Object.freeze({ timeout_ms: 2000, max_bytes: 6000, max_lines: 60 });

/**
 * Variables that keep a version probe from reaching the network or writing:
 * git takes no optional lock (`git status` otherwise refreshes the index),
 * Python writes no bytecode, pip and npm do not check for updates, npm writes
 * no log file, corepack, rustup and the go command download no toolchain, and
 * uv stays offline.
 */
const QUIET_ENV =
  "export GIT_OPTIONAL_LOCKS=0 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 " +
  "NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_LOGS_MAX=0 COREPACK_ENABLE_NETWORK=0 " +
  "RUSTUP_AUTO_INSTALL=0 GOTOOLCHAIN=local GOPROXY=off UV_OFFLINE=1";

/**
 * Toolchains asked for their version, each with the arguments that print it.
 * Only these: asking twenty tools for versions took over 20 s on GitHub's
 * macOS and Windows runners (docs/GUIDE.md §8, the bootstrap's reference
 * list), so the rest are only looked up (ENV_SNAPSHOT_PRESENT).
 */
export const ENV_SNAPSHOT_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["python3", "--version"],
  ["pip", "--version"],
  ["uv", "--version"],
  ["node", "--version"],
  ["npm", "--version"],
  ["cargo", "--version"],
  ["go", "version"],
  ["java", "-version"],
];

/** Tools whose presence on PATH is listed; `command -v` starts nothing. */
export const ENV_SNAPSHOT_PRESENT = [
  "python", "pip3", "pipx", "conda", "pnpm", "yarn", "bun", "deno", "rustc", "javac", "mvn", "gradle",
  "gcc", "g++", "clang", "make", "cmake", "ruby", "php", "dotnet", "git", "docker",
];

/** System package managers whose presence is listed (nothing of theirs is run). */
export const ENV_SNAPSHOT_PACKAGE_MANAGERS = [
  "apt-get", "apk", "dnf", "yum", "pacman", "zypper", "brew", "port", "choco", "winget",
];

/**
 * The one fixed, read-only command the snapshot runs, for a platform family.
 *
 * Serial and quick first (the directory, git, the machine), then the eight
 * version probes in parallel, each cut at one second (`timeout` where it
 * exists, else a perl alarm, which macOS and Git Bash ship), sorted so the
 * output does not depend on which finished first; then what else is on PATH.
 * It writes nothing and reaches nothing: no probe names a URL or a network
 * client, `git status` takes no lock and runs no fsmonitor, and the variables above stop the
 * toolchains' own update checks and downloads. It goes through the bash tool
 * like any bootstrap, so a role's bash_allow, bash_deny, the sandbox and
 * `[sandbox] exec` apply to it, and under `exec = "docker"` it describes the
 * container the model's commands run in, not the host.
 */
export function envSnapshotCommand(platform: BootstrapPlatform): string {
  const lines: string[] = [
    QUIET_ENV,
    `printf 'cwd: %s\\n' "$PWD"`,
    `printf 'top level: %s\\n' "$(ls -Ap 2>&1 | head -n 60 | tr '\\n' ' ')"`,
    // `-c core.fsmonitor=false`: a repository's own config cannot make this
    // status run a program (core.fsmonitor names one).
    `printf 'git: %s\\n' "$(git -c core.fsmonitor=false status --short --branch 2>&1 | head -n 12 | tr '\\n' ';')"`,
    `printf 'os: %s\\n' "$(uname -srm 2>&1)"`,
  ];
  if (platform === "macos") {
    lines.push(
      `printf 'macos: %s\\n' "$(sw_vers -productVersion 2>/dev/null)"`,
      `printf 'cpus: %s\\n' "$(sysctl -n hw.ncpu 2>/dev/null)"`,
      `printf 'memory: %s MiB\\n' "$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))"`
    );
  } else {
    if (platform === "linux") {
      lines.push(`printf 'distro: %s\\n' "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"')"`);
    }
    lines.push(
      `printf 'cpus: %s\\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"`,
      `printf 'memory: %s\\n' "$(awk '/^MemTotal:|^MemAvailable:/ {printf "%s %d MiB ", $1, $2/1024}' /proc/meminfo 2>/dev/null)"`
    );
  }
  lines.push(
    `T=; if command -v timeout >/dev/null 2>&1; then T='timeout 1'; ` +
      `elif command -v perl >/dev/null 2>&1; then T='perl -e alarm(1);exec(@ARGV)'; fi`,
    "{"
  );
  for (const [tool, flag] of ENV_SNAPSHOT_TOOLS) {
    lines.push(
      `if command -v ${tool} >/dev/null 2>&1; then echo "${tool}: $($T ${tool} ${flag} 2>&1 | head -n 1)"; ` +
        `else echo "${tool}: not found"; fi &`
    );
  }
  lines.push("wait", "} | sort");
  const present = (label: string, list: readonly string[]) =>
    `printf '${label}: %s\\n' "$(for p in ${list.join(" ")}; do command -v $p >/dev/null 2>&1 && printf '%s ' $p; done)"`;
  lines.push(present("also on PATH", ENV_SNAPSHOT_PRESENT), present("system package managers", ENV_SNAPSHOT_PACKAGE_MANAGERS));
  return lines.join("\n");
}

/**
 * The snapshot's last line: what the policy lets the network do, from the
 * surface, not from a probe (a probe that tried would be a network call).
 */
export function envSnapshotNetworkLine(opts: {
  network: boolean | undefined;
  docker: boolean;
  /** exec = "os": the kernel blocks egress, and no host list opens it. */
  os?: boolean;
  packageIndex: readonly string[];
}): string {
  if (opts.network !== false) return "network (policy): allowed";
  if (opts.docker) {
    return (
      "network (policy): off — [sandbox] network = false, and commands run in a container with no network" +
      (opts.packageIndex.length > 0 ? " (allow_package_index does not reach inside it)" : "")
    );
  }
  if (opts.os) {
    return (
      "network (policy): off — [sandbox] network = false, and commands run under a kernel sandbox that blocks egress (loopback stays reachable)" +
      (opts.packageIndex.length > 0 ? " (allow_package_index does not open it)" : "")
    );
  }
  return (
    "network (policy): off — [sandbox] network = false: webfetch, and commands that name a network client or a URL, are refused" +
    (opts.packageIndex.length > 0
      ? `; package downloads (pip, uv or npm install or download, and curl or wget GET) from ${opts.packageIndex.join(", ")} are allowed`
      : "")
  );
}

/** `[context] env_snapshot`: on only when it is exactly `true`. */
export function resolveEnvSnapshot(config: GnomonConfig): boolean {
  return (config.config.context as { env_snapshot?: unknown } | undefined)?.env_snapshot === true;
}

// ---------------------------------------------------------------------------
// 4. Enforced todos
// ---------------------------------------------------------------------------

/** Hand-backs per turn: once, so the gate can never be what keeps a turn going. */
export const TODO_GATE_ROUNDS = 1;

/** What the gate did at one end of the turn. */
export const TODO_GATE_ACTIONS = ["hand_back", "accept"] as const;
export type TodoGateAction = (typeof TODO_GATE_ACTIONS)[number];

/**
 * How the gate left the turn.
 *
 * - `passed`: the answer was accepted with no open item.
 * - `exhausted`: the round was spent and items were still open.
 * - `skipped_budget`: items were open and less than `[verify]
 *   completion_min_remaining` of the step budget (or the run deadline) was left.
 * - `not_reached`: the turn ended some other way, or the role cannot call
 *   `todo`, or this turn wrote no checklist.
 */
export const TODO_GATE_OUTCOMES = ["passed", "exhausted", "skipped_budget", "not_reached"] as const;
export type TodoGateOutcome = (typeof TODO_GATE_OUTCOMES)[number];

/** `counters.todo_gate`: present only when `[turn] todo_gate = true`. */
export interface TodoGateCounters {
  v: 1;
  max_rounds: number;
  /** Hand-backs. */
  rounds: number;
  /** Open items when the gate last judged an end (0 when it never did). */
  open: number;
  outcome: TodoGateOutcome;
}

/** `[turn] todo_gate`: on only when it is exactly `true`. */
export function resolveTodoGate(config: GnomonConfig): boolean {
  return (config.config as { turn?: { todo_gate?: unknown } } | undefined)?.turn?.todo_gate === true;
}

/** The items of a checklist that are not completed, in its order. */
export function openTodos<T extends { status: string }>(todos: ReadonlyArray<T>): T[] {
  return todos.filter((t) => t.status !== "completed");
}

/**
 * The hand-back: the open items by name, and what would let the turn end. A
 * system message after the rejected answer, as the completion gate's is.
 */
export function renderTodoHandBack(
  open: ReadonlyArray<{ content: string; status: string }>,
  opts: { round: number; maxRounds: number }
): string {
  const items = open.map((t) => `- [${t.status === "in_progress" ? ">" : " "}] ${t.content}`).join("\n");
  return (
    `Your checklist still has ${open.length} open item${open.length === 1 ? "" : "s"}, and you ended the turn:\n\n` +
    `${items}\n\n` +
    `Finish ${open.length === 1 ? "it" : "them"} now. For an item that is already done, or that no longer ` +
    `applies, update the checklist with the \`todo\` tool (mark it completed, or drop it) and say why. ` +
    `Then answer again. (todo gate, round ${opts.round} of ${opts.maxRounds})`
  );
}

// ---------------------------------------------------------------------------
// 5. Edit variant
// ---------------------------------------------------------------------------

/** tools.toml `[[tools]] name = "edit"` → `variant`. */
export const EDIT_VARIANTS = ["default", "compat"] as const;
export type EditVariant = (typeof EDIT_VARIANTS)[number];

/** How a compat edit found its text: the tier that matched, uniquely. */
export const EDIT_MATCH_TIERS = ["exact", "whitespace", "indentation"] as const;
export type EditMatchTier = (typeof EDIT_MATCH_TIERS)[number];

/** The edit variant this surface declares; anything but `compat` is `default`. */
export function resolveEditVariant(config: GnomonConfig): EditVariant {
  const decl = (config.tools?.tools ?? []).find((t) => t.name === "edit") as { variant?: unknown } | undefined;
  return decl?.variant === "compat" ? "compat" : "default";
}

/** `edit`'s parameters under `variant = "compat"`: the names most models were trained on. */
export const COMPAT_EDIT_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path, relative to the repository root" },
    old_string: {
      type: "string",
      description:
        "The text to replace. It must identify exactly one place in the file. Differences in " +
        "whitespace or indentation are tolerated only while the match stays unique.",
    },
    new_string: { type: "string", description: "The text to replace it with" },
  },
  required: ["path", "old_string", "new_string"],
};

/** Whitespace a model may have collapsed, expanded or retyped. */
const WS = /[ \t   -   　]+/g;

/** Tier `whitespace`: indentation kept as written, every other run of blanks one space, none at the end. */
function normWhitespace(line: string): string {
  const l = line.replace(/\r$/, "");
  const lead = /^[ \t]*/.exec(l)![0];
  return lead + l.slice(lead.length).replace(WS, " ").replace(/ $/, "");
}

/** Tier `indentation`: as `whitespace`, with the indentation dropped too. */
function normIndentation(line: string): string {
  return line.replace(/\r$/, "").replace(WS, " ").trim();
}

const leadOf = (s: string): string => /^[ \t]*/.exec(s.replace(/\r$/, ""))![0];

/**
 * new_string moved by the indentation the matched lines differ from
 * old_string by, when every non-blank line differs by the same prefix in the
 * same direction; otherwise as written. So a block the model quoted two
 * spaces short goes in at the file's indentation, and a Python body keeps
 * its structure.
 */
function reindent(text: string, oldLines: string[], fileLines: string[]): string {
  let add: string | undefined;
  let remove: string | undefined;
  for (let j = 0; j < oldLines.length; j++) {
    if (oldLines[j]!.trim() === "") continue;
    const o = leadOf(oldLines[j]!);
    const f = leadOf(fileLines[j]!);
    if (f.length >= o.length && f.endsWith(o)) {
      const p = f.slice(0, f.length - o.length);
      if (remove !== undefined || (add !== undefined && add !== p)) return text;
      add = p;
    } else if (o.endsWith(f)) {
      const p = o.slice(0, o.length - f.length);
      if (add !== undefined || (remove !== undefined && remove !== p)) return text;
      remove = p;
    } else {
      return text;
    }
  }
  const lines = text.split("\n");
  if (add) return lines.map((l) => (l.trim() === "" ? l : add + l)).join("\n");
  if (remove) {
    if (!lines.every((l) => l.trim() === "" || l.startsWith(remove!))) return text;
    return lines.map((l) => (l.trim() === "" ? l : l.slice(remove!.length))).join("\n");
  }
  return text;
}

export type FuzzyEditResult =
  | { ok: true; after: string; tier: Exclude<EditMatchTier, "exact"> }
  | { ok: false; why: "not_found" | "ambiguous" | "blank"; tier?: Exclude<EditMatchTier, "exact">; hits?: number };

/**
 * The tiers after an exact match found nothing: whole lines compared with
 * whitespace normalized, then with indentation ignored as well. Each tier must
 * find exactly ONE run of lines; two or more is refused as ambiguous and no
 * later, looser tier is tried. A blank old_string matches nothing.
 *
 * What the old text covered is what is replaced, as an exact match would: the
 * matched lines, and their final line break only when old_string ended with
 * one. A CRLF file gets CRLF in the replacement.
 */
export function fuzzyEdit(before: string, oldText: string, newText: string): FuzzyEditResult {
  const unified = oldText.replace(/\r\n/g, "\n");
  const trailingNl = unified.endsWith("\n");
  const oldLines = unified.split("\n");
  if (trailingNl) oldLines.pop();
  if (oldLines.every((l) => l.trim() === "")) return { ok: false, why: "blank" };
  const fileLines = before.split("\n");
  const crlf = before.includes("\r\n");
  for (const tier of ["whitespace", "indentation"] as const) {
    const norm = tier === "whitespace" ? normWhitespace : normIndentation;
    const want = oldLines.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + want.length <= fileLines.length; i++) {
      let all = true;
      for (let j = 0; j < want.length; j++) {
        if (norm(fileLines[i + j]!) !== want[j]) {
          all = false;
          break;
        }
      }
      if (all) hits.push(i);
    }
    if (hits.length > 1) return { ok: false, why: "ambiguous", tier, hits: hits.length };
    if (hits.length === 0) continue;
    const i = hits[0]!;
    const n = want.length;
    let start = 0;
    for (let k = 0; k < i; k++) start += fileLines[k]!.length + 1;
    let end = start;
    for (let k = i; k < i + n; k++) end += fileLines[k]!.length + 1;
    end -= 1; // the "\n" after the last matched line (or the end of the file)
    if (fileLines[i + n - 1]!.endsWith("\r")) end -= 1;
    if (trailingNl && end < before.length) end += before.startsWith("\r\n", end) ? 2 : 1;
    let repl = newText.replace(/\r\n/g, "\n");
    if (tier === "indentation") repl = reindent(repl, oldLines, fileLines.slice(i, i + n));
    if (crlf) repl = repl.replace(/\n/g, "\r\n");
    return { ok: true, after: before.slice(0, start) + repl + before.slice(end), tier };
  }
  return { ok: false, why: "not_found" };
}

// ---------------------------------------------------------------------------
// 6. Package-index allowlist
// ---------------------------------------------------------------------------

/**
 * Hosts known to serve packages. Any other well-formed host is accepted, and
 * the surface audit says it is not a known index: a private mirror is a
 * legitimate entry, and so is a typo the operator should see.
 */
export const KNOWN_PACKAGE_INDEXES = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "repo1.maven.org",
  "repo.maven.apache.org",
  "rubygems.org",
  "conda.anaconda.org",
  "download.pytorch.org",
];

/**
 * A bare DNS name: no scheme, port, path, wildcard or address literal. An
 * entry that is not one is never matched, which is the safe direction, and
 * the audit names it.
 */
export function isPackageIndexHost(h: unknown): h is string {
  if (typeof h !== "string" || h.length > 253) return false;
  const host = h.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return false;
  // An IPv4 literal is all digits; a host must have a letter in its last label.
  return /[a-z]/.test(host.slice(host.lastIndexOf(".") + 1));
}

/**
 * `[sandbox] allow_package_index` in policy.toml: the well-formed hosts,
 * lowercased, deduplicated, sorted. Empty -- the default -- leaves
 * `network = false` refusing every URL, exactly as before.
 */
export function resolvePackageIndex(config: GnomonConfig): string[] {
  const raw = (config.policy?.sandbox as { allow_package_index?: unknown } | undefined)?.allow_package_index;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isPackageIndexHost).map((h) => h.toLowerCase()))].sort();
}

// ---------------------------------------------------------------------------
// The surface audit
// ---------------------------------------------------------------------------

/**
 * What is wrong with a declared knob, for auditSurface. None of it is fatal:
 * every knob is opt-in and none grants a capability by being misspelt; what a
 * mistake does is look declared while doing nothing, and that is said.
 */
export function auditSweepKnobs(
  config: GnomonConfig,
  /** config.ts endpointKind: the declared kind, else the shape the URL names, else ollama. */
  kindOf: (endpoint: { url?: string; kind?: EndpointKind }) => EndpointKind
): KnobProblem[] {
  const out: KnobProblem[] = [];
  const warn = (where: string, problem: string, fix: string) => out.push({ where, problem, fix, fatal: false });
  const endpoints = (config.config.endpoints ?? {}) as unknown as Record<string, Record<string, unknown>>;

  for (const [name, ep] of Object.entries(endpoints)) {
    if (!ep || typeof ep !== "object") continue;
    const where = `.gnomon/config.toml [endpoints.${name}]`;
    const effort = ep.reasoning_effort;
    if (effort !== undefined && effort !== PROVIDER_DEFAULT && !isReasoningEffort(effort)) {
      warn(
        where,
        `reasoning_effort = ${JSON.stringify(effort)} is not one of ${REASONING_EFFORTS.join(", ")}, so no effort is sent ` +
          `(some providers, GLM among them, accept any string without an error, and would run at their default).`,
        `reasoning_effort = "high" (one of ${REASONING_EFFORTS.join(", ")}), or "${PROVIDER_DEFAULT}" to send none.`
      );
    }
    if (isReasoningEffort(effort) && kindOf(ep as { url?: string; kind?: EndpointKind }) === "ollama") {
      warn(
        where,
        `reasoning_effort is not sent to an Ollama /api/chat endpoint, which takes \`think\`, not an effort; here it does nothing.`,
        `Remove it, or serve the model behind an OpenAI-compatible endpoint (kind = "openai").`
      );
    }
    const sampling = ep.sampling;
    if (sampling !== undefined && !(SAMPLING_MODES as readonly unknown[]).includes(sampling)) {
      warn(
        where,
        `sampling = ${JSON.stringify(sampling)} is not one of ${SAMPLING_MODES.join(", ")}, so it runs as "harness": the role's temperature and top_p are sent.`,
        `sampling = "${PROVIDER_DEFAULT}" sends neither; "harness" (the default) sends the role's.`
      );
    }
  }

  for (const [role, def] of Object.entries(config.roles ?? {})) {
    if (!def || typeof def !== "object") continue;
    const where = `.gnomon/roles.toml [roles.${role}]`;
    const r = def as Record<string, unknown>;
    if (r.reasoning_effort !== undefined && r.reasoning_effort !== PROVIDER_DEFAULT && !isReasoningEffort(r.reasoning_effort)) {
      warn(
        where,
        `reasoning_effort = ${JSON.stringify(r.reasoning_effort)} is not one of ${REASONING_EFFORTS.join(", ")}, so this role's calls carry no effort ` +
          `(not the endpoint's either: the role's declaration wins).`,
        `reasoning_effort = "high" (one of ${REASONING_EFFORTS.join(", ")}), or "${PROVIDER_DEFAULT}" to send none.`
      );
    }
    for (const p of SAMPLING_PARAMS) {
      const v = r[p];
      if (typeof v === "string" && v !== PROVIDER_DEFAULT) {
        warn(
          where,
          `${p} = ${JSON.stringify(v)} is neither a number nor "${PROVIDER_DEFAULT}"; it is sent as written, a string, which a strict provider refuses.`,
          `${p} = 0.3, or ${p} = "${PROVIDER_DEFAULT}" to leave it to the provider.`
        );
      }
    }
    const epName = typeof r.endpoint === "string" ? r.endpoint : undefined;
    const ep = epName ? endpoints[epName] : undefined;
    if (ep?.sampling === PROVIDER_DEFAULT) {
      const numeric = SAMPLING_PARAMS.filter((p) => typeof r[p] === "number");
      if (numeric.length > 0) {
        warn(
          where,
          `${numeric.map((p) => `${p} = ${String(r[p])}`).join(" and ")} ${numeric.length === 1 ? "is" : "are"} not sent: ` +
            `endpoint "${epName}" declares sampling = "${PROVIDER_DEFAULT}", which leaves both to the provider.`,
          `Expected under a sampling sweep. To send this role's numbers, set sampling = "harness" on the endpoint, or route the role elsewhere.`
        );
      }
    }
  }

  const ctx = config.config.context as { env_snapshot?: unknown; bootstrap?: unknown } | undefined;
  if (ctx?.env_snapshot !== undefined && typeof ctx.env_snapshot !== "boolean") {
    warn(
      ".gnomon/config.toml [context]",
      `env_snapshot = ${JSON.stringify(ctx.env_snapshot)} is not true or false, so no snapshot is taken.`,
      "env_snapshot = true"
    );
  }
  if (ctx?.env_snapshot === true && typeof ctx.bootstrap === "string" && ctx.bootstrap.trim() !== "") {
    warn(
      ".gnomon/config.toml [context]",
      `env_snapshot = true and bootstrap = "${ctx.bootstrap}" both ask for a snapshot; one runs a session, and the declared bootstrap is it, so env_snapshot does nothing here.`,
      "Keep one of the two."
    );
  }
  if (ctx?.env_snapshot === true && config.policy?.bootstrap && Object.prototype.hasOwnProperty.call(config.policy.bootstrap, ENV_SNAPSHOT_ID)) {
    warn(
      `.gnomon/policy.toml [bootstrap.${ENV_SNAPSHOT_ID}]`,
      `"${ENV_SNAPSHOT_ID}" is the id the built-in snapshot records under, so a record could not tell the two apart.`,
      "Rename the block."
    );
  }

  const turn = (config.config as { turn?: { todo_gate?: unknown } }).turn;
  if (turn?.todo_gate !== undefined && typeof turn.todo_gate !== "boolean") {
    warn(
      ".gnomon/config.toml [turn]",
      `todo_gate = ${JSON.stringify(turn.todo_gate)} is not true or false, so the gate is off.`,
      "todo_gate = true"
    );
  }

  for (const t of config.tools?.tools ?? []) {
    const variant = (t as { variant?: unknown }).variant;
    if (variant === undefined) continue;
    const where = `.gnomon/tools.toml [[tools]] name = "${t.name}"`;
    if (t.name !== "edit") {
      warn(where, `variant is read on the edit declaration only; on ${t.name} it does nothing.`, "Remove it, or declare it on edit.");
    } else if (!(EDIT_VARIANTS as readonly unknown[]).includes(variant)) {
      warn(
        where,
        `variant = ${JSON.stringify(variant)} is not one of ${EDIT_VARIANTS.join(", ")}, so edit runs as "default".`,
        `variant = "compat"`
      );
    }
  }

  const sandbox = config.policy?.sandbox as { allow_package_index?: unknown; network?: unknown; exec?: unknown } | undefined;
  const pi = sandbox?.allow_package_index;
  if (pi !== undefined) {
    const where = ".gnomon/policy.toml [sandbox]";
    if (!Array.isArray(pi)) {
      warn(where, "allow_package_index is not a list, so no host is allowed.", 'allow_package_index = ["pypi.org", "files.pythonhosted.org"]');
    } else {
      const bad = pi.filter((h) => !isPackageIndexHost(h));
      if (bad.length > 0) {
        warn(
          where,
          `allow_package_index entries ${bad.map((b) => JSON.stringify(b)).join(", ")} are not bare host names (no scheme, port, path, wildcard or address), so they match nothing.`,
          'Write each as a host: "pypi.org".'
        );
      }
      const hosts = resolvePackageIndex(config);
      const unknown = hosts.filter((h) => !KNOWN_PACKAGE_INDEXES.includes(h));
      if (unknown.length > 0) {
        warn(
          where,
          `allow_package_index names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a known package index; under network = false, ` +
            `pip, uv and npm installs and downloads, and curl and wget GETs, may reach ${unknown.length === 1 ? "it" : "them"}.`,
          "Expected for a private mirror. Otherwise remove the entry.",
        );
      }
      if (hosts.length > 0 && sandbox?.network !== false) {
        warn(
          where,
          "allow_package_index narrows nothing and widens nothing unless network = false: with the network allowed, every host is.",
          "Set network = false to make the allowlist the only network a command can name."
        );
      } else if (hosts.length > 0 && sandbox?.exec === "docker") {
        warn(
          where,
          'allow_package_index does not reach inside exec = "docker": the container runs with --network none, which no host list can open, so downloads there still fail.',
          'Run on the host (exec = "off") for the allowlist to apply, or pre-fetch the packages into the repository.'
        );
      } else if (hosts.length > 0 && sandbox?.exec === "os") {
        warn(
          where,
          'allow_package_index does not open exec = "os": with network = false its supervisor admits loopback only and has no per-host allow, so downloads there still fail (and bash refuses them up front).',
          'Pre-fetch the packages (or point the tool at a local mirror on loopback), or run that role with exec = "off" for the allowlist to apply.'
        );
      }
    }
  }
  return out;
}
