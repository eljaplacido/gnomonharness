// gnomon dashboard — the page. No framework, no build step, no network but
// this server. Every node is built with createElement and textContent: record
// text is untrusted (a model wrote some of it), so nothing is ever parsed as
// HTML. Styles are set through the CSSOM, which the page's CSP allows; it
// forbids inline style attributes and inline script.
//
// Every button names the gnomon command it maps to. Read-only ones run; the
// rest show the command in the "Runs as" bar, disabled, until a later PR
// wires them through the server's action table.

const TOKEN_KEY = "gnomon.dashboard.token";
const S = {
  token: null,
  meta: null,
  overview: null,
  pid: null,
  screen: "projects",
  trail: null,
  data: {},
  bar: null,
  sel: null,
  open: {},
  verify: {},
  doctor: null,
  setupStep: 1,
  tables: {},
  loading: false,
};

// ── DOM helpers ─────────────────────────────────────────────────────────────
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}
function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "href") el.setAttribute("href", String(v).startsWith("#") ? String(v) : "#/projects");
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
const icon = (paths, size = 20) =>
  s("svg", { "aria-hidden": "true", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
    paths.map((d) => s("path", { d })));
const ICONS = {
  projects: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  setup: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0"],
  session: ["M3 8h6M12 8h9M3 16h10M16 16h5", "M9 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0", "M13 16a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"],
  governance: ["M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"],
  contracts: ["M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z", "M8.5 12.5l2.5 2.5 5-6"],
  measurements: ["M5 20v-8M10 20V6M15 20v-9M20 20V9M3 20h18"],
  lock: ["M5 11h14v10H5z", "M8 11V8a4 4 0 0 1 8 0v3"],
  prompt: ["M4 7l5 5-5 5M12 17h8"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  cross: ["M6 6l12 12M18 6L6 18"],
  arrow: ["M5 12h14M13 6l6 6-6 6"],
};
const mark = (ok) => s("svg", { "aria-hidden": "true", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: ok ? "#A3CF8F" : "#F3C6B6", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }, s("path", { d: ok ? ICONS.check[0] : ICONS.cross[0] }));

// ── formatting ──────────────────────────────────────────────────────────────
const fmtN = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));
function compact(n) {
  if (n === null || n === undefined) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
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
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + " "}· ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const secs = (x) => (x === null || x === undefined ? "–" : x >= 100 ? `${Math.round(x)} s` : `${x.toFixed(1)} s`);
const ms = (x) => (x === null || x === undefined ? "–" : secs(x / 1000));
const short = (hash) => (hash ? String(hash).slice(0, 12) : "–");
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const plural = (n, w, ws) => `${fmtN(n)} ${n === 1 ? w : ws || w + "s"}`;
const BUCKETS = ["result", "refusal", "apparatus_failure"];
const BUCKET_LABEL = { result: "result", refusal: "refusal", apparatus_failure: "apparatus failure" };

// ── server ──────────────────────────────────────────────────────────────────
async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${S.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
    credentials: "omit",
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    S.token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ }
    renderGate("This tab is not signed in. Use the link the terminal printed; press Enter there for a new one.");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}
const P = () => S.meta?.projects.find((p) => p.id === S.pid);
const projectApi = (what, q = "") => api(`/api/p/${S.pid}/${what}${q}`);

async function signIn() {
  const m = /^#k=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m) {
    // The fragment never reached any server. Trade it once for a token, then
    // take it out of the address bar and the history.
    history.replaceState(null, "", "/#/projects");
    try {
      const res = await fetch("/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: m[1] }), credentials: "omit" });
      const body = await res.json();
      if (!res.ok) return renderGate(body.error || "Sign-in failed.");
      S.token = body.token;
      try { sessionStorage.setItem(TOKEN_KEY, S.token); } catch { /* storage off: this tab only */ }
    } catch (e) {
      return renderGate(`Sign-in failed: ${e.message}`);
    }
  } else {
    try { S.token = sessionStorage.getItem(TOKEN_KEY); } catch { S.token = null; }
  }
  if (!S.token) return renderGate("Open the link `gnomon dashboard` printed in your terminal. It signs this tab in once; press Enter in the terminal for a new link.");
  try {
    S.meta = await api("/api/meta");
  } catch {
    return;
  }
  const here = S.meta.projects.find((p) => p.source === "here" && p.hasSurface) || S.meta.projects.find((p) => p.hasSurface) || S.meta.projects[0];
  S.pid = here ? here.id : null;
  window.addEventListener("hashchange", route);
  route();
}

function renderGate(text) {
  const root = document.getElementById("app");
  root.replaceChildren(
    h("div", { class: "gate" },
      h("span", { class: "brand" }, sundial(), h("span", { class: "wordmark", text: "GNOMON" })),
      h("h1", { text: "Sign in from the terminal" }),
      h("p", { class: "lede", text }),
      h("p", { class: "muted small", text: "The dashboard serves this machine only (127.0.0.1) and reads what gnomon already records. It changes nothing." })));
}

// ── routing ─────────────────────────────────────────────────────────────────
const SCREENS = [
  ["projects", "Projects"],
  ["setup", "Setup"],
  ["session", "Session"],
  ["governance", "Governance"],
  ["contracts", "Contracts"],
  ["measurements", "Measurements"],
];
function go(screen, pid = S.pid, trail = null) {
  location.hash = `#/${screen}${pid ? "/" + pid : ""}${trail ? "/" + encodeURIComponent(trail) : ""}`;
}
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const screen = SCREENS.some(([k]) => k === parts[0]) ? parts[0] : "projects";
  if (parts[1] && S.meta.projects.some((p) => p.id === parts[1])) S.pid = parts[1];
  const trail = parts[2] ? decodeURIComponent(parts[2]) : null;
  if (screen !== S.screen || trail !== S.trail) S.sel = null;
  S.screen = screen;
  S.trail = trail;
  await load();
}

async function load(force = false) {
  const key = `${S.screen}:${S.pid}:${S.trail || ""}`;
  if (force) S.data = {};
  render();
  if (S.data[key] !== undefined) return;
  S.data[key] = null;
  try {
    S.data[key] = await fetchScreen();
  } catch (e) {
    if (e.message === "unauthorized") return;
    S.data[key] = { error: e.message };
  }
  render();
}
async function fetchScreen() {
  const p = P();
  switch (S.screen) {
    case "projects":
      return api("/api/projects");
    case "setup":
      return api(`/api/setup${S.pid ? "?project=" + S.pid : ""}`);
    case "session": {
      if (!p?.hasSurface) return { none: true };
      const list = await projectApi("sessions");
      // Default: the newest working session that did something.
      const busy = (t) => ["prompt", "task", "acp"].includes(t.mode) && t.turns + t.tool_calls > 0;
      const pick = S.trail || (list.trails.find(busy) || list.trails[0])?.name;
      const detail = pick ? await projectApi("trail", `?name=${encodeURIComponent(pick)}`) : null;
      return { list, detail };
    }
    case "governance":
      return p?.hasSurface ? projectApi("governance") : { none: true };
    case "contracts":
      return p ? projectApi("contracts") : { none: true };
    case "measurements":
      return p?.hasSurface ? projectApi("measurements") : { none: true };
  }
  return null;
}
const current = () => S.data[`${S.screen}:${S.pid}:${S.trail || ""}`];

