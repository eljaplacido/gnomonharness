// gnomon desktop launcher: the one screen this app draws itself. Everything
// after it is the dashboard's own page, served by the installed gnomon.
//
// It calls only this app's eight commands (src-tauri/build.rs), and never
// names a path: folders come from the native dialog, recent ones by index.
// The DOM is built with textContent, never innerHTML, under a CSP with no
// inline script or style.

const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);

const root = document.getElementById("app");
let state = null; // the last status
let busy = null; // text while an action runs
let message = null; // { kind: "info" | "error", text }

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Text with `code` spans: backticks in our own strings become <code>. */
function prose(text) {
  return String(text).split("`").map((part, i) => (i % 2 ? h("code", { text: part }) : part));
}

async function act(label, fn) {
  if (busy) return;
  busy = label;
  message = null;
  render();
  try {
    await fn();
  } catch (e) {
    message = { kind: "error", text: String(e) };
  } finally {
    busy = null;
    render();
  }
}

async function refresh(cmd = "status") {
  state = await invoke(cmd);
  if (state.notice) message = { kind: "error", text: state.notice };
}

function copyable(text) {
  const code = h("code", { text });
  const btn = h("button", {
    text: "Copy",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        // No clipboard here: select it, for Ctrl+C.
        const r = document.createRange();
        r.selectNodeContents(code);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        btn.textContent = "Selected";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    },
  });
  return h("div", { class: "cmd" }, code, btn);
}

function cliCard(s) {
  const c = s.cli;
  const again = h("button", { text: "Check again", disabled: !!busy, onclick: () => act("Checking…", () => refresh("recheck")) });
  const locate = h("button", {
    text: "Locate gnomon…",
    disabled: !!busy,
    onclick: () => act("Waiting for the file dialog…", async () => { state = await invoke("locate_gnomon"); }),
  });
  if (c.found && c.dashboard) {
    return h("section", { class: "card" },
      h("div", { class: "status" }, h("span", { class: "dot ok" }), h("div", null,
        h("strong", { text: c.version }),
        h("div", { class: "dim small mono", text: c.path }))));
  }
  if (c.found) {
    return h("section", { class: "card" },
      h("h2", { text: "gnomon" }),
      h("div", { class: "status" }, h("span", { class: "dot bad" }), h("div", null,
        h("p", null, ...prose(`This gnomon (${c.version}) has no \`gnomon dashboard\`, which this window shows.`)),
        h("p", { class: "muted" }, ...prose("Update it with `gnomon update` to a release that has the dashboard, or point this app at another gnomon.")),
        h("div", { class: "dim small mono", text: c.path }))),
      h("div", { class: "row" }, again, locate));
  }
  return h("section", { class: "card" },
    h("h2", { text: "Install gnomon" }),
    h("div", { class: "status" }, h("span", { class: "dot bad" }), h("p", null,
      "This app runs the gnomon installed on this machine, and could not use one: ", c.problem, ".")),
    h("p", { class: "muted" }, `gnomon needs Node 22 or newer. Run its installer in ${s.install.script_shell}:`),
    copyable(s.install.script),
    h("p", { class: "muted" }, "or, with Node already installed:"),
    copyable(s.install.npm),
    h("p", { class: "muted small" }, "Then come back and check again. If gnomon is installed somewhere this app does not look, locate it."),
    h("div", { class: "row" },
      again,
      locate,
      h("button", { class: "link", text: "Install guide", disabled: !!busy, onclick: () => act(null, () => invoke("open_install_guide")) })));
}

function setupButton(s, primary) {
  return h("button", {
    class: primary ? "primary" : null,
    text: "Set up gnomon",
    disabled: !!busy || !s.cli.found,
    onclick: () => act("Choose the folder to set up in the dialog…", async () => {
      const r = await invoke("setup_gnomon");
      if (r.message) message = { kind: "info", text: r.message };
    }),
  });
}

function projectsCard(s) {
  const can = s.cli.found && s.cli.dashboard && !busy;
  const open = h("button", {
    class: s.first_run ? null : "primary",
    text: "Open Project Folder…",
    disabled: !can,
    onclick: () => act("Choose a folder in the dialog; its dashboard starts once you do…", () => invoke("pick_project")),
  });
  const list = s.recent.length
    ? h("ul", { class: "recent" }, s.recent.map((r, i) => h("li", null,
        h("div", { class: "what" },
          h("div", { class: "name" }, r.name,
            !r.exists ? h("span", { class: "tag", text: "missing" }) : !r.surface ? h("span", { class: "tag", text: "no .gnomon/ yet" }) : null),
          h("div", { class: "path", title: r.path, text: r.path })),
        h("button", {
          text: "Open",
          disabled: !can || !r.exists,
          onclick: () => act(`Starting gnomon dashboard for ${r.name}…`, () => invoke("open_recent", { index: i })),
        }),
        h("button", {
          class: "link",
          text: "Forget",
          disabled: !!busy,
          onclick: () => act(null, async () => { state = await invoke("forget_recent", { index: i }); }),
        }))))
    : h("p", { class: "muted" }, "No recent projects. Folders you open are listed here, in this app's own settings, never in the project.");
  return h("section", { class: "card" },
    h("h2", { text: "Projects" }),
    h("div", { class: "row" }, open, s.first_run ? null : setupButton(s, false)),
    h("div", { class: "spacer" }),
    list);
}

function welcomeCard(s) {
  return h("section", { class: "card welcome" },
    h("h2", { text: "Welcome" }),
    h("p", null, "Pick a project folder to see what gnomon recorded there: sessions as timelines, every refusal under the rule that made it, the audit chain, contracts and token measurements. The dashboard reads; it changes nothing."),
    h("p", { class: "muted" }, "New to gnomon in a project? Set it up first."),
    h("div", { class: "row" }, setupButton(s, true)));
}

function render() {
  const brand = root.querySelector(".brand");
  root.replaceChildren(brand);
  if (!state) {
    if (message) root.append(h("div", { class: "notice", text: message.text }));
    else root.append(h("p", { class: "muted", text: "Looking for gnomon…" }));
    return;
  }
  if (busy) root.append(h("div", { class: "notice info", text: busy }));
  else if (message) root.append(h("div", { class: `notice${message.kind === "info" ? " info" : ""}` }, ...prose(message.text)));
  root.append(cliCard(state));
  if (state.first_run && state.cli.found) root.append(welcomeCard(state));
  root.append(projectsCard(state));
  root.append(h("footer", null,
    h("p", null, "The dashboard is served by your installed gnomon on 127.0.0.1 only, and this window shows nothing else. No telemetry; no automatic updates."),
    h("p", null, "File ▸ Close Project comes back here. File ▸ Reconnect starts the dashboard again with a fresh sign-in.")));
}

act(null, () => refresh()).catch(() => {});
