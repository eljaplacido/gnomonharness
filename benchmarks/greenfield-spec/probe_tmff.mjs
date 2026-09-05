// Does test_must_fail_first fire when the model writes via BASH instead of write/edit?
// No model: a scripted endpoint emits the tool calls. Deterministic, $0.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "/home/eljaplacido/Desktop/gnomon";
const core = (m) => import(`${REPO}/packages/gnomon-core/dist/${m}`);
const { loadConfig } = await core("config.js");
const { runAgenticTurn } = await core("prompt_loop.js");

const root = mkdtempSync(join(tmpdir(), "tmff-"));
execFileSync(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/packages/gnomon-cli/src/index.ts`, "init"],
  { cwd: root, stdio: "pipe" });
// A defective implementation, and a test that PASSES on it (pins nothing).
writeFileSync(join(root, "m.py"), "def f(x):\n    return x <= 5\n");

const cfg = loadConfig(root);
cfg.policy = { ...(cfg.policy ?? {}),
  verify: { command: "pytest -q", after: "write", max_rounds: 1, test_must_fail_first: true } };

const ok = (r) => ({ ok: true, json: async () => r });
const call = (name, args) => ok({ choices: [{ message: { content: "", tool_calls: [
  { id: "c" + Math.random(), function: { name, arguments: JSON.stringify(args) } }] } }] });
const done = () => ok({ message: { content: "done" } });

async function run(mode) {
  const said = [];
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    // A test that passes against the code as it is -> pins nothing.
    const testBody = "from m import f\n\ndef test_f():\n    assert f(1) is True\n";
    const implBody = "def f(x):\n    return x < 5\n";
    if (mode === "bash") {
      if (n === 1) return call("bash", { command: `cat > test_m.py <<'PY'\n${testBody}PY` });
      if (n === 2) return call("bash", { command: `cat > m.py <<'PY'\n${implBody}PY` });
    } else {
      if (n === 1) return call("write", { path: "test_m.py", content: testBody });
      if (n === 2) return call("write", { path: "m.py", content: implBody });
    }
    return done();
  };
  try {
    const t = await runAgenticTurn(
      { config: cfg, exchanges: [], currentRole: "implement" }, "implement",
      { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } },
      [{ role: "user", content: "go" }],
      { approve: async () => true, progress: { start(){}, update(){}, stop(){} },
        ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false, cot: "work" },
        say: (l) => said.push(l) });
    return { trace: said.join("\n"), verify: t.verify };
  } finally { globalThis.fetch = orig; }
}

for (const mode of ["write", "bash"]) {
  writeFileSync(join(root, "m.py"), "def f(x):\n    return x <= 5\n");
  try { rmSync(join(root, "test_m.py")); } catch {}
  const r = await run(mode);
  const fired = /pins nothing/i.test(r.trace);
  console.log(`${mode.padEnd(6)} -> test_must_fail_first fired: ${fired}   turn.verify=${r.verify}`);
  if (!fired) {
    const v = r.trace.split("\n").filter((l) => /verify/i.test(l));
    console.log(`          verify lines: ${JSON.stringify(v)}`);
  }
}
rmSync(root, { recursive: true, force: true });
