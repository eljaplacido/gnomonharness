// gnomon dashboard v2: the per-project spec-to-verify LENS.
//
// Registers the "lens" screen with app.js. Everything here is read from
// GET /api/p/<id>/lens (and /lens/run?name=<trail> for one run's tool-call
// path): the intent (specs and requests), the runs, the evidence, the
// governance and the measures, as gnomon recorded them. Rule 4: no composite
// score. Each kind of evidence is its own segment of a quorum meter, and a
// request reads "verified" only when independent kinds agree.
import { registerScreen, h, projectApi, header, tile, icon, ICONS } from "/app.js";

const LENS_ICON = ["M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z", "M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0"];

// ── formatting ──────────────────────────────────────────────────────────────
const fmtN = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));
const plural = (n, w, ws) => `${fmtN(n)} ${n === 1 ? w : ws || w + "s"}`;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
function compact(n) {
  if (n === null || n === undefined) return "–";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  return fmtN(n);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function when(ts) {
  if (!ts) return "–";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const ms = (x) => (x === null || x === undefined ? "–" : x >= 100000 ? `${Math.round(x / 1000)} s` : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const words = (s) => String(s || "").replace(/_/g, " ");

// ── the quorum of evidence ──────────────────────────────────────────────────
const TYPES = [
  ["test", "test run"],
  ["verify", "[verify]"],
  ["check", "check / eval"],
  ["review", "review"],
  ["policy", "policy"],
];
const GLYPH = { pass: "✓", fail: "✕", partial: "~", none: "·" };
const STATE_WORD = { pass: "agrees", fail: "disagrees", partial: "ran, not clean", none: "no evidence" };
const QUORUM = {
  verified: ["verified", "two independent kinds agree, one of them judging the work itself"],
  single_source: ["single source", "one kind of evidence agrees; nothing independent confirms it"],
  contradicted: ["contradicted", "evidence disagrees with itself"],
  failing: ["failing", "the evidence that exists says it did not hold"],
  insufficient: ["insufficient evidence", "nothing recorded validates this"],
};
/** Five segments, one per kind of evidence, each with its own state; never summed. */
function meter(evidence, quorum) {
  const segs = TYPES.filter(([k]) => evidence && evidence[k]).map(([k, label]) => {
    const e = evidence[k];
    return h("li", { class: `qm-seg st-${e.state}`, title: `${label}: ${e.note}` },
      h("span", { class: "qm-g", "aria-hidden": "true", text: GLYPH[e.state] }),
      h("span", { class: "qm-l", text: label }),
      h("span", { class: "sr-only", text: `: ${STATE_WORD[e.state]}. ${e.note}` }));
  });
  const [word, why] = QUORUM[quorum] || QUORUM.insufficient;
  return h("div", { class: "qm" },
    h("ul", { class: "qm-segs", "aria-label": "Evidence by kind" }, segs),
    h("span", { class: `qm-q q-${quorum}`, title: why, text: word }));
}

// ── small parts ─────────────────────────────────────────────────────────────
const section = (id, title, sub, ...kids) =>
  h("section", { "aria-labelledby": id },
    h("div", { class: "sechead" }, h("h2", { id, text: title }), sub ? h("span", { class: "muted small", text: sub }) : null),
    ...kids);
const table = (cols, rows, caption) =>
  h("div", { class: "tablebox" }, h("table", null,
    caption ? h("caption", { class: "sr-only", text: caption }) : null,
    h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.num ? "num" : null, text: c.label })))),
    h("tbody", null, rows)));
const chip = (text, cls = "") => h("span", { class: `chip ${cls}`, text });
const emptyNote = (text) => h("p", { class: "empty", text });
const dot = (loc) => h("span", { class: `dot ${loc || "unknown"}`, title: loc || "unknown" });
const countChips = (obj, cls) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => chip(`${words(k)} ${fmtN(v)}`, cls));

