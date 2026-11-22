// gnomon dashboard v2: flag-for-fix work items. Registers with app.js (registerScreen / onAfterRender).
//
// "Flag for fix" writes one gitignored file, <project>/.gnomon-inbox/<id>.json,
// through the server's `inbox.add` action (a gnomon command, run after the
// confirm dialog states exactly what it will write and where). Any harness
// working in the project then reads it: gnomon (/inbox), Claude Code (a
// SessionStart hook), Cursor and Claude Code (`gnomon inbox mcp`).
//
// Coordination is by a typed shared artifact, not a message, and an item is
// INPUT, never authority: it is information from the operator, and it grants
// nothing, lifts no rule and approves no call. Like an approval card, an item
// that has been decided (resolved) is inert, and no gesture here approves
// anything: the only button that acts on an item is "Resolve", and it only
// closes the item.
//
// Proposals (below the items) are the other direction: changes to .gnomon/ that
// something proposed (the agent, a miner, a person) and a PERSON decides. Each
// card shows the exact diff and its evidence; Accept and Reject go through
// perform() as `proposal.accept` / `proposal.reject`, whose confirmation states
// the diff and the surface paths before anything is written. Nothing here
// applies a proposal by itself.
//
// Everything is built with createElement and textContent; item text is data.
import { registerScreen, onAfterRender, S, h, projectApi, perform, load, header, tile, icon } from "/app.js";

const TRAY = ["M4 13l2-7h12l2 7v6H4z", "M4 13h5l1 2h4l1-2h5"];
const TARGETS = [
  ["any", "Any harness"],
  ["claude-code", "Claude Code"],
  ["cursor", "Cursor"],
  ["gnomon", "gnomon"],
];
const TARGET_LABEL = Object.fromEntries(TARGETS);
const STATUS_LABEL = { open: "Open", acknowledged: "Acknowledged", resolved: "Resolved" };
const SCREEN_LABEL = {
  projects: "Projects", setup: "Setup", session: "Session", governance: "Governance",
  contracts: "Contracts", measurements: "Measurements", inbox: "Inbox", lens: "Lens", chat: "Chat",
};

// What the Inbox screen is showing: not data, so not in S.
const view = { status: "open", target: "all", notice: "" };
const KIND_LABEL = { skill: "Skill", memory: "Memory", harness: "Harness" };

const field = (text, control) => h("label", { class: "picker" }, text, control);
const projectOf = () => (S.meta ? S.meta.projects.find((p) => p.id === S.pid) : null);

function whenText(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || "");
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── the screen ──────────────────────────────────────────────────────────────

function itemCard(i, pid) {
  const note = h("input", { type: "text", class: "field", maxlength: "1000", autocomplete: "off", placeholder: "What was done (optional)" });
  const evidence = i.evidence.length
    ? h("p", { class: "small muted" }, "Evidence: ",
      i.evidence.map((e, n) => [
        n ? ", " : "",
        h("a", { href: `#/session/${pid}/${encodeURIComponent(e.trail)}`, text: `${e.trail} #${e.seq} (${e.kind})` }),
      ]))
    : null;
  return h("li", { class: `item ${i.status}` },
    h("div", { class: "cardhead wrapping" },
      h("h3", { text: i.title }),
      h("span", { class: "row" },
        h("span", { class: `pill ${i.status === "open" ? "" : i.status === "resolved" ? "outline" : "dashed"}`.trim(), text: STATUS_LABEL[i.status] }),
        h("span", { class: "pill outline", text: `For ${TARGET_LABEL[i.target] || i.target}` }))),
    h("p", { class: "muted small" }, `${whenText(i.created)} · flagged from the ${i.author}`, h("span", { class: "mono", text: ` · ${i.id}` })),
    i.detail ? h("p", { class: "itemtext", text: i.detail }) : null,
    i.scope.length ? h("p", { class: "small" }, "Scope: ", i.scope.map((p) => h("code", { class: "chip", text: p }))) : null,
    evidence,
    i.status === "resolved"
      ? h("p", { class: "small muted" }, `Resolved ${whenText(i.resolved_at)}${i.resolved_note ? `: ${i.resolved_note}` : "."}`)
      : h("div", { class: "cardfoot" },
        field("Note", note),
        h("button", {
          type: "button", class: "btn",
          title: `asks you first · gnomon inbox resolve ${i.id}`,
          onClick: async () => {
            const r = await perform("inbox.resolve", { id: i.id, ...(note.value.trim() ? { note: note.value.trim() } : {}) },
              { title: "Mark this item resolved?", confirmLabel: "Resolve" });
            if (r && !r.failed) load(true);
          },
        }, icon(["M5 12.5l4.5 4.5L19 7.5"], 18), "Resolve")));
}

