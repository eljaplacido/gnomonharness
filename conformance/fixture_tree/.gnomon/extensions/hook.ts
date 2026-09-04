// A real extension file, living in the conformance fixture tree on purpose.
//
// It pins the promise made on 2026-09-04: `.gnomon/extensions/` is NOT part of
// the surface hash, because nothing loads it. The fixture is the strongest form
// that promise can take — this file exists inside the hashed tree, and
// `conformance/manifest_golden.json` still carries the SAME surface_hash it did
// before the file was added, and still does not list it under `sources`.
//
// If an extension host is ever built, this file must start counting: delete the
// `.gnomon/extensions/` skip in `collect_surface` (Rust) and its twin in
// `collectSurface` (TypeScript), regenerate the golden, and expect this hash to
// change. Until then, a golden that moves when this file is edited is the bug.
export const hook = () => {};