// ── the data, and the run cache ─────────────────────────────────────────────
const runCache = new Map();
const openRuns = new Set();
const pathMaps = new Set();
let lensKey = "";
function resetFor(pid) {
  if (lensKey !== pid) {
    lensKey = pid;
    runCache.clear();
    openRuns.clear();
    pathMaps.clear();
  }
}

async function fetchLens(ctx) {
  resetFor(ctx.pid);
  if (!ctx.P || !ctx.P.hasSurface) return { none: true };
  return projectApi("lens");
}

// ── 0. coverage tiles ───────────────────────────────────────────────────────
function coverageTiles(d) {
  const c = d.coverage;
  const ratio = (a, b, unit) => h("span", null, fmtN(a), h("small", { text: ` of ${fmtN(b)} ${unit}` }));
  return h("div", { class: "tiles", role: "group", "aria-label": "Coverage summary" },
    tile("Sessions under guard", ratio(c.sessions_guarded, c.sessions, "sessions"),
      `${plural(c.sessions_gnomon, "gnomon session")} · the rest are other harnesses governed by gnomon guard`),
    tile("Turns with verify evidence", ratio(c.turns_with_verify, c.turns, "turns"),
      c.turns ? `${pct(c.turns_with_verify, c.turns)}% of recorded turns ended with a [verify] verdict` : "no turns recorded yet"),
    tile("Specs with passing evidence", ratio(c.specs_passing, c.specs, "specs"),
      c.specs ? "a passing latest verdict; read each spec's meter, not this count" : "no spec declared: add [verify] or .gnomon/trials/"),
    tile("Trail integrity verified", ratio(c.trails_intact, c.trails, "trails"),
      c.trails_intact === c.trails ? "every hash chain checks out" : "some trails fail gnomon audit verify: see Governance"));
}

