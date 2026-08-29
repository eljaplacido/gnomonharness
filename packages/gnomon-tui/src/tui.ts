/**
 * gnomon-tui: Basic terminal UI
 *
 * Minimal TUI for the gnomon harness:
 * - Session status view (list, select, follow)
 * - Step listing with outcome buckets
 * - Input area for commands
 *
 * No external TUI dependencies — pure readline + ANSI escape codes.
 */

import * as readline from "node:readline";
import { SessionRecord, SessionStep, Bucket } from "gnomon-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** TUI display mode */
export type TuiMode = "menu" | "view" | "input";

/** TUI state */
export interface TuiState {
  mode: TuiMode;
  sessions: SessionMeta[];
  selectedIndex: number;
  steps: SessionStep[];
  currentRole: string;
  inputBuffer: string;
  error?: string;
}

/** Metadata about a saved session */
export interface SessionMeta {
  id: string;
  path: string;
  file: string;
  stepCount: number;
  bucketCounts: Record<Bucket, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inner width of the banner box, excluding its two border columns. */
export const BANNER_WIDTH = 46;

/**
 * Centre `text` in `width` columns, colouring only the text itself.
 *
 * The padding is measured on the bare string and the escape codes are added
 * afterwards, because an ANSI sequence occupies characters in a JavaScript
 * string and zero columns in a terminal — padding a pre-coloured string is how
 * a box ends up looking right in the source and wrong on screen.
 */
export function centre(
  text: string,
  width: number,
  paint: (t: string) => string = (t) => t
): string {
  const visible = [...text].length;
  if (visible >= width) return paint(text);
  const left = Math.floor((width - visible) / 2);
  return " ".repeat(left) + paint(text) + " ".repeat(width - visible - left);
}


const ESC = "\x1b[";
const COLORS = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  gray: `${ESC}90m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  bgGray: `${ESC}100m`,
};

function c(color: string, text: string): string {
  const key = color as keyof typeof COLORS;
  return `${COLORS[key]}${text}${COLORS.reset}`;
}

function bucketColor(bucket: Bucket): string {
  switch (bucket) {
    case "result":
      return "green";
    case "refusal":
      return "yellow";
    case "apparatus_failure":
      return "red";
    default:
      return "white";
  }
}

/** Discover session files from a directory */
export function discoverSessions(dir?: string): SessionMeta[] {
  const sessionsDir = dir || join(process.cwd(), "sessions");
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir)
    .filter((f: string) => f.endsWith(".json"))
    .sort();

  return files.map((file) => {
    const content = readFileSync(join(sessionsDir, file), "utf-8");
    const record: SessionRecord = JSON.parse(content);
    const session = record.session;
    const bucketCounts: Record<Bucket, number> = {
      result: 0,
      refusal: 0,
      apparatus_failure: 0,
    };
    for (const step of session.steps) {
      bucketCounts[step.bucket]++;
    }
    return {
      id: file.replace(/\.json$/, ""),
      path: join(sessionsDir, file),
      file,
      stepCount: session.steps.length,
      bucketCounts,
    };
  });
}

/** Get the latest session metadata */
function latestSession(dir?: string): SessionMeta | null {
  const sessions = discoverSessions(dir);
  return sessions.length > 0 ? sessions[sessions.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the TUI header */
function renderHeader(): void {
  console.clear();
  // Centred against the border rather than padded by hand. Hand-counted
  // padding drifts the moment the title changes — and it had: the right edge
  // sat 13 columns inside the corner. Colour is applied after centring
  // because ANSI escapes have width in a string and none on screen.
  console.log(`${c("cyan", "╔" + "═".repeat(BANNER_WIDTH) + "╗")}`);
  console.log(
    `${c("cyan", "║")}${centre("gnomon — TUI", BANNER_WIDTH, (t) =>
      c("bold", c("white", t))
    )}${c("cyan", "║")}`
  );
  console.log(`${c("cyan", "╚" + "═".repeat(BANNER_WIDTH) + "╝")}`);
  console.log();
}

/** Render the session menu */
function renderMenu(state: TuiState): void {
  renderHeader();
  console.log(c("bold", "Sessions:"));
  console.log();

  if (state.sessions.length === 0) {
    console.log(c("gray", "  No sessions found. Run commands with `gnomon session <cmd>`"));
    console.log();
    console.log(c("dim", "  Press Enter to refresh, q to quit"));
    return;
  }

  state.sessions.forEach((s, i) => {
    const marker = i === state.selectedIndex ? c("cyan", "❯") : " ";
    const stepInfo = c("gray", `${s.stepCount} steps`);
    const buckets = Object.entries(s.bucketCounts)
      .filter(([, count]) => count > 0)
      .map(([b, count]) => {
        const color = bucketColor(b as Bucket);
        return c(color, `${b}=${count}`);
      })
      .join(" ");

    console.log(
      `  ${marker} ${c("bold", s.id.slice(0, 20))}  ${stepInfo}  ${buckets}`
    );
  });

  console.log();
  console.log(c("dim", "  ↑/↓ navigate  Enter view  q quit"));
}

/** Render a session view */
function renderView(state: TuiState): void {
  renderHeader();
  const session = state.sessions[state.selectedIndex];
  if (!session) {
    console.log(c("red", "No session selected"));
    console.log(c("dim", "  Enter back to menu  q quit"));
    return;
  }

  console.log(c("bold", `Session: ${session.id}`));
  console.log(c("dim", `  ${session.stepCount} steps — `) +
    Object.entries(session.bucketCounts)
      .filter(([, cnt]) => cnt > 0)
      .map(([b, cnt]) => `${c("gray", `${b}=${cnt}`)}`)
      .join(" ")
  );
  console.log();
  console.log(c("bold", "Steps:"));
  console.log();

  const steps = state.steps;
  const maxShow = 20;
  const show = steps.length > maxShow ? steps.slice(-maxShow) : steps;

  show.forEach((step, i) => {
    const idx = steps.length > maxShow ? i + (steps.length - maxShow) : i;
    const color = bucketColor(step.bucket);
    const code = step.native_code;
    const dur = `${step.duration_ms}ms`;
    const preview = (step.stdout || "").trim().slice(0, 60).replace(/\n/g, " ");
    console.log(
      `  ${c("gray", `#${idx}`)} ${c(color, step.bucket.padEnd(20))} ` +
      `${c("dim", `code=${code}`)} ${c("dim", `dur=${dur}`)} ${c("white", preview)}`
    );
  });

  if (steps.length > maxShow) {
    console.log(c("dim", `  ... and ${steps.length - maxShow} more steps`));
  }

  console.log();
  console.log(c("dim", "  ↑/↓ scroll  Enter input  m menu  q quit"));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Run the gnomon TUI.
 * @param dir Override sessions directory (defaults to ./sessions)
 */
export async function runTui(dir?: string): Promise<void> {
  const sessions = discoverSessions(dir);

  const state: TuiState = {
    mode: "menu",
    sessions,
    selectedIndex: 0,
    steps: [],
    currentRole: "implement",
    inputBuffer: "",
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  function render(): void {
    switch (state.mode) {
      case "menu":
        renderMenu(state);
        break;
      case "view":
        renderView(state);
        break;
    }
  }

  render();

  rl.setPrompt(c("cyan", "gnomon> "));

  rl.on("line", (line: string) => {
    const input = line.trim();

    if (state.mode === "menu") {
      if (input === "q" || input === "quit") {
        console.log(c("gray", "Goodbye."));
        rl.close();
        return;
      }
      if (input === "r" || input === "refresh") {
        state.sessions = discoverSessions(dir);
        state.selectedIndex = Math.min(state.selectedIndex, state.sessions.length - 1);
        render();
        rl.setPrompt(c("cyan", "gnomon> "));
        return;
      }
      if (input === "d" && state.selectedIndex >= 0 && state.sessions.length > 0) {
        // TODO: delete session
        state.error = "delete not yet implemented";
        render();
        return;
      }
      if (input === "m" || input === "menu") {
        state.mode = "menu";
        render();
        return;
      }

      // Enter selects/view
      if (state.selectedIndex >= 0 && state.selectedIndex < state.sessions.length) {
        const session = state.sessions[state.selectedIndex];
        const record: SessionRecord = JSON.parse(
          readFileSync(session.path, "utf-8")
        );
        state.steps = record.session.steps;
        state.mode = "view";
        render();
        return;
      }
    }

    if (state.mode === "view") {
      if (input === "q" || input === "quit") {
        console.log(c("gray", "Goodbye."));
        rl.close();
        return;
      }
      if (input === "m" || input === "menu") {
        state.mode = "menu";
        render();
        return;
      }
      if (input === "i" || input === "input") {
        console.log(c("dim", "Command mode not yet implemented"));
        render();
        return;
      }

      // Enter in view stays in view
      render();
      return;
    }
  });

  // Arrow key navigation (simple approach)
  let escapeSeq = "";
  rl.on("line", (line: string) => {
    if (escapeSeq) {
      if (escapeSeq === "[A") {
        // Up arrow
        if (state.selectedIndex > 0) state.selectedIndex--;
      } else if (escapeSeq === "[B") {
        // Down arrow
        if (state.selectedIndex < state.sessions.length - 1) state.selectedIndex++;
      }
      escapeSeq = "";
      render();
      return;
    }
  });

  process.on("SIGINT", () => {
    console.log(c("gray", "\nInterrupted. Goodbye."));
    rl.close();
    process.exit(0);
  });
}
