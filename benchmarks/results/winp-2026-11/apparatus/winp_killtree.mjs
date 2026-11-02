// WINP finding check: after gnomon's bash tool times out a command on Windows, how long do
// its processes live, and when can the working directory be removed?
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const { executeTool } = await import(pathToFileURL(join(process.argv[2], "packages/gnomon-core/dist/tools.js")).href);
const live = () => {
  const o = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'sleep(\\.exe)?\"? 7(\\s|$)' } | ForEach-Object { $_.ProcessId }"],
    { encoding: "utf8" }).trim();
  return o ? o.split(/\s+/).length : 0;
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
for (let trial = 0; trial < 3; trial++) {
  const root = mkdtempSync(join(tmpdir(), "winp-kill-"));
  const t0 = Date.now();
  const out = await executeTool("bash", { command: "sleep 7" },
    { root, sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 300, maxOutputBytes: 4000 }, new Set(["bash"]));
  const tRet = Date.now() - t0;
  const rows = [];
  for (const at of [0, 250, 1000, 3000, 8000]) {
    const wait = at - (Date.now() - t0 - tRet);
    if (wait > 0) await sleepMs(wait);
    let removable = false;
    try { rmSync(root, { recursive: true, force: true }); removable = !existsSync(root); } catch { removable = false; }
    rows.push({ after_return_ms: Date.now() - t0 - tRet, sleep_procs: live(), removable });
    if (removable) break;
  }
  console.log(JSON.stringify({ trial, timed_out: /timed out/i.test(out.content), tool_returned_ms: tRet, rows }));
}