// ── 1. intent ───────────────────────────────────────────────────────────────
function specRow(s) {
  const cov = s.coverage;
  const declared = s.kind === "verify"
    ? h("div", { class: "stack" },
      h("code", { class: "mono", text: s.command }),
      h("span", { class: "muted tiny", text: `runs ${words(s.after)} · up to ${s.max_rounds} round${s.max_rounds === 1 ? "" : "s"}${s.contract ? ` · contract ${s.contract}` : ""}` }),
      s.protects.length ? h("span", { class: "muted tiny", text: `protects: ${s.protects.join(", ")}` }) : h("span", { class: "muted tiny", text: "protects: nothing declared, so a changed test file is not noticed" }))
    : h("div", { class: "stack" },
      h("span", { class: "muted small", text: `${plural(s.tasks.length, "task")}${s.role ? ` · role ${s.role}` : ""}` }),
      s.tasks.length
        ? h("details", null, h("summary", { text: "tasks and their checks" }),
          h("ul", { class: "plain" }, s.tasks.map((t) => h("li", null, h("strong", { text: t.id || "(task)" }), " ", h("span", { class: "muted small", text: t.prompt }), t.check ? h("div", null, h("code", { class: "mono tiny", text: t.check })) : null))))
        : null);
  const coverage = s.kind === "verify"
    ? `${cov.runs} of ${cov.of} sessions · ${plural(cov.turns, "turn")}`
    : cov.runs ? plural(cov.runs, "run") : "never run";
  const latest = s.latest
    ? h("div", { class: "stack" }, h("strong", { text: words(s.latest.verdict) }),
      h("span", { class: "muted tiny", text: when(s.latest.ts) + (s.latest.protects_changed ? ` · ${s.latest.protects_changed} protected file(s) changed` : "") }))
    : h("span", { class: "muted", text: "no evidence yet" });
  return h("tr", null,
    h("th", { scope: "row" }, h("div", { class: "stack" }, h("span", { text: s.name }), h("span", { class: "muted tiny", text: s.kind === "verify" ? "declared check" : "trial spec" }))),
    h("td", null, declared), h("td", { text: coverage }), h("td", null, latest),
    h("td", null, s.evidence ? meter(s.evidence, s.quorum) : meter(null, "insufficient")));
}
function requestRow(r) {
  return h("tr", null,
    h("th", { scope: "row" }, h("div", { class: "stack" },
      h("span", { class: r.ask ? "" : "muted", text: r.ask || (r.turn === null ? "(work after the last recorded turn)" : "(request text not kept: no session snapshot)") }),
      h("span", { class: "muted tiny", text: `${when(r.ts)} · ${r.role || "role not recorded"} · turn ${r.turn === null ? "–" : r.turn}` }))),
    h("td", { class: "num", text: fmtN(r.steps) }),
    h("td", { text: words(r.stop_reason) || "–" }),
    h("td", null, meter(r.evidence, r.quorum)));
}
function intentSection(d) {
  const i = d.intent;
  const rows = i.specs.map(specRow);
  const g = i.gates;
  return section("lens-intent", "Intent: what was asked, and what would show it was done",
    "Specs are what the project declares; requests are what a person asked, shown on this machine only",
    h("p", { class: "muted small", text: "Each meter is a quorum, never a score: a segment lights only for evidence of that kind. A request is \"verified\" when two independent kinds agree and one of them judges the work (a test run, a [verify] verdict or a check). Review and policy show how it was governed; they cannot verify it alone." }),
    i.specs.length
      ? table([{ label: "Spec" }, { label: "Declared" }, { label: "Coverage" }, { label: "Latest evidence" }, { label: "Quorum of evidence" }], rows, "Specs the project declares, with coverage and evidence")
      : emptyNote("No spec is declared. Add a [verify] check to .gnomon/policy.toml, or a trial under .gnomon/trials/, and the lens will show what ran against it."),
    h("div", { class: "sechead" }, h("h3", { text: "Requests" }),
      h("span", { class: "muted small", text: `${plural(d.coverage.requests_verified, "request")} of the ${d.coverage.requests_shown} shown verified` })),
    i.requests.length
      ? table([{ label: "Request" }, { label: "Steps", num: true }, { label: "Ended" }, { label: "Quorum of evidence" }], i.requests.map(requestRow), "Recent requests with the evidence for each")
      : emptyNote("No working session has recorded a turn yet."),
    g.rounds
      ? h("p", { class: "muted small", text: `Requirement and finish gates ran ${plural(g.rounds, "round")} and raised ${plural(g.findings, "finding")}. The records keep the counts, not the requirement text.` })
      : null);
}

