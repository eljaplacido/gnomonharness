// gnomon dashboard v2: the read-only local chat drawer. Registers with app.js (onAfterRender).
//
// A side drawer on every project screen, not a home: it answers questions about
// the open project's own records and can run nothing (the server gives the
// model no tools). Each answer names the panels it came from, as links. It asks
// a LOCAL endpoint of the project's surface. A cloud endpoint is used only when
// the box under the question is ticked for that one question, and then the
// exact text that would leave this machine is shown and needs a Confirm.
//
// Every node is built with createElement and textContent: an answer is model
// text, so it is never parsed as HTML.
import { onAfterRender, S, h, icon, ICONS } from "/app.js";

ICONS.chat = ["M4 5h16v11H10l-5 4v-4H4z", "M8 9.5h8M8 12.5h5"];

const PANELS = {
  projects: "Projects",
  session: "Session",
  governance: "Governance",
  measurements: "Measurements",
  contracts: "Contracts",
  lens: "Lens",
};
const ASK_AGAIN = "Ask again, or more narrowly.";

const st = {
  open: false,
  pid: null,
  status: null, // GET /chat for the open project
  statusPid: null,
  convos: new Map(), // project id -> [{role, text, cites, kind, meta}]
  busy: false,
  since: 0,
  timer: null,
  cloud: false,
};
let drawer = null;
let els = null;

const turnsOf = (pid) => {
  if (!st.convos.has(pid)) st.convos.set(pid, []);
  return st.convos.get(pid);
};

// ── server ──────────────────────────────────────────────────────────────────
// Like app.js's api(), but a 4xx answer is data here (428 is the preview).
async function post(pid, body, signal) {
  const res = await fetch(`/api/p/${pid}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${S.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json || {} };
}
async function loadStatus() {
  const pid = S.pid;
  if (!pid || !S.token) return;
  const p = S.meta?.projects.find((x) => x.id === pid);
  if (!p?.hasSurface) {
    st.status = { none: true };
    st.statusPid = pid;
    return paint();
  }
  try {
    const res = await fetch(`/api/p/${pid}/chat`, { headers: { Authorization: `Bearer ${S.token}` }, cache: "no-store", credentials: "omit" });
    st.status = res.ok ? await res.json() : { error: (await res.json().catch(() => ({}))).error || `HTTP ${res.status}` };
  } catch (e) {
    st.status = { error: e.message };
  }
  st.statusPid = pid;
  paint();
}

// ── pieces ──────────────────────────────────────────────────────────────────
const lensPresent = () => Boolean(document.querySelector('a.navlink[href^="#/lens"]'));
function cite(key) {
  if (key === "lens" && !lensPresent()) return h("span", { class: "cite off", text: key });
  return h("a", { class: "cite", href: `#/${key}${st.pid ? "/" + st.pid : ""}`, title: `Go to ${PANELS[key]}`, text: key });
}
/** The answer's text, with each [panel] token turned into a link that navigates there. */
function rich(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\[([a-z][a-z, ]*)\]/g)) {
    const keys = m[1].split(",").map((k) => k.trim());
    if (!keys.every((k) => Object.hasOwn(PANELS, k))) continue;
    out.push(text.slice(last, m.index), "[");
    keys.forEach((k, i) => out.push(i ? ", " : "", cite(k)));
    out.push("]");
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
const where = (e) => `${e.local ? "Local" : "Cloud"} · ${e.model} · ${e.endpoint}`;

function bubble(t) {
  if (t.role === "user") return h("div", { class: "chat-turn user" }, h("p", { class: "chat-text", text: t.text }));
  if (t.kind === "error") {
    return h("div", { class: "chat-turn assistant" }, h("p", { class: "problem chat-text", role: "alert", text: t.text }));
  }
  if (t.kind === "note") return h("div", { class: "chat-turn note" }, h("p", { class: "muted small", text: t.text }));
  const meta = t.meta
    ? h("p", { class: "muted small mono chat-meta" },
      `${t.meta.local ? "local" : "cloud"} · ${t.meta.model} · ${(t.meta.ms / 1000).toFixed(1)} s`,
      t.meta.egress ? ` · ${t.meta.egress.recorded ? `sent ${t.meta.egress.chars} chars, recorded in ${t.meta.egress.trail}` : `sent ${t.meta.egress.chars} chars, not recorded (${t.meta.egress.reason})`}` : "")
    : null;
  return h("div", { class: `chat-turn assistant${t.kind === "withheld" ? " withheld" : ""}` },
    h("p", { class: "chat-text" }, rich(t.text)),
    t.cites?.length ? h("p", { class: "chat-cites small" }, h("span", { class: "muted", text: "Cites " }), t.cites.map((k, i) => [i ? " " : "", cite(k)])) : null,
    t.records?.length ? h("p", { class: "chat-records small" }, h("span", { class: "muted", text: "Records " }), t.records.map((r, i) => [i ? " " : "", h("code", { text: r })])) : null,
    t.raw ? h("details", { class: "chat-raw small" }, h("summary", { text: "Show what the model said anyway (uncited, so unchecked)" }), h("p", { class: "chat-text muted", text: t.raw })) : null,
    meta);
}

// ── the drawer ──────────────────────────────────────────────────────────────
function build() {
  els = {
    close: h("button", { type: "button", class: "btn chat-x", "aria-label": "Close chat", onClick: () => toggle(false) }, icon(ICONS.cross, 18)),
    where: h("p", { class: "chat-where small", role: "status" }),
    notice: h("div", { class: "chat-notice" }),
    log: h("div", { class: "chat-log", role: "log", "aria-live": "polite", "aria-label": "Conversation", tabindex: "0" }),
    think: h("p", { class: "chat-think muted", role: "status" }),
    q: h("textarea", { class: "field chat-q", rows: "3", maxlength: "2000", placeholder: "What should I look at first?", "aria-label": "Your question about this project's records" }),
    cloud: h("input", { type: "checkbox", onChange: (e) => { st.cloud = e.target.checked; paint(); } }),
    cloudNote: h("span", { class: "muted small" }),
    send: h("button", { type: "submit", class: "btn primary", text: "Ask" }),
  };
  els.q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  drawer = h("aside", { class: "chat-drawer", id: "chat-drawer", "aria-labelledby": "chat-h" },
    h("div", { class: "chat-head" },
      h("h2", { id: "chat-h", text: "Ask the records" }),
      els.close),
    h("p", { class: "muted small chat-lede", text: "Read-only. It answers from this project's recorded data and can run nothing. Each claim names the panel it came from." }),
    els.where,
    els.notice,
    els.log,
    els.think,
    h("form", { class: "chat-form", onSubmit: (e) => { e.preventDefault(); submit(); } },
      els.q,
      h("label", { class: "chat-cloud" }, els.cloud, h("span", { text: " Send to a cloud endpoint for this question" })),
      els.cloudNote,
      h("div", { class: "row" }, els.send, h("span", { class: "muted small", text: "Ctrl+Enter sends" }))));
  drawer.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]")) toggle(false);
  });
  document.body.append(drawer);
}