// ── actions: the "Runs as" bar ──────────────────────────────────────────────
function commandFor(name, fill = {}, pid = S.pid) {
  const a = S.meta.actions.find((x) => x.name === name);
  const argv = a.argv.map((x) => (x.startsWith("<") ? fill[x.slice(1, -1)] || x : x));
  const p = S.meta.projects.find((x) => x.id === pid);
  const dir = p && p.source !== "here" ? ` --dir ${p.root}` : "";
  return `gnomon ${argv.join(" ")}${dir}`;
}
function actionButton(name, label, opts = {}) {
  const a = S.meta.actions.find((x) => x.name === name);
  const planned = !a || a.state !== "enabled";
  const text = opts.command || commandFor(name, opts.fill, opts.pid);
  return h("button", {
    type: "button",
    class: `btn${opts.primary ? " primary" : ""}${opts.big ? " big" : ""}`,
    title: planned ? `next PR · ${text}` : text,
    "aria-describedby": planned ? "runbar-note" : null,
    onClick: () => (planned ? stage({ text, planned: true }) : opts.run ? opts.run(text) : null),
  }, label, planned ? h("span", { class: "sr-only", text: " (next PR)" }) : null);
}
function plainCommand(label, text, note) {
  return h("button", { type: "button", class: "btn", title: `next PR · ${text}`, onClick: () => stage({ text, planned: true, note }) }, label);
}
function stage(bar) {
  S.bar = bar;
  renderBar();
}
async function runAction(name, body, text, pid = S.pid) {
  stage({ text, running: true });
  try {
    const r = await api(`/api/actions/${name}`, { method: "POST", body: JSON.stringify({ project: pid, ...body }) });
    stage({ text, done: r });
    return r;
  } catch (e) {
    stage({ text, error: e.message });
    return null;
  }
}
function verifyNow(trail, pid = S.pid) {
  const p = S.meta.projects.find((x) => x.id === pid);
  if (!p?.hasSurface) return;
  const text = commandFor("audit.verify", {}, pid) + (trail ? ` ${trail}` : "");
  runAction("audit.verify", trail ? { trail } : {}, text, pid).then((r) => {
    if (r) {
      S.verify[`${pid}:${trail || "*"}`] = r;
      render();
    }
  });
}
function verifySummary(r) {
  if (!r) return "";
  const n = r.trails.length;
  if (!n) return "Nothing to verify: no trail in " + r.dir + ". Exit 1, which is no evidence, not no problem.";
  const broken = r.trails.filter((t) => !t.ok).length;
  const unsealed = r.trails.filter((t) => !t.sealed).length;
  return `exit ${r.exit} · ${n - broken} of ${plural(n, "trail")} intact${broken ? `, ${broken} BROKEN` : ""}${unsealed ? ` · ${unsealed} not sealed` : ""}`;
}
function renderBar() {
  const bar = document.getElementById("runbar");
  if (!bar) return;
  const b = S.bar;
  const kids = [h("span", { class: "label" }, icon(ICONS.prompt, 18), "Runs as")];
  if (!b) {
    kids.push(h("span", { class: "say", text: "Every button here is a gnomon command. Read-only ones run; the rest show their command." }));
  } else {
    kids.push(h("code", { text: b.text }));
    const row = h("div", { class: "row" });
    if (b.planned) {
      row.append(h("button", { type: "button", class: "btn", disabled: true, title: "next PR", text: "Run" }));
    }
    if (navigator.clipboard) row.append(h("button", { type: "button", class: "btn", text: "Copy", onClick: () => navigator.clipboard.writeText(b.text).catch(() => {}) }));
    row.append(h("button", { type: "button", class: "btn", text: "Dismiss", onClick: () => stage(null) }));
    kids.push(row);
    let note = "";
    if (b.planned) note = b.note || "Planned: the dashboard runs this in a later PR. It is read-only today; run it in a terminal.";
    else if (b.running) note = "Running…";
    else if (b.error) note = `Failed: ${b.error}`;
    else if (b.done?.action === "audit.verify") note = `Ran in-process with the function \`gnomon audit verify\` uses: ${verifySummary(b.done)}.`;
    else if (b.done?.action === "doctor.scan") note = b.done.available ? `exit ${b.done.exit}${b.done.timed_out ? " (timed out)" : ""}` : "This build has no `gnomon doctor`: it arrives with the setup wizard.";
    kids.push(h("span", { class: "note", id: "runbar-note", text: note }));
  }
  bar.replaceChildren(...kids);
}

