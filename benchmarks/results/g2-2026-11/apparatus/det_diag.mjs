// Apparatus check only: print the raw values behind run.mjs's booleans.
const m = await import(process.argv[2]);
for (const [label, env] of [["plain", {}], ["GNOMON_MODEL_URL", { GNOMON_MODEL_URL: "http://127.0.0.1:9/v1/chat/completions" }]]) {
  Object.assign(process.env, env);
  const fp = m.fingerprint(process.argv[3]);
  console.log(label, "fingerprint", fp.hash, "parts", fp.parts.length);
  console.log("  errors in parts:", fp.parts.filter((p) => /ERR|error/.test(p)).length);
  console.log("  " + fp.parts.filter((p) => p.startsWith("target(")).join("\n  "));
}
delete process.env.GNOMON_MODEL_URL;
console.log("surface", m.surfaceHash(process.argv[3]));
