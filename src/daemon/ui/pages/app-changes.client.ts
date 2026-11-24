// --- Phone app: the Changes screen (#2101 C1b, mock P3) ---
//
// Opened by the Chat header's right button (app-chat-head.client.ts) for
// the agent in view. It reads GET /api/app/changes?agent=<id>
// (app-changes.ts), the Hub's Diff view (#2102) for the agent's newest
// open request: its PR or MR, the files with their +/- counts and the
// diff of the file picked. A tap on a line opens a comment box under it;
// "Send to <agent>" posts every comment at once through
// POST /api/app/changes/comments, as the Hub's line comments go.
// Comments not sent stay while the screen is open.
//
// This string lives inside a TypeScript template literal: no backslashes,
// no dollar-brace and no backticks in it, or the inlined script breaks.

export const APP_CHANGES_SCRIPT = `
(function () {
  var V = window.AXChatView;
  if (!V) return;
  var BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  var OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
  var FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>';
  var SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/></svg>';
  var PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>';
  var box = document.createElement('section');
  box.className = 'chg'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'chg-title');
  box.innerHTML = '<header class="chg-head"><button type="button" id="chg-back" class="ch-btn" aria-label="Back to the chat">' + BACK + '</button>' +
    '<div class="chg-who"><h2 id="chg-title">Changes</h2><p id="chg-sub" class="chg-sub"></p></div>' +
    '<a id="chg-out" class="ch-btn" target="_blank" rel="noopener" aria-label="Open on the forge" hidden>' + OUT + '</a></header>' +
    '<ul id="chg-files" class="chg-files"></ul><div id="chg-diff" class="chg-diff"></div><p id="chg-note" class="chg-note" role="status"></p>' +
    '<footer id="chg-foot" class="chg-foot" hidden><span id="chg-count"></span><button type="button" id="chg-send" class="chg-send">' + SEND + '<span id="chg-send-label">Send</span></button></footer>';
  document.body.appendChild(box);
  function $(id) { return document.getElementById(id); }
  var filesEl = $('chg-files'), diffEl = $('chg-diff'), note = $('chg-note'), sub = $('chg-sub'), out = $('chg-out');
  var foot = $('chg-foot'), count = $('chg-count'), sendBtn = $('chg-send');
  // d: the last answer; at: the file shown; comments: not sent yet.
  var s = { target: null, d: null, at: 0, comments: [], editing: null, opener: null, view: 0 };

  function who() { return s.target ? (s.target.agentName || s.target.agent) : 'the agent'; }
  function counts(f) {
    var a = 0, r = 0;
    (f.hunks || []).forEach(function (h) { h.lines.forEach(function (l) { if (l.kind === 'add') a++; else if (l.kind === 'del') r++; }); });
    return [a, r];
  }
  function plusMinus(a, r) { return '<span class="chg-add">+' + a + '</span> <span class="chg-del">−' + r + '</span>'; }
  function forgeUrl(d) {
    var m = d && d.provider === 'github' && /^([^#]+)#([0-9]+)$/.exec(d.ref || '');
    return m ? 'https://github.com/' + m[1] + '/pull/' + m[2] : '';
  }
  function say(t, bad) { note.textContent = t || ''; note.classList.toggle('chg-bad', !!bad); }
  function fit() { var tabs = document.querySelector('.tabs'); box.style.bottom = (tabs ? tabs.offsetHeight : 0) + 'px'; }

  function open(target) {
    s.opener = document.activeElement;
    if (!s.target || s.target.agent !== target.agent || s.target.node !== target.node) s.comments = [];
    s.target = target; s.d = null; s.at = 0; s.editing = null;
    fit(); box.hidden = false;
    sub.textContent = who(); filesEl.innerHTML = ''; diffEl.innerHTML = ''; out.hidden = true;
    say('Reading the changes…');
    paintFoot();
    $('chg-back').focus();
    load('');
  }
  function close() {
    box.hidden = true; s.view++;
    if (s.opener && s.opener.focus) s.opener.focus();
  }
  function load(pr) {
    var mine = ++s.view;
    fetch('/api/app/changes?agent=' + encodeURIComponent(s.target.agent) + (pr ? '&pr=' + encodeURIComponent(pr) : ''), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.reload(); return null; }
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
      }).then(function (x) {
        if (!x || mine !== s.view) return;
        if (!x.ok) { say(x.j.error || ('Could not read the changes (HTTP ' + x.status + ').'), true); return; }
        s.d = x.j; paint();
      }).catch(function () { if (mine === s.view) say('Could not reach AgentX. Check the connection and try again.', true); });
  }
  function paint() {
    var d = s.d;
    if (!d.request) { say(who() + ' has no open request on a GitHub or GitLab issue on this computer, so there are no changes to show.'); return; }
    if (!d.ref) { say('No pull or merge request names ' + (d.request.title ? '“' + d.request.title + '”' : 'this request') + ' yet.'); return; }
    var all = d.files.reduce(function (n, f) { var c = counts(f); return [n[0] + c[0], n[1] + c[1]]; }, [0, 0]);
    var short = /([#!])([0-9]+)$/.exec(d.ref);
    sub.innerHTML = V.esc(who()) + ' · ' + V.esc(short ? (short[1] === '!' ? 'MR !' : 'PR #') + short[2] : d.ref) + ' · ' + plusMinus(all[0], all[1]);
    var url = forgeUrl(d); out.hidden = !url; if (url) out.href = url;
    filesEl.innerHTML = d.files.map(function (f, i) {
      var c = counts(f);
      return '<li><button type="button" data-i="' + i + '"' + (i === s.at ? ' aria-current="true"' : '') + '>' + FILE +
        '<span class="chg-path">' + V.esc(f.file) + '</span>' + plusMinus(c[0], c[1]) + '</button></li>';
    }).join('');
    say(d.files.length ? (d.truncated ? 'Long diff: some lines are left out. Open it on the forge for all of it.' : '') : 'This pull request changes no files.');
    paintDiff();
  }
  function keyOf(side, line) { return side + ':' + line; }
  function paintDiff() {
    var f = s.d && s.d.files[s.at];
    if (!f) { diffEl.innerHTML = ''; return; }
    if (f.status === 'binary') { diffEl.innerHTML = '<p class="chg-note">A binary file: no lines to show.</p>'; return; }
    var mine = s.comments.filter(function (c) { return c.file === f.file; });
    var html = '';
    f.hunks.forEach(function (h) {
      html += '<div class="chg-hunk">' + V.esc(h.header) + '</div>';
      h.lines.forEach(function (l) {
        var side = l.kind === 'del' ? 'old' : 'new', n = side === 'old' ? l.oldLine : l.newLine;
        var sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
        html += '<button type="button" class="chg-line chg-' + l.kind + '" data-side="' + side + '" data-line="' + (n || '') + '">' +
          '<span class="chg-n">' + (l.oldLine || '') + '</span><span class="chg-n">' + (l.newLine || '') + '</span>' +
          '<span class="chg-sign">' + sign + '</span><code>' + V.esc(l.text) + '</code></button>';
        mine.filter(function (c) { return c.side === side && c.line === n; }).forEach(function (c) {
          html += '<div class="chg-comment">' + PEN + '<span class="chg-c-at">Your comment · line ' + n + '</span><p>' + V.esc(c.text) + '</p></div>';
        });
        if (s.editing && s.editing.file === f.file && keyOf(s.editing.side, s.editing.line) === keyOf(side, n)) {
          html += '<form class="chg-edit"><label class="cx-sr" for="chg-text">Comment on line ' + n + '</label>' +
            '<textarea id="chg-text" rows="2" placeholder="Comment for ' + V.esc(who()) + '"></textarea>' +
            '<div><button type="button" class="fx-btn" id="chg-cancel">Cancel</button><button type="submit" class="chg-send">Add</button></div></form>';
        }
      });
    });
    diffEl.innerHTML = html;
    var t = $('chg-text');
    if (t) t.focus();
  }
  function paintFoot() {
    var n = s.comments.length;
    foot.hidden = !n;
    count.textContent = n + (n === 1 ? ' comment' : ' comments');
    $('chg-send-label').textContent = 'Send to ' + who();
  }

  $('chg-back').addEventListener('click', close);
  box.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  filesEl.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-i]');
    if (!b) return;
    s.at = Number(b.dataset.i); s.editing = null; paint();
  });
  diffEl.addEventListener('click', function (ev) {
    if (ev.target.id === 'chg-cancel') { s.editing = null; paintDiff(); return; }
    var b = ev.target.closest('.chg-line');
    if (!b || !b.dataset.line) return;
    var f = s.d.files[s.at];
    s.editing = { file: f.file, side: b.dataset.side, line: Number(b.dataset.line), code: b.querySelector('code').textContent };
    paintDiff();
  });
  diffEl.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = ($('chg-text').value || '').trim();
    if (!text || !s.editing) return;
    s.comments.push({ file: s.editing.file, side: s.editing.side, line: s.editing.line, code: s.editing.code, text: text });
    s.editing = null; paintDiff(); paintFoot();
  });
  sendBtn.addEventListener('click', function () {
    if (!s.comments.length || !s.d || !s.d.request) return;
    sendBtn.disabled = true;
    var body = { id: s.d.request.id, pr: s.d.ref, headSha: s.d.headSha, comments: s.comments };
    fetch('/api/app/changes/comments', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { say(x.j.error || ('Not sent (HTTP ' + x.status + ').'), true); return; }
        s.comments = []; paintDiff(); paintFoot();
        say('Sent to ' + who() + '.' + (x.j.moved ? ' The pull request moved since you read it; it is read again.' : ''));
        if (x.j.moved) load(s.d.ref);
      }).catch(function () { say('Could not reach AgentX. Your comments are kept; try again.', true); })
      .then(function () { sendBtn.disabled = false; });
  });
  window.addEventListener('resize', function () { if (!box.hidden) fit(); });
  window.AXChanges = { open: open, close: close };
})();
`

