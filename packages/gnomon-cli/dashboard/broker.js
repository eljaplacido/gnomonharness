// gnomon dashboard: pending-approval cards for the guard's approval broker
// (CONTRACTS.md §10). A guard hook on a host that cannot ask (Codex, Cursor
// preToolUse and beforeReadFile) is HOLDING a call and waiting for a person.
//
// The card says what the call is and why gnomon asked. Allow and Deny are two
// steps, like every action here: the first click asks the server what the
// answer will do and gets a one-use confirmation; only "Confirm" decides. A
// card nobody answers expires on the hook's side into a deny. Nothing on this
// page approves by itself.
//
// Everything is built with createElement and textContent; the call's text is data.
import { S, h, api } from "/app.js";

const POLL_MS = 2000;
const st = { cards: [], armed: null, effect: [], nonce: "", error: "" };
let root = null;

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

function paint() {
  if (!root) {
    root = h("section", { id: "broker-cards", class: "broker", "aria-live": "assertive", "aria-label": "Calls waiting for your approval" });
    document.body.append(root);
  }
  root.replaceChildren();
  root.hidden = st.cards.length === 0;
  for (const c of st.cards) {
    const armed = st.armed && st.armed.id === c.id ? st.armed : null;
    root.append(
      h("article", { class: "broker-card" },
        h("h3", { text: `${c.host} is waiting for you` }),
        h("p", { class: "broker-what", text: `${c.tool}: ${clip(c.target || "(no target)", 400)}` }),
        h("p", { class: "broker-why", text: clip(c.reason, 400) }),
        h("p", { class: "broker-ttl", text: `The call is refused if unanswered in ${c.expires_in_s}s.` }),
        armed
          ? h("div", null,
              ...st.effect.map((line) => h("p", { text: line })),
              h("button", { type: "button", class: "btn", onClick: () => decide(c, armed.decision, st.nonce) }, `Confirm ${armed.decision === "allow" ? "allow" : "deny"}`),
              h("button", { type: "button", class: "btn", onClick: () => { st.armed = null; paint(); } }, "Back"))
          : h("div", null,
              h("button", { type: "button", class: "btn", onClick: () => arm(c, "allow") }, "Allow once"),
              h("button", { type: "button", class: "btn", onClick: () => arm(c, "deny") }, "Deny")),
        st.error && armed ? h("p", { class: "broker-error", text: st.error }) : null)
    );
  }
}

async function arm(card, decision) {
  st.error = "";
  try {
    const r = await api(`/api/broker/${card.id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
    st.armed = { id: card.id, decision };
    st.nonce = r.confirm.nonce;
    st.effect = r.confirm.effect || [];
  } catch (e) {
    st.armed = null;
    st.error = e.message;
  }
  paint();
}

async function decide(card, decision, nonce) {
  try {
    await api(`/api/broker/${card.id}/decide`, { method: "POST", body: JSON.stringify({ decision, confirm: nonce }) });
    st.armed = null;
    st.error = "";
  } catch (e) {
    st.error = e.message;
  }
  await poll();
}

async function poll() {
  if (!S.token) return;
  try {
    st.cards = (await api("/api/broker/pending")).pending;
  } catch {
    st.cards = [];
  }
  if (!st.armed || !st.cards.some((c) => c.id === st.armed.id)) st.armed = null;
  paint();
}

setInterval(poll, POLL_MS);
