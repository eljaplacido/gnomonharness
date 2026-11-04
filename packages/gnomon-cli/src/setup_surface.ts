/**
 * gnomon-cli: what `gnomon setup` would change in `.gnomon/`, as text.
 *
 * Pure functions over file texts. Nothing here reads or writes the disk: the
 * wizard (setup_wizard.ts) reads the files, shows the change computed here as
 * a diff, and writes it only after a person accepts it. Every edit is a line
 * edit through the same helpers `gnomon endpoint add` and `/models` use
 * (`setRoleModel`, `setEndpointBlock`), so the comments that make a surface
 * readable survive, and nothing is re-serialised.
 *
 * Routing is written where a run reads it AND mirrored into roles.toml, as
 * `pointRoleAt` does: the active profile and roles.toml then agree, so no
 * start after setup prints "is ignored: role_profile ...".
 */

import { parseToml, setRoleModel, setEndpointBlock, diffLines } from "gnomon-core";
import { PROFILE_FOR, type Suggestion } from "./catalog.js";

/** `.gnomon/` files setup may read or write, relative, with `/`. */
export const SETUP_FILES = [
  "config.toml",
  "roles.toml",
  "profiles/local_first.toml",
  "profiles/frontier_plan.toml",
  "profiles/all_remote.toml",
] as const;

/** File texts by relative path; undefined when the file does not exist. */
export type SurfaceTexts = Record<string, string | undefined>;

export interface EndpointBlock {
  url: string;
  kind: string;
  api_key_env?: string;
  provider?: string;
}

export interface LocalPlan {
  /** The tag roles name for the reasoning roles. */
  tag: string;
  /** The tag `smol` names. */
  small: string;
  /** The endpoint name the local roles route to. */
  endpoint: string;
  /** Declared into config.toml when the endpoint is not there yet. */
  block?: EndpointBlock;
}

export interface CloudPlan {
  endpoint: string;
  model: string;
  block?: EndpointBlock;
}

export interface PlanInput {
  local?: LocalPlan;
  cloud?: CloudPlan;
  mode: Suggestion;
  /** The catalog's label, for the provenance line. */
  catalogLabel: string;
}

export interface FileChange {
  /** Relative to `.gnomon/`, with `/`. */
  path: string;
  /** Undefined: the file is created. */
  before?: string;
  after: string;
}

/** Roles a hybrid setup sends to the cloud: R1H's PC arm, "cloud plans, local builds". */
export const HYBRID_CLOUD_ROLES = ["coordinator", "plan"] as const;

// ---------------------------------------------------------------------------
// Provenance: tags and the catalog date, nothing about the machine
// ---------------------------------------------------------------------------

const PROV_HEAD = "# Set up by `gnomon setup`";
const PROV_DATA = "# gnomon-setup: ";
const PROV_FACTS = "# Machine facts stay in .gnomon-setup.json";

export interface Provenance {
  v: number;
  catalog: string;
  local: string | null;
  small: string | null;
  cloud: string | null;
  mode: Suggestion;
}

/**
 * The block written at the top of roles.toml. Only tags, the mode and the
 * catalog's label: no hostname, no user, no hardware and no date of its own,
 * so two machines that make the same choices write the same bytes and the
 * same surface hash (the design's open question 9, answered "facts in a
 * gitignored file"). The hardware facts go to .gnomon-setup.json.
 */
export function provenanceBlock(input: PlanInput): string[] {
  const p: Provenance = {
    v: 1,
    catalog: input.catalogLabel,
    local: input.local?.tag ?? null,
    small: input.local?.small ?? null,
    cloud: input.cloud ? `${input.cloud.model}@${input.cloud.endpoint}` : null,
    mode: input.mode,
  };
  const words =
    input.mode === "local_only"
      ? `${p.local} on this machine for every role`
      : input.mode === "hybrid"
        ? `${input.cloud?.model} plans (${HYBRID_CLOUD_ROLES.join(", ")}), ${p.local} builds`
        : `${input.cloud?.model} for every role`;
  return [
    `${PROV_HEAD} (catalog ${input.catalogLabel}): ${words}.`,
    `${PROV_DATA}${JSON.stringify(p)}`,
    `${PROV_FACTS} beside .gnomon/ (gitignored); \`gnomon doctor\` compares them with this machine.`,
  ];
}

/** The provenance setup wrote, read back from roles.toml. */
export function readProvenance(rolesText: string | undefined): Provenance | undefined {
  if (!rolesText) return undefined;
  const line = rolesText.split("\n").find((l) => l.startsWith(PROV_DATA));
  if (!line) return undefined;
  try {
    const p = JSON.parse(line.slice(PROV_DATA.length)) as Provenance;
    return p && typeof p === "object" && p.v === 1 ? p : undefined;
  } catch {
    return undefined;
  }
}

