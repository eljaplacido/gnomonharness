/**
 * The surface that may act on the host, for a command that judges by a
 * revision's rules (`gnomon check --base`, `gnomon guard`).
 *
 * WHY (seventh review, findings B2 and B4). The rules under judgement come
 * from a revision, and a revision is the model's to make: under exec =
 * "docker" it writes `.git/objects` and `.git/refs`. check took more than the
 * rules from it -- the [audit] settings, so `[audit.attest] sign` ran on the
 * host through `bash -lc`, an absolute `[audit] dir` was written, a
 * `public_key` path was read; and `[sandbox] network`, so [verify] ran with
 * the network the live policy had off.
 *
 * So a revision supplies only the policy being judged: roles, write_allow,
 * bash_allow/deny, [verify]. Everything that acts on the host -- [audit]
 * (dir, redact, attest, anchor), [sandbox] exec, image, network, extra_roots,
 * the tool timeout -- comes from the surface in the working tree, which a
 * container mounts read-only, held to this machine's exec floor. When that
 * surface does not load, the defaults: no signing, no anchoring, the default
 * trail directory, no network.
 */
import { loadConfig, type GnomonConfig } from "./config.js";
import { dirname } from "node:path";

/** A surface that declares nothing, at `gnomonDir`: every setting its default. */
export function emptySurface(gnomonDir: string): GnomonConfig {
  return {
    gnomonDir,
    config: {},
    policy: {},
    roles: {},
    profiles: {},
    tools: {},
    system: { content: "", version: "0.1" },
  } as unknown as GnomonConfig;
}

/** The live surface at `gnomonDir`, loaded, or null when it does not load. */
export function loadLiveSurface(gnomonDir: string): GnomonConfig | null {
  try {
    return loadConfig(dirname(gnomonDir));
  } catch {
    return null;
  }
}

/**
 * The configuration host-side settings are read from: the live surface at
 * `gnomonDir`, or the empty one when it does not load -- or when `distrust`
 * (a surface that appeared below a floored root, which a container could
 * have written: L3/B2).
 */
export function hostSurface(gnomonDir: string, distrust = false): { config: GnomonConfig; loaded: boolean } {
  const live = distrust ? null : loadLiveSurface(gnomonDir);
  return live ? { config: live, loaded: true } : { config: emptySurface(gnomonDir), loaded: false };
}