// ── 2. runs: the run lens ───────────────────────────────────────────────────
function segRow(s) {
  const tools = Object.entries(s.tools).sort((a, b) => b[1].n - a[1].n);
  const kids = [];
  if (s.reasoning) kids.push(h("span", { class: "rl-g", title: "model calls that reasoned" }, "✻ ", fmtN(s.reasoning)));
  if (tools.length) {
    kids.push(h("span", { class: "rl-g", title: "tool calls by tool" }, "⚙ ",
      tools.map(([t, v]) => h("span", { class: `rl-tool${v.fail ? " bad" : ""}`, text: `${t}×${v.n}${v.fail ? ` (${v.fail} ✕)` : ""}` }))));
  }
  for (const d of s.delegations) kids.push(h("span", { class: `rl-g rl-deleg${d.denied ? " bad" : ""}`, title: "delegated sub-turn" }, `↳ ${d.role}`, d.steps !== null ? ` ↲ ${d.steps} steps` : d.denied ? " ↲ denied" : ""));
  const skills = [...new Set([...s.skills.fired, ...s.skills.read])];
  for (const k of skills.slice(0, 4)) kids.push(h("span", { class: "rl-g rl-skill", title: s.skills.cited.includes(k) ? "fired and cited in reasoning" : "fired or read" }, `◆ ${k}${s.skills.cited.includes(k) ? " (cited)" : ""}`));
  if (s.escalation) kids.push(h("span", { class: "rl-g rl-esc", title: "hand-off to another model" }, `⇡ ${words(s.escalation.trigger)}`));
  for (const v of s.verdicts) kids.push(h("span", { class: `rl-g rl-v v-${v}` }, `⎿ [verify] ${words(v)}`));
  for (const t of s.tests) kids.push(h("span", { class: `rl-g rl-v ${t === 0 ? "v-passed" : "v-failed"}` }, `⎿ test exit ${t === null ? "?" : t}`));
  if (s.refused) kids.push(h("span", { class: "rl-g bad" }, `⎿ ${plural(s.refused, "refusal")}`));
  return h("li", { class: `rl-row b-${s.bucket || "none"}` },
    h("span", { class: "rl-turn", text: s.turn === null ? "…" : `T${s.turn}` }),
    h("span", { class: "rl-role" }, dot(s.locality), s.role || "–"),
    h("span", { class: "rl-body" }, kids.length ? kids : h("span", { class: "muted tiny", text: "no tool calls recorded" })),
    h("span", { class: "rl-end muted tiny", text: `${words(s.stop_reason) || (s.turn === null ? "did not finish" : "–")}${s.duration_ms !== null ? ` · ${ms(s.duration_ms)}` : ""}` }));
}
function pathMap(run) {
  const segs = run.segments.filter((s) => s.steps.length);
  if (!segs.length) return emptyNote("No tool calls recorded in this run.");
  return h("ol", { class: "pm" }, segs.map((s) => {
    const reached = s.verdicts.includes("passed") || s.tests.includes(0);
    return h("li", { class: "pm-row" },
      h("div", { class: "pm-ask" }, s.ask || `turn ${s.turn === null ? "(unfinished)" : s.turn}`),
      h("div", { class: "pm-path", role: "list", "aria-label": "Tool calls in order; a cross is a dead end" },
        s.steps.map((st, n) => h("span", { class: `pm-n ${st.ok ? "ok" : "dead"}`, role: "listitem", title: st.what },
          h("span", { class: "pm-g", "aria-hidden": "true", text: st.ok ? "●" : "✕" }), st.tool, h("span", { class: "sr-only", text: st.ok ? "" : " (dead end)" }), n < s.steps.length - 1 ? h("span", { class: "pm-a", "aria-hidden": "true", text: "›" }) : null)),
        reached ? h("span", { class: "pm-goal", text: "◎ reached a passing check" }) : null));
  }));
}
function runBody(run, box) {
  const draw = (full) => {
    const on = pathMaps.has(run.name);
    box.replaceChildren(
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn toggle", "aria-pressed": on ? "true" : "false", text: on ? "Show the run lens" : "Show the path map",
          onClick: () => { if (on) pathMaps.delete(run.name); else pathMaps.add(run.name); void load(); } }),
        h("span", { class: "muted tiny", text: on ? "Each request's tool calls in order; a ✕ is a dead end and ◎ marks the path that reached a passing check." : "✻ reasoning · ⚙ steps by tool · ↳/↲ delegations by role · ◆ skills · ⎿ outcomes. Dot colour: local or cloud." })),
      on ? (full ? pathMap(full) : h("p", { class: "muted", role: "status", text: "Reading the run…" }))
        : h("ol", { class: "rl" }, run.segments.map(segRow)),
      !on && run.segments_total > run.segments.length ? h("p", { class: "muted tiny", text: `Newest ${run.segments.length} of ${run.segments_total} turns.` }) : null);
  };
  const load = async () => {
    if (!pathMaps.has(run.name) || runCache.has(run.name)) return draw(runCache.get(run.name));
    draw(null);
    try {
      runCache.set(run.name, await projectApi("lens/run", `?name=${encodeURIComponent(run.name)}`));
    } catch (e) {
      box.replaceChildren(h("p", { class: "problem", role: "alert", text: e.message }));
      return;
    }
    draw(runCache.get(run.name));
  };
  return load();
}
function runItem(run) {
  const verdicts = {};
  for (const s of run.segments) for (const v of s.verdicts) verdicts[v] = (verdicts[v] || 0) + 1;
  const body = h("div", { class: "rl-box" });
  const det = h("details", { class: "run", open: openRuns.has(run.name) ? true : null },
    h("summary", null,
      h("strong", { text: run.harness }), " ",
      h("span", { class: "muted small", text: `${when(run.started)} · ${run.mode} · ${plural(run.segments_total, "turn")}${run.escalations ? ` · ${plural(run.escalations, "hand-off")}` : ""}${run.sealed ? "" : " · not sealed"}` }),
      Object.keys(verdicts).length ? h("span", { class: "runv" }, Object.entries(verdicts).map(([v, n]) => chip(`${words(v)} ${n}`, `v-${v}`))) : null),
    body);
  det.addEventListener("toggle", () => {
    if (det.open) { openRuns.add(run.name); void runBody(run, body); } else openRuns.delete(run.name);
  });
  if (det.open) void runBody(run, body);
  return h("li", null, det);
}
function runsSection(d) {
  const r = d.runs;
  const harnessRows = Object.entries(r.harnesses).sort((a, b) => b[1].sessions - a[1].sessions)
    .map(([k, v]) => h("tr", null, h("th", { scope: "row", text: k }), h("td", { class: "num", text: fmtN(v.sessions) }), h("td", { class: "num", text: fmtN(v.turns) })));
  const models = Object.entries(r.models).sort((a, b) => b[1].turns - a[1].turns);
  const skillNames = Object.keys(r.skills.fired);
  return section("lens-runs", "Runs: how the agents worked", "Sessions per harness, roles, delegations, models and skills, as recorded",
    h("div", { class: "cols" },
      h("div", { class: "stack" }, h("h3", { text: "Sessions per harness" }),
        harnessRows.length ? table([{ label: "Harness" }, { label: "Sessions", num: true }, { label: "Turns", num: true }], harnessRows, "Sessions per harness") : emptyNote("No session recorded.")),
      h("div", { class: "stack" }, h("h3", { text: "Roles, models and how turns ended" }),
        h("div", { class: "chips" }, h("span", { class: "muted small", text: "Roles" }), countChips(r.roles)),
        h("div", { class: "chips" }, h("span", { class: "muted small", text: "Models" }),
          models.map(([m, v]) => h("span", { class: "chip" }, dot(v.locality), ` ${m} ${fmtN(v.turns)}`))),
        h("div", { class: "chips" }, h("span", { class: "muted small", text: "Stop reasons" }), countChips(r.stop_reasons)),
        h("div", { class: "chips" }, h("span", { class: "muted small", text: `Delegations ↳ ${fmtN(r.delegations.total)}` }), countChips(r.delegations.by_role)),
        h("div", { class: "chips" }, h("span", { class: "muted small", text: `Skills ◆ fired ${fmtN(skillNames.length)}` }),
          skillNames.slice(0, 8).map((k) => chip(`${k} ×${r.skills.fired[k]}${r.skills.read[k] ? ` · read ${r.skills.read[k]}` : ""}${r.skills.cited[k] ? ` · cited ${r.skills.cited[k]}` : ""}`)),
          skillNames.length ? null : h("span", { class: "muted small", text: "none fired" })),
        r.escalations.length
          ? h("div", { class: "chips" }, h("span", { class: "muted small", text: `Hand-offs ⇡ ${fmtN(r.escalations.length)}` }),
            r.escalations.slice(-4).map((e) => chip(`${words(e.trigger)}: ${e.from || "?"} → ${e.to || "?"}`)))
          : null)),
    h("div", { class: "sechead" }, h("h3", { text: "Run lens" }), h("span", { class: "muted small", text: "Open a run for its swimlane, in gnomon's own trace grammar" })),
    r.recent.length ? h("ul", { class: "plain runs" }, r.recent.map(runItem)) : emptyNote("No run recorded yet."));
}

