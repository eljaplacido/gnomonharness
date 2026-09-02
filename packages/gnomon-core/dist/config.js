/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, basename, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
// Deliberate cycle: skills.ts imports parseToml from here. Both directions are
// used only inside function bodies, never at module scope, so the partially
// initialised namespace an ESM cycle hands the second module to load is never
// touched. The alternative -- a second directory reader inside auditSurface --
// is worse: the audit would then be checking files the runtime does not
// necessarily load. loadSkills is the reader the turn uses, so the audit sees
// exactly what the turn will see.
import { loadSkills } from "./skills.js";
// ---------------------------------------------------------------------------
// TOML parser (simple, handles .gnomon config format)
// ---------------------------------------------------------------------------
/**
 * Parse a simple TOML file. Supports:
 * - Key-value pairs: key = "value"
 * - Tables: [table]
 * - Nested tables: [table.sub]
 * - Arrays: items = ["a", "b"]
 */
/**
 * parseToml, with the filename in the message.
 *
 * "line 12: cannot parse ..." is only actionable if the reader knows which of
 * the four surface files it came from.
 */
function parseTomlNamed(content, filename) {
    try {
        return parseToml(content);
    }
    catch (e) {
        throw new Error(`.gnomon/${filename} ${e.message}`);
    }
}
export function parseToml(content) {
    const result = {};
    let currentTable = null;
    let currentObj = result;
    const lines = content.split("\n");
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        let trimmed = lines[lineNo].trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        // An array may span lines. Joining them here rather than parsing line by
        // line matters: an unjoined `key = [` parsed as the string "[", which
        // silently emptied every multi-line list in the surface.
        if (/=\s*\[[^\]]*$/.test(stripComment(trimmed))) {
            const parts = [stripComment(trimmed)];
            let depth = (parts[0].match(/\[/g) ?? []).length - (parts[0].match(/\]/g) ?? []).length;
            while (depth > 0 && lineNo + 1 < lines.length) {
                lineNo++;
                const next = stripComment(lines[lineNo].trim());
                if (!next)
                    continue;
                parts.push(next);
                depth +=
                    (next.match(/\[/g) ?? []).length - (next.match(/\]/g) ?? []).length;
            }
            trimmed = parts.join(" ");
        }
        // Array-of-tables header: [[tools]]. Must be tested before [table],
        // whose pattern also matches "[[tools]]" (capturing "[tools]") and would
        // otherwise fold every entry into one key named "[tools]".
        const arrayMatch = trimmed.match(/^\[\[(.+)\]\]$/);
        if (arrayMatch) {
            const parts = arrayMatch[1].split(".").map((x) => x.trim());
            let parent = result;
            for (let k = 0; k < parts.length - 1; k++) {
                if (!(parts[k] in parent))
                    parent[parts[k]] = {};
                parent = parent[parts[k]];
            }
            const leaf = parts[parts.length - 1];
            if (!Array.isArray(parent[leaf]))
                parent[leaf] = [];
            const entry = {};
            parent[leaf].push(entry);
            currentTable = arrayMatch[1];
            currentObj = entry;
            continue;
        }
        // Table header
        const tableMatch = trimmed.match(/^\[(.+)\]$/);
        if (tableMatch) {
            currentTable = tableMatch[1];
            const parts = currentTable.split(".");
            currentObj = result;
            for (const part of parts) {
                const key = part.trim();
                if (!(key in currentObj)) {
                    currentObj[key] = {};
                }
                currentObj = currentObj[key];
            }
            continue;
        }
        // Key = value
        const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
        if (kvMatch) {
            const key = kvMatch[1];
            const value = stripComment(kvMatch[2]);
            currentObj[key] = parseValue(value);
            continue;
        }
        // Anything reaching here matched none of the three shapes this parser
        // understands, and used to fall silently off the bottom of the loop.
        //
        // That silence is the dangerous part. `[roles.verifier` with the closing
        // bracket missing dropped the header and HOISTED its keys to the top level,
        // so the role vanished and its bash_allow became a root key read by nothing
        // — a role that appears to exist and is not there. `this is not toml`
        // vanished too. For a harness whose entire proposition is explicit
        // configuration, a line the parser cannot read must not be a line it
        // pretends it read.
        //
        // Thrown with the line number, because "somewhere in roles.toml" is not
        // materially better than silence.
        throw new Error(`line ${lineNo + 1}: cannot parse ${JSON.stringify(trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed)}. Expected a [table] header, a [[array]] header, or key = value.`);
    }
    return result;
}
/**
 * Strip a trailing `# ...` comment from a value, honouring quoted strings.
 *
 * Every documented value in config.toml carries an inline comment listing its
 * legal values. Without this, `approval = "on_write"  # never | on_write | ...`
 * parses to the whole line, so no enum value ever matches.
 */
function stripComment(value) {
    let quote = null;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote) {
            // Literal strings have no escapes, so only a basic string honours \".
            if (ch === quote && !(quote === '"' && value[i - 1] === "\\"))
                quote = null;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (ch === "#") {
            return value.slice(0, i).trim();
        }
    }
    return value.trim();
}
/** TOML basic-string escapes. Unknown escapes are left alone rather than
 * throwing: this parser is lenient by design, and a surface that fails to load
 * over an unrecognised escape helps nobody. */
function unescapeBasic(raw) {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (whole, esc) => {
        switch (esc) {
            case "n": return "\n";
            case "t": return "\t";
            case "r": return "\r";
            case "b": return "\b";
            case "f": return "\f";
            case '"': return '"';
            case "\\": return "\\";
            default:
                if (esc[0] === "u" || esc[0] === "U") {
                    return String.fromCodePoint(parseInt(esc.slice(1), 16));
                }
                return whole;
        }
    });
}
function parseValue(value) {
    // Literal string: 'no escapes here'. This is the TOML idiom for regular
    // expressions, and it needs no unescaping by definition.
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1);
    }
    // Basic string: escapes ARE processed, per the TOML spec.
    //
    // They were not, and the old comment here recorded that as a quirk without
    // drawing the consequence. Writing a pattern the ordinary, spec-correct way —
    // bash_deny = ["rm\\s+-rf"] — produced the string `rm\\s+-rf`, a regex
    // containing a literal backslash, which matches nothing. So a deny written
    // that way protected NOTHING while the surface read as though it did, and the
    // failure was silent in the dangerous direction.
    //
    // gnomon's own surface never hit it only because it happens to use literal
    // strings throughout. Measured: "rm\\s+-rf" failed to match `rm -rf x`;
    // 'rm\\s+-rf' matched. Two spellings of the same intent, one of them inert.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return unescapeBasic(value.slice(1, -1));
    }
    // Array. Split on top-level commas only: a pattern like '^(a|b),\\s' would
    // otherwise be torn in half, and a trailing comma would yield an empty item.
    if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        if (!inner)
            return [];
        const items = [];
        let buf = "";
        let quote = null;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (quote) {
                if (ch === quote && !(quote === '"' && inner[i - 1] === "\\"))
                    quote = null;
                buf += ch;
            }
            else if (ch === '"' || ch === "'") {
                quote = ch;
                buf += ch;
            }
            else if (ch === ",") {
                items.push(buf);
                buf = "";
            }
            else {
                buf += ch;
            }
        }
        items.push(buf);
        return items.map((v) => v.trim()).filter(Boolean).map(parseValue);
    }
    // Boolean
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    // Number
    if (/^-?\d+$/.test(value))
        return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value))
        return parseFloat(value);
    // Fallback: string
    return value;
}
// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
/**
 * Resolve the .gnomon/ directory for a given root.
 * @param root Path to project root (default: process.cwd())
 * @returns Resolved path to .gnomon/ directory
 */