function diffView(d) {
  // The new file, or the old and new side by side as - and + lines. Text nodes only.
  const lines = [];
  if (d.before) for (const l of d.before.split("\n")) lines.push(h("span", { class: "dl del", text: `- ${l}` }));
  for (const l of d.after.split("\n")) lines.push(h("span", { class: "dl add", text: `+ ${l}` }));
  return h("pre", { class: "diffview mono", tabindex: "0", "aria-label": `Change to .gnomon/${d.path}` }, lines);
}

function diffOf(prop) {
  return h("div", { class: "diffs" }, prop.diff.map((d) =>
    h("div", null,
      h("p", { class: "small" }, h("code", { class: "chip", text: `.gnomon/${d.path}` }),
        d.before_sha256 ? ` replaces the file (sha256 ${d.before_sha256.slice(0, 12)})` : " is a new file",
        d.moved ? h("span", { class: "pill dashed", text: "file changed since proposed" }) : null),
      diffView(d))));
}

function decisionPreview(body) {
  const pr = body.proposal;
  return h("div", { class: "panel sunk" },
    h("dl", { class: "facts" },
      h("div", null, h("dt", { text: "Proposal" }), h("dd", { text: `${pr.id} · ${KIND_LABEL[pr.kind] || pr.kind} · ${pr.title}` })),
      h("div", null, h("dt", { text: "Surface paths" }), h("dd", { text: pr.paths.join(", ") }))),
    h("pre", { class: "diffview mono", tabindex: "0", "aria-label": "The exact diff" },
      String(body.diff || "").split("\n").map((l) => h("span", { class: l.startsWith("-") ? "dl del" : l.startsWith("+") ? "dl add" : "dl", text: l }))));
}

async function decide(name, prop, note) {
  const params = { id: prop.id, ...(name === "proposal.reject" && note ? { note } : {}) };
  const accept = name === "proposal.accept";
  const r = await perform(name, params, {
    title: accept ? "Write this change to .gnomon/?" : "Reject this proposal?",
    confirmLabel: accept ? "Accept and write" : "Reject",
    details: decisionPreview,
  });
  view.notice = r && !r.failed && r.exit !== 0 ? `Not ${accept ? "accepted" : "rejected"}: ${r.stderr || "refused"}` : "";
  if (r) load(true);
}