// ── 3. evidence ─────────────────────────────────────────────────────────────
function evidenceSection(d) {
  const e = d.evidence;
  const verdictLine = Object.keys(e.verify.verdicts).length ? countChips(e.verify.verdicts, "") : [h("span", { class: "muted small", text: "no [verify] verdict recorded" })];
  return section("lens-evidence", "Evidence: what validated the work", "Test runs, [verify] verdicts, gnomon check and eval results",
    h("div", { class: "tiles" },
      tile("Test runs", fmtN(e.tests.total), e.tests.total ? `${e.tests.passed} exited 0 · ${e.tests.failed} did not` : "no test command seen"),
      tile("[verify] verdicts", fmtN(e.verify.total), h("div", { class: "chips" }, verdictLine)),
      tile("gnomon check", fmtN(e.checks.total), e.checks.total ? `${e.checks.held} held · ${e.checks.failed} failed` : "none recorded"),
      tile("Review gates", fmtN(Object.values(e.gates).reduce((a, b) => a + b, 0)), h("div", { class: "chips" }, countChips(e.gates)))),
    h("div", { class: "cols" },
      h("div", { class: "stack" }, h("h3", { text: "Recent test runs" }),
        e.tests.recent.length
          ? table([{ label: "Command" }, { label: "Exit", num: true }, { label: "When" }],
            e.tests.recent.map((t) => h("tr", null, h("th", { scope: "row" }, h("code", { class: "mono tiny", text: t.command })), h("td", { class: `num ${t.exit === 0 ? "ok" : "bad"}`, text: t.exit === null ? "?" : t.exit }), h("td", { class: "muted", text: when(t.ts) }))), "Recent test runs")
          : emptyNote("No test command was recorded.")),
      h("div", { class: "stack" }, h("h3", { text: "Recent [verify] verdicts" }),
        e.verify.recent.length
          ? table([{ label: "Verdict" }, { label: "Exit", num: true }, { label: "When" }],
            e.verify.recent.map((v) => h("tr", null, h("th", { scope: "row" }, chip(words(v.verdict), `v-${v.verdict}`), v.protects_changed ? h("span", { class: "muted tiny", text: ` ${v.protects_changed} protected file(s) changed` }) : null),
              h("td", { class: "num", text: v.exit === null ? "–" : v.exit }), h("td", { class: "muted", text: when(v.ts) }))), "Recent verify verdicts")
          : emptyNote("No [verify] verdict recorded."))),
    e.checks.recent.length || e.evals.length
      ? h("div", { class: "chips" },
        e.checks.recent.map((c) => chip(`check ${when(c.ts)}: exit ${c.exit === null ? "?" : c.exit}${c.failed.length ? ` (${c.failed.join(", ")})` : ""}`, c.exit === 0 ? "v-passed" : "v-failed")),
        e.evals.map((v) => chip(`${v.kind.replace("_", " ")} ${v.spec || ""} ${v.meets === true ? "meets thresholds" : v.meets === false ? "below thresholds" : words(v.status) || "undetermined"}`, v.meets === true ? "v-passed" : v.meets === false ? "v-failed" : "")))
      : null);
}

