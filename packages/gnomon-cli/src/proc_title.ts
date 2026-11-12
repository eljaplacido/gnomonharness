/**
 * The process title of a long-running gnomon: `gnomon task`, not the task.
 *
 * WHY. A benchmark adapter runs `gnomon task "<the whole task text>" ...`, so
 * /proc/<pid>/cmdline held every word of the task. In three cells (2026-11)
 * the model stopped its own background program with `pkill -f anon.py` (or a
 * /proc/*\/cmdline grep and a kill loop); the task text named anon.py, so the
 * pattern matched gnomon itself, SIGTERM ended the run, and the cell was lost
 * (exit 143). Nothing the model may do to its own processes should reach the
 * harness that is running it.
 *
 * Setting process.title replaces the command line other processes read: on
 * Linux (and macOS) libuv writes the title over the whole original argv area
 * and zeroes the rest, so /proc/<pid>/cmdline -- what `pkill -f`, `pgrep -f`
 * and `ps` show -- no longer carries the task text. process.argv is a copy
 * and is unchanged. Set at the top of main(), before anything slow, for the
 * commands that run for minutes; a short command keeps its ordinary command
 * line for `ps`.
 *
 * A wrapper's own shell (`sh -c 'gnomon task "..."'`) still carries the text,
 * and gnomon cannot rename that: `gnomon task --task-file <path|->` takes the
 * text from a file or stdin, so it need not be on any command line.
 *
 * The title's shape is load-bearing elsewhere: `gnomon skill accept`/`reject`
 * and `audit resolve` refuse when a gnomon process is among their ancestors
 * (gnomon-core agent_context.ts, check 3), and they recognise this title by
 * its leading word "gnomon". Keep it "gnomon <command>", and keep the decision
 * commands themselves untitled: an ancestor that is a launcher of the same
 * decision is allowed only because its arguments say so.
 */

/**
 * The commands that get a fixed title: the run, the interactive session and
 * its aliases, and the other long-lived servers.
 *
 * Every launcher runs the CLI in its own process (bin/gnomon.mjs imports
 * dist/, packages/gnomon-cli/gnomon.js imports its bundle, and the repo-root
 * ./gnomon imports gnomon.js), so the title set here is the one other
 * processes see. The checkout launcher's tsx fallback (GNOMON_LAUNCH=tsx, or
 * a bundle that cannot be built) is not covered: tsx's own process sits
 * between it and this one with the arguments intact.
 */
export const TITLED_COMMANDS: readonly string[] = ["task", "prompt", "run", "launch", "tui", "session", "acp", "loop"];

/** The title for `argv` (the arguments after the script), or null to leave the command line as it is. */
export function processTitleFor(argv: readonly string[]): string | null {
  const command = argv[0];
  return command !== undefined && TITLED_COMMANDS.includes(command) ? `gnomon ${command}` : null;
}

/** Set the title for this process's arguments. Never throws: a title is not worth a failed run. */
export function setProcessTitle(argv: readonly string[] = process.argv.slice(2)): void {
  const title = processTitleFor(argv);
  if (title === null) return;
  try {
    process.title = title;
  } catch {
    /* a platform that refuses it: the command line stays as it was */
  }
}