export function resolveGnomonDir(root) {
    // An explicit --dir means exactly that directory: no searching.
    if (root) {
        const gnomonDir = join(resolve(root), ".gnomon");
        if (!existsSync(gnomonDir)) {
            throw new Error(`.gnomon/ not found at ${gnomonDir}`);
        }
        return gnomonDir;
    }
    // Otherwise walk up from the cwd, the way git finds .git. Working from a
    // subdirectory of a project is normal, and requiring the exact project root
    // made it easy to run in the wrong place and get a confusing miss.
    const start = process.cwd();
    let dir = start;
    for (;;) {
        const candidate = join(dir, ".gnomon");
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error(`No .gnomon/ surface found in ${start} or any parent directory.\n` +
        `Run \`gnomon init\` in your project root to create one.`);
}
/**
 * Load a TOML config file from .gnomon/.
 * @param gnomonDir Path to .gnomon/ directory
 * @param filename TOML filename (or directory for profile subdirectory)
 * @returns Parsed config object
 */
function loadToml(gnomonDir, filename) {
    const filePath = join(gnomonDir, filename);
    // Handle profile subdirectory: glob all .toml files
    if (filename === "profiles") {
        const profilesDir = filePath;
        if (!existsSync(profilesDir)) {
            return {};
        }
        const files = readdirSync(profilesDir)
            .filter((f) => f.endsWith(".toml"))
            .sort();
        const result = {};
        for (const file of files) {
            const name = file.replace(/\.toml$/, "");
            const content = readFileSync(join(profilesDir, file), "utf-8");
            result[name] = parseTomlNamed(content, `profiles/${file}`);
        }
        return result;
    }
    if (!existsSync(filePath)) {
        return {};
    }
    const content = readFileSync(filePath, "utf-8");
    return parseTomlNamed(content, filename);
}
/**
 * Load the full .gnomon/ configuration.
 * @param root Project root path
 * @returns Typed configuration object
 */
export function loadConfig(root) {
    const gnomonDir = resolveGnomonDir(root);
    return {
        gnomonDir,
        config: loadToml(gnomonDir, "config.toml"),
        policy: loadToml(gnomonDir, "policy.toml"),
        // roles.toml has [roles.X] headers → parseToml wraps in {roles: {...}}
        roles: (loadToml(gnomonDir, "roles.toml").roles ?? {}),
        profiles: loadToml(gnomonDir, "profiles"),
        tools: loadToml(gnomonDir, "tools.toml"),
        // system.md is plain text, not TOML — read directly
        system: (() => {
            const filePath = join(gnomonDir, "system.md");
            const content = existsSync(filePath)
                ? readFileSync(filePath, "utf-8")
                : "";
            return { content, version: "0.1" };
        })(),
    };
}
/**
 * Get the role definition for a given role name.
 */
export function getRole(config, role) {
    const def = config.roles[role];
    if (!def) {
        throw new Error(`Role not found: "${role}". Available: ${Object.keys(config.roles).join(", ")}`);
    }
    return def;
}
/**
 * Get the profile definition for a given profile name.
 */
export function getProfile(config, name) {
    const profiles = config.profiles;
    if (!profiles[name]) {
        throw new Error(`Profile not found: "${name}". Available: ${Object.keys(profiles).join(", ")}`);
    }
    return profiles[name];
}
/**
 * Check if a tool is enabled.
 */
export function isToolEnabled(config, toolName) {
    const declared = config.tools.tools?.find((t) => t.name === toolName);
    if (!declared)
        return false;
    if (declared.enabled === false)
        return false;
    // config.toml may disable a declared tool without removing the declaration.
    const override = config.config.tools?.find((t) => t.name === toolName);
    return override?.enabled !== false;
}
/** Every tool the surface declares, in declaration order. */
export function declaredTools(config) {
    // Sorted, because Rule 3 says "resolved from .gnomon/tools.toml, sorted,
    // hashed" and this returned file order. Two surfaces with identical tools
    // written in a different order presented the model a differently-ordered
    // schema list, and MCP tools are appended in CONNECTION order on top of
    // that — so the same surface could differ between runs whenever a server
    // was slow. Consistent field order is also the cheapest of the three levers
    // the current top-of-leaderboard harness attributes its tool-call
    // reliability to, and a stable prefix is what makes prompt caching hit.
    // Byte-wise, NOT localeCompare — the same rule this file already applies to
    // manifest paths, and for the same reason. localeCompare goes through ICU,
    // whose collation tables differ between Node builds (a small-icu binary
    // collates differently from a full-icu one) and between ICU versions. Rule 3
    // says tool schemas are "sorted, hashed"; a sort whose result depends on which
    // Node compiled the harness is not a sort that can be hashed and compared
    // across machines. Demonstrated divergence on realistic names: localeCompare
    // orders ["Read", "mcp__fs__read", "read"] differently from byte order, and
    // MCP tools carry exactly that shape of name.
    return [...(config.tools.tools ?? [])].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
const CONTEXT_POLICIES = ["full", "sliding_window", "summary"];
const COMPACTIONS = ["discard", "summary", "truncate"];
function pickEnum(value, legal, fallback) {
    return typeof value === "string" && legal.includes(value)
        ? value
        : fallback;
}
function pickInt(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    return fallback;
}
/**
 * Resolve the context-window policy from config.toml.
 *
 * `[context]` and `[defaults].max_context_tokens` / `.compaction` are already
 * declared in the surface and already part of the surface hash — this reads
 * what is there rather than introducing new configuration.
 */
export function resolveContext(config) {
    const ctx = config.config.context ?? {};
    const defaults = config.config.defaults ?? {};
    return {
        policy: pickEnum(ctx.policy, CONTEXT_POLICIES, "sliding_window"),
        retain_after: pickInt(ctx.retain_after, 2048),
        max_context_tokens: pickInt(defaults.max_context_tokens, 65536),
        compaction: pickEnum(defaults.compaction, COMPACTIONS, "discard"),
        summary_role: typeof ctx.summary_role === "string" ? ctx.summary_role : "smol",
        reserve_output: (() => {
            const budget = pickInt(defaults.max_context_tokens, 65536);
            // 15% of the window, at least 1024 — but never more than 40% of it.
            // Without the cap a small max_context_tokens was consumed entirely by
            // the floor, leaving no room for history at all.
            const wanted = Math.max(1024, Math.floor(budget * 0.15));
            return pickInt(ctx.reserve_output, Math.min(wanted, Math.floor(budget * 0.4)));
        })(),
    };
}
export const META_FIELDS = [
    "turn",
    "role",
    "model",
    "bucket",
    "duration",
    "context",
    "tokens",
    "think",
    "tools",
];
const META_STYLES = ["line", "compact"];
const THINK_MODES = ["hide", "collapse", "show"];
export const COT_MODES = ["off", "brief", "tools", "think", "full"];
/**
 * Parse a meta field list, dropping names that are not fields.
 *
 * Unknown names are returned so the caller can name them rather than silently
 * showing a shorter line than the surface asked for.
 */
export function parseMetaFields(names) {
    const fields = [];
    const unknown = [];
    for (const raw of names) {
        const name = String(raw).trim();
        if (!name)
            continue;
        if (META_FIELDS.includes(name)) {
            if (!fields.includes(name))
                fields.push(name);
        }
        else {
            unknown.push(name);
        }
    }
    return { fields, unknown };
}
/**
 * Resolve the `[ui]` block from config.toml.
 *
 * Presentation is declared in the surface like everything else, so two
 * checkouts of a repo show the same thing. Runtime `/meta` and `/think` edit
 * only the in-memory copy — persisting them would be machine-scoped state,
 * which Rule 1 forbids.
 */
export function resolveUi(config) {
    const ui = config.config.ui ?? {};
    const declared = Array.isArray(ui.meta) ? parseMetaFields(ui.meta).fields : null;
    return {
        theme: typeof ui.theme === "string" && ui.theme ? ui.theme : "dark",
        meta: declared ?? ["turn", "role", "model", "bucket", "duration", "context", "tools"],
        meta_style: pickEnum(ui.meta_style, META_STYLES, "line"),
        think: pickEnum(ui.think, THINK_MODES, "collapse"),
        cot: pickEnum(ui.cot, COT_MODES, "full"),
        spinner: typeof ui.spinner === "boolean" ? ui.spinner : true,
        color: typeof ui.color === "boolean" ? ui.color : true,
        markdown: typeof ui.markdown === "boolean" ? ui.markdown : true,
    };
}
const ROUTING_MODES = ["manual", "suggest", "auto"];
export function resolveRouting(config) {
    const r = config.config.routing ?? {};
    return {
        mode: pickEnum(r.mode, ROUTING_MODES, "manual"),
        default: typeof r.default === "string" ? r.default : "implement",
        rules: Array.isArray(r.rules) ? r.rules : [],
    };
}
/**
 * Pick the role for one input.
 *
 * First matching rule wins, so order in the surface is the priority order.
 * A rule naming an undefined role is reported rather than silently skipped —
 * a routing table with a typo would otherwise fail open onto the default and
 * look like the rule simply did not match.
 */
export function routeInput(config, input, routing) {
    const r = routing ?? resolveRouting(config);
    const known = listRoles(config);
    for (const rule of r.rules) {
        let re;
        try {
            re = new RegExp(rule.match, "i");
        }
        catch {
            return {
                role: r.default,
                rule: null,
                problem: `rule for "${rule.role}" has an invalid pattern: ${rule.match}`,
            };
        }
        if (!re.test(input))
            continue;
        if (!known.includes(rule.role)) {
            return {
                role: r.default,
                rule: null,
                problem: `rule matched but role "${rule.role}" is not defined in roles.toml`,
            };
        }
        return { role: rule.role, rule };
    }
    return { role: r.default, rule: null };
}
/** The endpoint every role falls back to when none is named. */
export const DEFAULT_ENDPOINT = "local";
const BUILTIN_ENDPOINTS = {
    local: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama" },
};
/**
 * Resolve a named endpoint from the surface.
 *
 * `local` has a built-in default so a surface that never mentions endpoints
 * still works. Anything else must be declared: a role pointing at an endpoint
 * that does not exist is a configuration error worth naming, not something to
 * silently paper over with a guessed URL.
 */
export function resolveEndpoint(config, name = DEFAULT_ENDPOINT) {
    const declared = config.config.endpoints?.[name];
    if (declared?.url)
        return declared;
    const builtin = BUILTIN_ENDPOINTS[name];
    if (builtin)
        return builtin;
    const known = [
        ...Object.keys(config.config.endpoints ?? {}),
        ...Object.keys(BUILTIN_ENDPOINTS),
    ];
    throw new Error(`Unknown endpoint "${name}". Declared: ${known.join(", ") || "(none)"}.\n` +
        "Add it under [endpoints." + name + "] in .gnomon/config.toml.");
}
/** The only keys an [endpoints.<name>] block may carry. */
const ENDPOINT_KEYS = new Set(["url", "kind", "api_key_env", "provider"]);
/**
 * A deny pattern reduced to the text a guard should be read against.
 *
 * Measured, 2026-09-02: the xargs admission's guard was /\bxargs\b/ and the
 * deny spelling this file itself recommended -- and that the scaffolded
 * verifier actually carries -- is '\bxargs\b'. As a SUBJECT string that is
 * the nine characters `\bxargs\b`, in which "xargs" is preceded by the word
 * character 'b', so \b does not hold and the guard returned false. Same for
 * env: /\benv\b/ against '\benv\b' is false. Two of the six admissions
 * could never be marked guarded by their own recommended remedy, so an
 * operator who applied it exactly would have kept the warning forever.
 * Verified with node: guard.test('\\bxargs\\b') === false,
 * guard.test('xargs') === true.
 *
 * Only \b is removed. Removing more would widen the guard, and a guard that
 * matches too much SUPPRESSES a real warning -- the failure direction this
 * whole table was rebuilt to close.
 */
const denyText = (pattern) => pattern.replace(/\\b/g, "");
const EXECUTING_ARGS = [
    {
        admits: /\bfind\b/,
        why: "find (-exec, -execdir, -delete, -fprintf all write or run)",
        guard: /-exec|-execdir|-ok\b|-okdir|-delete|-fprint/,
        deny: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint"],
        note: "find still reads the tree; only its executing arguments are refused.",
    },
    {
        admits: /\bxargs\b/,
        why: "xargs (runs whatever it is piped)",
        guard: /\bxargs\b/,
        deny: ["\\bxargs\\b"],
        note: "Nothing else in bash_allow is affected.",
    },
    {
        admits: /\benv\b/,
        why: "env (runs its argument)",
        guard: /\benv\b/,
        deny: ["\\benv\\b"],
        note: "Nothing else in bash_allow is affected.",
    },
    {
        admits: /\b(sh|bash|zsh|ksh|dash)\b/,
        why: "a shell (runs anything)",
        guard: /\b(sh|bash|zsh|ksh|dash)\b|-c\b/,
        deny: ["\\b(sh|bash|zsh|ksh|dash)\\b"],
        note: "Deny wins over allow, so this also stops any bash_allow entry that spells " +
            "a shell. If you need one, narrow bash_allow instead.",
    },
    {
        admits: /\b(awk|gawk|perl|python3?|ruby|node)\b/,
        why: "an interpreter (runs anything)",
        guard: /\b(awk|gawk|perl|python3?|ruby|node)\b/,
        deny: ["\\b(awk|gawk|perl|python3?|ruby|node)\\b"],
        note: "Deny wins over allow, so this also stops bash_allow entries that spell an " +
            "interpreter -- 'python -m pytest' among them. If you need that one, narrow " +
            "bash_allow instead: 'pytest' on its own names no interpreter.",
    },
    {
        admits: /\bgit\b(?!\s*\()/,
        why: "git (-c core.pager / alias.* run commands)",
        guard: /core\.pager|alias\.|-c\b/,
        deny: ["\\bgit\\b[^|;&]*\\s-c\\s"],
        note: "Ordinary git subcommands are untouched; only `git -c \u2026` is refused.",
    },
];
/**
 * Every top-level block either surface file may declare.
 *
 * A misspelled block name — [resilence], [aproval], [sandobx] — is legal TOML,
 * hashes into the surface, and is read by nothing, so the setting it contains
 * silently reverts to the default. That is the same failure as the misplaced
 * [verify] block, one letter earlier.
 */
const KNOWN_BLOCKS = new Set([
    "endpoints", "defaults", "context", "ui", "routing", "resilience", "audit",
    "session", "process", "tools", "verify", "approval", "sandbox", "exit_codes",
    // Added with the feature, which is the point: [chain] shipped and this list
    // did not move, so every surface declaring one was told "[chain] is not a
    // block this harness reads; it does nothing" -- by the harness that had just
    // read it. A block the code honours and the auditor disowns is the same
    // silent mismatch in the other direction.
    "chain",
    // Same lesson, applied on the way in this time: resolveLoop reads [loop], so
    // this list moves in the same commit. Without it the auditor would print
    // "[loop] is not a block this harness reads" over a block the harness had
    // just read -- and the operator's most likely response is to delete the
    // block, which is how a declared loop setting silently reverts to a default.
    // NOT "loop": .gnomon/loops/*.toml already uses a [loop] header for a loop
    // DECLARATION (name/every/guard/act). Two schemas behind one name in two
    // files is how an operator writes [loop] name = "nightly" into config.toml
    // and gets silence -- the inert-setting failure this project exists to make
    // impossible. These numbers decide when a TURN stops.
    "turn",
]);
/**
 * Keys whose VALUE is a closed set, and what silently happens to a typo.
 *
 * Keyed by (block, key), not by block alone. It used to be a Record keyed on
 * the block, with the key derived at the call site as
 * `block === "approval" ? "gate" : "level"` -- a shape that can hold exactly
 * ONE enumeration per block. [sandbox] has two. So `exec` was unreachable by
 * this check, and resolveExec resolves it as
 * `raw === "docker" ? "docker" : "off"`: every misspelling becomes "off".
 * A surface that asked for container isolation ran on the host and said
 * nothing -- and `exec` was already in ROLE_KEYS and KNOWN_BLOCKS, so no other
 * check saw it either.
 *
 * Measured, 2026-09-02, on a scratch surface carrying
 * `[sandbox] level = "confined"` and `exec = "dokcer"`: auditSurface returned
 * 0 problems before this change and 1 after.
 */
const EXEC_VALUES = ["off", "docker"];
const ENUM_KEYS = [
    { block: "approval", key: "gate", values: ["never", "on_write", "always"], falls_back_to: "on_write" },
    { block: "sandbox", key: "level", values: ["off", "confined", "strict"], falls_back_to: "confined" },
    // resolveExec: anything that is not exactly "docker" resolves to "off".
    { block: "sandbox", key: "exec", values: EXEC_VALUES, falls_back_to: "off" },
];
/**
 * Keys that are read from a different block than the one an operator reaches
 * for first.
 *
 * `compaction` and `max_context_tokens` are read from [defaults], while the
 * block named [context] sits directly above them — so putting them under
 * [context], which is what the names invite, silently does nothing and the
 * window keeps its 65536-token default. Found the hard way: this exact mistake
 * cost a benchmark run today, in a session whose whole subject was misplaced
 * configuration.
 */
const KEY_OWNER = {
    compaction: "defaults",
    max_context_tokens: "defaults",
    edit_format: "defaults",
    role_profile: "defaults",
    policy: "context",
    retain_after: "context",
    summary_role: "context",
    reserve_output: "context",
};
/**
 * Which file each top-level block is read from, and whether it is read at all.
 *
 * A block in the wrong file is legal TOML, hashes into the surface, and is read
 * by nothing. That is not hypothetical: a [verify] block sat in config.toml
 * instead of policy.toml for days, silently disabling the declared check, and
 * the campaign that missed it is the reason this audit exists. The two files sit
 * side by side, both are TOML, both are hashed, and the block is valid in both —
 * there is no way for an operator to see the difference unaided. That case is
 * fatal, because a control that is declared and not read is worse than one that
 * was never declared: the surface says the check runs.
 *
 * This table drifted away from KNOWN_BLOCKS. KNOWN_BLOCKS gained `chain` and
 * `turn` and deliberately dropped `loop` (two schemas behind one name --
 * .gnomon/loops/*.toml uses a [loop] header for a loop DECLARATION); this one
 * still named `loop` and had never carried `turn`, `chain`, `session`,
 * `process` or `exit_codes`. The consequence, measured on a scratch surface:
 * `[turn]` written into policy.toml -- exactly the [verify]-in-the-wrong-file
 * mistake this check exists for -- produced no problem at all, because a block
 * missing from this table is skipped by the loop that reads it.
 *
 * `process` and `exit_codes` are here with read: false. Verified 2026-09-02 by
 * grep over packages/*​/src and crates/*​/src: nothing reads
 * `config.config.process` and nothing reads `config.policy.exit_codes`. The
 * `exit_codes` that IS read is conformance/exit_codes.json, a different file
 * and a different shape (session.ts ExitCodeMap) -- the name collision is
 * precisely why an operator would write the block and expect it to matter.
 */
const BLOCK_OWNER = {
    verify: { file: "policy.toml", read: true },
    approval: { file: "policy.toml", read: true },
    sandbox: { file: "policy.toml", read: true },
    // NOT read: no consumer of config.policy.exit_codes anywhere in this build.
    exit_codes: { file: "policy.toml", read: false },
    endpoints: { file: "config.toml", read: true },
    defaults: { file: "config.toml", read: true },
    context: { file: "config.toml", read: true },
    ui: { file: "config.toml", read: true },
    routing: { file: "config.toml", read: true },
    resilience: { file: "config.toml", read: true },
    audit: { file: "config.toml", read: true },
    // resolveSessionStore reads config.config.session.
    session: { file: "config.toml", read: true },
    // resolveChain reads config.config.chain.
    chain: { file: "config.toml", read: true },
    // resolveLoop reads config.config.turn. NOT "loop": that header means
    // a loop DECLARATION in .gnomon/loops/*.toml, and two schemas behind one
    // name is how a declared setting silently reverts to a default.
    turn: { file: "config.toml", read: true },
    // NOT read: ProcessConfig is typed on Config and no consumer exists.
    process: { file: "config.toml", read: false },
    roles: { file: "roles.toml", read: true },
    tools: { file: "tools.toml", read: true },
};
const ROLE_KEYS = new Set(["allowed_edit_formats", "bash_allow", "bash_deny", "converge_after", "description", "endpoint", "fallback", "max_steps", "max_steps_total", "model", "exec", "image", "profile", "task_allow", "temperature", "tools", "top_p", "write_allow"]);
/**
 * Spellings people reach for when they mean to supply a secret directly.
 *
 * Every one of them is silently ignored today: the block is read into
 * EndpointConfig, which has no field for them, so no Authorization header is
 * ever built. The endpoint then fails with the provider's own 401 and nothing
 * points at the cause — while the secret sits in a content-hashed directory
 * that is meant to be committable. Two failures wearing one typo.
 */
const SECRET_KEYS = new Set([
    "api_key",
    "apikey",
    "apiKey",
    "key",
    "token",
    "secret",
    "password",
    "authorization",
    "bearer",
]);
/**
 * Read the surface for things that are wrong but silent.
 *
 * Every check here exists because the failure it catches surfaced somewhere
 * far away from its cause — a 401 in the middle of a task, an endpoint that
 * was never reachable, a model tag no backend has. Offline and cheap on
 * purpose: it runs before the first turn, so it may not make a network call.
 * Whether a *key* works is a different question, and only the endpoint can
 * answer it — see probeEndpointAuth.
 */
/** Levenshtein, for "did you mean" on a misspelled surface key. */
function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}
export function auditSurface(config) {
    const problems = [];
    const declared = config.config.endpoints ?? {};
    // A block name nothing recognises, and an enum value nothing accepts. Both
    // revert to a default without saying so, and both are one keystroke away from
    // a control the operator believes is in force.
    for (const [file, parsed] of [
        ["config.toml", config.config],
        ["policy.toml", config.policy],
    ]) {
        for (const [block, body] of Object.entries((parsed ?? {}))) {
            if (!KNOWN_BLOCKS.has(block)) {
                const near = [...KNOWN_BLOCKS]
                    .map((k) => [k, editDistance(block, k)])
                    .filter(([, d]) => d <= 2)
                    .sort((a, b) => a[1] - b[1])[0]?.[0];
                problems.push({
                    where: `.gnomon/${file} [${block}]`,
                    problem: `[${block}] is not a block this harness reads` +
                        (near ? `. Did you mean "${near}"?` : "; it does nothing."),
                    fix: `Known blocks: ${[...KNOWN_BLOCKS].sort().join(", ")}.`,
                    fatal: false,
                });
                continue;
            }
            // Every enumeration this block owns, not just the first one. See
            // ENUM_KEYS: the old shape could only express one per block, which is
            // how [sandbox] exec went unchecked.
            for (const spec of ENUM_KEYS) {
                if (spec.block !== block)
                    continue;
                const value = body?.[spec.key];
                if (typeof value !== "string" || spec.values.includes(value))
                    continue;
                problems.push({
                    where: `.gnomon/${file} [${block}]`,
                    problem: `${spec.key} = "${value}" is not one of ${spec.values.join(" | ")}, so this ` +
                        `silently falls back to "${spec.falls_back_to}".`,
                    fix: `Use one of: ${spec.values.join(", ")}. \`gnomon enumerations\` lists them.`,
                    fatal: false,
                });
            }
        }
    }
    // Every pattern the surface declares must actually compile.
    //
    // bash_allow / bash_deny / write_allow are compiled inside the tool at CALL
    // time, so an uncompilable pattern is discovered mid-run or not at all. The
    // two failure directions are opposite and both bad: a broken DENY makes every
    // command refused (the role is dead), while a broken ALLOW silently
    // contributes nothing (the role is wider than it reads). audit.redact is
    // already validated at startup and warned about loudly; these were not.
    for (const [role, rawRole] of Object.entries(config.roles ?? {})) {
        const where = `.gnomon/roles.toml [roles.${role}]`;
        for (const key of ["bash_allow", "bash_deny"]) {
            const list = rawRole?.[key];
            if (!Array.isArray(list))
                continue;
            for (const pattern of list) {
                if (typeof pattern !== "string")
                    continue;
                try {
                    new RegExp(pattern);
                }
                catch (e) {
                    problems.push({
                        where,
                        problem: `${key} pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${e.message}`,
                        fix: key === "bash_deny"
                            ? `While it cannot be compiled, bash is refused outright — this role can run nothing. Fix or remove the pattern.`
                            : `An allow-list entry that cannot compile contributes nothing, so this role is wider than it reads. Fix or remove it.`,
                        // A dead deny is a dead role; a dead allow is a quiet widening.
                        fatal: key === "bash_deny",
                    });
                }
            }
        }
    }
    // routing.rules written with single brackets is a table, not an array of
    // tables — legal TOML, silently yielding zero rules while mode = "auto".
    {
        const routing = config.config?.routing;
        if (routing && "rules" in routing && routing.rules !== undefined && !Array.isArray(routing.rules)) {
            problems.push({
                where: `.gnomon/config.toml [routing]`,
                problem: `routing.rules is a ${typeof routing.rules === "object" ? "table" : typeof routing.rules}, not an array of tables — ` +
                    `so no routing rules are loaded at all.`,
                fix: `Write each rule as [[routing.rules]] with double brackets.`,
                fatal: false,
            });
        }
    }
    // A key in the neighbouring block is read by nothing either.
    for (const [file, parsed] of [
        ["config.toml", config.config],
        ["policy.toml", config.policy],
    ]) {
        for (const [block, body] of Object.entries((parsed ?? {}))) {
            if (!body || typeof body !== "object")
                continue;
            for (const key of Object.keys(body)) {
                const owner = KEY_OWNER[key];
                if (!owner || owner === block)
                    continue;
                problems.push({
                    where: `.gnomon/${file} [${block}]`,
                    problem: `"${key}" is read from [${owner}], not [${block}] — here it does nothing.`,
                    fix: `Move ${key} into the [${owner}] block.`,
                    fatal: false,
                });
            }
        }
    }
    // A declared block that lives in the wrong file is read by nothing.
    for (const [file, parsed] of [
        ["config.toml", config.config],
        ["policy.toml", config.policy],
    ]) {
        for (const block of Object.keys((parsed ?? {}))) {
            const owner = BLOCK_OWNER[block];
            if (!owner)
                continue;
            if (owner.file !== file) {
                problems.push({
                    where: `.gnomon/${file} [${block}]`,
                    problem: owner.read
                        ? `[${block}] is declared here but read from ${owner.file} — so this block ` +
                            `does nothing, while the surface reads as though it does.`
                        : `[${block}] belongs in ${owner.file}, not here — so nothing reads it here. ` +
                            `And nothing reads it there either: no consumer of [${block}] exists in ` +
                            `this build.`,
                    fix: `Move the [${block}] block to .gnomon/${owner.file}.`,
                    // Fatal only when the block is a control that would otherwise be in
                    // force. A block nothing reads is inert wherever it sits; refusing to
                    // start over it would be a claim larger than the evidence.
                    fatal: owner.read,
                });
                continue;
            }
            if (!owner.read) {
                problems.push({
                    where: `.gnomon/${file} [${block}]`,
                    problem: `[${block}] is in the right file and is read by nothing. Verified ` +
                        `2026-09-02 by grep over packages/*/src and crates/*/src: no consumer. ` +
                        `It is typed on the config interface and hashed into the surface, and it ` +
                        `changes no behaviour.`,
                    fix: `Delete the block. A setting that does nothing is worse than no setting: ` +
                        `it invites tuning that cannot move, and it moves the surface hash while ` +
                        `changing nothing about what the harness does.`,
                    fatal: false,
                });
            }
        }
    }
    for (const [role, rawRole] of Object.entries(config.roles ?? {})) {
        const where = `.gnomon/roles.toml [roles.${role}]`;
        // An allow-list that admits a program which takes a command as an argument
        // does not constrain that role, however read-only its description claims to
        // be. Warn rather than refuse: the operator may want exactly this, and it is
        // their surface. What they cannot do is notice it unaided.
        const allow = rawRole?.bash_allow;
        if (Array.isArray(allow) && allow.length > 0) {
            const deny = rawRole?.bash_deny ?? [];
            // One problem PER admission, each carrying the remedy for that admission
            // alone.
            //
            // The shipped version emitted a single problem whose `fix` was a fixed
            // string: "add a bash_deny for the executing forms, e.g. bash_deny =
            // ['-exec', '-execdir', '-delete', '-fprint', '\bxargs\b']". Measured
            // 2026-09-02 on a surface written by `gnomon init` itself: the fresh
            // surface warns on first launch, the admission is `an interpreter`
            // (bash_allow names `python -m pytest`), and all five patterns in that
            // remedy were ALREADY in the file init had just written. Following the
            // printed instruction to the letter could not clear the warning, because
            // none of those five patterns guards the interpreter admission. A remedy
            // that cannot clear the thing it is offered for teaches an operator to
            // ignore the auditor.
            //
            // `fix` is now built from the same `deny` data the guard is tested
            // against, so the remedy is by construction the thing whose absence made
            // this fire.
            for (const e of EXECUTING_ARGS) {
                const hits = allow.filter((pat) => typeof pat === "string" && e.admits.test(pat));
                if (hits.length === 0)
                    continue;
                // Guarded per admission: a deny for `git push --delete` says nothing
                // about whether `python` can still run arbitrary code.
                if (deny.some((d) => typeof d === "string" && e.guard.test(denyText(d))))
                    continue;
                problems.push({
                    where,
                    problem: `bash_allow admits ${e.why} — a program that takes a command as an ` +
                        `argument, so an allow-list of program NAMES does not bound this role by ` +
                        `the names it appears to. Named by: ${hits.map((h) => JSON.stringify(h)).join(", ")}. ` +
                        `NOT VERIFIED: this reads the allow-list pattern TEXT and does not evaluate ` +
                        `which commands that pattern actually matches, so it does not show that any ` +
                        `particular command reaches this role.`,
                    fix: `Add to this role's bash_deny — deny wins over allow, so the rest of ` +
                        `bash_allow is untouched:\n` +
                        `        bash_deny = [${e.deny.map((d) => `'${d}'`).join(", ")}]\n` +
                        `      ${e.note}\n` +
                        `      Or drop the entr${hits.length > 1 ? "ies" : "y"} above from bash_allow ` +
                        `(\`glob\`/\`grep\` are gated read-only tools that already exist).`,
                    fatal: false,
                });
            }
        }
        // A per-role `exec` override falls back exactly like the [sandbox] one:
        // resolveExec reads `roleDef?.exec ?? sandbox.exec` and resolves anything
        // that is not the string "docker" to "off". ROLE_KEYS catches a misspelled
        // KEY; nothing caught a misspelled VALUE, so `exec = "dokcer"` on a role
        // read as an isolation request and ran on the host.
        {
            const value = rawRole?.exec;
            if (typeof value === "string" && !EXEC_VALUES.includes(value)) {
                problems.push({
                    where,
                    problem: `exec = "${value}" is not one of ${EXEC_VALUES.join(" | ")}, so this role ` +
                        `silently falls back to "off" — no sandbox, and no warning.`,
                    fix: `Use one of: ${EXEC_VALUES.join(", ")}. Only "docker" is wired in this build.`,
                    fatal: false,
                });
            }
        }
        for (const field of Object.keys((rawRole ?? {}))) {
            if (ROLE_KEYS.has(field))
                continue;
            const near = [...ROLE_KEYS]
                .map((k) => [k, editDistance(field, k)])
                .filter(([, d]) => d <= 2)
                .sort((a, b) => a[1] - b[1])[0]?.[0];
            problems.push({
                where,
                problem: `unknown field "${field}" — it is read by nothing` +
                    (near ? `. Did you mean "${near}"?` : "."),
                fix: (near === "tools"
                    ? `A role with no readable \`tools\` list gets EVERY declared tool, so this ` +
                        `typo widens the role instead of narrowing it. `
                    : near && near.endsWith("_allow")
                        ? `An unreadable allow-list is not an empty one — it removes the restriction ` +
                            `entirely. `
                        : "") + `Roles take: ${[...ROLE_KEYS].join(", ")}.`,
                fatal: true,
            });
        }
    }
    // The three checks below are about the SURFACE, not about one role, and
    // they used to sit inside the per-role loop above. Each therefore ran once
    // per role: two genuine task_allow warnings were reported seven times each
    // on this repository's own surface, fifteen lines for three problems. A
    // fatal [chain] stage would have printed seven times and inflated the fatal
    // count sevenfold, which is worse -- warning fatigue is how a real finding
    // gets skipped, and an overstated count erodes trust in the diagnostic.
    // A chain stage naming a role that does not exist fails partway through a
    // turn, after the earlier stages have already spent their budget and their
    // tokens. Fatal, because the surface cannot do what it says it does.
    {
        const stages = resolveChain(config);
        for (const st of stages) {
            if (!config.roles?.[st]) {
                problems.push({
                    where: ".gnomon/config.toml [chain]",
                    problem: `stage "${st}" is not a role in this surface.`,
                    fix: `Declared roles: ${Object.keys(config.roles ?? {}).sort().join(", ")}.`,
                    fatal: true,
                });
            }
        }
        if (stages.length === 1) {
            problems.push({
                where: ".gnomon/config.toml [chain]",
                problem: `a chain of one stage ("${stages[0]}") is the same as no chain.`,
                fix: "Remove [chain], or add the stages that make it a chain.",
                fatal: false,
            });
        }
    }
    // A role holding `task` with no task_allow can delegate to any role, and a
    // sub-turn runs with the TARGET role's tools -- so its own `tools` line is
    // not the answer to what it can cause. Worth saying out loud, in the same
    // spirit as the bash_allow warning: the operator can decide this is fine,
    // what they cannot do is notice it unaided.
    for (const [roleName, rawRole] of Object.entries(config.roles ?? {})) {
        const def = rawRole;
        const holdsTask = !def?.tools || def.tools.includes("task");
        if (!holdsTask || def?.task_allow !== undefined)
            continue;
        const reachable = Object.keys(config.roles ?? {}).filter((r) => r !== roleName);
        const writers = reachable.filter((r) => {
            const t = config.roles[r]?.tools;
            return !t || t.includes("write") || t.includes("edit") || t.includes("bash");
        });
        if (writers.length === 0)
            continue;
        problems.push({
            where: `.gnomon/roles.toml [roles.${roleName}]`,
            problem: `holds \`task\` with no task_allow, so it may delegate to any role — ` +
                `including ${writers.slice(0, 3).join(", ")}${writers.length > 3 ? ", …" : ""}, ` +
                `which can write. A sub-turn runs with the TARGET role's tools, so this ` +
                `role's own tools list is not the limit of what it can cause.`,
            fix: `Name the roles it may delegate to, e.g. task_allow = ["${writers[0]}"]. ` +
                `An empty list forbids delegation entirely.`,
            fatal: false,
        });
    }
    // A granted extra root that is absolute, or that is not there, is worth
    // saying out loud. Neither is fatal -- a grant that resolves nowhere simply
    // grants nothing, which is the safe direction -- but both mean the surface
    // does not say what its author thought it said.
    {
        const raw = config.policy?.sandbox?.extra_roots;
        if (raw !== undefined && !Array.isArray(raw)) {
            problems.push({
                where: ".gnomon/policy.toml [sandbox]",
                problem: "extra_roots is not an array.",
                fix: 'Write it as a list, e.g. extra_roots = ["../sibling-checkout"].',
                fatal: true,
            });
        }
        else if (Array.isArray(raw)) {
            const root = resolve(config.gnomonDir, "..");
            for (const entry of raw) {
                if (typeof entry !== "string")
                    continue;
                if (isAbsolute(entry)) {
                    problems.push({
                        where: ".gnomon/policy.toml [sandbox]",
                        problem: `extra_roots contains an absolute path (${entry}) — that is ` +
                            `machine-scoped configuration, and it grants nothing on any other clone.`,
                        fix: "Name it relative to the repository root instead, e.g. \"../sibling-checkout\".",
                        fatal: false,
                    });
                }
                const abs = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
                if (!existsSync(abs)) {
                    problems.push({
                        where: ".gnomon/policy.toml [sandbox]",
                        problem: `extra_roots names ${entry}, which does not exist here — it grants nothing.`,
                        fix: "Remove it, or check the path relative to the repository root.",
                        fatal: false,
                    });
                }
            }
        }
    }
    for (const [name, raw] of Object.entries(declared)) {
        const where = `.gnomon/config.toml [endpoints.${name}]`;
        // Read as raw TOML: the point is to see the fields EndpointConfig has no
        // home for, which is exactly what the typed view hides.
        const block = (raw ?? {});
        for (const field of Object.keys(block)) {
            if (SECRET_KEYS.has(field)) {
                problems.push({
                    where,
                    problem: `${field} holds a secret in the surface — and the harness never reads it, ` +
                        `so this endpoint sends no Authorization header at all.`,
                    fix: `Delete the ${field} line, then:  gnomon key set ${name}\n` +
                        `      and declare  api_key_env = "<VARIABLE_NAME>"  in its place. ` +
                        `Rotate the exposed key: .gnomon/ is hashed and meant to be committed.`,
                    fatal: true,
                });
                continue;
            }
            if (!ENDPOINT_KEYS.has(field)) {
                problems.push({
                    where,
                    problem: `unknown field "${field}" — it is read by nothing.`,
                    fix: `Endpoints take: ${[...ENDPOINT_KEYS].join(", ")}. Check the spelling.`,
                    fatal: false,
                });
            }
        }
        if (!block.url) {
            problems.push({
                where,
                problem: "no url — nothing can be sent here.",
                fix: `Add url = "https://…/chat/completions" (or an Ollama /api/chat).`,
                fatal: true,
            });
        }
        const kind = block.kind;
        if (kind !== undefined && kind !== "openai" && kind !== "ollama") {
            problems.push({
                where,
                problem: `kind = "${String(kind)}" is not a request shape the harness knows.`,
                fix: 'kind is "openai" or "ollama".',
                fatal: true,
            });
        }
    }
    const known = new Set(listEndpoints(config));
    for (const [role, def] of Object.entries(config.roles ?? {})) {
        const targets = [
            [`[roles.${role}]`, def?.endpoint, def?.model],
            [`[roles.${role}.fallback]`, def?.fallback?.endpoint, def?.fallback?.model],
        ];
        for (const [block, endpoint, model] of targets) {
            if (endpoint === undefined && model === undefined)
                continue;
            const where = `.gnomon/roles.toml ${block}`;
            if (endpoint !== undefined && !known.has(endpoint)) {
                problems.push({
                    where,
                    problem: `endpoint = "${endpoint}" is not declared.`,
                    fix: `Declared: ${[...known].sort().join(", ")}. Add [endpoints.${endpoint}] or point this at one of those.`,
                    fatal: true,
                });
                continue;
            }
            // An Ollama tag on a cloud endpoint, or the reverse. Not conclusive —
            // only the endpoint's own model list is — but it is the mistake that
            // gets made, and it costs nothing to say so before the turn that fails.
            if (!model || endpoint === undefined)
                continue;
            const url = declared[endpoint]?.url ?? BUILTIN_ENDPOINTS[endpoint]?.url;
            if (!url)
                continue;
            const local = isLocalEndpoint(url);
            const looksLocal = /:\d|:[a-z0-9._-]*(b|q\d)/i.test(model) && model.includes(":");
            if (!local && looksLocal) {
                problems.push({
                    where,
                    problem: `model = "${model}" is an Ollama-style tag, but "${endpoint}" is a cloud endpoint.`,
                    fix: `Run /models to see what "${endpoint}" actually serves.`,
                    fatal: false,
                });
            }
        }
    }
    // ── Skills ───────────────────────────────────────────────────────────────
    //
    // A skill file is surface: it is hashed, and its body goes into the system
    // prompt. Three ways it can be inert or hostile, none of which said anything
    // before this:
    //
    //   1. `match` will not compile. selectSkills does
    //      `try { new RegExp(s.match, "i") } catch { return false }` -- so the
    //      skill silently applies to NOTHING, forever, and the surface reads as
    //      though the note is in force. The catch is right (one bad note must not
    //      break every turn) and silent is wrong.
    //   2. A control character. It renders as nothing in a terminal, so
    //      `gnomon skill list` and a diff both show a file that looks correct,
    //      while an ESC sequence in the body can repaint the operator's screen
    //      and any C0 byte reaches the model as prompt text. It hashes like any
    //      other byte, so the surface hash moves and the visible file does not.
    //   3. `roles` naming a role this surface does not declare. selectSkills
    //      filters on `s.roles.includes(role)`, so one typo -- "implementer" for
    //      "implementor" -- makes the note apply to nothing. Same silence as (1),
    //      one letter earlier.
    //
    // Warnings, not refusals: a dead skill costs knowledge, not safety.
    //
    // Guarded on gnomonDir because auditSurface is also called on hand-built
    // config objects that never loaded a directory (config.test.ts does this
    // throughout), and join(undefined, "skills") throws.
    if (typeof config.gnomonDir === "string" && config.gnomonDir) {
        const roleNames = new Set(Object.keys(config.roles ?? {}));
        let skills = [];
        try {
            skills = loadSkills(config);
        }
        catch (e) {
            problems.push({
                where: ".gnomon/skills/",
                problem: `the skills directory could not be read: ${e.message}`,
                fix: "Fix or remove the unreadable file. Until then no skill loads at all.",
                fatal: false,
            });
        }
        for (const skill of skills) {
            const where = `.gnomon/skills/${skill.id}.md`;
            if (skill.match !== undefined) {
                try {
                    new RegExp(skill.match, "i");
                }
                catch (e) {
                    problems.push({
                        where,
                        problem: `match = ${JSON.stringify(skill.match)} is not a valid regular expression: ` +
                            `${e.message}. selectSkills catches this and returns false, so ` +
                            `the skill applies to nothing — on every turn, silently.`,
                        fix: `Fix the pattern, or delete the \`match\` line entirely: a skill with no ` +
                            `match always applies, which is what a broken one was probably meant to do.`,
                        fatal: false,
                    });
                }
            }
            // C0 and C1 controls, minus the three that are legitimate text.
            // eslint-disable-next-line no-control-regex
            const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
            for (const [field, text] of [
                ["name", skill.name],
                ["description", skill.description],
                ["match", skill.match],
                ["body", skill.body],
            ]) {
                if (typeof text !== "string")
                    continue;
                const at = text.search(CONTROL);
                if (at < 0)
                    continue;
                const code = text.charCodeAt(at);
                problems.push({
                    where,
                    problem: `${field} holds a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}` +
                        `${code === 0x1b ? ", ESC" : ""}) at offset ${at}. It renders as nothing, so the ` +
                        `file looks correct in a terminal and in a diff while the surface hash has ` +
                        `moved` +
                        (field === "body"
                            ? ` — and the body goes into the system prompt verbatim.`
                            : `.`),
                    fix: `Remove the byte. To find it:  grep -nP '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' ` +
                        `.gnomon/skills/${skill.id}.md`,
                    fatal: false,
                });
                break; // one report per skill is enough to send someone to the file
            }
            for (const role of skill.roles ?? []) {
                if (roleNames.has(role))
                    continue;
                const near = [...roleNames]
                    .map((r) => [r, editDistance(role, r)])
                    .filter(([, d]) => d <= 3)
                    .sort((a, b) => a[1] - b[1])[0]?.[0];
                problems.push({
                    where,
                    problem: `roles names "${role}", which is not a role in this surface — selectSkills ` +
                        `filters on that list, so this skill reaches nothing under that name` +
                        (near ? `. Did you mean "${near}"?` : "."),
                    fix: `Declared roles: ${[...roleNames].sort().join(", ") || "(none)"}. ` +
                        `Remove \`roles\` entirely to apply the skill to every role.`,
                    fatal: false,
                });
            }
        }
    }
    return problems;
}
/**
 * Ask an endpoint whether a key is accepted for *inference*.
 *
 * A model list is not the test. opencode.ai serves /v1/models to an unset
 * key, a wrong key and no key at all — 200 every time — so a listing that
 * worked was read as a key that worked, and the first honest signal was a 401
 * several turns into a session. The smallest possible completion is the only
 * thing that answers the question actually being asked.
 */
export async function probeEndpointAuth(endpoint, model, timeoutMs = 20000) {
    const key = endpoint.api_key_env ? process.env[endpoint.api_key_env] : undefined;
    if (endpoint.api_key_env && !key) {
        return { ok: false, detail: `$${endpoint.api_key_env} is not set` };
    }
    const ollama = (endpoint.kind ?? "ollama") === "ollama";
    const body = ollama
        ? { model, messages: [{ role: "user", content: "hi" }], stream: false }
        : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
    try {
        const res = await fetch(endpoint.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok)
            return { ok: true, status: res.status };
        const text = (await res.text().catch(() => "")).slice(0, 300);
        return { ok: false, status: res.status, detail: text || res.statusText };
    }
    catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
/** Every endpoint the surface offers, built-ins included. */
/**
 * The environment-variable NAMES this surface declares as credential holders.
 *
 * The one legitimate reason for the machine-local store to touch process.env.
 * Anything not in this set is configuration, not a credential, and the store
 * refuses it -- see applyCredentials.
 */
export function declaredKeyVars(config) {
    const out = new Set();
    for (const ep of Object.values(config.config.endpoints ?? {})) {
        const name = ep?.api_key_env;
        if (typeof name === "string" && name.trim())
            out.add(name.trim());
    }
    // MCP servers forward named variables to their child process, and those are
    // credentials by the same definition.
    for (const def of Object.values(config.tools?.mcp_servers ?? {})) {
        for (const name of def.env ?? []) {
            if (typeof name === "string" && name.trim())
                out.add(name.trim());
        }
    }
    return [...out].sort();
}
export function listEndpoints(config) {
    return [
        ...new Set([
            ...Object.keys(BUILTIN_ENDPOINTS),
            ...Object.keys(config.config.endpoints ?? {}),
        ]),
    ].sort();
}
/**
 * Whether an endpoint URL is the operator's own hardware rather than a cloud.
 *
 * The distinction is the one a reader keeps confusing — a role on a cloud
 * endpoint must name a model that endpoint hosts, never a local Ollama tag —
 * so the listings mark each endpoint local or cloud from this. localhost, the
 * LAN (RFC1918), and Tailscale's CGNAT range (100.64.0.0/10) are all local.
 */
export function isLocalEndpoint(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return false;
    }
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host))
        return true;
    if (host.endsWith(".local"))
        return true;
    return (/^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host));
}
const KNOWN_PROVIDERS = [
    [/(^|\.)openrouter\.ai$/, "openrouter"],
    [/(^|\.)opencode\.ai$/, "opencode"],
    [/(^|\.)githubcopilot\.com$/, "copilot"],
    [/\.openai\.azure\.com$/, "azure"],
    [/(^|\.)azure\.com$/, "azure"],
    [/(^|\.)amazonaws\.com$/, "aws"],
    [/(^|\.)googleapis\.com$/, "google"],
    [/(^|\.)anthropic\.com$/, "anthropic"],
    [/(^|\.)openai\.com$/, "openai"],
    [/(^|\.)mistral\.ai$/, "mistral"],
    [/(^|\.)together\.(ai|xyz)$/, "together"],
    [/(^|\.)groq\.com$/, "groq"],
];
/**
 * Classify an endpoint for a listing: is it the operator's own hardware or a
 * cloud, and which provider. `provider` (if the surface set it) wins; otherwise
 * it is inferred from the host. Display only — routing never consults this.
 */
