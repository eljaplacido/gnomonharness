#!/usr/bin/env node
// The first-run journey, smoke-tested the way a new user meets it, on any OS:
//
//   gnomon doctor --json     reads the machine; exit 0 or 1, a gnomon.doctor/1 document
//   gnomon setup --json      recommends and stops at the proposal: exit 4 (needs
//                            consent or a model), a gnomon.setup/1 document, and
//                            nothing written
//   gnomon dashboard --no-open
//                            starts on a free 127.0.0.1 port and prints the one-use
//                            sign-in link; the page answers; then it is stopped
//
// In a fresh empty directory, so no surface of this repository is read. No
// model, no network beyond 127.0.0.1, nothing downloaded, nothing spent. Node
// rather than shell so the same file runs on Windows, macOS and Linux (CI's
// macos-tests and windows-tests jobs run it after the build).
//
// Usage: node scripts/first_run_smoke.mjs [path/to/gnomon entry script]
// Exit 0 when every step held; 1 with the reason otherwise.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(process.argv[2] ?? join(ROOT, "packages", "gnomon-cli", "gnomon.js"));
const DIR = mkdtempSync(join(tmpdir(), "gnomon-first-run-"));
const ENV = { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };

let failed = false;
const fail = (what) => {
  failed = true;
  console.error(`FAIL  ${what}`);
};
const pass = (what) => console.log(`ok    ${what}`);

function gnomon(args, timeout = 120_000) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], { cwd: DIR, env: ENV, encoding: "utf-8", timeout });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, json, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function check(name, cond, detail) {
  if (cond) pass(name);
  else fail(`${name}${detail ? `\n      ${String(detail).trim().split("\n").slice(-8).join("\n      ")}` : ""}`);
}

try {
  // ── doctor ──────────────────────────────────────────────────────────────
  const doctor = gnomon(["doctor", "--json"]);
  check(
    "gnomon doctor --json ran (exit 0 nothing to do, or 1 something needs attention)",
    doctor.code === 0 || doctor.code === 1,
    `exit ${doctor.code} ${doctor.error ?? ""}\n${doctor.stderr}`
  );
  check("  … and printed a gnomon.doctor/1 document", doctor.json?.schema === "gnomon.doctor/1", doctor.stdout.slice(0, 400));
  check("  … whose exit matches the process's", doctor.json?.exit === doctor.code, `document ${doctor.json?.exit}, process ${doctor.code}`);

  // ── setup ───────────────────────────────────────────────────────────────
  const setup = gnomon(["setup", "--json"]);
  check(
    "gnomon setup --json stopped at the proposal: exit 4 (needs consent or a model)",
    setup.code === 4,
    `exit ${setup.code} ${setup.error ?? ""}\n${setup.json?.why ?? setup.stderr}`
  );
  check("  … and printed a gnomon.setup/1 document", setup.json?.schema === "gnomon.setup/1", setup.stdout.slice(0, 400));
  check("  … and wrote nothing", readdirSync(DIR).length === 0, readdirSync(DIR).join(", "));

  // ── dashboard ───────────────────────────────────────────────────────────
  await new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY, "dashboard", "--no-open", "--port", "0", "--dir", DIR], {
      cwd: DIR,
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      check("gnomon dashboard --no-open printed its sign-in link and served the page", ok, why);
      // Windows has no catchable SIGTERM: the child is killed there, stopped elsewhere.
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.on("exit", (code, signal) => {
        clearTimeout(force);
        if (process.platform !== "win32") check("  … and stopped cleanly on a signal (exit 0)", code === 0, `exit ${code} signal ${signal}`);
        else pass("  … and was stopped");
        done();
      });
    };
    const timer = setTimeout(() => finish(false, `no sign-in link within 90 s\n${out}${err}`), 90_000);
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        check("gnomon dashboard --no-open printed its sign-in link", false, `exited ${code} first\n${out}${err}`);
        done();
      }
    });
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/#k=[A-Za-z0-9_-]+/.exec(out);
      if (!m || settled) return;
      get({ host: "127.0.0.1", port: Number(m[1]), path: "/", timeout: 15_000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => finish(res.statusCode === 200 && body.includes("/app.js"), `GET / answered ${res.statusCode}`));
      }).on("error", (e) => finish(false, `GET / failed: ${e.message}`));
    });
  });
} finally {
  rmSync(DIR, { recursive: true, force: true });
}

if (failed) {
  console.error("\nfirst-run smoke: FAILED");
  process.exit(1);
}
console.log("\nfirst-run smoke: every step held");
