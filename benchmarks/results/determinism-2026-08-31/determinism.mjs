/**
 * T2 — surface-replay determinism.
 *
 * gnomon's one claim no competing harness can even express: the same surface
 * decides the same behaviour, on any machine. Rules 1 and 2 exist to make that
 * true. It had never been tested, so this tries to BREAK it — the same surface
 * is read back under conditions that differ in every way that is not the
 * surface, and anything that shifts is a Rule 1 violation.
 *
 * Declared behaviour is fingerprinted as: the surface hash, plus, for every
 * role, its resolved model/endpoint/limits and the sorted tool schema it would
 * be sent, plus the role each of a corpus of inputs routes to.
 */
import { loadConfig } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/config.js";
import { buildToolSet } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/tools.js";
import { routeRole, routeInput } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/config.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const ROUTING_CORPUS = [
  "plan the migration", "review this diff", "what's wrong with add()",
  "implement the parser", "run the tests", "summarise these logs",
  "audit the config", "fix the failing build", "", "   ", "PLAN THE MIGRATION",
];

export function fingerprint(dir) {
  const config = loadConfig(dir);
  const roles = Object.keys(config.roles).sort();
  const parts = [];
  for (const role of roles) {
    const set = buildToolSet(config, role);
    const r = config.roles[role] ?? {};
    parts.push(JSON.stringify({
      role,
      model: r.model, endpoint: r.endpoint, temperature: r.temperature, top_p: r.top_p,
      max_steps: r.max_steps, max_steps_total: r.max_steps_total,
      tools: set.schemas.map((t) => t.function.name),           // Rule 3: sorted
      schemas: createHash("sha256").update(JSON.stringify(set.schemas)).digest("hex"),
      disabled: set.disabled, unimplemented: set.unimplemented,
    }));
  }
  for (const input of ROUTING_CORPUS) {
    let routed;
    try {
      const r = routeInput(config, input);
      routed = { role: r?.role, why: r?.why, problem: r?.problem };
    } catch (e) { routed = { error: String(e).slice(0, 80) }; }
    parts.push(`route(${JSON.stringify(input)}) = ${JSON.stringify(routed)}`);
  }
  // Where inference would actually go, per role -- this is the field an env var
  // can override, so it belongs in the fingerprint.
  for (const role of roles) {
    try {
      const t = routeRole(config, role).target;
      parts.push(`target(${role}) = ${JSON.stringify({ url: t.url, model: t.model, endpoint: t.endpoint, kind: t.kind })}`);
    } catch (e) { parts.push(`target(${role}) = ERR ${String(e).slice(0, 60)}`); }
  }
  return { hash: createHash("sha256").update(parts.join("\n")).digest("hex"), parts };
}

export function surfaceHash(dir) {
  try {
    return execFileSync("node", ["/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js", "surface", "hash", "--dir", dir],
      { encoding: "utf-8", env: process.env }).trim().split(/\s+/).pop();
  } catch (e) { return `ERR:${String(e).slice(0, 60)}`; }
}