export function endpointClass(url, kind, provider) {
    const where = isLocalEndpoint(url) ? "local" : "cloud";
    if (provider)
        return { where, provider };
    if (where === "local") {
        return { where, provider: kind === "ollama" ? "ollama" : "self-hosted" };
    }
    let host = "";
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        host = "";
    }
    for (const [re, name] of KNOWN_PROVIDERS) {
        if (re.test(host))
            return { where, provider: name };
    }
    return { where, provider: host || "custom" };
}
/**
 * Route a role to its model config.
 * Returns the model string and sampling params from roles.toml,
 * falling back to profile-level settings if role-level isn't set.
 */
export function routeRole(config, role) {
    const roleDef = getRole(config, role);
    // Role-level overrides take precedence
    const model = roleDef.model ?? roleDef.profile ?? "local:default";
    const temperature = roleDef.temperature ?? 0.2;
    const top_p = roleDef.top_p ?? 0.9;
    const description = roleDef.description ?? "";
    // Where inference goes is declared in the surface and hashed with it.
    // GNOMON_MODEL_URL remains only as an explicit override, and the prompt
    // loop announces it when set — a machine-scoped route that changed
    // behaviour silently is exactly what Rule 1 exists to prevent.
    const endpointName = roleDef.endpoint ?? DEFAULT_ENDPOINT;
    const endpoint = resolveEndpoint(config, endpointName);
    const target = {
        model,
        temperature,
        top_p,
        url: process.env.GNOMON_MODEL_URL ?? endpoint.url,
        apiKeyEnv: endpoint.api_key_env,
        endpoint: endpointName,
        kind: endpoint.kind ?? "ollama",
    };
    let fallback;
    if (roleDef.fallback?.model) {
        const fb = roleDef.fallback;
        // An explicit url wins over a named endpoint, so existing surfaces that
        // spelled the URL out keep working unchanged.
        const fbEndpointName = fb.endpoint ?? (fb.url ? undefined : DEFAULT_ENDPOINT);
        const fbEndpoint = fbEndpointName
            ? resolveEndpoint(config, fbEndpointName)
            : undefined;
        fallback = {
            model: fb.model,
            temperature,
            top_p,
            url: fb.url ?? fbEndpoint?.url ?? "",
            apiKeyEnv: fb.api_key_env ?? fbEndpoint?.api_key_env,
            endpoint: fbEndpointName,
            kind: fbEndpoint?.kind ?? "openai",
        };
    }
    return { model, temperature, top_p, description, target, fallback };
}
/**
 * List available roles.
 */