// ── shell ───────────────────────────────────────────────────────────────────
function sundial() {
  return s("svg", { "aria-hidden": "true", width: 32, height: 32, viewBox: "0 0 32 32", fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" },
    s("circle", { cx: 16, cy: 16, r: 13, stroke: "#ECE7DC", "stroke-width": 1.5 }),
    s("path", { d: "M16 4.5v2.5M16 25v2.5M4.5 16H7M25 16h2.5M7.9 7.9l1.8 1.8M22.3 22.3l1.8 1.8M7.9 24.1l1.8-1.8M22.3 9.7l1.8-1.8", stroke: "#B3AC9F", "stroke-width": 1.2 }),
    s("path", { d: "M16 16L16 8.5L21 16Z", fill: "#E2733F", stroke: "#E2733F", "stroke-width": 1 }),
    s("path", { d: "M16 16L23.5 20.5", stroke: "#ECE7DC", "stroke-width": 1.5 }));
}
function render() {
  const root = document.getElementById("app");
  const projects = S.meta.projects;
  const nav = h("nav", { class: "side", "aria-label": "Dashboard sections" },
    h("a", { class: "brand", href: `#/projects/${S.pid || ""}` }, sundial(), h("span", { class: "wordmark", text: "GNOMON" })),
    h("ul", { class: "navlist" },
      SCREENS.map(([k, label]) => h("li", null,
        h("a", { class: "navlink", href: `#/${k}${S.pid ? "/" + S.pid : ""}`, "aria-current": S.screen === k ? "page" : null }, icon(ICONS[k]), label)))),
    projects.length > 1
      ? h("label", { class: "picker" }, "Project",
        h("select", { onChange: (e) => go(S.screen === "session" ? "session" : S.screen, e.target.value) },
          projects.map((p) => h("option", { value: p.id, selected: p.id === S.pid, text: `${p.name}${p.source === "here" ? " (here)" : ""}` }))))
      : null,
    h("div", { class: "machine" },
      h("strong", null, icon(ICONS.lock, 16), "This machine only"),
      h("span", { class: "mono", text: location.host }),
      h("span", { text: S.meta.harness }),
      h("span", { text: "Read-only: this build changes nothing." })));
  const main = h("main", { class: "main", id: "main" },
    h("div", { class: "runbar", id: "runbar", role: "status", "aria-live": "polite" }),
    h("div", { class: "wrap" }, screen()));
  root.replaceChildren(nav, main);
  renderBar();
}
function screen() {
  const d = current();
  if (d === null || d === undefined) return [h("p", { class: "muted", role: "status", text: "Reading records…" })];
  if (d.error) return [h("p", { class: "problem", role: "alert", text: d.error })];
  if (d.none) return [header("No project", "Nothing to show here yet", "No project with a .gnomon/ is selected. Run `gnomon init` in a project, then `gnomon dashboard` there.")];
  switch (S.screen) {
    case "projects": return projectsScreen(d);
    case "setup": return setupScreen(d);
    case "session": return sessionScreen(d);
    case "governance": return governanceScreen(d);
    case "contracts": return contractsScreen(d);
    case "measurements": return measurementsScreen(d);
  }
  return [];
}
function header(kicker, title, lede, ...buttons) {
  return h("header", { class: "head" },
    h("div", null, h("p", { class: "kicker", text: kicker }), h("h1", { text: title }), lede ? h("p", { class: "lede", text: lede }) : null),
    buttons.length ? h("div", { class: "row" }, buttons) : null);
}
const tile = (k, v, sub) => h("div", { class: "tile" }, h("span", { class: "k", text: k }), h("span", { class: "v" }, v), sub ? (sub instanceof Node ? sub : h("div", { class: "k", text: sub })) : null);
function split(local, cloud, unknown = 0) {
  const total = local + cloud + unknown;
  if (!total) return h("div", { class: "split none", "aria-hidden": "true" });
  const seg = (cls, n) => (n > 0 ? h("span", { class: cls, style: { flex: `${n} 1 0px` } }) : null);
  return h("div", { class: "split", "aria-hidden": "true" }, seg("local", local), seg("cloud", cloud), seg("unknown", unknown));
}
const facts = (rows) => h("dl", { class: "facts" }, rows.filter(Boolean).map(([k, v]) => h("div", null, h("dt", { text: k }), h("dd", null, v))));

// ── 1. Projects ─────────────────────────────────────────────────────────────
const TRUST_TEXT = {
  default: "grants nothing beyond the defaults",
  trusted: "trusted on this machine",
  untrusted: "not trusted · headless runs clamped",
};
function projectsScreen(d) {
  const ps = d.projects;
  const ok = ps.filter((p) => !p.problem);
  const sum = (f) => ok.reduce((n, p) => n + f(p), 0);
  const tok = (loc) => sum((p) => p.tokens[loc].in + p.tokens[loc].out);
  const local = tok("local"), cloud = tok("cloud"), unknown = tok("unknown");
  const unmetered = sum((p) => p.tokens.local.unmetered + p.tokens.cloud.unmetered + p.tokens.unknown.unmetered);
  const turns = sum((p) => p.turns.total);
  const answered = sum((p) => p.turns.stop_reasons.answered || 0);
  const refusals = sum((p) => p.refusals.named + p.refusals.unnamed);
  const named = sum((p) => p.refusals.named);
  return [
    header("Command center", "Projects",
      "How gnomon has governed and performed in each project on this machine: which surface ran, what the policy refused, how turns ended and what they used. Read from the records gnomon keeps; nothing here is sampled or estimated.",
      h("button", { type: "button", class: "btn big", text: "Refresh", onClick: () => load(true) }),
      h("a", { class: "btn big", href: `#/setup/${S.pid || ""}`, text: "Run setup" }),
      plainCommand("Add a project", "gnomon init --dir <path>", "Planned. Today: run `gnomon init` in the project, then `gnomon dashboard` there, or trust it with `gnomon trust grant` so it is listed here.")),
    h("section", { "aria-labelledby": "tot-h" },
      h("div", { class: "sechead" }, h("h2", { id: "tot-h", text: "All projects on this list" }),
        h("span", { class: "muted small", text: `${plural(ps.length, "project")}: the one here, plus the roots in this machine's trust store` })),
      h("div", { class: "tiles" },
        tile("Sessions", fmtN(sum((p) => p.sessions)), `${plural(sum((p) => p.trails), "audit trail")} in all`),
        tile("Turns recorded", h("span", null, fmtN(turns), " ", h("small", { text: turns ? `${pct(answered, turns)}% answered` : "" })), "stop reason as recorded, per turn"),
        tile("Tool calls recorded", fmtN(sum((p) => p.tool_calls)), "each one a record in a hash-chained trail"),
        tile("Policy refusals", fmtN(refusals),
          refusals ? h("a", { class: "k", href: `#/governance/${S.pid || ""}`, text: `${fmtN(named)} by a named rule — see which` }) : "none recorded"),
        tile("Tokens", h("span", null, local + cloud ? `${pct(local, local + cloud)}% ` : "–", h("small", { text: local + cloud ? "local" : "" })),
          h("div", { class: "k" }, split(local, cloud, unknown), h("span", { text: `${compact(local)} local · ${compact(cloud)} cloud${unmetered ? ` · ${plural(unmetered, "turn")} unmetered` : ""}` }))),
        tile("Cloud spend", h("span", { text: "unknown" }), "not recorded: gnomon records tokens, not prices, and never shows $0 for unknown"))),
    h("section", { "aria-labelledby": "proj-h" },
      h("div", { class: "sechead" }, h("h2", { id: "proj-h", text: "Projects" }),
        h("span", { class: "legend" },
          h("span", null, h("span", { class: "sw result" }), "result"),
          h("span", null, h("span", { class: "sw refusal" }), "refusal"),
          h("span", null, h("span", { class: "sw apparatus_failure" }), "apparatus failure"))),
      ps.length === 0
        ? h("p", { class: "empty", text: "No .gnomon/ here and nothing trusted on this machine. Run `gnomon init` in a project, then `gnomon dashboard` there." })
        : h("div", { class: "cards" }, ps.map(projectCard))),
  ];
}
function projectCard(p) {
  if (p.problem) {
    return h("article", { class: "card dashed" },
      h("div", { class: "cardhead" }, h("div", null, h("h3", { text: p.name }), h("span", { class: "muted small mono", text: p.root })),
        h("span", { class: "pill", text: p.source === "here" ? "here" : "trusted" })),
      h("p", { class: "muted", text: p.problem }));
  }
  const L = p.tokens.local.in + p.tokens.local.out, C = p.tokens.cloud.in + p.tokens.cloud.out, U = p.tokens.unknown.in + p.tokens.unknown.out;
  const modeText = { hybrid: "Hybrid", local: "Local", cloud: "Cloud", none: "No turns yet" }[p.mode];
  const b = p.turns.buckets;
  const moved = p.last_surface_hash && p.last_surface_hash !== p.surface_hash;
  const checks = p.checks.held + p.checks.failed + p.checks.no_verdict;
  return h("article", { class: `card${p.id === S.pid ? " selected" : ""}` },
    h("div", { class: "cardhead" },
      h("div", null, h("h3", { text: p.name }), h("span", { class: "muted small mono", text: p.root })),
      h("span", { class: "pill" },
        p.mode === "local" || p.mode === "hybrid" ? h("span", { class: "dot local" }) : null,
        p.mode === "cloud" || p.mode === "hybrid" ? h("span", { class: "dot cloud" }) : null,
        modeText)),
    h("div", { class: "splitwrap" },
      h("div", { class: "splitlegend" }, h("span", { text: `Local ${L + C ? pct(L, L + C) : 0}% · ${compact(L)}` }), h("span", { text: `Cloud ${L + C ? pct(C, L + C) : 0}% · ${compact(C)}` })),
      split(L, C, U)),
    facts([
      ["Surface", h("span", null, h("span", { class: "mono", text: short(p.surface_hash) }), moved ? h("span", { class: "muted tiny", text: " · moved since the last session" }) : null)],
      ["Trust", TRUST_TEXT[p.trust.status] + (p.trust.uncovered ? ` · ${p.trust.uncovered} new grant${p.trust.uncovered === 1 ? "" : "s"}` : "")],
      ["Last activity", when(p.last_activity)],
      ["Sessions", `${fmtN(p.sessions)} · ${plural(p.trails, "trail")}`],
      ["Policy refusals", `${fmtN(p.refusals.named + p.refusals.unnamed)}${p.refusals.unnamed ? ` (${p.refusals.unnamed} no rule named)` : ""}`],
      ["Check verdicts", checks ? `${p.checks.held} held · ${p.checks.failed} failed · ${p.checks.no_verdict} no verdict` : "none yet"],
      ["Turns", p.turns.total ? `${fmtN(p.turns.total)} · ${b.result} result · ${b.refusal} refusal · ${b.apparatus_failure} apparatus` : "none recorded"],
      ["Audit trail", p.audit_enabled ? "on" : "off in this surface"],
    ]),
    p.ticks.length
      ? h("div", null,
        h("div", { class: "ticks", "aria-hidden": "true" }, p.ticks.map((t) => h("span", { class: BUCKETS.includes(t) ? t : "unrecorded" }))),
        h("span", { class: "muted tiny", text: `Last ${p.ticks.length} turns in run order (newest right)` }))
      : null,
    h("div", { class: "cardfoot" },
      actionButton("check.run", "Run check", { fill: { rev: "HEAD~1" }, pid: p.id }),
      h("button", { type: "button", class: "btn", text: "Verify trail", onClick: () => verifyNow(null, p.id) }),
      h("a", { class: "btn", href: `#/session/${p.id}` }, "Sessions", icon(ICONS.arrow, 16))));
}

// ── 2. Setup ────────────────────────────────────────────────────────────────
const SETUP_STEPS = [
  [1, "Scan this machine"],
  [2, "Pick a local model"],
  [3, "Connect a cloud model"],
  [4, "Choose how work splits"],
  [5, "Review the change"],
];
function setupScreen(d) {
  const lands = "Available after setup lands: the setup wizard (doctor, setup, proposal) is built on its own branch, feat/setup-wizard, and this screen calls it once it is in your build.";
  const step = S.setupStep;
  const stepPanel = () => {
    if (step === 1) {
      if (!d.commands.doctor) {
        return h("div", { class: "panel" },
          h("h2", { text: "Scan your hardware" }),
          h("p", { class: "lede", text: "gnomon reads what this machine has: operating system, memory, graphics, and any model server already running here. It only reads." }),
          h("p", { class: "empty", text: lands }),
          h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", disabled: true, title: "after setup lands · gnomon doctor --json", text: "Scan this machine" }),
            h("span", { class: "muted small mono", text: "gnomon doctor --json" })));
      }
      const r = S.doctor;
      return h("div", { class: "panel" },
        h("h2", { text: "Scan your hardware" }),
        h("p", { class: "lede", text: "Runs `gnomon doctor --json`: it reads the machine and any model server listening here. Nothing is written or sent anywhere." }),
        h("div", { class: "row" }, h("button", {
          type: "button", class: "btn primary", text: "Scan this machine",
          onClick: () => runAction("doctor.scan", {}, "gnomon doctor --json").then((x) => { S.doctor = x; render(); }),
        })),
        r ? doctorResult(r) : null);
    }
    const planned = {
      2: ["Your recommended local model", "Picked from gnomon's dated model catalog for what the scan found. Nothing downloads until you press the button, which shows the size.", "gnomon setup --pull <tag> --yes --json"],
      3: ["Connect a cloud model (optional)", "A cloud model can plan while the local one builds. The key goes to gnomon's key store on stdin, never into .gnomon/ and never on a command line.", "gnomon endpoint add · gnomon key set <NAME> --stdin · gnomon endpoint test <name>"],
      4: ["Choose how gnomon splits the work", "Local only, hybrid or cloud first, from your own speed check. The choice is written as a proposal, not straight into the surface.", "gnomon setup --speed-check --json"],
      5: ["Review the change", "Everything setup would write into .gnomon/, as a diff. Nothing changes until you accept it, and then the surface hash moves once.", "gnomon proposal accept <id>"],
    }[step];
    return h("div", { class: "panel" },
      h("h2", { text: planned[0] }), h("p", { class: "lede", text: planned[1] }),
      h("p", { class: "empty", text: (step === 3 ? "`gnomon endpoint add` works today in a terminal. " : "") +
        ((step === 5 ? d.commands.proposal : d.commands.setup)
          ? "This build has the command. Running it from here, with its consent steps as buttons, is the next dashboard PR; run it in a terminal for now."
          : lands) }),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", disabled: true, title: `after setup lands · ${planned[2]}`, text: "Continue" }),
        h("span", { class: "muted small mono", text: planned[2] })));
  };
  const roles = d.declared.roles || [];
  return [
    header("First run", "Set up gnomon", "Five steps: find a model this machine can run, optionally a cloud model to plan with, and how the work splits. Nothing is downloaded, spent or written until you say yes, and each step is a gnomon command."),
    h("ol", { class: "wizard", "aria-label": "Setup steps" },
      SETUP_STEPS.map(([n, label]) => h("li", null, h("button", {
        type: "button", class: "stepbtn", "aria-current": n === step ? "step" : null,
        onClick: () => { S.setupStep = n; render(); },
      }, h("span", { class: "num", text: String(n) }), label)))),
    stepPanel(),
    h("section", { "aria-labelledby": "decl-h" },
      h("div", { class: "sechead" }, h("h2", { id: "decl-h", text: "What this project's surface declares now" }),
        h("span", { class: "muted small", text: "roles.toml and config.toml, as routed today" })),
      roles.length
        ? h("div", { class: "tablebox" }, h("table", null,
          h("thead", null, h("tr", null, ["Role", "Model", "Endpoint", "Where"].map((x) => h("th", { scope: "col", text: x })))),
          h("tbody", null, roles.map((r) => h("tr", null,
            h("th", { scope: "row", text: r.role }),
            h("td", { class: "mono", text: r.model || "–" }),
            h("td", { class: "mono", text: r.endpoint || "–" }),
            h("td", null, h("span", { class: "row" }, h("span", { class: `dot ${r.where}` }), `${r.where}${r.provider ? " · " + r.provider : ""}`, r.problem ? h("span", { class: "bad small", text: r.problem }) : null)))))))
        : h("p", { class: "empty", text: d.declared.note || "No roles declared." }),
      d.declared.model_url_override ? h("p", { class: "problem", text: "GNOMON_MODEL_URL is set in this environment: every role's requests go there instead, and the surface hash does not show it." }) : null,
      h("div", { class: "row" },
        plainCommand("List endpoints", "gnomon endpoint list"),
        plainCommand("Test endpoints", "gnomon endpoint test"))),
  ];
}
function doctorResult(r) {
  if (!r.available) return h("p", { class: "empty", text: "This build has no `gnomon doctor`. It arrives with the setup wizard." });
  const doc = r.doctor;
  const rows = doc && typeof doc === "object" && !Array.isArray(doc)
    ? Object.entries(doc).map(([k, v]) => [k, typeof v === "object" && v !== null ? h("pre", { class: "well", text: JSON.stringify(v, null, 2) }) : String(v)])
    : [];
  return h("div", { class: "panel" },
    h("h3", { text: `What the scan found · exit ${r.exit}` }),
    rows.length ? facts(rows) : h("pre", { class: "well", text: r.stderr || "No JSON came back." }));
}