function proposalCard(prop) {
  const note = h("input", { type: "text", class: "field", maxlength: "1000", autocomplete: "off", placeholder: "Why (optional)" });
  const evidence = prop.evidence && prop.evidence.length
    ? h("p", { class: "small muted" }, "Evidence: ", prop.evidence.map((e, n) => [n ? ", " : "", h("span", { class: "mono", text: [e.trail, e.seq !== undefined ? `#${e.seq}` : "", e.note || ""].join("") })]))
    : null;
  const pending = prop.status === "pending";
  return h("li", { class: `item ${pending ? "open" : "resolved"}` },
    h("div", { class: "cardhead wrapping" },
      h("h3", { text: prop.title }),
      h("span", { class: "row" },
        h("span", { class: "pill", text: KIND_LABEL[prop.kind] || prop.kind }),
        h("span", { class: `pill ${pending ? "dashed" : "outline"}`, text: pending ? "Pending" : prop.status === "accepted" ? "Accepted" : "Rejected" }))),
    h("p", { class: "muted small" }, `${whenText(prop.created)} · proposed by ${prop.source}`, h("span", { class: "mono", text: ` · ${prop.id}` })),
    prop.rationale ? h("p", { class: "itemtext", text: prop.rationale }) : null,
    evidence,
    diffOf(prop),
    pending
      ? h("div", { class: "cardfoot" },
        field("Note for a rejection", note),
        h("button", {
          type: "button", class: "btn primary",
          title: `asks you first · gnomon proposals accept ${prop.id}`,
          onClick: () => decide("proposal.accept", prop, ""),
        }, icon(["M5 12.5l4.5 4.5L19 7.5"], 18), "Accept"),
        h("button", {
          type: "button", class: "btn",
          title: `asks you first · gnomon proposals reject ${prop.id}`,
          onClick: () => decide("proposal.reject", prop, note.value.trim()),
        }, "Reject"))
      : h("p", { class: "small muted" }, `${prop.status === "accepted" ? "Accepted" : "Rejected"} ${whenText(prop.decided_at)}${prop.note ? `: ${prop.note}` : "."}`));
}

function proposalsSection(pr) {
  if (!pr) return null;
  const pending = pr.proposals.filter((x) => x.status === "pending");
  const decided = pr.proposals.filter((x) => x.status !== "pending").slice(0, 10);
  return h("section", { "aria-labelledby": "proposals-h" },
    h("div", { class: "sechead" }, h("h2", { id: "proposals-h", text: "Proposals" }),
      h("span", { class: "muted small", text: `${pr.counts.pending} pending · ${pr.counts.accepted} accepted · ${pr.counts.rejected} rejected` })),
    h("p", { class: "muted small", text: "Changes to .gnomon/ that the agent, a miner or a person proposed. Nothing applies until you accept it; accepting moves the surface hash and takes effect from the next session. The diff below is exactly what is written." }),
    view.notice ? h("p", { class: "bad small", role: "alert", text: view.notice }) : null,
    pending.length
      ? h("ul", { class: "inboxlist" }, pending.map(proposalCard))
      : h("p", { class: "muted", role: "status", text: "No pending proposals." }),
    decided.length ? h("details", null, h("summary", { text: `Decided (${decided.length} most recent)` }), h("ul", { class: "inboxlist" }, decided.map(proposalCard))) : null,
    pr.problems && pr.problems.length ? h("p", { class: "bad small", role: "alert", text: `Not proposals, and not read: ${pr.problems.join("; ")}` }) : null);
}

function inboxFetch(ctx) {
  const p = projectOf();
  if (!p || !p.hasSurface) return Promise.resolve({ none: true });
  return Promise.all([ctx.projectApi("inbox"), ctx.projectApi("proposals").catch(() => null)]).then(([inbox, proposals]) => ({ ...inbox, proposals }));
}