function withProvenance(rolesText: string, block: string[]): string {
  const kept = rolesText
    .split("\n")
    .filter((l) => !l.startsWith(PROV_HEAD) && !l.startsWith(PROV_DATA) && !l.startsWith(PROV_FACTS));
  return [...block, ...kept].join("\n");
}

// ---------------------------------------------------------------------------
// Line edits
// ---------------------------------------------------------------------------

/**
 * Set `key = "value"` in `[defaults]`, keeping the line's trailing comment.
 * Adds the key under the header when it is absent, and the table when that is.
 */
export function setDefaultsKey(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\[defaults\]\s*$/.test(l));
  if (start === -1) {
    return [`[defaults]`, `${key} = "${value}"`, "", ...lines].join("\n");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"(.*)$`);
  for (let i = start + 1; i < end; i++) {
    const m = lines[i]!.match(re);
    if (m) {
      lines[i] = `${m[1]}"${value}"${m[2]}`;
      return lines.join("\n");
    }
  }
  lines.splice(start + 1, 0, `${key} = "${value}"`);
  return lines.join("\n");
}

/** setRoleModel, appending a `[roles.<role>]` section when the file has none. */
function ensureRole(text: string, role: string, model: string, endpoint: string): string {
  try {
    return setRoleModel(text, role, model, endpoint);
  } catch {
    const body = text.replace(/\n+$/, "");
    return `${body}\n\n[roles.${role}]\nmodel = "${model}"\nendpoint = "${endpoint}"\n`;
  }
}

/** Roles in a roles.toml text that name a model, in file order. */
export function rolesWithModels(rolesText: string | undefined): string[] {
  if (!rolesText) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(rolesText);
  } catch {
    return [];
  }
  const roles = (parsed.roles ?? {}) as Record<string, { model?: unknown }>;
  return Object.keys(roles).filter((r) => typeof roles[r]?.model === "string");
}

/** Declared endpoints in a config.toml text: name → url. */
export function declaredEndpoints(configText: string | undefined): Record<string, string> {
  if (!configText) return {};
  try {
    const eps = (parseToml(configText).endpoints ?? {}) as Record<string, { url?: unknown }>;
    const out: Record<string, string> = {};
    for (const [name, e] of Object.entries(eps)) if (typeof e?.url === "string") out[name] = e.url;
    return out;
  } catch {
    return {};
  }
}

const sameUrl = (a: string, b: string) =>
  a.replace("://localhost", "://127.0.0.1").replace(/\/+$/, "") === b.replace("://localhost", "://127.0.0.1").replace(/\/+$/, "");

/**
 * Which endpoint name a URL should be routed by: one already declared with
 * that URL, else `preferred` when free, else the first free fallback name.
 * `block` is set when the endpoint must be declared.
 */