// ── 3. Session ──────────────────────────────────────────────────────────────
function niceStep(total) {
  const raw = total / 8;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.001))));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) || raw;
}
function sessionScreen(d) {
  const { list, detail } = d;
  if (!list.trails.length) {
    return [header("Session · flight recorder", "No sessions recorded yet", "Turns, tool calls and policy decisions appear here once this project's [audit] trail is on and a session runs: `[audit] enabled = true` in .gnomon/config.toml.")];
  }
  const t = detail;
  const picker = h("label", { class: "picker" }, "Trail",
    h("select", { onChange: (e) => go("session", S.pid, e.target.value) },
      list.trails.map((x) => h("option", { value: x.name, selected: x.name === t.name, text: `${when(x.started)} · ${x.mode} · ${plural(x.turns, "turn")}, ${plural(x.tool_calls, "call")}${x.opening ? " · " + x.opening : ""}` }))));
  const refusals = t.events.filter((e) => e.kind === "tool_call" && e.bucket === "refusal").length + t.events.filter((e) => e.kind === "guard" && e.decision !== "allow").length;
  const moved = t.surface_hash && t.current_surface_hash && t.surface_hash !== t.current_surface_hash;
  return [
    header("Session · flight recorder", `${t.mode} session · ${when(t.started)}`, null),
    h("div", { class: "row" }, picker),
    h("div", { class: "row" },
      h("span", { class: "pill outline" }, "Surface ", h("span", { class: "mono", text: short(t.surface_hash) }), moved ? h("span", { class: "muted", text: " · not the current surface" }) : null),
      t.harness ? h("span", { class: "pill outline" }, "Harness ", h("span", { class: "mono", text: t.harness })) : null,
      h("span", { class: "pill outline" }, mark(t.sealed), t.sealed ? "sealed with session_end" : "not sealed: truncated, or the run was killed"),
      h("span", { class: "pill outline", text: `${plural(t.records, "record")} · ${plural(refusals, "refusal")}` }),
      t.unreadable ? h("span", { class: "pill outline bad", text: `${t.unreadable} unreadable line(s)` }) : null),
    timelinePanel(t),
    h("section", { class: "twocol", "aria-live": "polite" }, detailPanel(t), endPanel(t)),
    stepsList(t),
  ];
}
function segmentsOf(t) {
  // Runs of consecutive tool calls by one role. A call's record is written when
  // it ends, so a run starts where the record before it ended.
  const segs = [];
  let prevT = 0;
  let cur = null;
  for (const e of t.events) {
    if (e.kind === "tool_call") {
      if (!cur || cur.role !== e.role) {
        cur = { id: `s${e.seq}`, role: e.role, a: prevT ?? 0, b: e.t ?? prevT, calls: [] };
        segs.push(cur);
      }
      cur.calls.push(e);
      cur.b = e.t ?? cur.b;
    } else if (e.kind === "turn" || e.kind === "chain_stage") {
      cur = null;
    }
    if (e.t !== null && e.t !== undefined) prevT = e.t;
  }
  for (const g of segs) {
    const counts = {};
    for (const c of g.calls) counts[c.tool || c.kind] = (counts[c.tool || c.kind] || 0) + 1;
    g.label = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(" · ");
    g.steps = g.calls.map((c) => c.seq);
  }
  return segs;
}
function pinsOf(t) {
  return t.events
    .filter((e) => (e.kind === "tool_call" && e.bucket === "refusal") || e.kind === "guard" || (e.kind === "approval" && e.decision))
    .map((e) => ({
      id: `g${e.seq}`, role: e.role, t: e.t ?? 0, e,
      refused: e.kind === "approval" ? e.decision !== "approved" : e.kind === "guard" ? e.decision !== "allow" : true,
      steps: [e.seq],
    }));
}
function timelinePanel(t) {
  const total = Math.max(t.duration_s || 0, ...t.events.map((e) => e.t || 0), 1);
  const at = (x) => `${Math.min(100, Math.max(0, ((x || 0) / total) * 100)).toFixed(2)}%`;
  const step = niceStep(total);
  const ticks = [];
  for (let x = 0; x <= total + 1e-9; x += step) ticks.push(x);
  const segs = segmentsOf(t);
  const pins = pinsOf(t);
  const select = (id) => () => { S.sel = S.sel === id ? null : id; render(); };
  const laneRow = (lane) => {
    const mine = segs.filter((g) => g.role === lane.role);
    const minePins = pins.filter((g) => g.role === lane.role);
    const tokens = !lane.turns ? "no turn record of its own" : lane.tokens_in === null && lane.tokens_out === null ? "tokens unmetered" : `${compact((lane.tokens_in || 0) + (lane.tokens_out || 0))} tokens`;
    return h("div", { class: "lanerow" },
      h("div", { class: "lanehead" },
        h("span", { class: "name" }, h("span", { class: `dot ${lane.locality}` }), `${lane.role} · ${lane.locality}`),
        h("span", { class: "sub", text: `${lane.model || "model not recorded"}${lane.endpoint ? " · " + lane.endpoint : ""}${lane.from === "surface" ? " (per the current surface)" : ""}` }),
        h("span", { class: "tiny", text: `${tokens} · ${plural(lane.tool_calls, "tool call")}` })),
      h("div", { class: "track" },
        ticks.map((x) => h("span", { class: "gridline", "aria-hidden": "true", style: { left: at(x) } })),
        mine.map((g) => h("button", {
          type: "button", class: `seg ${lane.locality}`, "aria-pressed": S.sel === g.id ? "true" : "false",
          "aria-label": `${lane.role}: ${g.label}, ${secs(g.a)} to ${secs(g.b)}`,
          style: { left: at(g.a), width: `max(28px, calc(${at(g.b - g.a)}))` },
          onClick: select(g.id),
        }, g.label)),
        minePins.map((g) => [
          h("span", { class: `pinline ${g.refused ? "refused" : "allowed"}`, "aria-hidden": "true", style: { left: at(g.t) } }),
          h("button", {
            type: "button", class: "pin", "aria-pressed": S.sel === g.id ? "true" : "false",
            "aria-label": `${g.refused ? "Refused" : "Allowed"}: ${g.e.tool || g.e.kind} ${g.e.target || ""}, at ${secs(g.t)}`,
            style: { left: at(g.t) }, onClick: select(g.id),
          }, h("span", { class: `disc ${g.refused ? "refused" : "allowed"}` }, mark(!g.refused))),
        ])));
  };
  return h("section", { class: "panel", "aria-labelledby": "tl-h" },
    h("div", { class: "sechead" }, h("h2", { id: "tl-h", text: `Timeline · ${secs(total)}` }), h("span", { class: "muted small", text: "Choose a block or a marker to see what happened" })),
    t.lanes.length
      ? h("div", { class: "scrollx" }, h("div", { class: "timeline" },
        h("div", { class: "lanerow" }, h("div", { class: "lanehead" }), h("div", { class: "axis", "aria-hidden": "true" }, ticks.map((x) => h("span", { style: { left: at(x) }, text: step >= 1 ? `${Math.round(x)} s` : secs(x) })))),
        t.lanes.map(laneRow)))
      : h("p", { class: "empty", text: "No role acted in this trail: it records a governance command, not a working session." }),
    h("div", { class: "legend" },
      h("span", null, h("span", { class: "sw cloud" }), "cloud model"),
      h("span", null, h("span", { class: "sw local" }), "local model"),
      h("span", null, mark(false), "refused (rule, gate or a person)"),
      h("span", null, mark(true), "approved / allowed"),
      h("span", { text: "Blocks: consecutive tool calls by one role" })));
}
function detailPanel(t) {
  const segs = segmentsOf(t);
  const pins = pinsOf(t);
  const sel = segs.find((g) => g.id === S.sel) || pins.find((g) => g.id === S.sel) || pins.find((g) => g.refused) || segs[0];
  if (!sel) return h("div", { class: "panel" }, h("h2", { text: "Nothing to inspect" }), h("p", { class: "muted", text: "This trail has no tool calls or decisions." }));
  if (sel.calls) {
    return h("div", { class: "panel" },
      h("div", null, h("span", { class: "muted small", text: `${sel.role} · +${secs(sel.a)} to +${secs(sel.b)}` }), h("h2", { text: sel.label })),
      h("ul", { class: "clauses" }, sel.calls.map((c) => h("li", null,
        h("span", { class: "c" }, h("span", { class: "chip", text: c.tool }), h("span", { class: "mono small", text: c.target || c.summary })),
        h("span", { class: `f ${outcomeClass(c)}`, text: outcomeText(c) })))),
      h("p", { class: "muted small", text: "Tokens are metered per turn, not per tool call, so this block carries none of its own." }));
  }
  const e = sel.e;
  const idx = t.events.indexOf(e);
  const next = t.events.slice(idx + 1).find((x) => x.kind === "tool_call" || x.kind === "turn");
  return h("div", { class: "panel" },
    h("div", null, h("span", { class: "muted small", text: `${e.kind === "approval" ? "Approval" : e.kind === "guard" ? "Guard decision" : "Policy decision"} · ${e.role || "–"} · +${secs(e.t)}` }),
      h("h2", { text: `${sel.refused ? "Refused" : "Approved"}: ${e.tool || e.kind}` })),
    h("dl", { class: "stack" },
      h("div", null, h("dt", { text: "Call" }), h("dd", { class: "well", text: `${e.tool || ""} ${e.target || e.summary || ""}`.trim() || "–" })),
      h("div", null, h("dt", { text: "Rule" }), h("dd", { class: "well", text: e.rule ? `${e.rule}${e.pattern ? ` (${e.pattern})` : ""}` : e.kind === "approval" ? `approval gate · decided by ${e.by || "–"}` : "no rule named in the record" })),
      h("div", null, h("dt", { text: "Recorded" }), h("dd", { class: sel.refused ? "bad" : "ok", text: e.kind === "approval" ? e.decision : `${e.summary || e.decision || ""}${e.bucket ? ` · bucket ${e.bucket}` : ""}${e.code !== null && e.code !== undefined ? `, code ${e.code}` : ""}` })),
      h("div", null, h("dt", { text: "What happened next" }), h("dd", { text: next ? `${next.kind === "turn" ? "the turn ended" : `${next.role} · ${next.tool} ${next.target || ""}`} (+${secs(next.t)})` : "nothing after it in this trail" }))),
    h("div", { class: "row" }, e.tool && e.role
      ? plainCommand("Ask the guard again", `gnomon guard --role ${e.role} --tool ${e.tool} --input '{…}'`, "Planned. `gnomon guard` decides one call by this surface's rules; the dashboard will run it from here in a later PR.")
      : null));
}
const outcomeText = (e) => {
  if (e.kind === "approval") return `${e.decision} by ${e.by}`;
  if (e.kind === "guard") return `${e.decision}${e.rule ? " · " + e.rule : ""}`;
  if (e.kind === "turn") return `${e.stop_reason} · ${e.bucket}`;
  if (e.kind === "chain_stage") return `stage ${e.stage}/${e.of} · ${e.stop_reason || e.bucket}`;
  if (e.kind === "check") return `exit ${e.exit}`;
  if (e.bucket === "refusal") return `refused${e.rule ? " · " + e.rule : ""}`;
  return e.bucket ? `${e.bucket}${e.code ? " · " + e.code : ""}` : e.kind;
};
const outcomeClass = (e) =>
  (e.kind === "approval" && e.decision !== "approved") || e.bucket === "refusal" || (e.kind === "guard" && e.decision !== "allow") ? "bad"
    : e.bucket === "result" || e.decision === "approved" || e.decision === "allow" ? "ok" : "muted";