function paint() {
  if (!drawer) return;
  drawer.hidden = !st.open;
  document.body.classList.toggle("chat-open", st.open);
  const btn = document.getElementById("chat-toggle");
  if (btn) btn.setAttribute("aria-expanded", String(st.open));
  if (!st.open) return;
  const s = st.statusPid === S.pid ? st.status : null;
  const p = S.meta?.projects.find((x) => x.id === S.pid);

  // Where a question goes, and whether that is this machine.
  els.where.replaceChildren();
  els.notice.replaceChildren();
  let canLocal = false;
  if (!p) els.notice.append(h("p", { class: "muted small", text: "No project is selected." }));
  else if (s === null) els.where.textContent = "Checking where questions go…";
  else if (s.none) els.notice.append(h("p", { class: "muted small", text: "This project has no .gnomon/, so there are no records to ask about. `gnomon init` writes one." }));
  else if (s.error) els.notice.append(h("p", { class: "problem small", role: "alert", text: s.error }));
  else {
    if (s.local) {
      canLocal = true;
      els.where.append(h("span", { class: "pill chat-pill local", text: "Local" }), " ", h("span", { class: "mono", text: `${s.local.model} · ${s.local.endpoint}` }), h("span", { class: "muted", text: ` (role ${s.local.role}${s.local.source === "declared" ? ", chat_role" : ""})` }));
    } else {
      els.notice.append(h("div", { class: "problem small", role: "status" },
        h("p", { text: "No local endpoint is set for the chat." }),
        h("p", { class: "mono", text: s.why || "" })));
    }
  }
  const cloud = s && !s.none && !s.error ? s.cloud : null;
  els.cloud.disabled = !cloud || st.busy;
  els.cloud.checked = Boolean(cloud) && st.cloud;
  els.cloudNote.textContent = cloud
    ? st.cloud
      ? `Will ask ${cloud.model} at ${cloud.endpoint}. You see exactly what leaves first.`
      : `Off. Nothing leaves this machine. (Cloud: ${cloud.endpoint}.)`
    : "No cloud endpoint is declared, so nothing can leave this machine.";
  els.send.disabled = st.busy || !p?.hasSurface || (!canLocal && !(cloud && st.cloud));
  els.q.disabled = !p?.hasSurface;

  // The conversation.
  const turns = p ? turnsOf(p.id) : [];
  els.log.replaceChildren(...(turns.length ? turns.map(bubble) : [h("p", { class: "muted small chat-empty", text: "Try: “What was refused most, and by which rule?” or “How much ran locally versus in the cloud?”" })]));
  els.log.scrollTop = els.log.scrollHeight;
  els.think.replaceChildren(...(st.busy ? ["Thinking… ", h("span", { "aria-hidden": "true", class: "mono", text: `${Math.floor((Date.now() - st.since) / 1000)} s` })] : []));
}

