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
  .credentials { width:100%; max-width:760px; margin:0 auto; padding:8px 16px; border-bottom:1px solid var(--line); }
  .credentials summary { cursor:pointer; font-weight:600; }
  .credential-panel { max-height:50vh; overflow:auto; }
  #credential-form { display:block; padding:0; border:0; }
  #credential-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; border:0; padding:0; margin:8px 0; }
  #credential-fields label { font-size:13px; }
  #credential-fields input { display:block; width:100%; min-width:0; margin-top:4px; }
  .credential-value { grid-column:1/-1; }
  #credential-list { padding:0; list-style:none; }
  #credential-list li { display:flex; gap:8px; align-items:center; justify-content:space-between; margin:8px 0; overflow-wrap:anywhere; }
  #credential-list button, #credential-refresh { padding:4px 10px; border:1px solid var(--line); border-radius:8px; color:var(--fg); background:var(--card); font:inherit; cursor:pointer; }
  @media (max-width:480px) { #credential-fields { grid-template-columns:minmax(0,1fr); } }
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
  .budgets { display:flex; flex-wrap:wrap; gap:12px; padding:8px 16px; max-width:760px; width:100%; margin:0 auto; font-size:13px; color:var(--muted); }
  .budgets label { flex:1; min-width:150px; }
  .budgets input { display:block; width:100%; margin-top:4px; font-size:13px; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--fg); background:var(--card); color:var(--fg); font:inherit; }
  button[type=submit] { padding:10px 16px; border-radius:10px; border:none; background:var(--accent); color:var(--on-accent); font:inherit; cursor:pointer; }
  :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); border:0; }