function inboxRender(d, ctx) {
  const pid = ctx.pid;
  const shown = d.items.filter((i) => i.status === view.status && (view.target === "all" || i.target === view.target || i.target === "any"));
  const setView = (patch) => () => { Object.assign(view, patch); load(); };
  const tabs = ["open", "acknowledged", "resolved"].map((k) =>
    h("button", {
      type: "button", class: "btn toggle", "aria-pressed": view.status === k ? "true" : "false",
      onClick: setView({ status: k }),
    }, `${STATUS_LABEL[k]} · ${d.counts[k]}`));
  const target = h("select", { onChange: (e) => { view.target = e.target.value; load(); } },
    [["all", "All harnesses"], ...TARGETS].map(([v, t]) => h("option", { value: v, selected: view.target === v, text: t })));
  return [
    header("Work items", "Inbox",
      "Things you flagged for a harness to fix. Each is one file in .gnomon-inbox/ (gitignored). A harness reads an item as information from you, never as an instruction or an approval."),
    h("div", { class: "tiles" },
      tile("Open", String(d.counts.open), "not yet picked up"),
      tile("Acknowledged", String(d.counts.acknowledged), "a harness has seen it"),
      tile("Resolved", String(d.counts.resolved), "closed, inert")),
    h("section", { "aria-labelledby": "inbox-h" },
      h("div", { class: "sechead" }, h("h2", { id: "inbox-h", text: "Items" }),
        h("div", { class: "row" }, h("div", { class: "row", role: "group", "aria-label": "Show items that are" }, tabs), field("Show items for", target))),
      shown.length
        ? h("ul", { class: "inboxlist" }, shown.map((i) => itemCard(i, pid)))
        : h("p", { class: "muted", role: "status", text: d.items.length ? "Nothing matches this filter." : "Nothing flagged yet. Use Flag for fix at the top of any screen." }),
      d.problems.length ? h("p", { class: "bad small", role: "alert", text: `Not items, and not read: ${d.problems.join("; ")}` }) : null),
    proposalsSection(d.proposals),
    h("section", { "aria-labelledby": "deliver-h" },
      h("h2", { id: "deliver-h", text: "How a harness gets them" }),
      h("ul", { class: "findings" },
        h("li", null, h("strong", { text: "gnomon: " }), "the launch banner counts the open ones; /inbox lists them and resolves one."),
        h("li", null, h("strong", { text: "Claude Code: " }), h("code", { text: "gnomon guard install claude-code --write" }), " adds a SessionStart hook that hands it the open items, labelled information, not instructions."),
        h("li", null, h("strong", { text: "Cursor, Claude Code: " }), h("code", { text: "gnomon inbox mcp" }), " is an MCP server with inbox_list, inbox_get, inbox_acknowledge and inbox_resolve. It cannot add an item."))),
  ];
}

registerScreen("inbox", "Inbox", TRAY, { fetch: inboxFetch, render: inboxRender });

// ── Flag for fix ────────────────────────────────────────────────────────────

/** What the current screen can say about where the person is looking. */
function contextOf() {
  const p = projectOf();
  const screen = SCREEN_LABEL[S.screen] || S.screen;
  const ctx = { project: p ? p.name : "", screen, trail: null, evidence: null };
  const data = S.data[`${S.screen}:${S.pid}:${S.trail || ""}`];
  const detail = S.screen === "session" && data && data.detail ? data.detail : null;
  if (detail && detail.name) {
    ctx.trail = detail.name;
    const m = /^g(\d+)$/.exec(S.sel || "");
    const ev = m && Array.isArray(detail.events) ? detail.events.find((e) => e.seq === Number(m[1])) : null;
    if (ev && /^[a-z_]{1,40}$/.test(ev.kind || "")) ctx.evidence = { trail: detail.name, seq: ev.seq, kind: ev.kind, what: ev.tool || ev.kind };
  } else if (S.trail) {
    ctx.trail = S.trail;
  }
  return ctx;
}

function previewOf(body) {
  const it = body.item;
  const row = (k, v) => h("div", null, h("dt", { text: k }), h("dd", null, v));
  return h("div", { class: "panel sunk" },
    h("dl", { class: "facts" },
      row("Title", it.title),
      row("For", TARGET_LABEL[it.target] || it.target),
      row("Detail", it.detail ? h("span", { class: "itemtext", text: it.detail }) : "none"),
      row("Scope", it.scope.length ? it.scope.join(", ") : "none"),
      row("Evidence", it.evidence.length ? it.evidence.map((e) => `${e.trail} #${e.seq} (${e.kind})`).join(", ") : "none")));
}