function toggle(open = !st.open) {
  st.open = open;
  if (open) {
    if (!drawer) build();
    st.pid = S.pid;
    if (st.statusPid !== S.pid) st.status = null;
    paint();
    loadStatus();
    els.q.focus();
  } else {
    paint();
    document.getElementById("chat-toggle")?.focus();
  }
}

// ── asking ──────────────────────────────────────────────────────────────────
function previewDialog(r) {
  return new Promise((done) => {
    const opener = document.activeElement;
    let dlg = null;
    const finish = (yes) => {
      dlg.close();
      dlg.remove();
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
      done(yes);
    };
    const c = r.confirm;
    dlg = h("dialog", { class: "confirm", "aria-labelledby": "chat-dlg-h" },
      h("h2", { id: "chat-dlg-h", text: `Send this to ${r.endpoint}?` }),
      h("ul", { class: "effect" }, c.effect.map((e) => h("li", { text: e }))),
      h("details", { open: true },
        h("summary", { text: `Exactly what is sent (${c.chars} characters)` }),
        h("pre", { class: "chat-preview mono small", tabindex: "0", text: c.messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n") })),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary", text: "Send to the cloud", onClick: () => finish(true) }),
        h("button", { type: "button", class: "btn", text: "Cancel, keep it local", onClick: () => finish(false) })));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector(".btn.primary").focus();
  });
}

function tick() {
  if (st.busy) paint();
}

async function submit() {
  const q = els.q.value.trim();
  const pid = S.pid;
  if (!q || st.busy || !pid) return;
  const turns = turnsOf(pid);
  const history = turns.filter((t) => (t.role === "user" || t.kind === "answer" || t.kind === "notinrecords") && t.text).map((t) => ({ role: t.role, content: t.text }));
  turns.push({ role: "user", text: q });
  els.q.value = "";
  const wantCloud = st.cloud;
  st.cloud = false; // an opt-in is for one question
  st.busy = true;
  st.since = Date.now();
  st.timer = setInterval(tick, 1000);
  paint();
  try {
    const body = { question: q, history, cloud: wantCloud };
    let r = await post(pid, body);
    if (r.status === 200 && r.body.sent === false && r.body.confirm) {
      if (!(await previewDialog(r.body))) {
        turns.push({ role: "assistant", kind: "note", text: "Not sent. Nothing left this machine." });
        return;
      }
      r = await post(pid, { ...body, confirm: r.body.confirm.nonce });
    }
    const b = r.body;
    if (r.status === 401) {
      turns.push({ role: "assistant", kind: "error", text: "This tab is not signed in. Use the link the terminal printed." });
    } else if (r.status !== 200) {
      turns.push({
        role: "assistant",
        kind: "error",
        text: b.no_endpoint ? `${b.error}` : `${b.error || `HTTP ${r.status}`}${r.status === 504 ? " A local model can be slow to load; try again." : ""}`,
      });
    } else {
      turns.push({
        role: "assistant",
        kind: b.withheld ? "withheld" : b.not_in_records && !b.cites.length ? "notinrecords" : "answer",
        text: b.answer,
        cites: b.cites,
        records: b.records,
        raw: b.raw,
        meta: { local: b.local, model: b.model, ms: b.ms, egress: b.egress },
      });
    }
  } catch (e) {
    turns.push({ role: "assistant", kind: "error", text: `The question did not go through: ${e.message}` });
  } finally {
    st.busy = false;
    clearInterval(st.timer);
    paint();
    els.q.focus();
  }
}

// ── hooks ───────────────────────────────────────────────────────────────────
onAfterRender((root) => {
  // The drawer lives on <body>, so a render of the page never takes it (or what
  // was typed in it) away. Only the header button is put back.
  const list = root.querySelector("nav.side .navlist");
  if (list) {
    list.append(h("li", null,
      h("button", { type: "button", class: "navlink chat-toggle", id: "chat-toggle", "aria-expanded": String(st.open), "aria-controls": "chat-drawer", "aria-keyshortcuts": "c", onClick: () => toggle() },
        icon(ICONS.chat), "Ask the records", h("kbd", { class: "chat-key", "aria-hidden": "true", text: "c" }))));
  }
  if (st.open) paint();
});
window.addEventListener("hashchange", () => {
  if (st.open) {
    st.pid = S.pid;
    if (st.statusPid !== S.pid) {
      st.status = null;
      loadStatus();
    }
    paint();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "c" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.querySelector("dialog[open]") || !S.token || !S.meta) return;
  e.preventDefault();
  toggle();
});
