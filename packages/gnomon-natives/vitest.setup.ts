// vitest setup — must run before any imports
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rustBinOverride = join(
  __dirname, "..", "..", "target", "debug"
);
console.error(`[vitest-setup] GNOMON_BIN_OVERRIDE = ${rustBinOverride}`);
process.env.GNOMON_BIN_OVERRIDE = rustBinOverride;
