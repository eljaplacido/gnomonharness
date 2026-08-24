/**
 * gnomon-cli: argument parsing.
 *
 * Its own module so that the tests exercise the parser the CLI actually uses.
 * `cli.test.ts` used to inline a copy of this function, because importing
 * `index.ts` resolves the native binaries at import time — so the parser under test
 * was a lookalike, and the two were free to drift apart without a single test going
 * red.
 */

export interface CliArgs {
  command: string;
  subcommand?: string;
  dir?: string;
  /** `-p` was given. With a task after it this is one-shot mode; bare, it prints
   * the latest session id. */
  print?: boolean;
  /** `--json`: write the session record to stdout and nothing else. */
  json?: boolean;
  /** `--role <name>` for one-shot mode. */
  role?: string;
  positional: string[];
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { command: "", subcommand: "", positional: [] };
  let i = 0;

  if (args[0]?.startsWith("-")) {
    i = 0; // a leading flag is parsed in the loop below, not skipped
  } else {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--dir" || arg === "-d") {
      i++;
      result.dir = args[i];
    } else if (arg === "--role") {
      i++;
      result.role = args[i];
    } else if (arg === "-p" || arg === "--print") {
      result.print = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--help" || arg === "-h") {
      result.command = "help";
    } else if (arg.startsWith("-")) {
      // Unknown flag: ignored, so that a typo does not become a task string.
    } else if (!result.subcommand) {
      result.subcommand = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

/**
 * The task text of a one-shot invocation, or null when this is not one.
 *
 * `gnomon -p 'implement X'` is one-shot; bare `gnomon -p` is the session-id probe
 * that predates it. Keeping both is deliberate: the probe is already in use, and a
 * flag that silently changes meaning is worse than a flag that carries two.
 */
export function oneShotTask(args: CliArgs): string | null {
  if (!args.print) return null;
  const words = [args.subcommand, ...args.positional].filter(
    (w): w is string => typeof w === "string" && w.length > 0
  );
  if (words.length === 0) return null;
  return words.join(" ");
}