// ── 4. governance ───────────────────────────────────────────────────────────
function governanceSection(d) {
  const g = d.governance;
  const total = Math.max(1, ...Object.values(g.by_rule));
  const rules = Object.entries(g.by_rule).sort((a, b) => b[1] - a[1]);
  const trust = g.trust ? `${words(g.trust.status)}${g.trust.uncovered ? ` · ${g.trust.uncovered} new grant(s)` : ""}` : "unknown";
  return section("lens-gov", "Governance: what the policy decided", "Guard decisions, refusals by rule, approvals and posture",
    h("div", { class: "tiles" },
      tile("Guard decisions", fmtN(g.guard.allow + g.guard.deny + g.guard.ask), `${g.guard.allow} allowed · ${g.guard.deny} denied · ${g.guard.ask} asked`),
      tile("Refusals", fmtN(Object.values(g.by_rule).reduce((a, b) => a + b, 0)), "policy stopped these; each names its rule below"),
      tile("Approvals", fmtN(g.approvals.approved + g.approvals.declined), `${g.approvals.approved} approved · ${g.approvals.declined} declined by a person`),
      tile("Posture", h("span", { class: "tv", text: trust }), g.tamper_records ? `${plural(g.tamper_records, "tamper record")} in the trails` : "no tamper records")),
    rules.length
      ? h("ul", { class: "plain rulebars" }, rules.map(([k, v]) => h("li", { class: "rulebar" },
        h("span", { class: "mono small", text: k }),
        h("span", { class: "rb", role: "img", "aria-label": `${v} of ${total} at the busiest rule` }, h("span", { style: { width: `${Math.max(3, pct(v, total))}%` } })),
        h("span", { class: "num small", text: fmtN(v) }))))
      : emptyNote("No refusal or guard denial recorded."),
    h("a", { class: "btn", href: `#/governance/${d.project.id}` }, "Open Governance", icon(ICONS.arrow, 16)));
}

