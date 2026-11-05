#!/usr/bin/env node
// GBS-OVERHEAD 0.1 §3.3 "F0": the wire floor. Replays a recorded request sequence (the bodies
// gnomon sent in one trial of the same scenario) with a bare HTTP client, reading each reply in
// full. The time neither harness can avoid: runtime start, connection, bytes, the fake model's d.
// Usage: node wire_floor.mjs <url> <bodies.jsonl>
import { readFileSync } from "node:fs";
const [url, file] = process.argv.slice(2);
for (const line of readFileSync(file, "utf-8").split("\n").filter(Boolean)) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: line });
  await res.text();
}