function endPanel(t) {
  const turns = t.turns;
  const L = turns.filter((x) => x.locality === "local").reduce((n, x) => n + (x.tokens_in || 0) + (x.tokens_out || 0), 0);
  const C = turns.filter((x) => x.locality === "cloud").reduce((n, x) => n + (x.tokens_in || 0) + (x.tokens_out || 0), 0);
  const v = S.verify[`${S.pid}:${t.name}`];
  const vt = v?.trails?.[0];
  return h("div", { class: "panel" },
    h("h2", { text: t.end ? "How the session ended" : "What this trail records" }),
    t.end
      ? facts([
        ["Stop reason", h("span", { class: "mono", text: t.end.stop_reason || "–" })],
        ["Bucket", h("span", null, h("span", { class: "mono", text: t.end.bucket || "–" }), t.end.code !== null ? ` (exit ${t.end.code})` : "")],
        ["Turns", fmtN(turns.length)],
        ["Session time", secs(t.duration_s)],
        ["Tokens", turns.some((x) => x.tokens_in !== null || x.tokens_out !== null) ? `${compact(L)} local · ${compact(C)} cloud` : "unmetered"],
        ["Spend", "not recorded"],
      ])
      : facts(Object.entries(t.kinds).map(([k, n]) => [k, fmtN(n)])),
    t.end ? h("p", { class: "muted small", text: "The bucket and the stop reason are kept side by side, never folded into one score: a turn can answer and still carry a refusal on the way." }) : null,
    t.end && L + C ? h("div", null, h("div", { class: "splitlegend" }, h("span", { text: `Local ${compact(L)} · ${pct(L, L + C)}%` }), h("span", { text: `Cloud ${compact(C)} · ${pct(C, L + C)}%` })), split(L, C)) : null,
    h("div", { class: "cardfoot" },
      h("button", { type: "button", class: "btn primary", text: "Verify this trail", onClick: () => verifyNow(t.name) }),
      plainCommand("Open the full trail", `gnomon audit show --json`, "Planned: `audit show` gains --json in a later PR (#105 step 7). The steps below are this trail's records.")),
    vt ? h("p", { class: "status" }, mark(vt.ok && vt.sealed),
      h("span", { text: `${vt.ok ? "Chain intact" : `Chain BROKEN at seq ${vt.broken.join(", ")}`}: ${vt.records} records${vt.sealed ? ", sealed" : ", NOT sealed"}. Anchor: ${vt.attestation ? vt.attestation.status : "not checked"}${vt.attestation && !vt.attestation.declared ? " (no [audit.attest] signer declared, so a full re-chain would pass)" : ""}.` })) : null);
}
function stepsList(t) {
  const segs = segmentsOf(t);
  const pins = pinsOf(t);
  const sel = segs.find((g) => g.id === S.sel) || pins.find((g) => g.id === S.sel);
  const inSel = (seq) => Boolean(sel && sel.steps.includes(seq));
  const owner = (seq) => (pins.find((g) => g.steps.includes(seq)) || segs.find((g) => g.steps.includes(seq)))?.id;
  const all = t.events;
  const showAll = S.open[`steps:${t.name}`];
  const shown = showAll ? all : all.slice(0, 300);
  const laneOf = (role) => t.lanes.find((l) => l.role === role);
  return h("section", { "aria-labelledby": "steps-h" },
    h("div", { class: "sechead" }, h("h2", { id: "steps-h", text: `The ${plural(all.length, "record")}` }), h("span", { class: "muted small", text: "Times from the session start. Metadata only: prompt and output text are not shown." })),
    h("ol", { class: "steps" }, shown.map((e) => h("li", null, h("button", {
      type: "button", class: `steprow${inSel(e.seq) ? " sel" : ""}`,
      onClick: () => { const id = owner(e.seq); if (id) { S.sel = id; render(); } },
    },
    h("span", { class: "n", text: `#${e.seq}` }),
    h("span", { class: "t", text: e.t === null ? "–" : `+${secs(e.t)}` }),
    h("span", { class: "lane" }, h("span", { class: `dot ${laneOf(e.role)?.locality || "unknown"}` }), e.role || "–"),
    h("span", { class: "chip", text: e.kind === "tool_call" ? e.tool : e.kind }),
    h("span", { class: "what", text: e.kind === "turn" ? `${e.model || ""} · ${e.tokens_in ?? "?"} in / ${e.tokens_out ?? "?"} out · ${ms(e.duration_ms)}` : e.target || e.summary || "" }),
    h("span", { class: `out ${outcomeClass(e)}`, text: outcomeText(e) }))))),
    all.length > shown.length ? h("button", { type: "button", class: "btn", text: `Show all ${fmtN(all.length)}`, onClick: () => { S.open[`steps:${t.name}`] = true; render(); } }) : null);
}