export function listRoles(config) {
    return Object.keys(config.roles);
}
/**
 * List available profiles.
 */
export function listProfiles(config) {
    return Object.keys(config.profiles);
}
/**
 * Infer role from user input pattern (simple heuristic).
 * "Plan:" → plan, "Implement:" → implement, "Critique:" → critique, otherwise → implement.
 */
export function inferRole(input) {
    const lower = input.toLowerCase().trim();
    if (lower.startsWith("plan:") || lower.startsWith("plan ") || lower.startsWith("/plan")) {
        return "plan";
    }
    if (lower.startsWith("critique:") || lower.startsWith("critique ") || lower.startsWith("/critique")) {
        return "critique";
    }
    if (lower.startsWith("smol:") || lower.startsWith("smol ") || lower.startsWith("/smol")) {
        return "smol";
    }
    return "implement";
}
/**
 * Canonical .gnomon/ surface paths — the minimum set every manifest lists.
 * Mirrors gnomon-surface's SURFACE_PATHS.
 */
/**
 * Canonical surface paths, `.gnomon/`-prefixed to match gnomon-surface and
 * conformance/manifest_golden.json.
 *
 * These strings go into the hash, so a different prefix is a different hash.
 * Unprefixed, this implementation and the Rust one returned different values
 * for the same directory — two things both called "the surface hash".
 */
