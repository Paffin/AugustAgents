/** The chat page served by the gateway at "/". No framework, no external requests, text rendered with textContent only. */
export const WEB_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>August</title>
<style>
  :root { --bg:#faf9f7; --fg:#1d1c1a; --muted:#57544e; --card:#fff; --line:#cfcbc4; --accent:#2f5d50; --on-accent:#fff; --warn:#8a5a00; --focus:#0b57d0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe8; --muted:#b4b1ab; --card:#1f1f1d; --line:#4a4945; --accent:#7fb8a4; --on-accent:#10201a; --warn:#e0b25a; --focus:#8ab4f8; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; display:flex; flex-direction:column; height:100vh; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:1rem; font-weight:600; }
  main { flex:1; display:flex; flex-direction:column; min-height:0; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; max-width:760px; width:100%; margin:0 auto; }
  .msg { padding:10px 12px; border-radius:10px; background:var(--card); border:1px solid var(--line); white-space:pre-wrap; word-wrap:break-word; }
  .me { align-self:flex-end; background:var(--accent); color:var(--on-accent); border:none; max-width:85%; }
  .ask { border:2px solid var(--warn); }
  .ask h2 { margin:0 0 4px; font-size:1rem; }
  .ask button { margin:8px 8px 0 0; padding:8px 16px; border-radius:8px; border:1px solid var(--fg); background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; }
  .muted { color:var(--muted); font-size:13px; }
  .judge { margin-top:8px; font-size:13px; color:var(--muted); }
  .judge button { margin-right:8px; padding:4px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; font-size:13px; }
  form { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); max-width:760px; width:100%; margin:0 auto; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--fg); background:var(--card); color:var(--fg); font:inherit; }
  button[type=submit] { padding:10px 16px; border-radius:10px; border:none; background:var(--accent); color:var(--on-accent); font:inherit; cursor:pointer; }
  :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); border:0; }
</style>
</head>
<body>
<header><h1>August</h1></header>
<main>
<div id="log" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabindex="0"><p class="muted" id="hint"></p></div>
<form id="form"><label class="sr" for="text">Message to August</label><input id="text" autocomplete="off" placeholder="Message"><button type="submit">Send</button></form>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const WEB_JS = `(() => {
  const KEY = "august-token";
  const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (m) { try { sessionStorage.setItem(KEY, decodeURIComponent(m[1])); } catch {} history.replaceState(null, "", location.pathname); }
  let token = null; try { token = sessionStorage.getItem(KEY); } catch {}
  const log = document.getElementById("log"), form = document.getElementById("form"), input = document.getElementById("text");
  const hint = document.getElementById("hint");
  hint.textContent = token ? "Connected to your local agent." : "Open the link printed by \\"august serve\\" to connect.";
  const who = { channel: "web", user: "local" };
  const headers = () => ({ "content-type": "application/json", authorization: "Bearer " + token });
  const add = (text, cls) => { const d = document.createElement("div"); d.className = "msg " + (cls || ""); d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  let shown = null;
  // An answered request stays in the log as a record, no longer a dialog.
  const resolved = (card) => { card.querySelectorAll("button").forEach((x) => x.remove()); card.removeAttribute("role"); card.removeAttribute("aria-labelledby"); card.removeAttribute("aria-describedby"); card.removeAttribute("tabindex"); };
  const clear = () => { if (shown) { shown.card.remove(); shown = null; } };
  async function answer(approval, allow, label) {
    const card = shown && shown.card;
    if (card) card.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    const r = await fetch("/v1/approve", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, approvalId: approval.id, nonce: approval.nonce, allow }) });
    if (card) { resolved(card); card.appendChild(document.createTextNode("\\n" + (r.ok ? "→ " + label : "This request is no longer open."))); }
    shown = null; input.focus();
  }
  async function checkPending() {
    const r = await fetch("/v1/pending?channel=" + who.channel + "&user=" + who.user, { headers: headers() });
    if (!r.ok) return;
    const { approval } = await r.json();
    if (!approval) { return; }
    if (shown && shown.id === approval.id) return;
    clear();
    const card = document.createElement("section");
    card.className = "msg ask"; card.setAttribute("role", "alertdialog"); card.setAttribute("aria-labelledby", "ask-title-" + approval.id); card.setAttribute("aria-describedby", "ask-body-" + approval.id); card.tabIndex = -1;
    const title = document.createElement("h2"); title.id = "ask-title-" + approval.id; title.textContent = approval.tool + " needs your approval";
    const body = document.createElement("div"); body.id = "ask-body-" + approval.id;
    body.textContent = approval.reason + (approval.details ? "\\n" + approval.details : "") + "\\n" + JSON.stringify(approval.args, null, 2) + "\\nRequest " + approval.id;
    card.append(title, body);
    for (const [label, allow, aria] of [["Deny", false, "Deny " + approval.tool], ["Allow once", true, "Allow " + approval.tool + " once"]]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.setAttribute("aria-label", aria);
      b.onclick = () => answer(approval, allow, label).catch(() => {});
      card.appendChild(b);
    }
    card.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); answer(approval, false, "Deny").catch(() => {}); } });
    log.appendChild(card); log.scrollTop = log.scrollHeight;
    shown = { id: approval.id, card };
    card.focus();
  }
  // The owner's verdict on an answer is an outcome nobody else can supply; it is what August learns from.
  function judge(card, runId) {
    const bar = document.createElement("div"); bar.className = "judge"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Was this answer right?");
    for (const [label, verdict, aria] of [["Good answer", "success", "Mark this answer as good"], ["Not right", "failure", "Mark this answer as not right"]]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.setAttribute("aria-label", aria);
      b.onclick = async () => {
        bar.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        const r = await fetch("/v1/feedback", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, runId, verdict }) }).catch(() => null);
        bar.textContent = r && r.ok ? "Thank you." : "Could not record that.";
      };
      bar.appendChild(b);
    }
    card.appendChild(bar);
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text || !token) return;
    input.value = ""; add(text, "me");
    const wait = add("…", "muted");
    const timer = setInterval(() => checkPending().catch(() => {}), 1000);
    try {
      const r = await fetch("/v1/message", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, text }) });
      const body = await r.json().catch(() => ({}));
      wait.remove(); const shownReply = add(r.ok ? body.reply : "Error: " + (body.error || r.status));
      if (r.ok && body.runId) judge(shownReply, body.runId);
    } catch { wait.remove(); add("The agent is not reachable."); }
    finally { clearInterval(timer); if (shown) { resolved(shown.card); shown = null; } }
  };
})();
`;
