/**
 * Server-rendered HTML for the authorize flow. Monochrome ZyroPay styling, no external
 * assets, one nonce'd inline script that polls the connection status. Every string that
 * reaches the page is escaped: client names and URIs come from DCR or CIMD documents,
 * i.e. from whoever registered the client.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`=]/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#6b6b6b;--line:#e5e5e5;--chip:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#9a9a9a;--line:#262626;--chip:#161616}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
main{width:100%;max-width:420px}
.brand{font-weight:700;letter-spacing:.18em;font-size:12px;text-transform:uppercase}
h1{font-size:22px;line-height:1.25;margin:28px 0 8px;font-weight:650}
p{margin:0 0 12px;color:var(--muted)}
strong{color:var(--fg);font-weight:600}
.code{margin:28px 0;padding:22px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);text-align:center}
.code span{display:block;font:600 34px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}
.code small{display:block;margin-top:10px;color:var(--muted);font-size:13px}
dl{margin:0 0 20px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14px}
dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.warn{background:var(--chip);padding:10px 12px;border-radius:8px;color:var(--fg);font-size:14px}
.status{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted);margin:16px 0}
.dot{width:8px;height:8px;border-radius:50%;background:var(--fg);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
button{appearance:none;border:1px solid var(--fg);background:var(--fg);color:var(--bg);font:inherit;font-weight:600;padding:11px 16px;border-radius:999px;width:100%;cursor:pointer}
button.secondary{background:transparent;color:var(--fg)}
ol{padding-left:18px;margin:0 0 16px;color:var(--muted)}li{margin:2px 0}
`;

function layout(title: string, nonce: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ZyroPay</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main><div class="brand">ZyroPay</div>${body}</main>${script}</body>
</html>`;
}

export interface WaitingPageInput {
  nonce: string;
  clientName: string;
  clientDomain: string | null;
  redirectHost: string;
  redirectIsLoopback: boolean;
  userCode: string;
  expiresAt: string;
  handle: string;
  ticket: string;
}

export function renderWaitingPage(input: WaitingPageInput): string {
  const name = escapeHtml(input.clientName);
  const publisher = input.clientDomain
    ? `<dd>Published by <strong>${escapeHtml(input.clientDomain)}</strong></dd>`
    : `<dd>Self-registered; name not verified</dd>`;
  const loopbackWarning = input.redirectIsLoopback
    ? `<p class="warn">Access will be sent to an app on this computer. Continue only if you just started connecting from it.</p>`
    : "";
  const body = `
<h1>Connect ${name} to your wallet</h1>
<p>Approve this connection in the ZyroPay app. The agent starts with <strong>Always Ask</strong>: it can read balances and request payments, and every payment needs your passkey approval.</p>
<div class="code" aria-live="polite"><span id="code">${escapeHtml(input.userCode)}</span><small>Expires <time datetime="${escapeHtml(input.expiresAt)}">${escapeHtml(input.expiresAt.replace("T", " ").slice(0, 16))} UTC</time></small></div>
<ol><li>Open the ZyroPay app.</li><li>Go to <strong>Agents</strong> and tap <strong>Connect</strong>.</li><li>Enter the code above, check the details, and approve.</li></ol>
<dl><dt>App</dt><dd>${name}</dd><dt>Publisher</dt>${publisher}<dt>Redirects to</dt><dd>${escapeHtml(input.redirectHost)}</dd></dl>
${loopbackWarning}
<div class="status" id="status"><span class="dot"></span><span id="status-text">Waiting for approval in the ZyroPay app…</span></div>
<form method="post" action="/authorize" id="continue">
<input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
<button type="submit" class="secondary">I approved it, continue</button>
</form>`;
  const script = `<script nonce="${input.nonce}">
(function(){var t=${JSON.stringify(input.ticket).replace(/</g, "\\u003c")};var done=false;
function poll(){if(done)return;fetch("/authorize/status?ticket="+encodeURIComponent(t),{headers:{Accept:"application/json"},cache:"no-store"})
.then(function(r){return r.ok?r.json():null}).then(function(s){if(!s)return;if(s.status!=="pending"){done=true;
document.getElementById("status-text").textContent=s.status==="approved"?"Approved. Finishing…":"Finishing…";document.getElementById("continue").submit();}})
.catch(function(){}).finally(function(){if(!done)setTimeout(poll,2000)});}
setTimeout(poll,2000);})();
</script>`;
  return layout(`Connect ${input.clientName}`, input.nonce, body, script);
}

export function renderMessagePage(nonce: string, title: string, message: string): string {
  return layout(title, nonce, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function pageHeaders(nonce: string, formActionOrigins: string[] = []): Headers {
  const formAction = ["'self'", ...formActionOrigins].join(" ");
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}