const SURFACE_PATHS = [
    ".gnomon/config.toml",
    ".gnomon/system.md",
    ".gnomon/roles.toml",
    ".gnomon/tools.toml",
    ".gnomon/policy.toml",
];
/**
 * Compute SHA256 of file contents.
 */
function fileSha256(filePath) {
    try {
        const content = readFileSync(filePath);
        return createHash("sha256").update(content).digest("hex");
    }
    catch {
        return null;
    }
}
/**
 * Walk .gnomon/ directory, collect files with their hashes.
 * Only hashes — never contents.
 */
/**
 * Resolve either a project root or a `.gnomon/` directory to the surface dir.
 *
 * Both call styles exist in this codebase — the tests pass a project root, and
 * every runtime caller passes `config.gnomonDir`. Accepting only the former
 * meant the runtime looked for `.gnomon/.gnomon`, found nothing, and hashed
 * "every file absent": a constant that was identical in every repository and
 * never changed when the surface did.
 */
function surfaceDirOf(dir) {
    return basename(resolve(dir)) === ".gnomon" ? resolve(dir) : join(dir, ".gnomon");
}
function collectSurface(baseDir) {
    const sources = [];
    const gnomonDir = surfaceDirOf(baseDir);
    if (!existsSync(gnomonDir))
        return sources;
    function walk(dir) {
        if (!existsSync(dir))
            return;
        const entries = readdirSync(dir);
        for (const entry of entries) {
            const fullPath = join(dir, entry);
            // Prefixed to match the Rust implementation and the golden fixture.
            // POSIX separators always. The path string is hashed, so `join()` on
            // Windows puts backslashes into the manifest and the same tree gets two
            // hashes. Worse: recomputeManifest looks the canonical SURFACE_PATHS up by
            // exact string, so every one of them misses and is recorded absent while
            // the real files are listed again as extras. No-op where sep is "/".
            const relPath = join(".gnomon", relative(gnomonDir, fullPath))
                .split(sep)
                .join("/");
            const st = statSync(fullPath);
            if (st.isDirectory()) {
                // skills/proposed/ is staging, not surface. DESIGN.md gives the reason
                // the `skill` tool writes there at all: "An agent rewriting its own
                // skills mid-session would change the hash underneath the run that
                // changed it -- so the skill tool writes to skills/proposed/, which is
                // not loaded". Half of that was true. The proposal is genuinely not
                // loaded and cannot change behaviour -- but it sits inside .gnomon/,
                // so it was hashed, and the hash moved anyway. Measured: a coordinator
                // turn that proposed one skill left the surface hash at aa71d075c48e
                // where its own audit record had stamped d715443b4af3.
                //
                // README names that exact harm as the thing the surface block prevents:
                // an agent must not "move the surface hash, which is the one identifier
                // a session is traced by". So excluding staging is not a narrowing of
                // what the hash covers, it is the hash finally meaning what it is
                // documented to mean -- everything that decides how the agent behaves,
                // and identical hashes for identical rules in BOTH directions.
                //
                // Nothing becomes invisible. `gnomon skill list` shows proposals, and
                // accepting one moves the file into skills/, which is hashed -- so the
                // moment a proposal can affect behaviour is exactly the moment it
                // starts counting.
                if (relPath !== ".gnomon/skills/proposed")
                    walk(fullPath);
            }
            else {
                const hash = fileSha256(fullPath);
                sources.push({ path: relPath, sha256: hash });
            }
        }
    }
    walk(gnomonDir);
    return sources;
}
/**
 * Absolute extra roots granted by `[sandbox] extra_roots`, resolved against the
 * repository root so a surface can name a sibling checkout as `"../other"` and
 * stay portable.
 *
 * Relative entries are the point: an absolute path in the surface would be
 * machine-scoped configuration, which Rule 1 forbids. `../other` means the same
 * thing on every clone that has the same two repositories side by side, and
 * means nothing -- resolving to a path that simply does not exist, and so
 * granting nothing -- on one that does not.
 */