// ── 5. measures ─────────────────────────────────────────────────────────────
function measuresSection(d) {
  const m = d.measures;
  const c = m.context;
  const fill = c.median_fill;
  const trims = Object.entries(c.trims);
  return section("lens-measures", "Measures: what it took", "Tokens, cache, latency, context and cost from the model-call records",
    h("div", { class: "tiles" },
      tile("Tokens", h("span", null, compact(m.tokens.in + m.tokens.out)),
        `${compact(m.tokens.in)} in · ${compact(m.tokens.out)} out${m.tokens.unmetered_turns ? ` · ${plural(m.tokens.unmetered_turns, "turn")} unmetered` : ""}`),
      tile("Cache share", m.cache_share === null ? "–" : `${Math.round(m.cache_share * 100)}%`,
        m.cache_share === null ? "no model call reported prompt tokens" : `${compact(m.tokens.cached)} of ${compact(m.tokens.prompt)} prompt tokens served from cache`),
      tile("Latency", ms(m.latency_ms.median), m.latency_ms.calls ? `median per model call · p90 ${ms(m.latency_ms.p90)} · first byte ${ms(m.first_byte_ms.median)}` : "no model call recorded"),
      tile("Context fill", fill === null ? "–" : `${Math.round(fill * 100)}%`,
        fill === null ? "no window recorded" : `median of a ${compact(c.window)}-token window · max ${Math.round(c.max_fill * 100)}%`),
      tile("Cost", m.cost_usd === null ? "unknown" : `$${m.cost_usd.toFixed(2)}`, m.cost_note)),
    fill === null ? null : h("div", { class: "fillbar", role: "img", "aria-label": `Median context fill ${Math.round(fill * 100)} percent, maximum ${Math.round(c.max_fill * 100)} percent` },
      h("span", { class: "med", style: { width: `${Math.min(100, Math.round(fill * 100))}%` } }),
      h("span", { class: "mx", style: { left: `${Math.min(100, Math.round(c.max_fill * 100))}%` } })),
    h("div", { class: "chips" }, h("span", { class: "muted small", text: `Context trims (${fmtN(c.dropped)} turns dropped)` }),
      trims.length ? trims.map(([k, v]) => chip(`${words(k)} ${fmtN(v)}`)) : h("span", { class: "muted small", text: "none recorded" })));
}

// ── the screen ──────────────────────────────────────────────────────────────
function renderLens(d, ctx) {
  if (d.none) return [header("Lens", "Nothing to show here yet", "This project has no .gnomon/ yet. `gnomon init` writes one.")];
  return [
    header("Lens", `Spec → verify: ${d.project.name}`,
      "How gnomon covers this project end to end: what was specified, how agents ran, what validated the work and under which rules. Read from the records gnomon keeps; where nothing was recorded the page says so rather than guess.",
      h("button", { type: "button", class: "btn big", text: "Refresh", onClick: () => { runCache.clear(); ctx.load(true); } })),
    coverageTiles(d),
    intentSection(d),
    runsSection(d),
    evidenceSection(d),
    governanceSection(d),
    measuresSection(d),
  ];
}

registerScreen("lens", "Lens", LENS_ICON, { fetch: fetchLens, render: renderLens });