// ── 4. Governance ───────────────────────────────────────────────────────────
const RULE_TEXT = {
  tools: "The role was not given this tool",
  malformed: "Arguments that are not the tool's",
  bash_deny: "Commands no role may run",
  bash_allow: "Only the listed commands",
  sudo: "No sudo on the host",
  sandbox: "Stay inside the workspace",
  surface: "Nobody edits .gnomon/",
  record: "Nobody writes gnomon's own records",
  write_allow: "Writes only where the role may",
  network: "No network from tools",
  url: "Only public http(s) URLs",
  approval: "The approval gate asks a person",
};
function governanceScreen(d) {
  const max = Math.max(1, ...d.rules.map((r) => r.refused + r.asked), d.unnamed.count);
  const ruleRow = (key, name, cfg, n, nText, examples) => {
    const open = Boolean(S.open[`rule:${key}`]);
    return h("div", null,
      h("button", { type: "button", class: "rulebtn", "aria-expanded": open ? "true" : "false", onClick: () => { S.open[`rule:${key}`] = !open; render(); } },
        h("span", { class: "name" }, h("span", null, name, key === "unnamed" ? null : [" ", h("span", { class: "chip", text: key })]), h("span", { class: "cfg", text: cfg || "fixed by gnomon" })),
        h("span", { class: "count" }, h("span", { class: "meter", "aria-hidden": "true" }, h("span", { style: { width: `${(n / max) * 100}%` } })), h("span", { text: nText }))),
      open ? h("div", { class: "ruledetail" },
        examples.length
          ? h("ul", null, examples.map((x) => h("li", { text: `${x.role || "–"} · ${x.tool} ${x.target || x.summary}   (${x.trail}:${x.seq}${x.source === "guard" ? ", gnomon guard" : ""})` })))
          : h("p", { class: "muted small", text: "Nothing refused under this rule in this project's records." })) : null);
  };
  const totalRefused = d.rules.reduce((n, r) => n + r.refused + r.asked, 0);
  const v = S.verify[`${S.pid}:*`];
  const a = d.audit;
  return [
    header("Governance", "What the policy allowed, and what it stopped",
      "gnomon's tools check every call against the rules in .gnomon/ before it runs, `gnomon guard` asks the same of another harness, and `gnomon check` judges a change afterwards. All three write to the hash-chained trail this page reads.",
      actionButton("check.run", "Check this branch", { fill: { rev: "origin/master" }, primary: true, big: true })),
    h("section", { "aria-labelledby": "map-h" },
      h("div", { class: "sechead" }, h("h2", { id: "map-h", text: "The policy, and what each rule stopped" }),
        h("span", { class: "muted small", text: `${fmtN(totalRefused)} refused by a named rule · ${fmtN(d.unnamed.count)} with none named · ${fmtN(d.approvals.approved)} approved, ${fmtN(d.approvals.declined)} declined at the gate` })),
      h("div", { class: "rules" },
        d.rules.map((r) => ruleRow(r.rule, RULE_TEXT[r.rule] || r.rule, r.declared.join(" · "), r.refused + r.asked,
          r.refused + r.asked ? `${fmtN(r.refused)} refused${r.asked ? ` · ${fmtN(r.asked)} asked` : ""}` : "nothing refused", r.examples)),
        ruleRow("unnamed", "Refused, no rule in the record", "a delegation refused, a sub-turn that ended refused, a person saying no", d.unnamed.count,
          d.unnamed.count ? `${fmtN(d.unnamed.count)} refused` : "none", d.unnamed.examples)),
      h("p", { class: "muted small", text: "Rule names are the published set (CONTRACTS §10). A refusal whose record names no rule is counted apart, never guessed into one." })),
    h("div", { class: "twocol" },
      h("section", { class: "panel", "aria-labelledby": "chain-h" },
        h("h2", { id: "chain-h", text: "Audit chain" }),
        h("p", { class: "muted small", text: `${a.enabled ? "Recording" : "Off in this surface"} · ${plural(a.trails, "trail")}, ${plural(a.records, "record")} in ${a.dir} · ${a.attest_declared ? "an [audit.attest] signer is declared" : "no external attestation declared"}` }),
        v
          ? h("p", { class: "status" }, mark(v.exit === 0), h("span", { text: verifySummary(v) + (v.trails.some((x) => !x.sealed) ? ". An unsealed trail was cut short or killed; the chain cannot tell which." : "") }))
          : h("p", { class: "muted", text: "Not verified in this tab yet." }),
        a.newest ? h("div", { class: "chain", role: "list", "aria-label": `Last records of ${a.newest.name}` },
          a.newest.tail.map((c) => h("span", { class: "link", role: "listitem" }, h("span", { text: `#${c.seq} ${c.kind}` }), h("span", { class: "h", text: c.hash ? short(c.hash) : "unchained" })))) : null,
        h("p", { class: "muted small", text: "Each record carries the hash of the one before it, so an edit, deletion or reordering breaks the chain. Known limit: rewriting and re-chaining every record passes this check; an [audit.attest] signer catches that." }),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn primary", text: v ? "Verify again" : "Verify chain", onClick: () => verifyNow() }),
          h("a", { class: "btn", href: `#/session/${S.pid}` }, "Open the timeline"))),
      trustPanel(d.trust)),
    h("section", { "aria-labelledby": "chk-h" },
      h("div", { class: "sechead" }, h("h2", { id: "chk-h", text: "Check verdicts" }), h("span", { class: "muted small", text: "`gnomon check` on changes another harness made; exit 0 held, 2 a check failed, 10 no verdict" })),
      d.checks.length
        ? h("ul", { class: "clauses" }, d.checks.map((c) => h("li", null,
          h("span", { class: "c" },
            h("span", null, h("strong", { class: c.exit === 0 ? "ok" : c.exit === 2 ? "bad" : "muted", text: c.exit === 0 ? "held" : c.exit === 2 ? "a check failed" : "no verdict" }), ` · exit ${c.exit} · role ${c.role || "–"}`),
            h("span", { class: "muted small mono", text: `${c.base_given || short(c.base)} → ${c.head === "worktree" ? "worktree" : short(c.head)} · ${when(c.ts)}` })),
          h("span", { class: "verdicts" }, c.checks.map((k) => h("span", { class: `chip ${k.status === "pass" ? "ok" : k.status === "fail" || k.status === "error" ? "bad" : "muted"}`, title: k.reason || "", text: `${k.id}: ${k.status}` }))))))
        : h("p", { class: "empty", text: "No `gnomon check` verdicts recorded in this project." })),
    h("section", { "aria-labelledby": "guard-h" },
      h("h2", { id: "guard-h", text: "Guard another coding agent" }),
      h("p", { class: "lede", text: "`gnomon guard` decides another harness's tool calls against this same policy, before they run. Each button is the command that prints its hook; add --write to install it." }),
      h("div", { class: "row" },
        ["claude-code", "opencode", "cursor"].map((x) => actionButton("guard.install", { "claude-code": "Claude Code", opencode: "OpenCode", cursor: "Cursor" }[x], { fill: { harness: x } })))),
  ];
}
function trustPanel(tr) {
  const status = { default: "Grants nothing beyond gnomon's defaults: never asks", trusted: `Trusted (${tr.via === "store:covered" ? "no looser than a surface trusted here" : tr.via})`, untrusted: "Not trusted: a terminal session asks; a headless run is clamped to the defaults" }[tr.status];
  return h("section", { class: "panel", "aria-labelledby": "trust-h" },
    h("h2", { id: "trust-h", text: "Trust on this machine" }),
    h("p", { class: `status ${tr.status === "untrusted" ? "bad" : ""}` }, mark(tr.status !== "untrusted"), status),
    tr.grants.length
      ? h("div", { class: "tablebox" }, h("table", null,
        h("thead", null, h("tr", null, ["What", "This surface grants", "Default", ""].map((x) => h("th", { scope: "col", text: x })))),
        h("tbody", null, tr.grants.map((g) => h("tr", null, h("th", { scope: "row", text: g.subject }), h("td", { text: g.grants }), h("td", { class: "muted", text: g.default }), h("td", { class: g.new ? "bad" : "muted", text: g.new ? "new" : "" }))))))
      : null,
    h("p", { class: "muted small", text: tr.store.length ? `Trusted here before: ${tr.store.map((e) => `${short(e.surface_hash)} (${e.at.slice(0, 10)}, ${e.by})`).join(", ")}. The store keeps hashes and grants, not file lists, so it can say which grants are new, not which file changed.` : "Nothing trusted for this project in the store." }),
    h("div", { class: "row" }, actionButton("trust.grant", "Grant trust"), actionButton("trust.revoke", "Revoke")));
}

