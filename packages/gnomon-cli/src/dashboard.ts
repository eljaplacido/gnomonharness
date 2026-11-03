/**
 * `gnomon dashboard` (alias `gnomon ui`): a read-only command center in the
 * browser, served from this machine to this machine.
 *
 * Imported only by its own dispatch case in index.ts, so no other command
 * loads any of it. It keeps no state of its own and writes no file: it reads
 * what gnomon already records (dashboard_data.ts) and serves it on 127.0.0.1
 * (dashboard_server.ts). Design: docs/design/SETUP-AND-COMMAND-CENTER.md
 * Part II; contract: CONTRACTS.md §17.
 *
 * Exit: 0 on a clean stop (Ctrl-C), 1 on a usage error, 4 when the port or
 * loopback cannot be had, 10 when the server cannot start for any other
 * reason (its assets are missing, say).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { knownProjects } from "./dashboard_data.js";
import { startDashboard, type DashboardServer } from "./dashboard_server.js";

export const DASHBOARD_EXIT = { stopped: 0, usage: 1, port_unavailable: 4, launch_failed: 10 } as const;

export interface DashboardArgs {
  port: number;
  open: boolean;
  dir?: string;
  help: boolean;
}

export function parseDashboardArgs(argv: string[]): DashboardArgs | string {
  const out: DashboardArgs = { port: 0, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-open") out.open = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port" || a === "--dir" || a === "-d") {
      const v = argv[++i];
      if (v === undefined) return `${a} needs a value`;
      if (a === "--port") {
        if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) return `--port takes a number from 0 to 65535, not ${v}`;
        out.port = Number(v);
      } else out.dir = v;
    } else return `unknown argument: ${a}`;
  }
  return out;
}

/** How each OS opens a URL in the default browser. Never through a shell. */
export function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url: string): string | null {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "no display here";
  }
  const { cmd, args } = openerFor(process.platform, url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {
      console.error(`  (could not start ${cmd}; open the link above yourself)`);
    });
    child.unref();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const USAGE = `Usage: gnomon dashboard [--port <n>] [--no-open] [--dir <path>]

Serve a read-only command center for this project (and every project this
machine trusts) on 127.0.0.1, and open it in the browser. Ctrl-C stops it.`;

export async function cmdDashboard(argv: string[]): Promise<number> {
  const args = parseDashboardArgs(argv);
  if (typeof args === "string") {
    console.error(`gnomon dashboard: ${args}\n\n${USAGE}`);
    return DASHBOARD_EXIT.usage;
  }
  if (args.help) {
    console.log(USAGE);
    return DASHBOARD_EXIT.stopped;
  }

  const projects = knownProjects({ cwd: process.cwd(), dir: args.dir });
  let dash: DashboardServer;
  try {
    dash = await startDashboard({ projects, port: args.port, cliEntry: process.argv[1] });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      console.error(
        `gnomon dashboard: cannot listen on 127.0.0.1:${args.port} (${code}). ` +
          `Leave --port off to take a free one.`
      );
      return DASHBOARD_EXIT.port_unavailable;
    }
    console.error(`gnomon dashboard: could not start: ${err instanceof Error ? err.message : String(err)}`);
    return DASHBOARD_EXIT.launch_failed;
  }

  const url = dash.signInUrl();
  const here = projects.find((p) => p.source === "here");
  console.log(`gnomon dashboard · read-only · this machine only (127.0.0.1:${dash.port})`);
  console.log("");
  console.log(`  ${url}`);
  console.log("");
  console.log("  The link signs one browser tab in, once, within 5 minutes.");
  console.log(
    process.stdin.isTTY ? "  Press Enter for a new link. Ctrl-C stops the server." : "  Ctrl-C stops the server."
  );
  console.log(
    here
      ? `  Project: ${here.root}${here.hasSurface ? "" : " (no .gnomon/ yet)"}`
      : "  No .gnomon/ here or above; showing the projects this machine trusts."
  );
  const trusted = projects.filter((p) => p.source === "trust").length;
  if (trusted) console.log(`  Also: ${trusted} project${trusted === 1 ? "" : "s"} from the trust store.`);

  if (args.open) {
    const why = openBrowser(url);
    if (why) {
      console.log(`  (not opening a browser: ${why}. Open the link on this machine, or forward the same port:`);
      console.log(`   ssh -L ${dash.port}:127.0.0.1:${dash.port} <this host>)`);
    }
  }

  return new Promise<number>((done) => {
    let rl: ReturnType<typeof createInterface> | null = null;
    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin });
      rl.on("line", () => console.log(`  ${dash.signInUrl()}`));
    }
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      rl?.close();
      console.log("\ngnomon dashboard: stopped.");
      void dash.close().then(() => done(DASHBOARD_EXIT.stopped));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
