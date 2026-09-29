/** The chat page served by the gateway at "/". No framework, no external requests, text rendered with textContent only. */
export const WEB_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>August</title>
<style>
  :root { --bg:#faf9f7; --fg:#1d1c1a; --muted:#6b6862; --card:#fff; --line:#e6e3de; --accent:#2f5d50; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe8; --muted:#a09d97; --card:#1f1f1d; --line:#2e2d2a; --accent:#7fb8a4; --warn:#e0b25a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; display:flex; flex-direction:column; height:100vh; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); font-weight:600; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; max-width:760px; width:100%; margin:0 auto; }
  .msg { padding:10px 12px; border-radius:10px; background:var(--card); border:1px solid var(--line); white-space:pre-wrap; word-wrap:break-word; }
  .me { align-self:flex-end; background:var(--accent); color:var(--bg); border:none; max-width:85%; }
  .ask { border-color:var(--warn); }
  .ask button { margin:8px 8px 0 0; padding:6px 14px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  .muted { color:var(--muted); font-size:13px; }
  form { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); max-width:760px; width:100%; margin:0 auto; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--fg); font:inherit; }
  button[type=submit] { padding:10px 16px; border-radius:10px; border:none; background:var(--accent); color:var(--bg); font:inherit; cursor:pointer; }
</style>
</head>
<body>
<header>August</header>
<div id="log"><div class="muted" id="hint"></div></div>
<form id="form"><input id="text" autocomplete="off" placeholder="Message"><button type="submit">Send</button></form>
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
  async function checkPending() {
    const r = await fetch("/v1/pending?channel=web&user=local", { headers: headers() });
    if (!r.ok) return;
    const { approval } = await r.json();
    if (!approval || shown) return;
    const card = add(approval.tool + " wants to run: " + approval.reason + (approval.details ? "\\n" + approval.details : "") + "\\n" + JSON.stringify(approval.args, null, 2), "ask");
    shown = card;
    for (const [label, allow] of [["Allow once", true], ["Deny", false]]) {
      const b = document.createElement("button"); b.textContent = label;
      b.onclick = async () => { card.querySelectorAll("button").forEach((x) => x.remove()); card.appendChild(document.createTextNode("\\n→ " + label)); shown = null;
        await fetch("/v1/approve", { method: "POST", headers: headers(), body: JSON.stringify({ ...who, allow }) }); };
      card.appendChild(b);
    }
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
      wait.remove(); add(r.ok ? body.reply : "Error: " + (body.error || r.status));
    } catch { wait.remove(); add("The agent is not reachable."); }
    finally { clearInterval(timer); if (shown) { shown.querySelectorAll("button").forEach((x) => x.remove()); shown = null; } }
  };
})();
`;