// ── 5. Contracts ────────────────────────────────────────────────────────────
function contractsScreen(d) {
  const verify = d.verify.declared
    ? `[verify] ${d.verify.command} (after ${d.verify.after}${d.verify.test_must_fail_first ? ", a new test must fail first" : ""})`
    : "No [verify] declared: a turn that ends \"done\" is not checked by the project's own tests.";
  const proj = h("section", { class: "panel", "aria-labelledby": "pv-h" },
    h("h2", { id: "pv-h", text: "This project's own gate" }),
    h("p", { class: d.verify.declared ? "well" : "empty", text: verify }));
  if (!d.source.available) {
    return [
      header(`Contracts · ${d.harness}`, "What's verified about this harness", "gnomon publishes what it promises: exit codes, record shapes, the surface hash. The recorded property-suite results and the contracts document ship with the source repository, not the npm package, so this install shows the build only."),
      proj,
      h("p", { class: "empty", text: "Run the dashboard from a gnomon checkout to see the property suites, test counts and contract clauses, or read docs/CONTRACTS.md on GitHub." }),
    ];
  }
  const dots = (s) => {
    const n = Math.min(s.total || 0, 24);
    const zero = s.id === "silent-success";
    return h("div", { class: "dots", "aria-hidden": "true" }, Array.from({ length: n }, (_, i) => h("span", { class: zero ? (i < (s.hit || 0) ? "miss" : "zero") : i < (s.hit || 0) ? "good" : "miss" })));
  };
  const t = d.tests;
  const maxT = t ? Math.max(t.core, t.cli, t.natives, t.tui, t.rust) : 1;
  return [
    header(`Contracts · ${d.harness}`, "What's verified about this harness",
      "gnomon publishes what it promises: exit codes, record shapes, the surface hash. Property suites test the promises with no model in the loop, and CI holds each suite to its published figure.",
      plainCommand("Run full CI", ".gnomon/ci.sh", "Planned. The gate runs from the gnomon repository: build, every test, fixtures, property suites (minutes)."),
      plainCommand("Run property suites", "node scripts/property_suites.mjs", "Planned. About 20 s; this page never runs them on load.")),
    h("section", { "aria-labelledby": "ps-h" },
      h("div", { class: "sechead" }, h("h2", { id: "ps-h", text: "Property suites, last recorded" }), h("span", { class: "muted small", text: "From the result files committed in the repository; CI re-runs them on every change" })),
      h("div", { class: "cards" }, d.suites.map((s) => h("article", { class: "card" },
        h("div", { class: "cardhead wrapping" }, h("h3", { text: s.name }),
          h("span", { class: "pill" }, mark(s.matches_published), s.matches_published ? "at its published figure" : "differs from published")),
        h("p", { class: "muted small", text: s.question }),
        h("div", { class: "figure" }, h("span", { class: "big", text: s.hit === null ? "–" : fmtN(s.hit) }), h("span", { class: "muted", text: `/ ${s.total ?? "–"} ${s.unit}` }), h("span", { class: "muted small", text: `published ${s.published}` })),
        dots(s),
        s.id === "silent-success" ? h("p", { class: "muted small", text: "Zero is the goal here: no decision point reported a false success." }) : null,
        h("p", { class: "muted tiny mono", text: s.file || "no result file found" }),
        h("div", null, plainCommand("Run this suite", "node scripts/property_suites.mjs", "Planned. All five suites run together; about 20 s."))))))
    ,
    h("div", { class: "twocol" },
      h("section", { class: "panel", "aria-labelledby": "tc-h" },
        h("div", { class: "sechead" }, h("h2", { id: "tc-h", text: "Tests" }), h("span", { class: "muted small", text: "as README states; ci.sh fails when the runners disagree" })),
        t ? [
          h("div", { class: "figure" }, h("span", { class: "big", text: fmtN(t.total) }), h("span", { class: "muted", text: `${fmtN(t.typescript)} TypeScript + ${fmtN(t.rust)} Rust` })),
          h("div", { class: "bars" }, [["core", t.core], ["cli", t.cli], ["Rust", t.rust], ["natives", t.natives], ["tui", t.tui]].map(([k, n]) => h("div", { class: "barrow" },
            h("span", { text: k }), h("span", { class: "track2", "aria-hidden": "true" }, h("span", { style: { width: `${(n / maxT) * 100}%` } })), h("span", { class: "num", text: fmtN(n) })))),
        ] : h("p", { class: "empty", text: "README's status line was not found." })),
      proj),
    h("section", { "aria-labelledby": "cl-h" },
      h("div", { class: "sechead" }, h("h2", { id: "cl-h", text: "Contract clause → what holds it" }),
        h("div", { class: "row" }, plainCommand("Print enumerations", "gnomon enumerations --json"), plainCommand("Show surface hash", "gnomon surface"))),
      h("p", { class: "muted small", text: "Every numbered section of docs/CONTRACTS.md with a fixture, and the fixture files and tests it names. A change that breaks one fails CI before it merges." }),
      h("ul", { class: "clauses" }, d.clauses.map((c) => h("li", null,
        h("span", { class: "c" }, h("strong", { text: `§${c.section} ${c.title}` })),
        h("span", { class: "f" },
          c.fixtures.map((f) => h("span", { class: "row" }, mark(f.exists), f.path)),
          c.tests.map((x) => h("span", { class: "row", text: x }))))))),
  ];
}

