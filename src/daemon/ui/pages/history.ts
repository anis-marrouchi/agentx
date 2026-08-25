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
    <nav class="ax-crumbs" aria-label="Breadcrumb">
      <a href="/live">Live</a>
      <span class="ax-crumbs__sep">/</span>
      <span class="ax-mention">@${esc(opts.agentId)}</span>
      <span class="ax-crumbs__sep">/</span>
      <span class="ax-crumbs__here">History</span>
    </nav>
  </header>
  <!-- Summary of the list below, not of the agent in general. Three numbers
       and the channel mix — enough to see "mostly GitLab, two failures" at a
       glance without reading 50 rows. Cost and health live on their own
       pages; repeating them here would make this a status report. -->
  <section class="ax-hist-sum" id="hist-sum" hidden>
    <div class="ax-hist-sum__nums">
      <span><b id="hs-total">0</b> tasks</span>
      <span class="ax-hist-sum__fail" id="hs-fail-wrap" hidden><b id="hs-fail">0</b> failed</span>
      <span><b id="hs-time">—</b> of agent time</span>
      <span class="ax-hist-sum__span" id="hs-span"></span>
    </div>
    <div class="ax-hist-sum__chips" id="hs-chips"></div>
  </section>
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
/* <main> carries no padding in the shell — without this the breadcrumb sits
   flush against the sticky topbar. */
.ax-history {
  display: flex; flex-direction: column; gap: var(--ax-gap);
  max-width: 1000px; margin: 0 auto; padding: 22px var(--ax-pad) var(--ax-pad);
}
.ax-crumbs { display: flex; align-items: center; gap: 8px; font-size: var(--ax-fs-sm); min-width: 0; }
.ax-crumbs a { color: var(--ax-text-2); font-weight: 600; text-decoration: none; }
.ax-crumbs a:hover { color: var(--ax-accent); text-decoration: none; }
.ax-crumbs__sep { color: var(--ax-border-2); }
.ax-crumbs__here { color: var(--ax-text); font-weight: 700; }
.ax-history__head { display: flex; align-items: center; justify-content: space-between; gap: var(--ax-gap); flex-wrap: wrap; }
.ax-history__who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ax-history__back { font-size: var(--ax-fs-sm); font-weight: 600; white-space: nowrap; }
.ax-history__name { color: var(--ax-text-2); }
.ax-hist-sum {
  display: flex; align-items: center; justify-content: space-between; gap: var(--ax-gap);
  flex-wrap: wrap; padding: 10px 14px;
  background: var(--ax-surface-2); border: var(--ax-border-w) solid var(--ax-border);
  border-radius: var(--ax-radius);
}
.ax-hist-sum__nums { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.ax-hist-sum__nums b { color: var(--ax-text); font-family: var(--ax-mono); font-weight: 700; }
.ax-hist-sum__fail b { color: var(--ax-err); }
.ax-hist-sum__span { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.ax-hist-sum__chips { display: flex; gap: 6px; flex-wrap: wrap; }
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
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    // Totals across 50 tasks run to hours — "226m 18s" is arithmetic, not an
    // answer. Drop seconds once we're past an hour; nobody reads them there.
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function taskUrl(id, channel) {
    return '/tasks/' + encodeURIComponent(id)
      + '?agent=' + encodeURIComponent(agentId)
      + '&node=' + encodeURIComponent(nodeUrl)
      + '&name=' + encodeURIComponent(agentName)
      + (channel ? '&channel=' + encodeURIComponent(channel) : '')
      + '&archived=1';
  }

  /** Everything here is derived from the rows we already fetched — no second
   *  request, and the numbers can never disagree with the list under them. */
  function summarize(items) {
    var fails = 0, totalMs = 0, byChannel = {};
    var oldest = Infinity, newest = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.ok) fails++;
      totalMs += it.durationMs || 0;
      var ch = it.channel || 'other';
      byChannel[ch] = (byChannel[ch] || 0) + 1;
      var t = new Date(it.endedAt).getTime();
      if (t) { if (t < oldest) oldest = t; if (t > newest) newest = t; }
    }
    document.getElementById('hs-total').textContent = items.length;
    document.getElementById('hs-time').textContent = dur(totalMs);
    if (fails) {
      document.getElementById('hs-fail').textContent = fails;
      document.getElementById('hs-fail-wrap').hidden = false;
    }
    if (oldest !== Infinity && newest > oldest) {
      document.getElementById('hs-span').textContent = 'spanning ' + ago(oldest).replace(' ago', '');
    }
    var chips = Object.keys(byChannel).sort(function (a, b) { return byChannel[b] - byChannel[a]; });
    document.getElementById('hs-chips').innerHTML = chips.map(function (c) {
      return '<span class="ax-chip">' + esc(c) + ' ' + byChannel[c] + '</span>';
    }).join('');
    document.getElementById('hist-sum').hidden = false;
  }

  fetch('/api/task/history?node=' + encodeURIComponent(nodeUrl)
        + '&agent=' + encodeURIComponent(agentId) + '&limit=50')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (items) {
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = '<div class="ax-history__empty">No recorded tasks yet.</div>';
        return;
      }
      summarize(items);
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