export function resolveExtraRoots(config) {
    const raw = config.policy?.sandbox?.extra_roots;
    if (!Array.isArray(raw))
        return [];
    const root = resolve(config.gnomonDir, "..");
    return raw
        .filter((r) => typeof r === "string" && r.trim().length > 0)
        .map((r) => (isAbsolute(r) ? resolve(r) : resolve(root, r)));
}
/**
 * Resolve `[sandbox] exec`, with a per-role override in roles.toml.
 *
 * The sandbox LEVEL governs tool paths and has never governed `bash` -- a role
 * that runs builds and installers cannot have its shell enumerated in advance,
 * so `strict` still runs `cat /etc/passwd`. This is the other half: not what
 * paths a tool may name, but where the shell itself executes.
 *
 * "off" is the default and changes nothing, so no existing surface moves. It is
 * opt-in per surface and per role, which is the point -- one role can run its
 * calculations in a container while the rest of the harness runs on the host.
 *
 * Only "docker" is wired. bwrap was tested first and cannot work on stock
 * Ubuntu without relaxing the AppArmor restriction on unprivileged user
 * namespaces: `bwrap: setting up uid map: Permission denied`, with
 * /proc/sys/kernel/unprivileged_userns_clone already 1. A backend that cannot
 * start must refuse rather than silently run unsandboxed, so it is not offered
 * rather than offered-and-broken.
 */