// ── 6. Measurements ─────────────────────────────────────────────────────────
function measurementsScreen(d) {
  const loc = d.by_locality;
  const tokens = (k) => loc[k].in + loc[k].out;
  const L = tokens("local"), C = tokens("cloud"), U = tokens("unknown");
  const unmetered = loc.local.unmetered + loc.cloud.unmetered + loc.unknown.unmetered;
  return [
    header("Measurements", "What your turns used, and how they ended",
      `From this project's turn records: ${plural(d.turns, "turn")}. Tokens are what each backend reported; a turn whose backend reported nothing is counted as unmetered, not as zero.`,
      actionButton("setup.speed_check", "Measure this machine"),
      plainCommand("Export turn records", "gnomon audit show --json", "Planned: `audit show --json` (#105 step 7).")),
    h("div", { class: "legend" },
      h("span", null, h("span", { class: "dot local" }), h("strong", { text: "Local" }), " endpoint on this machine or its network"),
      h("span", null, h("span", { class: "dot cloud" }), h("strong", { text: "Cloud" }), " any other endpoint"),
      U ? h("span", null, h("span", { class: "dot unknown" }), h("strong", { text: "Unknown" }), " no endpoint URL recorded") : null),
    h("div", { class: "tiles" },
      tile("Turns", fmtN(d.turns), d.turns ? `${pct(d.stop_reasons.answered || 0, d.turns)}% stopped as answered` : "none recorded"),
      tile("Local share of tokens", L + C ? `${pct(L, L + C)}%` : "–", h("div", { class: "k" }, split(L, C), h("span", { text: `${compact(L)} local · ${compact(C)} cloud` }))),
      tile("Median turn, local", ms(loc.local.median_ms), `${plural(loc.local.turns, "turn")}`),
      tile("Median turn, cloud", ms(loc.cloud.median_ms), `${plural(loc.cloud.turns, "turn")}`),
      tile("Unmetered turns", fmtN(unmetered), "the backend reported no usage"),
      tile("Spend", "unknown", "no record carries a price, so not $0 either")),
    d.turns ? outcomesChart(d) : h("p", { class: "empty", text: "No turn records yet. They appear once [audit] is on and a session runs." }),
    d.by_day.length ? tokenFlowChart(d) : null,
    d.by_model.length ? modelChart(d) : null,
    d.turns ? h("section", { "aria-labelledby": "sr-h" },
      h("h2", { id: "sr-h", text: "Why turns stopped" }),
      h("div", { class: "row" }, Object.entries(d.stop_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => h("span", { class: "pill outline" }, h("span", { class: "mono", text: k }), ` ${fmtN(n)}`)))) : null,
    d.recent.length ? recentTable(d) : null,
  ];
}
function tableToggle(key) {
  const on = Boolean(S.tables[key]);
  return h("button", { type: "button", class: "btn toggle", "aria-pressed": on ? "true" : "false", text: on ? "Show as chart" : "Show as table", onClick: () => { S.tables[key] = !on; render(); } });
}
let tipEl = null;
function tip(evt, text) {
  if (!tipEl) {
    tipEl = h("div", { class: "tip", role: "tooltip" });
    document.body.append(tipEl);
  }
  if (!text) { tipEl.style.display = "none"; return; }
  tipEl.textContent = text;
  tipEl.style.display = "block";
  const x = Math.min(evt.clientX + 14, window.innerWidth - 300);
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${evt.clientY + 14}px`;
}
const hover = (text) => ({ onMousemove: (e) => tip(e, text), onMouseleave: (e) => tip(e, null), onFocus: (e) => { const r = e.target.getBoundingClientRect(); tip({ clientX: r.left, clientY: r.bottom }, text); }, onBlur: (e) => tip(e, null), tabindex: "0" });
// Charts are drawn at the width they will occupy, so their 12px text stays 12px.
function chartW() {
  const wrap = document.querySelector(".wrap");
  if (!wrap) return 720;
  const pad = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
  return Math.max(300, Math.floor(wrap.clientWidth - 2 * pad - 42));
}
function outcomesChart(d) {
  const rows = ["local", "cloud", "unknown"].filter((k) => d.by_locality[k].turns > 0);
  const W = chartW(), rowH = 44, labelW = 80, gap = 2;
  const H = rows.length * rowH + 8;
  const plot = W - labelW - 80;
  const body = S.tables.outcomes
    ? h("div", { class: "tablebox" }, h("table", null, h("caption", { text: "Turn outcomes by where the turn ran" }),
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Where" }), BUCKETS.map((b) => h("th", { scope: "col", class: "num", text: BUCKET_LABEL[b] })), h("th", { scope: "col", class: "num", text: "answered" }))),
      h("tbody", null, rows.map((k) => h("tr", null, h("th", { scope: "row", text: k }), BUCKETS.map((b) => h("td", { class: "num", text: fmtN(d.by_locality[k].buckets[b]) })), h("td", { class: "num", text: fmtN(d.by_locality[k].answered) }))))))
    : s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Turn outcomes by locality: ${rows.map((k) => `${k} ${BUCKETS.map((b) => `${d.by_locality[k].buckets[b]} ${BUCKET_LABEL[b]}`).join(", ")}`).join("; ")}` },
      rows.map((k, i) => {
        const r = d.by_locality[k];
        const total = r.turns;
        let x = labelW;
        const y = i * rowH + 10;
        const marks = [];
        for (const b of BUCKETS) {
          const n = r.buckets[b];
          if (!n) continue;
          const w = Math.max(2, (n / total) * plot - gap);
          marks.push(s("rect", { class: `m-${b}`, x, y, width: w, height: 22, rx: 4 }));
          if (w > 44) marks.push(s("text", { x: x + 8, y: y + 15, class: "", style: { fill: b === "result" ? "#171613" : b === "refusal" ? "#171613" : "#ECE7DC" }, text: fmtN(n) }));
          marks.push(s("rect", { class: "hit", x, y: y - 4, width: w + gap, height: 30, ...hover(`${k}: ${fmtN(n)} ${BUCKET_LABEL[b]} of ${fmtN(total)} turns (${pct(n, total)}%)`) }));
          x += w + gap;
        }
        return s("g", null, s("text", { x: 0, y: y + 15, class: "ink", text: `${k}` }), ...marks, s("text", { x: W, y: y + 15, "text-anchor": "end", text: `${fmtN(total)} turns` }));
      }));
  return h("section", { "aria-labelledby": "oc-h" },
    h("div", { class: "sechead" }, h("div", null, h("h2", { id: "oc-h", text: "How turns ended, by where they ran" }),
      h("p", { class: "muted small", text: "Each turn's recorded bucket. Three buckets side by side, never one score." })), tableToggle("outcomes")),
    h("div", { class: "legend" }, BUCKETS.map((b) => h("span", null, h("span", { class: `sw ${b}` }), BUCKET_LABEL[b]))),
    h("div", { class: "panel" }, body));
}
function tokenFlowChart(d) {
  const days = d.by_day;
  const W = chartW(), H = 240, left = 48, bottom = 28, top = 10;
  const max = Math.max(1, ...days.map((x) => x.local + x.cloud + x.unknown));
  const stepRaw = max / 4;
  const p10 = Math.pow(10, Math.floor(Math.log10(stepRaw)));
  const step = [1, 2, 5, 10].map((m) => m * p10).find((x) => x >= stepRaw);
  const yMax = Math.ceil(max / step) * step;
  const ph = H - bottom - top;
  const band = (W - left) / days.length;
  const bw = Math.min(24, band * 0.7);
  const y = (v) => top + ph - (v / yMax) * ph;
  const body = S.tables.flow
    ? h("div", { class: "tablebox" }, h("table", null, h("caption", { text: "Tokens per day (in + out), by locality" }),
      h("thead", null, h("tr", null, ["Day", "Local", "Cloud", "Unknown"].map((x, i) => h("th", { scope: "col", class: i ? "num" : null, text: x })))),
      h("tbody", null, days.map((x) => h("tr", null, h("th", { scope: "row", text: x.day }), h("td", { class: "num", text: fmtN(x.local) }), h("td", { class: "num", text: fmtN(x.cloud) }), h("td", { class: "num", text: fmtN(x.unknown) }))))))
    : s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Tokens per day, ${days.length} days, peak ${compact(max)}` },
      Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step).map((v) => s("g", null,
        s("line", { class: "gridl", x1: left, x2: W, y1: y(v), y2: y(v) }),
        s("text", { x: left - 6, y: y(v) + 4, "text-anchor": "end", text: compact(v) }))),
      days.map((x, i) => {
        const cx = left + band * i + (band - bw) / 2;
        let acc = 0;
        const parts = [];
        for (const k of ["local", "cloud", "unknown"]) {
          const v = x[k];
          if (!v) continue;
          const y0 = y(acc), y1 = y(acc + v);
          const hgt = Math.max(1, y0 - y1 - (acc ? 2 : 0));
          parts.push(s("rect", { class: `m-${k}`, x: cx, y: y1, width: bw, height: hgt, rx: 3 }));
          acc += v;
        }
        const label = i === 0 || i === days.length - 1 || days.length <= 8 || i % Math.ceil(days.length / 6) === 0;
        return s("g", null, ...parts,
          label ? s("text", { x: cx + bw / 2, y: H - 8, "text-anchor": "middle", text: x.day.slice(5) }) : null,
          s("rect", { class: "hit", x: left + band * i, y: top, width: band, height: ph, ...hover(`${x.day}: ${compact(x.local)} local · ${compact(x.cloud)} cloud${x.unknown ? ` · ${compact(x.unknown)} unknown` : ""}`) }));
      }));
  return h("section", { "aria-labelledby": "tf-h" },
    h("div", { class: "sechead" }, h("div", null, h("h2", { id: "tf-h", text: "Token flow by day" }), h("p", { class: "muted small", text: `Input plus output tokens the backends reported, last ${plural(days.length, "day")} with turns` })), tableToggle("flow")),
    h("div", { class: "legend" }, ["local", "cloud", "unknown"].map((k) => h("span", null, h("span", { class: `sw ${k}` }), k))),
    h("div", { class: "panel" }, body));
}
function modelChart(d) {
  const ms_ = d.by_model.slice(0, 12);
  const max = Math.max(1, ...ms_.map((m) => m.tokens_in + m.tokens_out));
  const W = chartW(), rowH = 34, labelW = Math.min(230, Math.round(W * 0.34));
  const H = ms_.length * rowH + 6;
  const plot = W - labelW - 80;
  const body = S.tables.models
    ? h("div", { class: "tablebox" }, h("table", null, h("caption", { text: "Tokens by model" }),
      h("thead", null, h("tr", null, ["Model", "Where", "Turns", "In", "Out", "Unmetered"].map((x, i) => h("th", { scope: "col", class: i > 1 ? "num" : null, text: x })))),
      h("tbody", null, d.by_model.map((m) => h("tr", null, h("th", { scope: "row", class: "mono", text: m.model }), h("td", { text: m.locality }), h("td", { class: "num", text: fmtN(m.turns) }), h("td", { class: "num", text: fmtN(m.tokens_in) }), h("td", { class: "num", text: fmtN(m.tokens_out) }), h("td", { class: "num", text: fmtN(m.unmetered) }))))))
    : s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Tokens by model: ${ms_.map((m) => `${m.model} ${compact(m.tokens_in + m.tokens_out)}`).join(", ")}` },
      ms_.map((m, i) => {
        const v = m.tokens_in + m.tokens_out;
        const w = Math.max(2, (v / max) * plot);
        const yy = i * rowH + 6;
        const fit = Math.max(8, Math.floor(labelW / 7.5));
        const name = m.model.length > fit ? m.model.slice(0, fit - 1) + "…" : m.model;
        return s("g", null,
          s("text", { x: 0, y: yy + 15, class: "ink", text: name }),
          s("rect", { class: `m-${m.locality}`, x: labelW, y: yy + 3, width: w, height: 18, rx: 4 }),
          s("text", { x: labelW + w + 8, y: yy + 16, text: compact(v) }),
          s("rect", { class: "hit", x: 0, y: yy, width: W, height: rowH, ...hover(`${m.model} (${m.locality}): ${fmtN(m.tokens_in)} in · ${fmtN(m.tokens_out)} out over ${plural(m.turns, "turn")}${m.unmetered ? `, ${m.unmetered} unmetered` : ""}`) }));
      }));
  return h("section", { "aria-labelledby": "md-h" },
    h("div", { class: "sechead" }, h("div", null, h("h2", { id: "md-h", text: "Tokens by model" }), h("p", { class: "muted small", text: "To price yourself: gnomon records tokens, not prices." })), tableToggle("models")),
    h("div", { class: "legend" }, ["local", "cloud"].map((k) => h("span", null, h("span", { class: `sw ${k}` }), k))),
    h("div", { class: "panel" }, body));
}
function recentTable(d) {
  const rows = d.recent.slice(-50).reverse();
  return h("section", { "aria-labelledby": "rt-h" },
    h("h2", { id: "rt-h", text: "Recent turns" }),
    h("div", { class: "tablebox" }, h("table", null,
      h("thead", null, h("tr", null, ["When", "Role", "Model", "Where", "Stop reason", "Bucket", "Time", "In", "Out"].map((x, i) => h("th", { scope: "col", class: i > 5 ? "num" : null, text: x })))),
      h("tbody", null, rows.map((t) => h("tr", null,
        h("td", { text: when(t.ts) }), h("td", { text: t.role }), h("td", { class: "mono", text: t.model }), h("td", null, h("span", { class: `dot ${t.locality}` }), ` ${t.locality}`),
        h("td", { class: "mono", text: t.stop_reason }), h("td", { text: `${t.bucket}${t.code !== null ? ` (${t.code})` : ""}` }),
        h("td", { class: "num", text: ms(t.duration_ms) }), h("td", { class: "num", text: t.tokens_in === null ? "unmetered" : fmtN(t.tokens_in) }), h("td", { class: "num", text: t.tokens_out === null ? "–" : fmtN(t.tokens_out) })))))));
}

let resizing = null;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => { if (S.meta && S.screen === "measurements") render(); }, 150);
});

signIn();
