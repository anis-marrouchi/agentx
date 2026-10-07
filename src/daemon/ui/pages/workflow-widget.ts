// --- Floating progress widget (#796) ---
//
// A small page at /workflows/widget that follows running follow-up
// workflows: title, the step each is on, who that step waits for, and
// whether it waits on the owner, with Yes/No for a decision and a reply box
// for a blocked step. It reads /api/workflows/widget, refreshes when the
// dashboard's /events stream says a run moved, and polls as a fallback.
//
// Floating: "Keep on top" opens the same list in a Document
// Picture-in-Picture window, which the browser keeps above every other
// window (Chrome and Edge on macOS, Windows and Linux). Elsewhere it opens
// a small separate window in the configured corner. No operating-system
// code: one page for every desktop.
//
// Deliberately NOT built on renderShell: a widget has no topbar.
//
// The script lives inside a TypeScript template literal: no backticks and
// no dollar-brace in it.

import { AX_TOKENS_CSS } from "../tokens"
import { esc } from "../util"
import { injectFns } from "../inject"
import { widgetPlacement, widgetStateLabel, type WidgetSettings } from "@/workflows/widget"

const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('ax-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();</script>`

export function renderWorkflowWidgetPage(settings: WidgetSettings): string {
  const cfg = esc(JSON.stringify({
    position: settings.position,
    width: settings.width,
    height: settings.height,
    refreshSeconds: settings.refreshSeconds,
  }))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="/favicon.ico">
<title>Workflow progress · AgentX</title>
${THEME_BOOT}
<style id="wg-style">${AX_TOKENS_CSS}${WIDGET_CSS}</style>
</head>
<body>
<div id="wg" class="wg" data-cfg="${cfg}">
  <header class="wg__bar">
    <h1>Workflows <span id="wg-count" class="wg__muted"></span></h1>
    <div class="wg__btns">
      <button type="button" id="wg-float" class="wg__btn" title="Keep this list above your other windows">Keep on top</button>
      <a class="wg__btn" href="/workflows" target="_blank" rel="noopener" title="Open the Workflows page">Open</a>
    </div>
  </header>
  <p id="wg-status" class="wg__status" role="status" aria-live="polite">Loading&hellip;</p>
  <ul id="wg-list" class="wg__list" aria-live="polite"></ul>
</div>
<script>${injectFns({ widgetPlacement, widgetStateLabel })}${WIDGET_SCRIPT}</script>
</body>
</html>`
}

const WIDGET_CSS = `
html, body { margin: 0; background: var(--ax-bg); color: var(--ax-text); font: 13px/1.4 var(--ax-font-sans, system-ui, sans-serif); }
.wg { display: flex; flex-direction: column; min-height: 100vh; }
.wg__bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: var(--ax-border-w, 1px) solid var(--ax-border); position: sticky; top: 0; background: var(--ax-bg); }
.wg__bar h1 { font-size: 13px; font-weight: 600; margin: 0; }
.wg__btns { display: flex; gap: 6px; }
.wg__btn { font: inherit; font-size: 12px; padding: 3px 8px; border-radius: var(--ax-radius-sm, 4px); border: var(--ax-border-w, 1px) solid var(--ax-border); background: none; color: inherit; cursor: pointer; text-decoration: none; }
.wg__btn:focus-visible, .wg__list textarea:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: 1px; }
.wg__btn--yes { border-color: var(--ax-accent); color: var(--ax-accent); }
.wg__muted { color: var(--ax-text-muted, var(--ax-muted)); font-weight: 400; }
.wg__status { margin: 0; padding: 4px 10px; font-size: 11px; color: var(--ax-text-muted, var(--ax-muted)); }
.wg__status.is-bad { color: var(--ax-danger, #d33); }
.wg__list { list-style: none; margin: 0; padding: 0 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.wg__row { border: var(--ax-border-w, 1px) solid var(--ax-border); border-radius: var(--ax-radius-sm, 4px); padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.wg__row.is-you, .wg__row.is-blocked { border-color: var(--ax-warning, #c80); }
.wg__head { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
.wg__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wg__pill { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: var(--ax-border-w, 1px) solid var(--ax-border); white-space: nowrap; }
.wg__pill.is-you, .wg__pill.is-blocked { border-color: var(--ax-warning, #c80); color: var(--ax-warning, #c80); }
.wg__line { font-size: 12px; color: var(--ax-text-muted, var(--ax-muted)); overflow-wrap: anywhere; }
.wg__answer { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; align-items: flex-end; }
.wg__answer textarea { flex: 1 1 100%; font: inherit; font-size: 12px; min-height: 2.6em; resize: vertical; padding: 4px; border-radius: var(--ax-radius-sm, 4px); border: var(--ax-border-w, 1px) solid var(--ax-border); background: var(--ax-bg); color: inherit; }
.wg__empty { padding: 16px 10px; color: var(--ax-text-muted, var(--ax-muted)); }
`

const WIDGET_SCRIPT = `
(function () {
  var root = document.getElementById('wg');
  var cfg = {};
  try { cfg = JSON.parse(root.getAttribute('data-cfg') || '{}'); } catch (e) {}
  var token = '';
  try { token = localStorage.getItem('ax_token') || ''; } catch (e) {}
  var rows = [];
  var drafts = {};
  var busy = false, queued = false, timer = 0, pip = null;
  function $(sel) { return root.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function headers(json) {
    var h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    if (json) { h['Content-Type'] = 'application/json'; h['X-Requested-With'] = 'agentx-board'; }
    return h;
  }
  function status(text, bad) {
    var el = $('#wg-status');
    el.textContent = text;
    el.className = 'wg__status' + (bad ? ' is-bad' : '');
  }
  function stateClass(s) { return s === 'waiting-on-you' ? ' is-you' : s === 'blocked' ? ' is-blocked' : ''; }

  function render(data) {
    // Never redraw under an answer being typed: the next read after that
    // draws it (a redraw on blur would eat the Send click). Only while this
    // window has focus and the box holds text, so a box left focused when
    // the owner went to another app does not freeze the list.
    var doc = root.ownerDocument, active = doc.activeElement;
    if (active && active.tagName === 'TEXTAREA' && root.contains(active) && active.value.trim() && doc.hasFocus()) {
      status('Paused while you type', false);
      return;
    }
    // An empty box the owner clicked into keeps its focus across the redraw.
    var focusRun = active && active.tagName === 'TEXTAREA' && root.contains(active) ? active.getAttribute('data-run') : null;
    // Keep what the owner typed across a redraw.
    root.querySelectorAll('textarea[data-run]').forEach(function (t) { drafts[t.getAttribute('data-run')] = t.value; });
    rows = data.rows || [];
    var you = rows.filter(function (r) { return r.answer; }).length;
    $('#wg-count').textContent = rows.length ? '(' + rows.length + (you ? ', ' + you + ' need you' : '') + ')' : '';
    var list = $('#wg-list');
    if (!data.enabled) {
      list.innerHTML = '<li class="wg__empty">The progress widget is off. On the computer, run: agentx workflow widget --enabled on</li>';
    } else if (!rows.length) {
      list.innerHTML = '<li class="wg__empty">Nothing is being followed right now.</li>';
    } else {
      list.innerHTML = rows.map(function (r, i) {
        var a = r.answer, html = '';
        if (a && a.kind === 'card' && a.choices) {
          html = '<div class="wg__answer"><a class="wg__btn wg__btn--yes" href="/approvals" target="_blank" rel="noopener">Choose in Approvals</a></div>';
        } else if (a && a.kind === 'card') {
          html = '<div class="wg__answer"><button type="button" class="wg__btn wg__btn--yes" data-i="' + i + '" data-act="yes">Yes</button>' +
            '<button type="button" class="wg__btn" data-i="' + i + '" data-act="no">No</button>' +
            '<a class="wg__btn" href="/approvals" target="_blank" rel="noopener">Details</a></div>';
        } else if (a && a.kind === 'reply') {
          html = '<div class="wg__answer"><textarea data-run="' + esc(r.runId) + '" aria-label="Your answer to ' + esc(a.agentId) + '" placeholder="Tell ' + esc(a.agentId) + ' what to do"></textarea>' +
            '<button type="button" class="wg__btn wg__btn--yes" data-i="' + i + '" data-act="reply">Send</button></div>';
        }
        return '<li class="wg__row' + stateClass(r.state) + '">' +
          '<div class="wg__head"><span class="wg__title" title="' + esc(r.title) + '">' + esc(r.title) + '</span>' +
          '<span class="wg__pill' + stateClass(r.state) + '">' + esc(widgetStateLabel(r.state)) + '</span></div>' +
          '<span class="wg__line">Step <b>' + esc(r.step) + '</b> · ' + esc(r.owner === 'you' ? 'waiting on you' : r.owner) + '</span>' +
          '<span class="wg__line">' + esc(r.waitingOn) + '</span>' +
          '<span class="wg__line">' + esc(ago(r.since)) + (r.tags && r.tags.length ? ' · ' + esc(r.tags.join(', ')) : '') + (r.nodeName ? ' · ' + esc(r.nodeName) : '') + '</span>' +
          html + '</li>';
      }).join('');
      root.querySelectorAll('textarea[data-run]').forEach(function (t) {
        var id = t.getAttribute('data-run');
        if (drafts[id]) t.value = drafts[id];
        if (id === focusRun) t.focus();
      });
    }
    var note = 'Updated ' + new Date(data.ts || Date.now()).toLocaleTimeString();
    if (data.unreachable && data.unreachable.length) note += ' · ' + data.unreachable.length + ' node(s) not reachable';
    status(note, false);
  }

  function load() {
    if (busy) { queued = true; return; }
    busy = true;
    // ?tag=client:acme narrows the list, as on the CLI.
    fetch('/api/workflows/widget' + location.search, { headers: headers(false), credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; }); })
      .then(render)
      .catch(function (e) { status('Could not load: ' + e.message, true); })
      .then(function () { busy = false; if (queued) { queued = false; load(); } });
  }
  function soon() { clearTimeout(timer); timer = setTimeout(load, 400); }

  function answer(i, act, btn) {
    var r = rows[i];
    if (!r) return;
    // The step (and card) on screen: a run that moved on refuses the answer.
    var body = { node: r.node, runId: r.runId, step: r.step, action: act };
    if (r.answer && r.answer.kind === 'card') body.key = r.answer.key;
    if (act === 'reply') {
      var t = root.querySelector('textarea[data-run="' + CSS.escape(r.runId) + '"]');
      body.text = t ? t.value.trim() : '';
      if (!body.text) { status('Nothing sent: the answer is empty.', true); return; }
    }
    btn.disabled = true;
    fetch('/api/workflows/widget/answer', { method: 'POST', headers: headers(true), credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { if (!res.ok) throw new Error(b.error || ('HTTP ' + res.status)); return b; }); })
      .then(function () {
        if (act === 'reply') { delete drafts[r.runId]; if (t) t.value = ''; }
        status(act === 'reply' ? 'Sent to ' + r.answer.agentId + '.' : 'Answered ' + (act === 'yes' ? 'yes' : 'no') + ': ' + r.title + '.', false);
        soon();
      })
      .catch(function (e) { btn.disabled = false; status('Not answered: ' + e.message, true); });
  }

  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (b) answer(+b.getAttribute('data-i'), b.getAttribute('data-act'), b);
  });
  // Keep on top: Document Picture-in-Picture where the browser has it,
  // else a small window in the configured corner.
  var floatBtn = $('#wg-float');
  function dock() {
    if (!pip) return;
    document.body.appendChild(root);
    pip = null;
    floatBtn.textContent = 'Keep on top';
  }
  floatBtn.addEventListener('click', function () {
    var w = cfg.width || 360, h = cfg.height || 420;
    if (pip) { pip.close(); return; }
    if (window.documentPictureInPicture && window.documentPictureInPicture.requestWindow) {
      window.documentPictureInPicture.requestWindow({ width: w, height: h }).then(function (win) {
        pip = win;
        win.document.title = document.title;
        win.document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'light');
        var st = win.document.createElement('style');
        st.textContent = document.getElementById('wg-style').textContent;
        win.document.head.appendChild(st);
        win.document.body.appendChild(root);
        floatBtn.textContent = 'Put back';
        win.addEventListener('pagehide', dock);
      }).catch(function (e) { status('Could not float: ' + e.message, true); });
      return;
    }
    var at = widgetPlacement(cfg.position || 'top-right', w, h, window.screen);
    var win = window.open(location.pathname + location.search, 'agentx-workflow-widget', 'popup,width=' + w + ',height=' + h + ',left=' + at.left + ',top=' + at.top);
    if (!win) status('Your browser blocked the small window: allow pop-ups for this page.', true);
    else status('Opened in a small window. This browser cannot keep it above other windows; Chrome and Edge can.', false);
  });

  // Live: a run event from any node means a step moved; read again.
  if (window.EventSource) {
    try {
      var es = new EventSource('/events?type=run');
      es.addEventListener('run', soon);
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') soon(); });
  setInterval(load, Math.max(3, cfg.refreshSeconds || 10) * 1000);
  load();
})();
`