export function resolveExec(config, role) {
    const sandbox = (config.policy?.sandbox ?? {});
    const roleDef = role ? config.roles?.[role] : undefined;
    const raw = (roleDef?.exec ?? sandbox.exec);
    const mode = raw === "docker" ? "docker" : "off";
    const image = (typeof roleDef?.image === "string" && roleDef.image) ||
        (typeof sandbox.image === "string" && sandbox.image) ||
        "debian:stable-slim";
    return { mode, image, network: sandbox.network === true };
}
/**
 * A declared role chain: the stages one turn passes through, in order.
 *
 * The separation this buys is the one the harness was built around, and until
 * now it existed only across turns a person drove by hand. `task` lets a model
 * reach for it mid-turn; this makes it the shape of the turn itself.
 *
 * Declared in the surface rather than typed at a keyboard, because a chain a
 * human types is machine-scoped behaviour of the worst kind: it lives in their
 * habits, it is not hashed, it is not in the manifest, and it does not
 * reproduce on another machine. Declared, it is data — hashed, diffable, and
 * identical everywhere.
 *
 * Absent means the current behaviour: one role answers. Nothing existing moves.
 *
 * Rule 4 is the constraint that shapes the rest: every stage keeps its OWN
 * bucket and its own record. The chain never collapses three outcomes into a
 * composite verdict, because that is precisely the thing this harness refuses
 * to do.
 */
