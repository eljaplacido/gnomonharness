// gnomon dashboard v2: the shell. A Ctrl/Cmd+K palette over screens, projects,
// actions and recent sessions; the keyboard shortcuts and their `?` overlay;
// opt-in toasts for finished jobs; the light/dark/system theme.
//
// It adds no authority. An action chosen in the palette is perform(): the same
// call the button makes, so anything that writes still opens the server's
// confirmation first. Preferences (theme, toasts) live in this browser's
// localStorage and nowhere else; the page works without it.
import { S, h, api, go, load, perform, icon, ICONS, commandFor, actionOf, screenList, onAfterRender } from "/app.js";

// ── preferences (localStorage only) ─────────────────────────────────────────
const THEME_KEY = "gnomon.dashboard.theme";
const TOAST_KEY = "gnomon.dashboard.toasts";
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ }
  },
};
const THEMES = ["system", "light", "dark"];
const themeNow = () => { const v = store.get(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; };
function applyTheme() {
  const t = themeNow();
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
applyTheme();
const toastsOn = () => store.get(TOAST_KEY) === "1";
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD = isMac ? "⌘" : "Ctrl";

// ── live region for preference changes (no focus moves) ─────────────────────
let said = null;
function say(text) {
  if (!said) {
    said = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    document.body.append(said);
  }
  said.textContent = text;
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(themeNow()) + 1) % THEMES.length];
  store.set(THEME_KEY, next === "system" ? null : next);
  applyTheme();
  say(`Theme: ${next}`);
  refreshBar();
}
function toggleToasts() {
  store.set(TOAST_KEY, toastsOn() ? null : "1");
  say(`Toasts for finished jobs: ${toastsOn() ? "on" : "off"}`);
  refreshBar();
}

// ── the preferences bar in the side rail ────────────────────────────────────
let lastRoot = null;
function bar() {
  const t = themeNow();
  return h("div", { class: "shellbar", role: "group", "aria-label": "Search and preferences" },
    h("button", { type: "button", class: "btn", id: "open-palette", "aria-haspopup": "dialog", onClick: () => openPalette() }, h("span", null, "Search"), h("kbd", { text: `${MOD} K` })),
    h("button", { type: "button", class: "btn", "aria-label": `Theme: ${t}. Press to change.`, onClick: cycleTheme }, h("span", { text: `Theme: ${t}` }), icon(ICONS.setup, 16)),
    h("button", { type: "button", class: "btn", "aria-pressed": toastsOn() ? "true" : "false", title: "A small notice when a job finishes. It never takes focus.", onClick: toggleToasts }, h("span", { text: `Toasts: ${toastsOn() ? "on" : "off"}` })),
    h("button", { type: "button", class: "btn", "aria-haspopup": "dialog", onClick: () => openHelp() }, h("span", null, "Keyboard shortcuts"), h("kbd", { text: "?" })));
}
function refreshBar() {
  if (!lastRoot) return;
  const old = lastRoot.querySelector(".shellbar");
  if (!old) return;
  // Keep the keyboard where it was: the bar is rebuilt under it.
  const at = [...old.children].indexOf(document.activeElement);
  const fresh = bar();
  old.replaceWith(fresh);
  if (at >= 0) fresh.children[at].focus();
}
onAfterRender((root) => {
  lastRoot = root;
  const side = root.querySelector(".side");
  if (!side) return;
  const machine = side.querySelector(".machine");
  const el = bar();
  if (machine) side.insertBefore(el, machine);
  else side.append(el);
});

// ── the palette ─────────────────────────────────────────────────────────────
const extraCache = new Map();
async function extras() {
  const pid = S.pid;
  const p = S.meta && S.meta.projects.find((x) => x.id === pid);
  const out = { sessions: [], harnesses: [] };
  if (!p) return out;
  const hit = extraCache.get(pid);
  if (hit && Date.now() - hit.at < 15000) return hit.out;
  const [sessions, setup] = await Promise.all([
    p.hasSurface ? api(`/api/p/${pid}/sessions`).catch(() => null) : null,
    api(`/api/setup?project=${pid}`).catch(() => null),
  ]);
  if (sessions && sessions.trails) out.sessions = sessions.trails.slice(0, 8);
  if (setup && setup.harnesses) out.harnesses = setup.harnesses;
  extraCache.set(pid, { at: Date.now(), out });
  return out;
}
const HNAME = { "claude-code": "Claude Code", opencode: "opencode", cursor: "Cursor" };
const when = (ts) => (ts ? String(ts).replace("T", " ").slice(0, 16) : "");

