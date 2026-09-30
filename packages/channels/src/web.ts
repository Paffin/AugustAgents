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
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; display:flex; height:100vh; height:100dvh; }
  [hidden] { display:none !important; }
  .sidebar { width:216px; flex-shrink:0; padding:28px 16px; border-right:1px solid var(--line); display:flex; flex-direction:column; gap:28px; background:var(--card); }
  .brand { font-size:22px; font-weight:700; letter-spacing:-.8px; padding:0 12px; }
  .brand span { display:block; font-size:11px; font-weight:500; letter-spacing:1.3px; text-transform:uppercase; color:var(--muted); margin-top:4px; }
  nav { display:grid; gap:6px; }
  nav button { display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:12px; border:0; border-radius:8px; font:inherit; font-weight:550; color:var(--muted); background:transparent; cursor:pointer; }
  nav button[aria-current=page] { color:var(--on-accent); background:var(--accent); }
  nav button:hover:not([aria-current]) { background:var(--bg); color:var(--fg); }
  .nav-icon { width:20px; height:20px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
  .sidebar-note { margin-top:auto; padding:0 12px; font-size:12px; color:var(--muted); }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:24px 32px; border-bottom:1px solid var(--line); }
  header p { margin:4px 0 0; }
  #connection { max-width:240px; font-size:12px; text-align:right; color:var(--muted); }
  #connection[data-state=ready] { color:var(--accent); }
  #reconnect { float:right; margin-top:6px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; font-size:12px; padding:4px 10px; cursor:pointer; }
  #activity { font-size:12px; color:var(--warn); }
  .credentials { width:100%; max-width:1040px; margin:0 auto; padding:28px 32px; overflow:auto; }
  .credentials > summary { display:none; }
  .credentials summary { cursor:pointer; font-weight:600; }
  .credential-panel { max-width:680px; }
  #credential-form { display:block; padding:0; border:0; }
  #credential-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; border:0; padding:0; margin:8px 0; }
  #credential-fields label { font-size:13px; }
  #credential-fields input { display:block; width:100%; min-width:0; margin-top:4px; }
  .credential-value { grid-column:1/-1; }
  #credential-list { padding:0; list-style:none; }
  #credential-list li { display:flex; gap:8px; align-items:center; justify-content:space-between; margin:8px 0; overflow-wrap:anywhere; }
  #credential-list button, #credential-refresh { padding:4px 10px; border:1px solid var(--line); border-radius:8px; color:var(--fg); background:var(--card); font:inherit; cursor:pointer; }
  @media (max-width:480px) { #credential-fields { grid-template-columns:minmax(0,1fr); } }
  .task-panel { min-height:0; }
  #task-list { padding:0; list-style:none; }
  #task-list li { margin:12px 0; padding:12px; border:1px solid var(--line); border-radius:8px; background:var(--card); }
  #task-list p { margin:4px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
  #task-list button, #task-refresh { padding:6px 10px; margin:4px 8px 0 0; border:1px solid var(--line); border-radius:8px; color:var(--fg); background:var(--card); font:inherit; cursor:pointer; }
  h1 { margin:0; font-size:20px; font-weight:650; letter-spacing:-.4px; }
  h2 { margin:0 0 12px; font-size:18px; }
  main { flex:1; display:flex; flex-direction:column; min-height:0; min-width:0; }
  #chat { flex:1; display:flex; flex-direction:column; min-height:0; }
  #log { flex:1; overflow-y:auto; padding:32px; display:flex; flex-direction:column; gap:20px; max-width:880px; width:100%; margin:0 auto; }
  .welcome { margin:auto 0; max-width:520px; padding:24px 0; }
  .welcome h2 { font-size:30px; letter-spacing:-1px; font-weight:600; }
  .welcome p { color:var(--muted); }
  .msg { padding:16px 18px; border-radius:12px; background:var(--card); border:1px solid var(--line); white-space:pre-wrap; overflow-wrap:anywhere; }
  .me { align-self:flex-end; background:var(--accent); color:var(--on-accent); border:none; max-width:85%; }
  .ask { border:2px solid var(--warn); }
  .ask h2 { margin:0 0 4px; font-size:1rem; }
  .ask button { margin:8px 8px 0 0; padding:8px 16px; border-radius:8px; border:1px solid var(--fg); background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; }
  .muted { color:var(--muted); font-size:13px; }
  .judge { margin-top:8px; font-size:13px; color:var(--muted); }
  .judge button { margin-right:8px; padding:4px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; font-size:13px; }
  #form { display:flex; gap:12px; align-items:flex-end; padding:12px; border:1px solid var(--line); border-radius:14px; background:var(--card); max-width:816px; width:calc(100% - 64px); margin:0 auto; }
  #text { resize:vertical; min-height:72px; max-height:240px; width:100%; border:0; padding:8px; background:transparent; color:var(--fg); font:inherit; }
  .composer-note { margin:8px 32px 20px; text-align:center; font-size:12px; color:var(--muted); }
  .budgets { display:flex; flex-wrap:wrap; gap:12px; padding:8px 32px 16px; max-width:880px; width:100%; margin:0 auto; font-size:13px; color:var(--muted); }
  .budgets label { flex:1; min-width:150px; }
  .budgets input { display:block; width:100%; margin-top:4px; font-size:13px; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--fg); background:var(--card); color:var(--fg); font:inherit; }
  button[type=submit] { padding:10px 16px; border-radius:10px; border:none; background:var(--accent); color:var(--on-accent); font:inherit; cursor:pointer; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  button { min-height:40px; }
  .task-title { display:flex; justify-content:space-between; gap:12px; font-weight:600; }
  .task-id { font-size:11px; font-weight:400; color:var(--muted); font-family:ui-monospace,monospace; }
  .task-state { text-transform:capitalize; }
  .task-request { font-weight:600; margin:12px 0 !important; }
  .task-reply { max-height:240px; overflow:auto; padding:12px 0; border-top:1px solid var(--line); }
  .billing-warning { color:var(--warn); padding:12px 0; }
  #audit-status { color:var(--warn); font-size:13px; margin:0; padding:8px 24px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  #provider-status { overflow-wrap:anywhere; }
  .receipt-form { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .receipt-form label { display:block; font-size:13px; }
  .receipt-form input[type=number] { display:block; width:100%; min-width:0; margin-top:4px; }
  .receipt-confirm { grid-column:1/-1; }
  @media (max-width:760px) { .sidebar { width:76px; padding:24px 8px; } .brand { padding:0; text-align:center; font-size:17px; } .brand span,.sidebar-note,.nav-label { display:none; } nav button { justify-content:center; padding:12px 4px; } header { padding:20px; } .credentials,#log { padding:20px; } #form { width:calc(100% - 40px); } .budgets { padding:8px 20px 12px; } }
  @media (max-width:480px) { body { flex-direction:column; } .sidebar { width:100%; padding:8px 12px; flex-direction:row; align-items:center; gap:12px; border-right:0; border-bottom:1px solid var(--line); } .brand { font-size:18px; } nav { display:flex; margin-left:auto; gap:4px; } nav button { width:auto; padding:8px 12px; } .nav-label { display:inline; font-size:12px; } .nav-icon { display:none; } header { padding:16px; } #connection { max-width:140px; } .credentials,#log { padding:16px; } #form { width:calc(100% - 24px); gap:4px; } .budgets { padding:8px 12px 12px; gap:8px; } .budgets label { min-width:120px; } .task-title { flex-direction:column; gap:4px; } .welcome h2 { font-size:26px; } }
  :focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); border:0; }
</style>
</head>
<body>
<aside class="sidebar" aria-label="August workspace">
<div class="brand">August<span>Agent workspace</span></div>
<nav aria-label="Workspace sections">
<button type="button" data-view="chat" aria-current="page" aria-controls="chat"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v11H9l-4 4z"/></svg><span class="nav-label">Chat</span></button>
<button type="button" data-view="tasks" aria-controls="tasks"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2M11 6h9M11 12h9M11 18h9"/></svg><span class="nav-label">Tasks</span></button>
<button type="button" data-view="credentials" aria-controls="credentials"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/></svg><span class="nav-label">Secrets</span></button>
</nav>
<p class="sidebar-note">Your runtime.<br>Your permissions.<br>Your decisions.</p>
</aside>
<main>
<header><div><h1 id="view-title">Chat</h1><p id="view-description" class="muted">Work with your agent. Stay in control.</p></div><div><div id="connection" role="status">Not connected</div><div id="activity" role="status" aria-live="polite"></div><button id="reconnect" type="button" hidden>Retry connection</button></div></header>
<p id="audit-status" role="status" aria-live="polite" hidden></p>
<details class="credentials" id="credentials" name="owner-controls" hidden><summary>Secrets</summary>
<section class="credential-panel" aria-label="Secure credential controls">
<h2>Secure credential store</h2>
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
<details class="credentials" id="tasks" name="owner-controls" hidden><summary>Tasks</summary>
<section class="task-panel" aria-label="Recent task controls">
<h2>Recent work</h2>
<p id="provider-status" class="muted" role="status" aria-live="polite">Provider circuit status is being checked.</p>
<p class="muted">Latest 20 tasks in this browser session. Stops wait for a safe boundary and do not undo calls already started. Cost is based on your configured estimate, not a vendor bill.</p>
<button id="task-refresh" type="button" disabled>Refresh tasks</button>
<p id="task-status" class="muted" role="status" aria-live="polite">Connect to view tasks.</p>
<ul id="task-list" aria-label="Recent tasks"></ul>
</section></details>
<section id="chat" aria-label="Agent chat">
<div id="log" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" tabindex="0"><div class="welcome" id="welcome"><h2>What are we working on?</h2><p>Describe the result you need. Review permissions before sensitive actions, then track real progress in Tasks.</p><p class="muted" id="hint"></p></div></div>
<section class="budgets" aria-label="Optional task limits">
<label for="token-budget">Token limit<input id="token-budget" inputmode="numeric" placeholder="Default"></label>
<label for="money-budget">Cost stop threshold (USD estimate)<input id="money-budget" inputmode="decimal" placeholder="Default"></label>
<label for="time-budget">Time limit (seconds)<input id="time-budget" inputmode="numeric" placeholder="Runtime default" aria-describedby="time-budget-help"></label>
<p class="muted" id="time-budget-help">Waiting and restart downtime count toward the time limit. Recovery does not reset it.</p>
</section>
<form id="form"><label class="sr" for="text">Message to August</label><textarea id="text" rows="2" autocomplete="off" placeholder="Describe a task or ask a question…" aria-describedby="composer-help"></textarea><button type="submit" id="send">Send</button></form>
<p class="composer-note" id="composer-help">Enter to send · Shift + Enter for a new line. Verify important results.</p>
</section>
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
  hint.textContent = token ? "Checking your local runtime…" : "Open the link printed by \\"august serve\\" to connect.";
  const connection = document.getElementById("connection"), send = document.getElementById("send"), activity = document.getElementById("activity");
  let messageBusy = false, connected = false;
  function connectionState(ready, message) {
    connected = ready; connection.dataset.state = ready ? "ready" : "unavailable"; connection.textContent = message;
    send.disabled = !ready || messageBusy; input.disabled = !ready;
    document.getElementById("reconnect").hidden = ready || !token;
  }
  connectionState(false, token ? "Checking connection…" : "Not connected");
  const views = { chat: ["Chat", "Work with your agent. Stay in control."], tasks: ["Tasks", "Progress, usage and safe continuation."], credentials: ["Secrets", "Credentials stay out of your conversation."] };
  function showView(view) {
    if (!Object.hasOwn(views, view)) return;
    for (const id of Object.keys(views)) { const panel = document.getElementById(id); panel.hidden = id !== view; if (panel.tagName === "DETAILS") panel.open = id === view; }
    for (const button of document.querySelectorAll("[data-view]")) { if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
    document.getElementById("view-title").textContent = views[view][0]; document.getElementById("view-description").textContent = views[view][1];
  }
  for (const button of document.querySelectorAll("[data-view]")) button.onclick = () => showView(button.dataset.view);
  const who = { channel: "web", user: "local" };
  const headers = () => ({ "content-type": "application/json", authorization: "Bearer " + token });
  async function loadAudit() {
    if (!token || !connected) return;
    const status = document.getElementById("audit-status");
    try {
      const response = await fetch("/v1/audit", { headers: headers() });
      const body = await response.json();
      if (!response.ok || !["not-configured","pending","published","unavailable","conflict"].includes(body.state) || !Number.isSafeInteger(body.anchoredThrough) || !Number.isSafeInteger(body.localThrough)) throw new Error();
      status.hidden = false;
      status.textContent = body.state === "not-configured" ? "Audit protection is local only. Configure an independent anchor sink to detect deletion of local audit evidence." : body.state === "published" ? "External audit retained through entry " + body.anchoredThrough + ". Tail gap: " + Math.max(0, body.localThrough - body.anchoredThrough) + " retained entries. Removal beyond the last anchor is unknown." : body.state === "conflict" ? "Audit conflict: retained independent evidence does not match local history. No repair was attempted." : body.state === "pending" ? "External audit publication is pending; independent coverage is not yet confirmed." : "External audit unavailable. Local history is retained, but independent coverage is not confirmed.";
    } catch { status.hidden = false; status.textContent = "Audit status unavailable; independent integrity is not established."; }
  }
  setInterval(() => { void loadAudit(); }, 5000);
  async function loadProviders() {
    if (!token || !connected) return;
    const status = document.getElementById("provider-status");
    try {
      const response = await fetch("/v1/providers", { headers: headers() }), body = await response.json();
      if (!response.ok || !Array.isArray(body.providers) || body.providers.some(p => typeof p.provider !== "string" || !["closed","open","half-open"].includes(p.state))) throw new Error();
      status.title = body.providers.map(p => p.provider).join("; ");
      status.textContent = body.providers.length ? "Provider admission (not a live health guarantee): " + body.providers.map(p => p.provider.replace(/#[0-9a-f]{32}$/, "") + " · " + p.state + (Number.isSafeInteger(p.retryAt) ? " · next probe " + new Date(p.retryAt).toLocaleTimeString() : "")).join("; ") : "Provider health is unavailable for this adapter.";
    } catch { status.textContent = "Provider circuit status unavailable; availability is not established."; }
  }
  setInterval(() => { void loadProviders(); }, 5000);
  async function verifyConnection() {
    if (!token) return;
    try { const r = await fetch("/v1/runs?channel=" + who.channel + "&user=" + who.user + "&limit=1", { headers: headers() });
      const body = await r.json().catch(() => ({}));
      const ready = r.ok && Array.isArray(body.runs);
      connectionState(ready, ready ? "Runtime connected" : "Connection unavailable");
      hint.textContent = ready ? "Connected to your local runtime." : "Check the gateway and reopen its connection link.";
      if (ready) { void loadAudit(); void loadProviders(); }
    } catch { connectionState(false, "Runtime unreachable"); hint.textContent = "Start your gateway, then reload this page."; }
  }
  verifyConnection();
  document.getElementById("reconnect").onclick = () => verifyConnection();
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
  const add = (text, cls) => { document.getElementById("welcome")?.remove(); const d = document.createElement("div"); d.className = "msg " + (cls || ""); d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const taskPanel = document.getElementById("tasks"), taskList = document.getElementById("task-list"), taskStatus = document.getElementById("task-status");
  let taskTimer = null, taskLoading = false, taskFingerprint = "";
  const controlling = new Set();
  const receiptDrafts = new Map();
  const usd = value => { const n = BigInt(value); return (n / 1000000n).toString() + "." + (n % 1000000n).toString().padStart(6, "0"); };
  async function loadTasks() {
    if (!token || taskLoading) return;
    taskLoading = true;
    try {
      const response = await fetch("/v1/runs?channel=" + who.channel + "&user=" + who.user + "&limit=20", { headers: headers() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.runs)) { taskList.replaceChildren(); taskFingerprint = ""; taskStatus.textContent = "Tasks unavailable. Check your connection."; if ([401, 403].includes(response.status)) connectionState(false, "Connection rejected"); return; }
      const fingerprint = JSON.stringify(body.runs) + Array.from(controlling).join(",");
      if (fingerprint === taskFingerprint) return;
      const focused = taskList.contains(document.activeElement) ? { id: document.activeElement.id, run: document.activeElement.dataset.run, action: document.activeElement.dataset.action } : null;
      taskFingerprint = fingerprint; taskList.replaceChildren();
      taskStatus.textContent = body.runs.length ? "Runtime state and recorded usage." : "No tasks in this session yet.";
      for (const run of body.runs) {
        const item = document.createElement("li"), title = document.createElement("p"), metrics = document.createElement("p"), request = document.createElement("p");
        title.className = "task-title"; const state = document.createElement("span"), id = document.createElement("span"); state.className = "task-state"; state.textContent = run.state.replaceAll("_", " "); id.className = "task-id"; id.textContent = run.id; title.append(state, id); metrics.className = "muted";
        metrics.textContent = run.steps + "/" + run.budget.maxSteps + " steps · " + run.usage.totalTokens + "/" + run.budget.maxTokens + " recorded tokens (" + run.usage.inputTokens + " in / " + run.usage.outputTokens + " out) · USD " + usd(run.usage.costMicros) + "/" + usd(run.budget.maxCostMicros) + " estimate";
        request.className = "task-request"; request.textContent = run.request.slice(0, 600); item.append(title, request, metrics);
        if (run.reply) { const reply = document.createElement("p"); reply.className = "task-reply"; reply.textContent = run.reply; item.appendChild(reply); }
        if (run.accounting?.unresolvedCalls) {
          const warning = document.createElement("p"); warning.className = "billing-warning";
          warning.textContent = "Usage receipt pending for " + run.accounting.unresolvedCalls + " call(s). Held allowance: " + run.accounting.reservedTokens + " tokens / USD " + usd(run.accounting.reservedCostMicros) + ". This is a hold, not a bill or proof of zero charge." + (run.accounting.unknownCalls || !["created","running","waiting_approval","waiting_external","verifying"].includes(run.state) ? " Further generation needs reconciliation." : " Generation is in progress; the receipt will settle this hold.");
          item.appendChild(warning);
          for (const attempt of run.unresolvedAttempts || []) if (attempt.state === "unknown") {
            const estimate = document.createElement("p"); estimate.className = "billing-warning";
            estimate.textContent = (attempt.failure === "timeout" ? "Timed out call: " : "Interrupted call: ") + "estimated upper-bound allowance exposure " + attempt.reservedTokens + " tokens / USD " + usd(attempt.reservedCostMicros) + " is held. Billing is unknown; this estimate is not a usage receipt or a settled charge.";
            item.appendChild(estimate);
          }
          if (!["created","running","waiting_approval","waiting_external","verifying"].includes(run.state)) for (const attempt of run.unresolvedAttempts || []) addReconciliation(item, attempt);
        }
        if (run.accounting?.ownerReceipts) { const manual = document.createElement("p"); manual.className = "muted"; manual.textContent = "Includes " + run.accounting.ownerReceipts + " owner-reconciled estimate(s), not provider receipts."; item.appendChild(manual); }
        if (run.accounting?.legacyUsage) { const legacy = document.createElement("p"); legacy.className = "muted"; legacy.textContent = "Legacy usage predates the attempt ledger. Earlier unreported billing cannot be reconstructed automatically."; item.appendChild(legacy); }
        if (run.feedbackId && !run.feedbackRecorded) judge(item, run.id, run.feedbackId);
        if (run.feedbackRecorded) { const recorded = document.createElement("p"); recorded.className = "muted"; recorded.textContent = "Your assessment is recorded for this result."; item.appendChild(recorded); }
        if (run.state === "recovering" && !run.canResume) { const caution = document.createElement("p"); caution.textContent = "Continuation blocked: an external effect may be uncertain. Owner resolution is required."; item.appendChild(caution); }
        const active = ["created", "running", "waiting_approval", "waiting_external", "paused", "recovering"].includes(run.state);
        const actions = [...(active && run.state !== "paused" && run.state !== "recovering" ? [["Pause", "pause"]] : []), ...(run.canResume ? [["Continue", "resume"]] : []), ...(active ? [["Cancel further work", "cancel"]] : [])];
        for (const [label, action] of actions) {
          const button = document.createElement("button"), key = run.id + ":" + action;
          button.type = "button"; button.textContent = controlling.has(key) ? label + " requested…" : label;
          button.dataset.run = run.id; button.dataset.action = action; button.setAttribute("aria-label", label + " task " + run.id); button.disabled = controlling.has(key);
          button.onclick = async () => {
            if (controlling.has(key)) return;
            controlling.add(key); button.disabled = true; taskStatus.textContent = label + " requested; waiting for the runtime.";
            let failed = false;
            const poll = setInterval(() => checkPending().catch(() => {}), 1000);
            try {
              const r = await fetch("/v1/runs/" + encodeURIComponent(run.id), { method: "POST", headers: headers(), body: JSON.stringify({ ...who, action }) });
              if (!r.ok) throw new Error();
            } catch { failed = true; }
            finally { clearInterval(poll); controlling.delete(key); taskFingerprint = ""; await loadTasks(); if (failed) taskStatus.textContent = "Could not complete that control. Refresh the authoritative state before retrying."; }
          };
          item.appendChild(button);
        }
        taskList.appendChild(item);
      }
      if (focused) { const element = focused.id ? document.getElementById(focused.id) : focused.run && focused.action ? Array.from(taskList.querySelectorAll("button")).find(b => b.dataset.run === focused.run && b.dataset.action === focused.action) : null; if (element && !element.disabled) element.focus({ preventScroll: true }); }
    } catch { taskStatus.textContent = "Runtime is not reachable."; connectionState(false, "Runtime unreachable"); }
    finally { taskLoading = false; }
  }
  document.getElementById("task-refresh").disabled = !token;
  function addReconciliation(item, attempt) {
    const receipt = document.createElement("form"); receipt.className = "receipt-form";
    const intro = document.createElement("p"); intro.className = "receipt-confirm muted";
    intro.textContent = "Reconcile " + attempt.model + " · " + attempt.id + ". Frozen quote: " + attempt.quote.inputMicrosPerMillion + " input / " + attempt.quote.outputMicrosPerMillion + " output microdollars per million tokens.";
    receipt.appendChild(intro);
    const draft = receiptDrafts.get(attempt.id) || { input: "", output: "", confirm: false };
    const fields = [];
    for (const [key,label] of [["input","Input tokens"],["output","Output tokens"]]) {
      const row = document.createElement("label"), field = document.createElement("input");
      field.type = "number"; field.min = "0"; field.step = "1"; field.required = true; field.max = String(Number.MAX_SAFE_INTEGER); field.value = draft[key];
      field.id = "receipt-" + attempt.id + "-" + key; row.htmlFor = field.id; row.textContent = label;
      field.oninput = () => { draft[key] = field.value; receiptDrafts.set(attempt.id, draft); }; row.appendChild(field); receipt.appendChild(row); fields.push(field);
    }
    const row = document.createElement("label"), confirm = document.createElement("input"); row.className = "receipt-confirm";
    confirm.type = "checkbox"; confirm.required = true; confirm.checked = draft.confirm; confirm.id = "receipt-" + attempt.id + "-confirm"; row.htmlFor = confirm.id;
    confirm.onchange = () => { draft.confirm = confirm.checked; receiptDrafts.set(attempt.id, draft); };
    row.append(confirm, document.createTextNode(" I checked the receipt/estimate. This records my reconciliation, not a provider receipt.")); receipt.appendChild(row);
    const save = document.createElement("button"); save.type = "submit"; save.id = "receipt-" + attempt.id + "-save"; save.textContent = "Record owner reconciliation"; receipt.appendChild(save);
    receipt.onsubmit = async e => {
      e.preventDefault(); const inputTokens = Number(fields[0].value), outputTokens = Number(fields[1].value);
      if (!confirm.checked || ![inputTokens,outputTokens,inputTokens+outputTokens].every(Number.isSafeInteger) || inputTokens < 0 || outputTokens < 0) return;
      save.disabled = true;
      try {
        const response = await fetch("/v1/model-attempts/" + encodeURIComponent(attempt.id), { method: "POST", headers: headers(), body: JSON.stringify({ ...who, inputTokens, outputTokens, confirm: true }) });
        if (!response.ok) throw Error(); receiptDrafts.delete(attempt.id); taskFingerprint = ""; await loadTasks(); taskStatus.textContent = "Owner reconciliation recorded. It does not certify a vendor bill.";
      } catch { taskStatus.textContent = "Could not record reconciliation. Check task state before retrying."; save.disabled = false; }
    };
    item.appendChild(receipt);
  }
  document.getElementById("task-refresh").onclick = () => { taskFingerprint = ""; loadTasks(); };
  taskPanel.ontoggle = () => {
    if (taskTimer) clearInterval(taskTimer); taskTimer = null;
    if (taskPanel.open && token) { loadTasks(); taskTimer = setInterval(loadTasks, 1000); }
  };
  let shown = null;
  // An answered request stays in the log as a record, no longer a dialog.
  const resolved = (card) => { card.querySelectorAll("button").forEach((x) => x.remove()); card.removeAttribute("role"); card.removeAttribute("aria-labelledby"); card.removeAttribute("aria-describedby"); card.removeAttribute("tabindex"); };
  const clear = () => { if (shown) { shown.card.remove(); shown = null; } };
  async function answer(approval, allow, label) {
    const card = shown && shown.card;
    if (card) card.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    let r;
    try { r = await fetch("/v1/approve", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, approvalId: approval.id, nonce: approval.nonce, allow }) }); }
    catch { if (card) { card.querySelectorAll("button").forEach(x => { x.disabled = false; }); const error = document.createElement("p"); error.setAttribute("role", "status"); error.textContent = "Could not confirm your decision. Check the connection and retry."; card.appendChild(error); } return; }
    if (card) { resolved(card); card.appendChild(document.createTextNode("\\n" + (r.ok ? "→ " + label : "This request is no longer open."))); }
    shown = null; input.focus();
  }
  async function checkPending() {
    const r = await fetch("/v1/pending?channel=" + who.channel + "&user=" + who.user, { headers: headers() });
    if (!r.ok) return;
    const { approval } = await r.json();
    if (!approval) { if (shown) { resolved(shown.card); shown.card.appendChild(document.createTextNode("\\nApproval is no longer pending. Check the task state.")); shown = null; } return; }
    if (shown && shown.id === approval.id) return;
    clear();
    showView("chat"); document.getElementById("welcome")?.remove();
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
  function judge(card, runId, feedbackId) {
    const bar = document.createElement("div"); bar.className = "judge"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Was this answer right?");
    for (const [label, verdict, aria] of [["Good answer", "success", "Mark this answer as good"], ["Not right", "failure", "Mark this answer as not right"]]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.setAttribute("aria-label", aria);
      b.onclick = async () => {
        bar.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        const r = await fetch("/v1/feedback", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, runId, feedbackId, verdict }) }).catch(() => null);
        bar.textContent = r && r.ok ? "Thank you." : "Could not record that.";
      };
      bar.appendChild(b);
    }
    card.appendChild(bar);
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text || !token || !connected || messageBusy) return;
    const budget = {};
    const tokens = document.getElementById("token-budget").value.trim();
    const dollars = document.getElementById("money-budget").value.trim().replace(",", ".");
    const seconds = document.getElementById("time-budget").value.trim();
    if (seconds) {
      const wallMs = Number(seconds) * 1000;
      if (!/^[0-9]+$/.test(seconds) || !Number.isSafeInteger(wallMs) || wallMs < 1000) { add("Enter a positive whole time limit in seconds."); return; }
      budget.maxWallMs = wallMs;
    }
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
    messageBusy = true; send.disabled = true; activity.textContent = "Task running · controls in Tasks";
    input.value = ""; add(text, "me");
    const wait = add("Working on your task. You can pause or cancel further work in Tasks.", "muted");
    const timer = setInterval(() => checkPending().catch(() => {}), 1000);
    try {
      const r = await fetch("/v1/message", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, text, ...(Object.keys(budget).length ? { budget } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) connectionState(false, "Connection rejected");
      wait.remove(); const shownReply = add(r.ok ? body.reply : "Error: " + (body.error || r.status));
      if (r.ok && body.runId && body.feedbackId && (body.state === undefined || body.state === "completed")) judge(shownReply, body.runId, body.feedbackId);
    } catch { wait.remove(); connectionState(false, "Runtime unreachable"); add("Response unavailable. Check Tasks before sending again: work may still be running."); }
    finally { clearInterval(timer); messageBusy = false; send.disabled = !connected; activity.textContent = ""; if (shown) { resolved(shown.card); shown = null; } }
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
})();
`;