export function resolveChain(config) {
    const raw = config.config?.chain?.stages;
    if (!Array.isArray(raw))
        return [];
    const stages = raw.filter((r) => typeof r === "string" && r.trim().length > 0);
    // A stage naming a role that does not exist would fail mid-turn, after the
    // earlier stages had already spent their budget. auditSurface reports it.
    return stages;
}
/**
 * Read [resilience] from config.toml.
 *
 * In the surface, not the environment, because a harness that retried three
 * times here and once there would not be the same harness — and the timeout in
 * particular decides what counts as apparatus failure, which is a behaviour.
 * GNOMON_MODEL_TIMEOUT_MS used to set it from the shell, which is exactly the
 * machine-scoped configuration Rule 1 forbids.
 *
 * Retrying is not a behaviour in the sense determinism cares about: it does not
 * change what the harness decides, only how many times it asks before giving
 * up on a socket. What would break determinism is retrying a *different* number
 * of times per machine, which is why the count is hashed with everything else.
 */
export function resolveResilience(config) {
    const r = config.config
        ?.resilience;
    const num = (v, d) => typeof v === "number" && isFinite(v) && v >= 0 ? v : d;
    return {
        // 1 attempt means "try once, do not retry" — the behaviour before this
        // existed, and still the value a surface can choose.
        attempts: Math.max(1, Math.floor(num(r?.attempts, 3))),
        backoff_ms: Math.floor(num(r?.backoff_ms, 500)),
        request_timeout_ms: Math.max(1000, Math.floor(num(r?.request_timeout_ms, 300_000))),
        // 60s rides out the transient provider blips that are actually observed —
        // the one that prompted this lasted 54 — while staying far inside a
        // 900s harness wall. It is spent at most once per turn, because an
        // endpoint that is still unreachable afterwards ends the turn.
        transport_grace_ms: Math.floor(num(r?.transport_grace_ms, 60_000)),
    };
}
/**
 * The compiled-in values, kept in ONE place.
 *
 * prompt_loop.ts re-exports these under their old constant names rather than
 * repeating the numbers, because a default written twice is a setting with two
 * values: `modelTimeoutMs` hardcoded 120_000 while resolveResilience defaulted
 * to 300_000, and the same surface got whichever path happened to ask.
 */
export const LOOP_DEFAULTS = {
    max_consecutive_empty: 3,
    max_run_notes: 40,
    read_only_converge_after: 0.6,
    all_refused_notice: 3,
    max_steps: 12,
    legs: 8,
    stall_repeats: 3,
    nudge_after_idle: 12,
    converge_refire: 6,
};
/**
 * Read [loop] from config.toml.
 *
 * Defaults are exactly the constants this replaces, so no existing surface
 * changes behaviour and no existing hash starts meaning something new. What
 * changes is that a surface CAN now say -- and when it says, the hash moves.
 *
 * NOT VERIFIED: no run has been measured before and after this. It is a
 * correctness change to what the surface hash covers, not a tuning change, and
 * it is not evidence that any of these numbers is the right one.
 *
 * Known limit, published rather than papered over: three loop behaviours are
 * still compiled in and still outside the hash -- `STALL_WINDOW` (8) and
 * `STALL_DISTINCT` (2), which govern the A-B-A-B alternation test, and the TEXT
 * of the nudge and convergence messages, which the reconciliation doc names
 * alongside the numbers. So "[loop] declares the loop" is true of these nine and
 * of nothing else yet.
 */
export function resolveLoop(config) {
    const l = config.config?.turn;
    const num = (v, d) => typeof v === "number" && isFinite(v) && v >= 0 ? v : d;
    const d = LOOP_DEFAULTS;
    return {
        // 0 is legal and means "one blank ends the turn": never re-ask.
        max_consecutive_empty: Math.floor(num(l?.max_consecutive_empty, d.max_consecutive_empty)),
        // Floored at 1, not 0. `pushNote` keeps the tail with `slice(-limit)`, and
        // `[1,2,3].slice(-0)` returns the WHOLE array -- checked in node, not in a
        // test -- so a bound of zero would silently mean no bound at all. A setting
        // that reads as "keep none" and does the opposite is the failure this file
        // exists to prevent.
        max_run_notes: Math.max(1, Math.floor(num(l?.max_run_notes, d.max_run_notes))),
        // A fraction of the step budget, so clamped to it. 0 means never.
        read_only_converge_after: Math.min(1, num(l?.read_only_converge_after, d.read_only_converge_after)),
        all_refused_notice: Math.floor(num(l?.all_refused_notice, d.all_refused_notice)),
        // Floored at 1 because 0 makes max_steps_total 0, which is the wall on the
        // first call: the turn ends before any tool runs. A role that really wants
        // that already has max_steps_total = 0 in roles.toml, where it is one role's
        // decision rather than every role's.
        max_steps: Math.max(1, Math.floor(num(l?.max_steps, d.max_steps))),
        legs: Math.max(1, Math.floor(num(l?.legs, d.legs))),
        // Floored at 1 for the same class of reason as max_run_notes: the stall test
        // is `recentCalls.slice(-stall_repeats).every(...)`, and at 0 that is
        // `[].every(...)`, which is `true`. Zero would declare a stall on the first
        // tool call of every turn.
        stall_repeats: Math.max(1, Math.floor(num(l?.stall_repeats, d.stall_repeats))),
        // Both are "calls since the last one", so 0 would fire on every single call
        // and turn a nudge into a wall of system messages.
        nudge_after_idle: Math.max(1, Math.floor(num(l?.nudge_after_idle, d.nudge_after_idle))),
        converge_refire: Math.max(1, Math.floor(num(l?.converge_refire, d.converge_refire))),
    };
}
/**
 * Read [verify] from policy.toml.
 *
 * Returns null unless a command is declared, so every call site can treat "no
 * gate" as the ordinary case rather than a special one.
 */
export function resolveVerify(config) {
    const v = config.policy?.verify;
    const command = typeof v?.command === "string" ? v.command.trim() : "";
    if (!command)
        return null;
    const after = v?.after === "always" ? "always" : "write";
    const rounds = typeof v?.max_rounds === "number" ? v.max_rounds : 1;
    return {
        command,
        after,
        // Zero is a legitimate setting: run the check, report it, never hand the
        // turn back. Negative is not.
        max_rounds: Math.max(0, Math.floor(rounds)),
        test_must_fail_first: v?.test_must_fail_first === true,
        test_paths: Array.isArray(v?.test_paths) && v.test_paths.length > 0
            ? v.test_paths
            : ["**/test_*.py", "**/*_test.py", "**/*.test.ts", "**/*.test.js", "**/tests/**"],
    };
}
/**
 * Recompute the manifest from the .gnomon/ tree on disk.
 * Used for drift detection: compare against the cached manifest.
 * Returns a fresh Manifest suitable for comparison.
 *
 * It took a `build` parameter until this commit and never read it. Six call
 * sites passed the literal "0.1.0", which read as if the returned manifest were
 * stamped with a version — it is not, and the return type never carried one.
 * A dead argument that looks like provenance is worse than no argument in a
 * codebase whose subject is provenance, so it is gone rather than defaulted.
 * The build string a record actually carries comes from harnessBuild().
 */
export function recomputeManifest(baseDir) {
    const existing = collectSurface(baseDir);
    const existingMap = new Map();
    for (const s of existing) {
        existingMap.set(s.path, s);
    }
    const sources = [];
    // 1. All canonical surface paths (present or absent)
    for (const path of SURFACE_PATHS) {
        const existing = existingMap.get(path);
        sources.push(existing ?? { path, sha256: null });
    }
    // 2. Additional files not in SURFACE_PATHS (profiles/, skills/, etc.)
    for (const s of existing) {
        const isCanonical = SURFACE_PATHS.includes(s.path);
        if (!isCanonical) {
            if (!sources.some((ss) => ss.path === s.path)) {
                sources.push(s);
            }
        }
    }
    // Sort by path, byte-wise — NOT localeCompare.
    //
    // localeCompare is locale-sensitive: it orders punctuation differently under
    // different collations, so the same surface could hash differently on two
    // machines. That is the machine-scoped behaviour Rule 1 forbids, inside the
    // hash meant to prove behaviour is not machine-scoped. It also disagreed
    // with gnomon-surface's byte-wise sort, so the two implementations of the
    // same hash returned different values for the same directory.
    sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Compute surface hash
    const hash = createHash("sha256");
    for (const source of sources) {
        hash.update(source.path);
        hash.update(":");
        if (source.sha256) {
            hash.update(source.sha256);
        }
        else {
            hash.update("null");
        }
        hash.update("\n");
    }
    const surface_hash = hash.digest("hex");
    return { manifest: sources, surface_hash };
}
//# sourceMappingURL=config.js.map