/** Every entry the palette can run. An action is perform(): a write opens the server's confirmation. */
function buildItems(ex) {
  const items = [];
  const p = S.meta.projects.find((x) => x.id === S.pid);
  const act = (group, label, name, params, o = {}) => {
    const a = actionOf(name);
    if (!a || a.state !== "enabled") return;
    if (!S.pid && !o.noProject) return;
    if (o.needsSurface && !(p && p.hasSurface)) return;
    items.push({
      group, label: o.label || label, keys: `${name} ${label}`,
      hint: a.confirm === "required" ? "asks first" : "runs now",
      title: commandFor(name, params),
      run: () => perform(name, params),
    });
  };
  for (const { key, label } of screenList()) {
    items.push({ group: "Screens", label: `Go to ${label}`, keys: `${key} ${label}`, hint: "screen", run: () => go(key, S.pid) });
  }
  items.push({ group: "Screens", label: "Set up a local model (quick start)", keys: "setup quickstart local model onboarding", hint: "screen", run: () => go("setup", S.pid, "quick") });
  items.push({ group: "Screens", label: "Set up step by step (full wizard)", keys: "setup wizard choose", hint: "screen", run: () => go("setup", S.pid, "step-1") });
  items.push({ group: "Actions", label: "Add a project (gnomon init)…", keys: "init add project directory", hint: "asks first", title: "gnomon init --dir <directory>", run: () => go("setup", S.pid, "init") });
  act("Actions", "Scan this machine", "doctor.scan", {});
  act("Actions", "Verify the audit trail", "audit.verify", {}, { needsSurface: true });
  act("Actions", "Run a check against HEAD~1", "check.run", { rev: "HEAD~1" }, { needsSurface: true });
  act("Actions", "Trust this surface…", "trust.grant", {}, { needsSurface: true });
  act("Actions", "Revoke trust for this project…", "trust.revoke", {}, { needsSurface: true });
  for (const r of ex.harnesses) {
    act("Actions", `Install the guard hook for ${HNAME[r.harness] || r.harness}…`, "guard.install", { harness: r.harness }, { needsSurface: true });
    const last = items[items.length - 1];
    if (last && last.keys.includes("guard.install") && last.label.includes(HNAME[r.harness] || r.harness)) last.hint = `${r.detected ? "found here · " : ""}asks first`;
  }
  for (const t of ex.sessions) {
    items.push({
      group: "Recent sessions", label: t.opening ? `${t.opening}` : t.name, keys: `${t.name} ${t.mode} ${t.opening || ""}`,
      hint: [t.mode || "session", when(t.started)].filter(Boolean).join(" · "), title: t.name,
      run: () => go("session", S.pid, t.name),
    });
  }
  for (const pr of S.meta.projects) {
    items.push({ group: "Projects", label: `Open ${pr.name}`, keys: `${pr.name} ${pr.root}`, hint: pr.id === S.pid ? "current" : pr.root, title: pr.root, run: () => go(S.screen, pr.id) });
  }
  items.push({ group: "Preferences", label: `Theme: ${themeNow()}, switch to ${THEMES[(THEMES.indexOf(themeNow()) + 1) % 3]}`, keys: "theme dark light system appearance", hint: "this browser", run: cycleTheme });
  items.push({ group: "Preferences", label: `Toasts for finished jobs: ${toastsOn() ? "on, turn off" : "off, turn on"}`, keys: "toasts notifications", hint: "this browser", run: toggleToasts });
  items.push({ group: "Preferences", label: "Keyboard shortcuts", keys: "help keys shortcuts ?", hint: "?", run: () => setTimeout(openHelp, 0) });
  return items;
}
/** Every query word must appear in the entry; entries that start with the query come first. */
function filter(items, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored = [];
  for (const it of items) {
    const label = it.label.toLowerCase();
    const hay = `${label} ${it.keys.toLowerCase()} ${(it.hint || "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push([label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

let palette = null;
async function openPalette() {
  if (palette || !S.meta) return;
  const opener = document.activeElement;
  let items = buildItems({ sessions: [], harnesses: [] });
  let shown = items;
  let sel = 0;
  const input = h("input", {
    type: "text", role: "combobox", "aria-label": "Search screens, projects, actions and recent sessions", "aria-expanded": "true",
    "aria-controls": "pal-list", "aria-autocomplete": "list", autocomplete: "off", spellcheck: "false", placeholder: "Type to search, then Enter",
  });
  const list = h("ul", { class: "results", id: "pal-list", role: "listbox", "aria-label": "Results" });
  const dlg = h("dialog", { class: "palette", "aria-label": "Command palette" },
    h("div", { class: "pin-input" }, input),
    list,
    h("div", { class: "foot" }, h("span", null, h("kbd", { text: "↑" }), " ", h("kbd", { text: "↓" }), " choose"), h("span", null, h("kbd", { text: "Enter" }), " run"), h("span", null, h("kbd", { text: "Esc" }), " close"),
      h("span", { text: "An action that writes asks you first." })));
  const close = () => {
    if (!palette) return;
    palette = null;
    if (dlg.open) dlg.close();
    dlg.remove();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  };
  const paint = () => {
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    const rows = [];
    let group = null;
    shown.forEach((it, i) => {
      if (it.group !== group) {
        group = it.group;
        rows.push(h("li", { class: "group", role: "presentation", text: group }));
      }
      rows.push(h("li", {
        class: "opt", role: "option", id: `pal-o-${i}`, "aria-selected": i === sel ? "true" : "false", title: it.title || null,
        onMousemove: () => { if (sel !== i) { sel = i; mark(); } },
        onClick: () => run(it),
      }, h("span", { class: "lbl", text: it.label }), it.hint ? h("span", { class: "hint", text: it.hint }) : null));
    });
    if (!shown.length) rows.push(h("li", { class: "none", role: "presentation", text: "Nothing matches. Try a screen, a project, or an action such as “check”." }));
    list.replaceChildren(...rows);
    input.setAttribute("aria-activedescendant", shown.length ? `pal-o-${sel}` : "");
    scroll();
  };
  const mark = () => {
    list.querySelectorAll("li.opt").forEach((el, i) => el.setAttribute("aria-selected", i === sel ? "true" : "false"));
    input.setAttribute("aria-activedescendant", `pal-o-${sel}`);
  };
  const scroll = () => { const el = document.getElementById(`pal-o-${sel}`); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); };
  const run = (it) => {
    close();
    // After the palette is gone: an action opens its own confirmation dialog.
    setTimeout(() => { Promise.resolve(it.run()).catch(() => {}); }, 0);
  };
  input.addEventListener("input", () => { shown = filter(items, input.value); sel = 0; paint(); });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) run(shown[sel]); }
    else if (e.key === "Home" && e.ctrlKey) { sel = 0; paint(); }
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  palette = dlg;
  document.body.append(dlg);
  paint();
  dlg.showModal();
  input.focus();
  // Recent sessions and the harnesses found here arrive a moment later.
  const ex = await extras();
  if (palette === dlg) {
    items = buildItems(ex);
    shown = filter(items, input.value);
    paint();
  }
}

// ── the `?` overlay ─────────────────────────────────────────────────────────
const SHORTCUTS = [
  [[`${MOD} K`, "/"], "Open the palette: screens, projects, actions, recent sessions"],
  [["?"], "Show this list"],
  [["g", "1 … 9"], "Go to the nth screen in the side rail"],
  [["r"], "Read the current screen's records again"],
  [["Esc"], "Close a dialog or the palette; nothing runs"],
  [["Tab"], "Move through the page; the skip target is the main region"],
];
let helpOpen = null;
function openHelp() {
  if (helpOpen) return;
  const opener = document.activeElement;
  const finish = () => {
    if (!helpOpen) return;
    const d = helpOpen;
    helpOpen = null;
    d.close();
    d.remove();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  };
  const dlg = h("dialog", { class: "confirm", "aria-labelledby": "keys-h" },
    h("h2", { id: "keys-h", text: "Keyboard shortcuts" }),
    h("table", { class: "keys" },
      h("caption", { class: "sr-only", text: "Keyboard shortcuts" }),
      h("tbody", null, SHORTCUTS.map(([keys, what]) => h("tr", null,
        h("th", { scope: "row" }, keys.flatMap((k, i) => (i ? [" or ", h("kbd", { text: k })] : [h("kbd", { text: k })]))),
        h("td", { text: what }))))),
    h("p", { class: "muted small", text: "Shortcuts are off while you type in a field. A write chosen from the palette opens the same confirmation as its button." }),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", text: "Close", onClick: finish })));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  helpOpen = dlg;
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector(".btn.primary").focus();
}

// ── shortcuts ───────────────────────────────────────────────────────────────
let chord = null;
const typing = (el) => !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
document.addEventListener("keydown", (e) => {
  if (!S.meta) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (palette) return;
    if (document.querySelector("dialog[open]")) return;
    void openPalette();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (typing(e.target) || document.querySelector("dialog[open]")) return;
  if (chord) {
    clearTimeout(chord);
    chord = null;
    const n = Number(e.key);
    const screens = screenList();
    if (n >= 1 && n <= screens.length) {
      e.preventDefault();
      go(screens[n - 1].key, S.pid);
    }
    return;
  }
  if (e.key === "?") { e.preventDefault(); openHelp(); }
  else if (e.key === "/") { e.preventDefault(); void openPalette(); }
  else if (e.key === "g") chord = setTimeout(() => { chord = null; }, 1200);
  else if (e.key === "r") { e.preventDefault(); void load(true); }
});

// ── toasts for finished jobs: opt in, never move focus ──────────────────────
let host = null;
function toast(detail) {
  if (!host) {
    host = h("div", { class: "toasts", role: "region", "aria-label": "Notifications", "aria-live": "polite" });
    document.body.append(host);
  }
  const t = h("div", { class: `toast ${detail.ok ? "good" : "bad"}`, role: "status" },
    h("strong", { text: detail.ok ? "Finished" : "Did not finish" }),
    h("span", { text: detail.note || "" }),
    detail.text ? h("code", { text: detail.text }) : null,
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", text: "Dismiss", onClick: () => t.remove() })));
  host.append(t);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => t.remove(), detail.ok ? 8000 : 15000);
}
window.addEventListener("gnomon:job", (e) => {
  if (!toastsOn() || !e.detail) return;
  // The run bar already says what is running; a toast is for the end of it.
  toast(e.detail);
});