</style>
</head>
<body>
<header><h1>August</h1></header>
<details class="credentials" id="credentials"><summary>Secrets</summary>
<section class="credential-panel" aria-label="Secure credential controls">
<p class="muted">Sent directly to your credential store, never through chat. Values cannot be displayed. Running providers or capabilities may need a restart after replacement.</p>
<p id="credential-warning" class="muted" hidden>This OS backend currently shares credential names across installations. Verify the scope before changing entries.</p>
<form id="credential-form" autocomplete="off">
<fieldset id="credential-fields" disabled><legend class="sr">Store a credential</legend>
<label for="credential-name">Secret name<input id="credential-name" required pattern="[A-Z_][A-Z0-9_]*" maxlength="128" placeholder="API_KEY" autocomplete="off" spellcheck="false"></label>
<label for="credential-scope">Capability ID (optional)<input id="credential-scope" pattern="[A-Za-z0-9_\\-]+" maxlength="64" autocomplete="off" spellcheck="false"></label>
<label class="credential-value" for="credential-value">Secret value<input id="credential-value" type="password" required maxlength="8192" autocomplete="new-password" spellcheck="false"></label>
<button type="submit">Save secret</button>
</fieldset></form>
<p id="credential-status" class="muted" role="status" aria-live="polite">Connect to your local agent to manage secrets.</p>
<button id="credential-refresh" type="button" disabled>Refresh names</button>
<ul id="credential-list" aria-label="Stored secret names"></ul>
</section></details>
<main>
<div id="log" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabindex="0"><p class="muted" id="hint"></p></div>
<section class="budgets" aria-label="Optional task limits">
<label for="token-budget">Token limit<input id="token-budget" inputmode="numeric" placeholder="Default"></label>
<label for="money-budget">Cost stop threshold (USD estimate)<input id="money-budget" inputmode="decimal" placeholder="Default"></label>
</section>
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
  const credentialForm = document.getElementById("credential-form"), credentialFields = document.getElementById("credential-fields");
  const credentialStatus = document.getElementById("credential-status"), credentialList = document.getElementById("credential-list");
  let credentialBusy = false, credentialAvailable = false;
  document.getElementById("credential-refresh").disabled = !token;
  document.getElementById("credential-refresh").onclick = () => { if (!credentialBusy) loadCredentials().catch(() => { credentialStatus.textContent = "Credential store is not reachable."; }); };
  async function loadCredentials() {
    if (!token) return;
    credentialAvailable = false; credentialFields.disabled = true; credentialStatus.textContent = "Loading credential names…";
    credentialList.replaceChildren(); document.getElementById("credential-warning").hidden = true;
    const r = await fetch("/v1/secrets", { headers: headers() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || typeof body.backend !== "string" || !Array.isArray(body.names) || body.names.some(name => typeof name !== "string")) { credentialFields.disabled = true; credentialStatus.textContent = "Secure credential controls unavailable. Check your connection and backend."; credentialList.replaceChildren(); return; }
    credentialAvailable = true; credentialFields.disabled = credentialBusy; credentialList.replaceChildren();
    document.getElementById("credential-warning").hidden = body.backend !== "keychain" && body.backend !== "secret-service";
    credentialStatus.textContent = "Store: " + body.backend + (body.names.length ? ". Values are hidden." : ". No stored secrets.");
    for (const name of body.names) {
      const row = document.createElement("li"), label = document.createElement("span"), remove = document.createElement("button");
      label.textContent = name; remove.type = "button"; remove.textContent = "Remove"; remove.setAttribute("aria-label", "Remove secret " + name);
      remove.onclick = async () => {
        if (credentialBusy || !credentialAvailable || !confirm("Remove secret " + name + "? This may disconnect its provider or capability.")) return;
        credentialBusy = true; credentialFields.disabled = true; remove.disabled = true;
        try { const response = await fetch("/v1/secrets/" + encodeURIComponent(name), { method: "DELETE", headers: headers() }); if (!response.ok) { if ([401, 403, 404].includes(response.status)) { credentialAvailable = false; credentialList.replaceChildren(); } throw new Error(); } await loadCredentials(); credentialStatus.textContent = "Secret removed."; }
        catch { credentialStatus.textContent = "Could not remove the secret. Refresh the list before retrying."; remove.disabled = false; }
        finally { credentialBusy = false; credentialFields.disabled = !credentialAvailable; }
      };
      row.append(label, remove); credentialList.appendChild(row);
    }
  }
  document.getElementById("credentials").ontoggle = () => {
    if (document.getElementById("credentials").open) loadCredentials().catch(() => { credentialStatus.textContent = "Credential store is not reachable."; });
    else document.getElementById("credential-value").value = "";
  };
  credentialForm.onsubmit = async e => {
    e.preventDefault(); if (!token || credentialBusy || credentialFields.disabled) return;
    const name = document.getElementById("credential-name").value.trim(), scope = document.getElementById("credential-scope").value.trim();
    const field = document.getElementById("credential-value"), value = field.value;
    field.value = ""; credentialBusy = true; credentialFields.disabled = true; credentialStatus.textContent = "Saving securely…";
    try {
      const r = await fetch("/v1/secrets/" + encodeURIComponent((scope ? scope + "." : "") + name), { method: "PUT", headers: headers(), body: JSON.stringify({ value }) });
      if (!r.ok) { if ([401, 403, 404].includes(r.status)) { credentialAvailable = false; credentialList.replaceChildren(); } throw new Error(); }
      await loadCredentials(); credentialStatus.textContent = "Secret saved. Its value is hidden.";
    } catch { credentialStatus.textContent = "Could not confirm storage. The value was cleared; refresh the list before retrying."; }
    finally { credentialBusy = false; credentialFields.disabled = !credentialAvailable; if (credentialAvailable) field.focus(); }
  };
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
    const budget = {};
    const tokens = document.getElementById("token-budget").value.trim();
    const dollars = document.getElementById("money-budget").value.trim().replace(",", ".");
    if (tokens) {
      const value = Number(tokens);
      if (!/^[0-9]+$/.test(tokens) || !Number.isSafeInteger(value) || value < 1) { add("Enter a positive whole token limit."); return; }
      budget.maxTokens = value;
    }
    if (dollars) {
      if (!/^[0-9]+([.][0-9]{1,6})?$/.test(dollars)) { add("Enter a non-negative USD limit with up to six decimal places."); return; }
      const [whole, fraction = ""] = dollars.split(".");
      const micros = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
      if (micros > BigInt(Number.MAX_SAFE_INTEGER)) { add("The cost limit is too large."); return; }
      budget.maxCostMicros = Number(micros);
    }
    input.value = ""; add(text, "me");
    const wait = add("…", "muted");
    const timer = setInterval(() => checkPending().catch(() => {}), 1000);
    try {
      const r = await fetch("/v1/message", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, text, ...(Object.keys(budget).length ? { budget } : {}) }) });
      const body = await r.json().catch(() => ({}));
      wait.remove(); const shownReply = add(r.ok ? body.reply : "Error: " + (body.error || r.status));
      if (r.ok && body.runId) judge(shownReply, body.runId);
    } catch { wait.remove(); add("The agent is not reachable."); }
    finally { clearInterval(timer); if (shown) { resolved(shown.card); shown = null; } }
  };
})();
`;
