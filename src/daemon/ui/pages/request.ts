import { renderShell, esc, type TopbarPeer } from ".."

// --- Request page — the one home of a task (#1170) ---
//
// A piece of work shows up in many places: a running card on Live, a bar on
// Activity, a review on Monitor, a card on the Desk, a row on Approvals, an
// issue on Boards. Each of those is a view; this page is where the task
// lives. Every view links here, and this page links back out to each run,
// delegation, card and issue the request collected (request_links).
//
// Read-only by design: replying, handing off and closing stay on Approvals,
// which this page links to, so there is one place to act as well as one
// place to look.
//
// Reads: GET /api/admin/approvals/requests/home?id=   (requests-panel.ts)
// ?peer= reads the request from another node, through the admin proxy.

export interface RequestPageOpts {
  requestId: string
  /** A mesh peer's id or URL, when the request is on another node. */
  peer?: string
  peers?: TopbarPeer[]
  localToken?: string
}

export function renderRequestPage(opts: RequestPageOpts): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const body = `<div class="ax-req" data-id="${esc(opts.requestId)}" data-peer="${esc(opts.peer || "")}">
  <nav class="ax-crumbs" aria-label="Breadcrumb">
    <a href="/approvals#req-section">Requests</a>
    <span class="ax-crumbs__sep">/</span>
    <code class="ax-crumbs__here">${esc(opts.requestId)}</code>
  </nav>
  <p class="ax-req__lead">This is the home of one task. Live, Activity, Monitor, the Desk, Approvals and Boards all link here.</p>
  <div id="req-body" aria-live="polite"><p class="ax-muted">Loading…</p></div>
</div>`

  return renderShell({
    title: `AgentX · Request ${opts.requestId}`,
    activeTab: "approvals",
    subtitle: "Request",
    peers: opts.peers,
    body,
    css: REQUEST_PAGE_CSS,
    scripts: `${tokenScript}<script>${REQUEST_PAGE_JS}</script>`,
  })
}

const REQUEST_PAGE_CSS = `
.ax-req { max-width: 900px; margin: 0 auto; padding: 22px var(--ax-pad) var(--ax-pad); display: flex; flex-direction: column; gap: var(--ax-gap); }
.ax-crumbs { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-sm); min-width: 0; flex-wrap: wrap; }
.ax-crumbs a { color: var(--ax-text-2); font-weight: 600; text-decoration: none; }
.ax-crumbs a:hover, .ax-crumbs a:focus-visible { color: var(--ax-accent); }
.ax-crumbs__sep { color: var(--ax-border-2); }
.ax-crumbs__here { overflow-wrap: anywhere; }
.ax-req__lead { margin: 0; color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.ax-req__card { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: var(--ax-pad); display: flex; flex-direction: column; gap: 10px; }
.ax-req__title { margin: 0; font-size: 1.25rem; line-height: 1.3; overflow-wrap: anywhere; }
.ax-req__meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.ax-req__state { font-weight: 700; color: var(--ax-text); }
.ax-req__need { margin: 0; }
.ax-req__section { margin: 0; font-size: var(--ax-fs-sm); text-transform: uppercase; letter-spacing: .04em; color: var(--ax-text-2); }
.ax-req__links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ax-req__links li { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: var(--ax-fs-sm); }
.ax-req__links code, .ax-req__links a { overflow-wrap: anywhere; }
.ax-req__kind { min-width: 7em; color: var(--ax-text-2); }
.ax-req__md { overflow-wrap: anywhere; }
.ax-req__acts { display: flex; gap: 8px; flex-wrap: wrap; }
`