export function endpointFor(
  configText: string | undefined,
  url: string,
  preferred: string[],
  block: EndpointBlock
): { name: string; block?: EndpointBlock } {
  const declared = declaredEndpoints(configText);
  const existing = Object.entries(declared).find(([, u]) => sameUrl(u, url));
  if (existing) return { name: existing[0] };
  const free = preferred.find((n) => !(n in declared)) ?? `${preferred[0]}-${Object.keys(declared).length + 1}`;
  return { name: free, block };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function profileText(name: string, description: string, header: string[], roles: Array<[string, string, string]>): string {
  const out = [...header, `name = "${name}"`, `description = "${description}"`];
  for (const [role, model, endpoint] of roles) out.push("", `[roles.${role}]`, `model = "${model}"`, `endpoint = "${endpoint}"`);
  return out.join("\n") + "\n";
}

const PROFILE_HEADERS: Record<string, { description: string; header: string[] }> = {
  local_first: {
    description: "Local models for every role, written by gnomon setup.",
    header: [
      "# local_first — keep token volume on local hardware.",
      "#",
      "# Written by `gnomon setup`. A profile is merged OVER the base roles in",
      "# roles.toml, per field; these are the same local models roles.toml names.",
    ],
  },
  frontier_plan: {
    description: "A cloud model plans; the local model builds. Written by gnomon setup.",
    header: [
      "# frontier_plan — a cloud model plans, the local model builds.",
      "#",
      "# Written by `gnomon setup`. The split gnomon measured in R1H (2026-11): the",
      "# coordinator and plan roles on a cloud model; implementor, verifier, implement,",
      "# critique and smol stay on this machine, as roles.toml names them. A profile",
      "# is merged OVER the base roles, so roles not named here are roles.toml's.",
      "# Start a turn with `/plan ...` or `/role coordinator` for the cloud to plan",
      "# and delegate the building to the local implementor.",
    ],
  },
  all_remote: {
    description: "A cloud model for every role. Written by gnomon setup.",
    header: [
      "# all_remote — every role on a cloud model.",
      "#",
      "# Written by `gnomon setup` for a machine where no local model is fast",
      "# enough, or none was chosen. Switch role_profile back once one is.",
    ],
  },
};

/**
 * The changes setup proposes, as before/after texts. Only files whose text
 * changes are returned; an empty list means the surface already says this.
 */
export function planSurface(texts: SurfaceTexts, input: PlanInput): FileChange[] {
  if (input.mode !== "cloud_first" && !input.local) throw new Error(`mode ${input.mode} needs a local model`);
  if (input.mode !== "local_only" && !input.cloud) throw new Error(`mode ${input.mode} needs a cloud model`);
  const profile = PROFILE_FOR[input.mode];
  const out = new Map<string, string>();
  const get = (p: string) => (out.has(p) ? out.get(p) : texts[p]);

  // ── config.toml: endpoints, then the profile ──────────────────────────────
  let config = texts["config.toml"] ?? "";
  if (input.local?.block) config = setEndpointBlock(config, input.local.endpoint, input.local.block);
  if (input.cloud?.block) config = setEndpointBlock(config, input.cloud.endpoint, input.cloud.block);
  config = setDefaultsKey(config, "role_profile", profile);
  out.set("config.toml", config);

  // ── where each role goes ─────────────────────────────────────────────────
  const rolesText = texts["roles.toml"] ?? "";
  const roles = rolesWithModels(rolesText);
  const want = (role: string): [string, string] => {
    const cloudHere =
      input.mode === "cloud_first" || (input.mode === "hybrid" && (HYBRID_CLOUD_ROLES as readonly string[]).includes(role));
    if (cloudHere) return [input.cloud!.model, input.cloud!.endpoint];
    return [role === "smol" ? input.local!.small : input.local!.tag, input.local!.endpoint];
  };

  // roles.toml mirrors what runs.
  let roleFile = rolesText;
  for (const role of roles) {
    const [model, endpoint] = want(role);
    roleFile = setRoleModel(roleFile, role, model, endpoint);
  }
  out.set("roles.toml", withProvenance(roleFile, provenanceBlock(input)));

  // local_first: the local models, whenever there is one (it is the profile to
  // switch back to), created only when it is the one selected.
  const lf = "profiles/local_first.toml";
  if (input.local) {
    const existing = get(lf);
    if (existing !== undefined) {
      let t = existing;
      for (const role of rolesWithModels(existing)) {
        t = setRoleModel(t, role, role === "smol" ? input.local.small : input.local.tag, input.local.endpoint, { onlyExisting: true });
      }
      out.set(lf, t);
    } else if (profile === "local_first") {
      const roleRows: Array<[string, string, string]> = ["plan", "implement", "critique", "smol"]
        .filter((r) => roles.includes(r))
        .map((r) => [r, r === "smol" ? input.local!.small : input.local!.tag, input.local!.endpoint]);
      out.set(lf, profileText("local_first", PROFILE_HEADERS.local_first!.description, PROFILE_HEADERS.local_first!.header, roleRows));
    }
  }

  // The selected profile carries the cloud roles.
  if (profile !== "local_first") {
    const path = `profiles/${profile}.toml`;
    const cloudRoles = profile === "frontier_plan" ? roles.filter((r) => (HYBRID_CLOUD_ROLES as readonly string[]).includes(r)) : roles;
    const existing = get(path);
    if (existing !== undefined) {
      let t = existing;
      for (const role of cloudRoles) t = ensureRole(t, role, input.cloud!.model, input.cloud!.endpoint);
      // A role the profile already names that should now stay local follows roles.toml.
      for (const role of rolesWithModels(existing).filter((r) => !cloudRoles.includes(r))) {
        const [model, endpoint] = want(role);
        t = setRoleModel(t, role, model, endpoint, { onlyExisting: true });
      }
      out.set(path, t);
    } else {
      const h = PROFILE_HEADERS[profile]!;
      out.set(path, profileText(profile, h.description, h.header, cloudRoles.map((r) => [r, input.cloud!.model, input.cloud!.endpoint])));
    }
  }

  return [...out.entries()]
    .filter(([path, after]) => texts[path] !== after)
    .map(([path, after]) => ({ path, ...(texts[path] !== undefined ? { before: texts[path] } : {}), after }));
}

/** A change as diff lines (`+ `, `- `, `  `), for the screen and for --json. */
export function changeDiff(change: FileChange): string[] {
  return diffLines(change.before ?? "", change.after, 2);
}
