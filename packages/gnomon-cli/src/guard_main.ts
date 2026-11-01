/**
 * `gnomon guard` as its own entry point.
 *
 * The published launcher (bin/gnomon.mjs) imports this instead of index.js
 * when the command is `guard`. index.js loads the whole harness — the turn
 * loop, the TUI, the natives — and a guard runs once per tool call of another
 * agent, so that start-up is paid on every call. This loads guard.js and the
 * part of gnomon-core the decision needs.
 *
 * exitCode, not exit(): stdout to a pipe is asynchronous, and exiting at once
 * can cut off the answer the hook is waiting for.
 */
import { cmdGuard } from "./guard.js";

const at = process.argv.indexOf("guard", 2);
cmdGuard(process.argv.slice(at < 0 ? 2 : at + 1)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`gnomon guard: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 10;
  }
);