const REQUEST_PAGE_JS = `
(function(){
var root = document.querySelector('.ax-req');
var ID = root.dataset.id, PEER = root.dataset.peer;
var STATE = { in_progress: 'In progress', waiting_owner: 'Waiting on you', waiting_other: 'Waiting on another agent', needs_attention: 'Needs attention', done: 'Done', declined: 'Declined', dropped: 'Dropped' };
var KIND = { run: 'Agent run', delegation: 'Handed to', card: 'Decision card', workflow: 'Workflow run', watcher: 'Watcher', issue: 'Issue', idea: 'Idea', approval: 'Approval', erp: 'ERP record' };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function when(ms){ return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''; }
function isUrl(s){ return /^https?:\\/\\//i.test(String(s || '')); }
function ref(s){ return isUrl(s) ? '<a href="' + esc(s) + '" target="_blank" rel="noopener">' + esc(s) + '</a>' : '<code>' + esc(s) + '</code>'; }
function headers(){
  var h = { 'X-Requested-With': 'agentx-board' };
  if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  return h;
}
function more(label, html){ return html ? '<details><summary>' + esc(label) + '</summary><div class="ax-req__md">' + html + '</div></details>' : ''; }
function linkRow(l, r){
  var target = ref(l.ref);
  if (l.kind === 'run') target = '<a href="/tasks/' + encodeURIComponent(l.ref) + '?agent=' + encodeURIComponent(r.agentId) + '&archived=1' + (PEER ? '&node=' + encodeURIComponent(PEER) : '') + '">Open the run</a> <code>' + esc(l.ref) + '</code>';
  else if (l.kind === 'card' || l.kind === 'approval') target = '<a href="/approvals">On Approvals</a> <code>' + esc(l.ref) + '</code>';
  else if (l.kind === 'workflow') target = '<a href="/workflows">Workflows</a> <code>' + esc(l.ref) + '</code>';
  return '<li><span class="ax-req__kind">' + esc(KIND[l.kind] || l.kind) + '</span>' + target + '<span class="ax-muted">' + esc(when(l.at)) + '</span></li>';
}
// summary, why, needed and the ids are escaped here; textHtml, ownerNoteHtml
// and lastAnswer.html arrive rendered and escaped by requests/card-view.ts.
function render(d){
  var r = d.item, links = d.links || [];
  var open = !r.closedAt;
  var plan = r.plan ? '<h2 class="ax-req__section">Plan</h2><ol>' + r.plan.steps.map(function(s){ return '<li>' + esc(s.name) + ' <span class="ax-muted">(' + esc(s.state) + ', @' + esc(s.agentId) + ')</span></li>'; }).join('') + '</ol>' : '';
  document.getElementById('req-body').innerHTML =
    '<article class="ax-req__card">' +
    '<h1 class="ax-req__title" dir="auto">' + esc(r.summary) + '</h1>' +
    '<div class="ax-req__meta"><span class="ax-req__state">' + esc(STATE[r.state] || r.state) + '</span>' +
    '<span>With <span class="ax-mention">@' + esc(r.agentId) + '</span></span>' +
    '<span>Asked ' + esc(when(r.createdAt)) + ' on ' + esc(r.channel) + (r.sender ? ' by ' + esc(r.sender) : '') + '</span>' +
    (r.closedAt ? '<span>Closed ' + esc(when(r.closedAt)) + '</span>' : '<span>Last change ' + esc(when(r.updatedAt)) + '</span>') + '</div>' +
    (open && r.needed ? '<p class="ax-req__need" dir="auto"><b>Needed from you:</b> ' + esc(r.needed) + '</p>' : '') +
    (r.why ? '<p class="ax-req__need" dir="auto">' + esc(r.why) + '</p>' : '') +
    (r.home ? '<p class="ax-req__need"><b>Where the work lives:</b> ' + ref(r.home.link) + '</p>' : '') +
    (r.evidence ? '<p class="ax-req__need"><b>Evidence:</b> ' + ref(r.evidence) + '</p>' : '') +
    (r.closeReason ? '<p class="ax-req__need"><b>Why it closed:</b> ' + esc(r.closeReason) + '</p>' : '') +
    more(r.loop && r.loop.promise ? 'What @' + r.agentId + ' promised' : 'What was asked', r.textHtml) +
    more('Your last reply', r.ownerNoteHtml) +
    (r.lastAnswer ? more('Last answer from @' + r.lastAnswer.agentId + ' (' + when(r.lastAnswer.at) + ')', r.lastAnswer.html) : '') +
    (open && !PEER ? '<div class="ax-req__acts"><a class="ax-btn ax-btn--primary" href="/approvals#req-' + encodeURIComponent(r.id) + '">Reply, hand off or close it</a></div>' : '') +
    '</article>' + plan +
    '<h2 class="ax-req__section">Everything on this task</h2>' +
    (links.length ? '<ul class="ax-req__links">' + links.map(function(l){ return linkRow(l, r); }).join('') + '</ul>' : '<p class="ax-muted">Nothing linked yet.</p>');
  document.title = 'AgentX · ' + r.summary;
}
var q = '/api/admin/approvals/requests/home?id=' + encodeURIComponent(ID) + (PEER ? '&peer=' + encodeURIComponent(PEER) : '');
fetch(q, { headers: headers() }).then(function(res){
  return res.json().then(function(d){ return { ok: res.ok, status: res.status, d: d }; });
}).then(function(x){
  if (x.ok) return render(x.d);
  document.getElementById('req-body').innerHTML = x.status === 404
    ? '<p>No request <code>' + esc(ID) + '</code> on this node. It may have been removed after its retention period, or it lives on another node: pick that node in the top bar.</p>'
    : '<p>The request could not be read: ' + esc(x.d && x.d.error || ('HTTP ' + x.status)) + '</p>';
}).catch(function(e){
  document.getElementById('req-body').innerHTML = '<p>The request could not be read: ' + esc(e.message) + '. The node may be unreachable.</p>';
});
})();
`

