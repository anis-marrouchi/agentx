import type { IncomingMessage, ServerResponse } from "http"
import { isOffBox, pageToken } from "./dashboard-session"
import { renderShell } from "./ui/shell"
import { HUB_NAME } from "./ui/hub-name"
import { OwnerBrowserStore } from "@/members/owner-browsers"
import type { MemberStore } from "@/members/store"

// --- Sign-in requests: the owner's browsers, confirmed here (#1478, Decision 8) ---
//
// The owner's first sign-in by email link from a new browser waits until
// it is confirmed on the home machine itself. This page and its API answer
// a caller on this machine only (isOffBox false): never a phone, never a
// browser signed in from elsewhere, not even one that holds ax_session.
// Writes need X-Requested-With, so another site in the owner's browser
// cannot press Confirm; the /api/admin gate in board-dashboard.ts asks for
// the dashboard token, which this page carries as AX_LOCAL_TOKEN.
//
//   GET  /signin-requests                             the page
//   GET  /api/admin/owner-signins                     every owner browser
//   POST /api/admin/owner-signins/<id>/confirm        let a waiting sign-in in
//   POST /api/admin/owner-signins/<id>/refuse         refuse it
//   POST /api/admin/owner-signins/<id>/end            forget a confirmed browser

export const SIGNIN_REQUESTS_PATH = "/signin-requests"
export const OWNER_SIGNINS_API = "/api/admin/owner-signins"

export interface OwnerSignInPanelDeps {
  browsers: OwnerBrowserStore
  members: MemberStore
  /** dashboard.token, for the page's AX_LOCAL_TOKEN. */
  token?: string
  log?: (line: string) => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}

/** Returns false when the path is not one of ours. */
export async function handleOwnerSignInPanel(req: IncomingMessage, res: ServerResponse, path: string, deps: OwnerSignInPanelDeps): Promise<boolean> {
  if (path !== SIGNIN_REQUESTS_PATH && path !== OWNER_SIGNINS_API && !path.startsWith(`${OWNER_SIGNINS_API}/`)) return false
  const method = (req.method || "GET").toUpperCase()
  const log = deps.log ?? ((line: string) => console.log(line))

  if (isOffBox(req)) {
    if (path === SIGNIN_REQUESTS_PATH) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(renderOffBoxPage())
      return true
    }
    return sendJson(res, 403, { error: "sign-in requests are answered on the home machine only" })
  }

  if (path === SIGNIN_REQUESTS_PATH) {
    if (method !== "GET") return sendJson(res, 405, { error: "GET only" })
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(renderSignInRequestsPage(pageToken(req, deps.token)))
    return true
  }

  if (method === "GET" && path === OWNER_SIGNINS_API) {
    const browsers = deps.browsers.list()
    return sendJson(res, 200, { browsers, waiting: browsers.filter((b) => b.state === "pending" && !b.expired).length })
  }

  if (method !== "POST") return sendJson(res, 405, { error: "GET or POST" })
  if (req.headers["x-requested-with"] !== "agentx-board") return sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
  const m = path.match(/^\/api\/admin\/owner-signins\/([a-f0-9]{16})\/(confirm|refuse|end)$/)
  if (!m) return sendJson(res, 404, { error: "not found" })
  const [, id, action] = m
  const done = action === "end" ? deps.browsers.end(id) : deps.browsers.decide(id, action as "confirm" | "refuse")
  if (!done) return sendJson(res, 404, { error: action === "end" ? "no confirmed browser with this id" : "no sign-in waiting with this id (it may have waited more than 15 minutes)" })
  const event = action === "confirm" ? "approved" : action === "refuse" ? "refused" : "removed"
  const said = action === "confirm" ? "confirmed" : action === "refuse" ? "refused" : "ended"
  deps.members.log({ person: done.personId, event, detail: `${done.label} (owner browser): ${said} on the home machine` })
  log(`[member] owner browser "${done.label}" (${done.id}) ${said} on the home machine`)
  const { hash: _, ...browser } = done
  return sendJson(res, 200, { ok: true, browser })
}

function renderOffBoxPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in requests · AgentX</title>
<style>body{font:15px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.5}</style></head>
<body><h1 style="font-size:20px">Open this on the home machine</h1>
<p>A new browser signing in as the owner is confirmed on the computer that runs AgentX, with its dashboard opened there. Not from a phone, and not from another computer.</p></body></html>`
}

const PAGE_CSS = `
.osr{max-width:46rem;margin:0 auto;display:grid;gap:var(--ax-gap,16px)}
.osr h1{font-size:20px;margin:0}
.osr__sub{color:var(--ax-muted);margin:0}
.osr__list{display:grid;gap:12px;list-style:none;margin:0;padding:0}
.osr__item{border:1px solid var(--ax-border);border-radius:var(--ax-radius);padding:12px 14px;background:var(--ax-bg-elev);display:grid;gap:6px}
.osr__top{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between}
.osr__name{font-weight:600}
.osr__check{font:600 20px/1.2 var(--ax-mono,ui-monospace,monospace);letter-spacing:.08em}
.osr__meta{color:var(--ax-muted);font-size:var(--ax-fs-sm,13px)}
.osr__acts{display:flex;gap:8px;flex-wrap:wrap}
.osr__empty{color:var(--ax-muted)}
.osr__msg{min-height:1.2em;margin:0}
`

const PAGE_SCRIPT = `
(function () {
  var list = document.getElementById('osr-list'), waitList = document.getElementById('osr-waiting'), msg = document.getElementById('osr-msg');
  var auth = window.AX_LOCAL_TOKEN ? { Authorization: 'Bearer ' + window.AX_LOCAL_TOKEN } : {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function when(iso) { try { return new Date(iso).toLocaleString(); } catch (x) { return iso; } }
  function row(b, buttons) {
    var where = 'From ' + esc(b.address) + (b.login ? ', network login ' + esc(b.login) : '') + '. Started ' + esc(when(b.createdAt)) + '.';
    return '<li class="osr__item"><div class="osr__top"><span class="osr__name">' + esc(b.label) + '</span>' +
      (b.state === 'pending' ? '<span class="osr__check" aria-label="Check code">' + esc(b.check) + '</span>' : '<span class="ax-badge">' + esc(b.state) + '</span>') +
      '</div><div class="osr__meta">' + where + (b.lastSignInAt && b.state === 'confirmed' ? ' Last sign-in ' + esc(when(b.lastSignInAt)) + '.' : '') + '</div>' +
      (buttons ? '<div class="osr__acts">' + buttons + '</div>' : '') + '</li>';
  }
  function load() {
    fetch('${OWNER_SIGNINS_API}', { headers: auth, credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var all = j.browsers || [];
      var waiting = all.filter(function (b) { return b.state === 'pending' && !b.expired; });
      var known = all.filter(function (b) { return b.state === 'confirmed'; });
      waitList.innerHTML = waiting.length ? waiting.map(function (b) {
        return row(b, '<button type="button" class="ax-btn ax-btn--primary" data-act="confirm" data-id="' + b.id + '">Confirm</button>' +
          '<button type="button" class="ax-btn ax-btn--ghost" data-act="refuse" data-id="' + b.id + '">Refuse</button>');
      }).join('') : '<li class="osr__empty">No sign-in is waiting.</li>';
      list.innerHTML = known.length ? known.map(function (b) {
        return row(b, '<button type="button" class="ax-btn ax-btn--ghost" data-act="end" data-id="' + b.id + '">End</button>');
      }).join('') : '<li class="osr__empty">No browser is confirmed yet.</li>';
    }).catch(function () { msg.textContent = 'Could not load the sign-in requests. Refresh the page.'; });
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'refuse' && !confirm('Refuse this sign-in?')) return;
    if (act === 'end' && !confirm('Forget this browser? Its next sign-in will ask here again.')) return;
    btn.disabled = true;
    var headers = Object.assign({ 'X-Requested-With': 'agentx-board' }, auth);
    fetch('${OWNER_SIGNINS_API}/' + btn.getAttribute('data-id') + '/' + act, { method: 'POST', headers: headers, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        msg.textContent = r.ok ? (act === 'confirm' ? 'Confirmed. That browser opens the ${HUB_NAME} within a few seconds.' : act === 'refuse' ? 'Refused.' : 'Ended.') : (r.body.error || 'That did not work.');
        load();
      }).catch(function () { btn.disabled = false; msg.textContent = 'No connection.'; });
  });
  load();
  setInterval(load, 5000);
})();
`

export function renderSignInRequestsPage(localToken?: string): string {
  const body = `<div class="osr">
  <header>
    <h1>Sign-in requests</h1>
    <p class="osr__sub">A new browser that signs in as the owner by email link waits here. Confirm it only if the code matches the one on that browser's screen.</p>
  </header>
  <p id="osr-msg" class="osr__msg" role="status" aria-live="polite"></p>
  <section aria-labelledby="osr-h-wait"><h2 id="osr-h-wait">Waiting</h2><ul class="osr__list" id="osr-waiting"><li class="osr__empty">Loading…</li></ul></section>
  <section aria-labelledby="osr-h-known"><h2 id="osr-h-known">Confirmed browsers</h2>
    <p class="osr__sub">These go straight in on their next email link. End one to make it ask here again. Ending does not sign it out now; changing the dashboard token does.</p>
    <ul class="osr__list" id="osr-list"></ul></section>
</div>`
  return renderShell({
    title: "AgentX · Sign-in requests",
    activeTab: "people",
    subtitle: "Sign-in requests",
    body,
    css: PAGE_CSS,
    localToken,
    noAssistant: true,
    scripts: `<script>${PAGE_SCRIPT}</script>`,
  })
}