function openFlagDialog(opener) {
  const c = contextOf();
  const where = [c.project, c.screen].filter(Boolean).join(" · ");
  const title = h("input", { type: "text", class: "field", maxlength: "200", required: true, autocomplete: "off", value: `${c.screen}: ` });
  const lines = [`Flagged from the ${c.screen} screen${c.project ? ` of ${c.project}` : ""}.`];
  if (c.trail) lines.push(`Trail: ${c.trail}`);
  if (c.evidence) lines.push(`Record: #${c.evidence.seq} (${c.evidence.kind}${c.evidence.what !== c.evidence.kind ? `: ${c.evidence.what}` : ""})`);
  lines.push("", "What is wrong, and what should be different:", "");
  const detail = h("textarea", { class: "field", rows: "6", maxlength: "4000", spellcheck: "true" });
  detail.value = lines.join("\n");
  const target = h("select", { class: "field" }, TARGETS.map(([v, t]) => h("option", { value: v, text: t })));
  const scope = h("textarea", { class: "field mono", rows: "2", maxlength: "1000", spellcheck: "false", placeholder: "packages/app/src/x.ts" });
  const attach = c.evidence ? h("input", { type: "checkbox", checked: true }) : null;
  const msg = h("p", { class: "bad small", role: "alert" });
  let dlg = null;
  const close = () => {
    dlg.close();
    dlg.remove();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  };
  const submit = async () => {
    const t = title.value.trim();
    if (!t) { msg.textContent = "Give it a title."; title.focus(); return; }
    const paths = scope.value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (paths.some((x) => x.includes(","))) { msg.textContent = "A path may not hold a comma; one path per line."; scope.focus(); return; }
    const params = { title: t, detail: detail.value.trim(), target: target.value };
    if (paths.length) params.scope = paths;
    if (attach && attach.checked) params.evidence = [{ trail: c.evidence.trail, seq: c.evidence.seq, kind: c.evidence.kind }];
    close();
    const r = await perform("inbox.add", params, {
      title: "Write this item to .gnomon-inbox/?",
      confirmLabel: "Write item",
      details: previewOf,
    });
    if (r && !r.failed && S.screen === "inbox") load(true);
  };
  dlg = h("dialog", { class: "confirm flag", "aria-labelledby": "flag-h" },
    h("h2", { id: "flag-h", text: "Flag for fix" }),
    h("p", { class: "muted small" }, `${where ? where + ". " : ""}This writes a work item a harness in this project reads as information from you. It grants nothing and approves nothing; you review exactly what is written before it is.`),
    field("Title", title),
    field("What is wrong", detail),
    field("For", target),
    field("Files or folders it concerns (one per line, relative to the project; optional)", scope),
    attach ? h("label", { class: "choice" }, attach, h("span", null, `Attach record #${c.evidence.seq} of ${c.evidence.trail} (${c.evidence.kind}) as evidence`)) : null,
    msg,
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn primary", text: "Review and write", onClick: submit }),
      h("button", { type: "button", class: "btn", text: "Cancel", onClick: close })));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);
}

onAfterRender((root) => {
  const p = projectOf();
  if (!p || !p.hasSurface) return;
  const head = root.querySelector(".wrap > header.head");
  if (!head || head.querySelector(".flagbtn")) return;
  let row = head.querySelector(".row");
  if (!row) {
    row = h("div", { class: "row" });
    head.append(row);
  }
  const btn = h("button", {
    type: "button", class: "btn flagbtn", "aria-haspopup": "dialog",
    title: "asks you first · gnomon inbox add",
    onClick: () => openFlagDialog(btn),
  }, icon(TRAY, 18), "Flag for fix");
  row.append(btn);
});

// Kept for the palette and the other modules: reads the inbox without a screen.
export const inboxCounts = async () => {
  const p = projectOf();
  if (!p || !p.hasSurface) return null;
  try { return (await projectApi("inbox")).counts; } catch { return null; }
};