/** Finds the request a run or an issue belongs to, for the views that show
 *  a slice of a task (Live's task page, Activity, Monitor, Boards) and link
 *  back to its home. A run that answered a message without being a request
 *  has no home, and gets no link.
 *    axRequestHome({ run | issue | id, peer? }, done)  calls done({ url, summary, state, id }), or never
 *    axFillRequestHomes(root)  fills every [data-home-run] / [data-home-issue] element under root with
 *                              a "Task home" link (data-home-node: the node's URL). A found home is
 *                              looked up once per page load, a missing one once a minute, so
 *                              pages that redraw stay cheap. */
export const REQUEST_HOME_JS = `
(function () {
  var cache = {};
  function lookup(q) {
    var qs = Object.keys(q).filter(function (k) { return q[k]; }).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    if (!qs) return Promise.resolve(null);
    // A run can become a request after it starts, so "none" is asked again
    // after a minute; a found home is kept.
    if (cache[qs] && !(cache[qs].none && Date.now() - cache[qs].at > 60000)) return cache[qs].p;
    var h = { 'X-Requested-With': 'agentx-board' };
    if (window.AX_LOCAL_TOKEN) h['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
    var entry = { at: Date.now(), none: false };
    entry.p = fetch('/api/admin/approvals/requests/home?' + qs, { headers: h })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.item) return null;
        return { url: d.url + (q.peer ? '?peer=' + encodeURIComponent(q.peer) : ''), summary: d.item.summary, state: d.item.state, id: d.item.id };
      })
      .catch(function () { return null; })
      .then(function (found) { entry.none = !found; return found; });
    cache[qs] = entry;
    return entry.p;
  }
  window.axRequestHome = function (q, done) { lookup(q).then(function (h) { if (h) done(h); }); };
  window.axFillRequestHomes = function (root) {
    (root || document).querySelectorAll('[data-home-run],[data-home-issue]').forEach(function (el) {
      var q = el.dataset.homeRun ? { run: el.dataset.homeRun } : { issue: el.dataset.homeIssue };
      q.peer = el.dataset.homeNode || '';
      lookup(q).then(function (h) {
        if (!h || !el.isConnected) return;
        var a = document.createElement('a');
        a.href = h.url; a.textContent = 'Task home'; a.title = h.summary; a.className = el.dataset.homeClass || '';
        el.replaceChildren(a);
      });
    });
  };
})();
`
