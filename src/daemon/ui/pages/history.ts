import { renderShell, esc, type TopbarPeer } from ".."

// --- Agent history page ---
//
// Replaces the 360px right-hand drawer that used to slide over Live. A drawer
// was the wrong container for this: the list is the thing you came to read, it
// wants width for message previews, and every row leads somewhere — so it
// needs to be linkable and back-navigable, which a drawer over another page
// can't be.
//
// One job: what has this agent done recently. One action per row: open that
// task. Reads GET /api/task/history?node=&agent=&limit=.

export interface HistoryPageOpts {
  agentId: string
  agentName?: string
  nodeUrl: string
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderHistoryPage(opts: HistoryPageOpts): string {
  const who = opts.agentName || opts.agentId

  const body = `<div class="ax-history"
     data-agent-id="${esc(opts.agentId)}"
     data-agent-name="${esc(who)}"
     data-node-url="${esc(opts.nodeUrl)}">
  <header class="ax-history__head">
    <div class="ax-history__who">
      <a class="ax-history__back" href="/live">← Live</a>
      <span class="ax-mention">@${esc(opts.agentId)}</span>
      <span class="ax-history__name">${esc(who)}</span>
    </div>
    <span class="ax-mono ax-muted" id="hist-count"></span>
  </header>
  <div class="ax-history__list" id="hist-list">
    <div class="ax-history__empty">loading…</div>
  </div>
</div>`

  return renderShell({
    title: `AgentX · ${who} history`,
    activeTab: "live",
    subtitle: "History",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: HISTORY_CSS,
    scripts: `<script>${HISTORY_JS}</script>`,
  })
}

const HISTORY_CSS = `
.ax-history { display: flex; flex-direction: column; gap: var(--ax-gap); max-width: 1000px; margin: 0 auto; }
.ax-history__head { display: flex; align-items: center; justify-content: space-between; gap: var(--ax-gap); flex-wrap: wrap; }
.ax-history__who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ax-history__back { font-size: var(--ax-fs-sm); font-weight: 600; white-space: nowrap; }
.ax-history__name { color: var(--ax-text-2); }
.ax-history__list { display: flex; flex-direction: column; gap: 8px; }
.ax-history__empty { color: var(--ax-muted); padding: var(--ax-pad); text-align: center; }

/* One row per task. The whole row is the link — a row with a nested "open"
   button would be two targets for one intent. */
.ax-history__row {
  display: block; text-decoration: none; color: inherit;
  background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius); box-shadow: var(--ax-shadow);
  padding: 12px 14px; transition: border-color .1s, transform .06s, box-shadow .06s;
}
.ax-history__row:hover { border-color: var(--ax-accent); text-decoration: none; }
.ax-history__row:active { transform: translateY(2px); box-shadow: 0 1px 0 var(--ax-border); }
.ax-history__row.is-err { border-color: var(--ax-red-e); }
.ax-history__top { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-xs); }
.ax-history__flag { font-weight: 700; }
.ax-history__flag.ok { color: var(--ax-ok); }
.ax-history__flag.err { color: var(--ax-err); }
.ax-history__when { margin-left: auto; color: var(--ax-muted); font-family: var(--ax-mono); }
.ax-history__preview {
  margin-top: 6px; font-size: var(--ax-fs-sm); color: var(--ax-text-2);
  line-height: 1.5; overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.ax-history__foot { margin-top: 6px; font-size: var(--ax-fs-xs); color: var(--ax-muted); font-family: var(--ax-mono); }
`

const HISTORY_JS = `
(function () {
  var root = document.querySelector('.ax-history');
  if (!root) return;
  var agentId = root.getAttribute('data-agent-id');
  var agentName = root.getAttribute('data-agent-name');
  var nodeUrl = root.getAttribute('data-node-url');
  var listEl = document.getElementById('hist-list');
  var countEl = document.getElementById('hist-count');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(iso) {
    var t = new Date(iso).getTime();
    if (!t) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function dur(ms) {
    if (!ms) return '—';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  function taskUrl(id, channel) {
    return '/tasks/' + encodeURIComponent(id)
      + '?agent=' + encodeURIComponent(agentId)
      + '&node=' + encodeURIComponent(nodeUrl)
      + '&name=' + encodeURIComponent(agentName)
      + (channel ? '&channel=' + encodeURIComponent(channel) : '')
      + '&archived=1';
  }

  fetch('/api/task/history?node=' + encodeURIComponent(nodeUrl)
        + '&agent=' + encodeURIComponent(agentId) + '&limit=50')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (items) {
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = '<div class="ax-history__empty">No recorded tasks yet.</div>';
        return;
      }
      countEl.textContent = items.length + ' task' + (items.length === 1 ? '' : 's');
      listEl.innerHTML = items.map(function (it) {
        return '<a class="ax-history__row' + (it.ok ? '' : ' is-err') + '" href="' + esc(taskUrl(it.id, it.channel)) + '">' +
          '<div class="ax-history__top">' +
            '<span class="ax-history__flag ' + (it.ok ? 'ok">✓' : 'err">✗') + '</span>' +
            '<span class="ax-badge ax-badge--mono ax-badge--ghost">' + esc(it.channel || '—') + '</span>' +
            (it.sender ? '<span class="ax-muted">' + esc(it.sender) + '</span>' : '') +
            '<span class="ax-history__when">' + esc(ago(it.endedAt)) + '</span>' +
          '</div>' +
          '<div class="ax-history__preview">' + esc((it.message || '').slice(0, 300)) + '</div>' +
          '<div class="ax-history__foot">' + esc(dur(it.durationMs)) +
            (it.error ? ' · ' + esc(it.error.slice(0, 90)) : '') +
          '</div>' +
        '</a>';
      }).join('');
    })
    .catch(function (e) {
      listEl.innerHTML = '<div class="ax-history__empty" style="color:var(--ax-err)">' + esc(e.message) + '</div>';
    });
})();
`