export const APP_CHANGES_CSS = `
.chg {
  position: fixed; top: 0; left: 0; right: 0; z-index: 40; display: flex; flex-direction: column; overflow: hidden;
  padding-top: env(safe-area-inset-top); background: var(--ax-bg); color: var(--ax-text);
}
.chg-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 8px calc(16px + env(safe-area-inset-right)) 8px calc(16px + env(safe-area-inset-left)); }
.chg-head a.ch-btn { text-decoration: none; }
.chg-who { flex: 1; min-width: 0; }
.chg-who h2 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
.chg-sub { margin: 2px 0 0; font-size: 14px; color: var(--ax-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg-add { color: var(--ax-green); }
.chg-del { color: var(--ax-red-ink); }
.chg-files { flex: none; list-style: none; margin: 0; padding: 0 12px 8px; display: grid; gap: 2px; max-height: 30dvh; overflow-y: auto; border-bottom: 1px solid var(--ax-border); }
.chg-files button {
  width: 100%; min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 10px; cursor: pointer;
  border: 0; border-radius: 10px; background: none; color: inherit; font: inherit; text-align: left;
}
.chg-files button[aria-current=true] { background: var(--ax-accent-t); }
.chg-files svg, .chg-comment svg, .chg-send svg { flex: none; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.chg-path { flex: 1; min-width: 0; font-family: var(--ax-mono); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.chg-diff { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; font-family: var(--ax-mono); font-size: 13px; }
.chg-hunk { padding: 6px 12px; color: var(--ax-text-2); background: var(--ax-surface-2); white-space: pre; }
.chg-line {
  display: grid; grid-template-columns: 3.2em 3.2em 1.4em max-content; align-items: baseline; min-width: 100%; min-height: 28px; padding: 3px 0;
  border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.chg-line code { background: none; padding: 0; font-size: inherit; white-space: pre; }
.chg-n { padding-right: 8px; text-align: right; color: var(--ax-text-2); }
.chg-add.chg-line { background: color-mix(in oklch, var(--ax-green) 16%, transparent); }
.chg-del.chg-line { background: color-mix(in oklch, var(--ax-red) 14%, transparent); }
.chg-sign { color: var(--ax-text-2); }
.chg-comment, .chg-edit {
  margin: 8px 12px; padding: 12px 14px; border: 1.5px solid var(--ax-accent); border-radius: 14px;
  background: var(--ax-surface); font-family: var(--ax-font); font-size: 15px;
}
.chg-c-at { margin-left: 8px; font-size: 14px; color: var(--ax-text-2); }
.chg-comment svg { vertical-align: -4px; color: var(--ax-text-2); }
.chg-comment p { margin: 6px 0 0; line-height: 1.4; overflow-wrap: anywhere; }
.chg-edit textarea {
  width: 100%; box-sizing: border-box; min-height: 64px; padding: 8px 10px; resize: vertical; font: inherit; font-size: 16px;
  border: var(--ax-border-w) solid var(--ax-border); border-radius: 10px; background: var(--ax-bg); color: var(--ax-text);
}
.chg-edit div { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.chg-note { flex: none; margin: 0; padding: 8px 16px; font-size: 14px; color: var(--ax-text-2); }
.chg-note:empty { display: none; }
.chg-note.chg-bad { color: var(--ax-red-ink); }
.chg-foot {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left)); border-top: 1px solid var(--ax-border);
}
.chg-foot > span { color: var(--ax-text-2); }
.chg-send {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; cursor: pointer;
  border: 0; border-radius: 12px; background: var(--ax-primary); color: var(--ax-primary-fg); font: inherit; font-weight: 600;
}
.chg-send:disabled { opacity: .6; cursor: default; }
`
