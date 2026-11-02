// WINP: the path-only portability patch (PRE-REGISTRATION.md, amendment). Applied to the
// suite copies in a throwaway clone; changes nothing a suite asserts.
//   node winp_port.mjs <repo>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2];
const files = [
  "benchmarks/surface-fidelity/fidelity.mjs",
  "benchmarks/degradation-contract/contract.mjs",
  "benchmarks/fault-disclosure/disclose.mjs",
  "benchmarks/silent-success/sweep.mjs",
  "benchmarks/results/determinism-2026-08-31/determinism.mjs",
  "benchmarks/results/determinism-2026-08-31/run.mjs",
];
const URLIMP = 'import { fileURLToPath as __f2p, pathToFileURL as __p2f } from "node:url";\n';
for (const rel of files) {
  const p = join(repo, rel);
  let s = readFileSync(p, "utf8");
  const before = s;
  // 1. REPO via fileURLToPath (any depth of "../").
  s = s.replace(/new URL\(("(?:\.\.\/)+"), import\.meta\.url\)\.pathname\.replace\(\/\\\/\$\/, ""\)/g,
    (_m, up) => `__f2p(new URL(${up}, import.meta.url)).replace(/[\\\\/]$/, "")`);
  // 2. dynamic imports of a built path: through a file URL.
  s = s.replace(/import\(`\$\{REPO\}([^`]*)`\)/g, (_m, rest) => `import(__p2f(\`\${REPO}${rest}\`).href)`);
  // run.mjs builds a `node -e` string importing a joined path.
  s = s.replace('import(${JSON.stringify(join(process.cwd(), "determinism.mjs"))})',
    'import(${JSON.stringify(__p2f(join(process.cwd(), "determinism.mjs")).href)})');
  // 3. tsx's .cmd shim: run tsx's CLI with node instead.
  s = s.replace(/execFileSync\(`\$\{REPO\}\/node_modules\/\.bin\/tsx`,(\s*)\[/g,
    (_m, ws) => `execFileSync(process.execPath,${ws}[\`\${REPO}/node_modules/tsx/dist/cli.mjs\`, `);
  if (s !== before) {
    if (!s.includes("__f2p as")) {
      // After a shebang line, if any: it must stay the first line.
      const nl = s.startsWith("#!") ? s.indexOf("\n") + 1 : 0;
      s = s.slice(0, nl) + URLIMP + s.slice(nl);
    }
    writeFileSync(p, s);
    console.log(`patched ${rel}`);
  } else console.log(`unchanged ${rel}`);
}
