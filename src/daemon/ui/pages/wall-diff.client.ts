// --- The Diff view of an open post, browser side (#2102) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), headers(), act(), findPost(), loadThread() and nameOf().
//
// A post whose home is a GitHub or GitLab issue, pull request or merge
// request (p.mergeRef, wall-api.ts) has a Diff button in its action row. It
// opens in the Hub's right panel as its Changes tab (#2101 R15,
// wall-context.client.ts): GET /api/admin/wall/diff?id=<post>, from the
// node that keeps the post, gives the pull or merge requests found for it
// and the diff of the first open one. With several, a small picker reads
// another (&pr=<ref>); with none, the view says so. Each file has a header that folds it, each
// line its old and new numbers. Selecting a line opens a box under it; Add
// keeps the comment as a draft, shown under its line and counted in the
// footer, where it can be edited or removed. "Send N comments to agent"
// posts them all at once (POST /api/admin/wall/diff-comments) with the
// PR's ref and the head commit the diff was read at: the agent that has the
// post gets them as one message, as a comment would reach it. When the
// head moved since, the answer says moved and the view warns. Drafts are
// cleared only once the send succeeds, and the picker waits for them to be
// sent or removed. Drafts stay in memory, and in sessionStorage when the browser has it, per
// post, with the ref and head commit they were written on: after a reload
// the view opens that PR again and the send names that commit, so drafts
// never go to another PR and a moved head is still caught. A refresh of
// the Hub does not repaint a box being typed in.

export const WALL_DIFF_SCRIPT = String.raw`
  // --- Diff view (#2102) ---
  var DIFF_KEY = 'ax.wall.diff.';
  function diffStore() { try { return window.sessionStorage || null; } catch (e) { return null; } }
  function diffOf(id) {
    S.diffs = S.diffs || {};
    if (!S.diffs[id]) {
      // Kept as {ref, headSha, drafts}: drafts with no ref are dropped.
      var kept = null;
      var ss = diffStore();
      if (ss) { try { kept = JSON.parse(ss.getItem(DIFF_KEY + id) || 'null'); } catch (e) { kept = null; } }
      var ok = kept && typeof kept.ref === 'string' && kept.ref && Array.isArray(kept.drafts) && kept.drafts.length;
      S.diffs[id] = { open: false, loading: false, error: '', data: null, folded: {}, drafts: ok ? kept.drafts : [], at: ok ? { ref: kept.ref, headSha: kept.headSha || null } : null, editing: null, sending: false, note: '' };
      // data: {prs, ref, provider, title, state, headSha, files, truncated}; ref null: no PR found.
      // at: {ref, headSha} the drafts were written on; null with no drafts.
    }
    return S.diffs[id];
  }
  function diffKeep(id) {
    var ss = diffStore(), d = diffOf(id);
    if (!d.drafts.length) d.at = null;
    if (!ss) return;
    try { if (d.drafts.length && d.at) ss.setItem(DIFF_KEY + id, JSON.stringify({ ref: d.at.ref, headSha: d.at.headSha, drafts: d.drafts })); else ss.removeItem(DIFF_KEY + id); } catch (e) { /* full or private: memory only */ }
  }
  /** A box in the diff is being typed in: a refresh leaves the post alone. */
  function diffTyping() { var a = document.activeElement; return !!(a && a.id === 'wdf-text'); }
  function diffSide(l) { return l.kind === 'del' ? 'old' : 'new'; }
  function diffLineNo(l) { return l.kind === 'del' ? l.oldLine : l.newLine; }
  function diffKey(file, side, line) { return file + '\n' + side + '\n' + line; }
  function diffButtonHtml(p) {
    if (!p.mergeRef) return '';
    var d = diffOf(p.id);
    return '<button type="button" data-wdf="toggle" aria-expanded="' + (d.open ? 'true' : 'false') + '" title="The changes in ' + esc(p.mergeRef) + '">Diff' + (d.drafts.length ? ' (' + d.drafts.length + ')' : '') + '</button>';
  }
  /** The diff is drawn in the right panel (#2101 R15), not under the post. */
  function diffHtml() { return ''; }
  function diffEditorHtml(d) {
    var e = d.editing;
    return '<tr class="wdf__ed"><td colspan="3"><textarea id="wdf-text" class="wdo__t" rows="3" maxlength="2000" placeholder="Your comment on this line">' + esc(e.text || '') + '</textarea>' +
      '<div class="wdo__row"><button type="button" class="ax-btn" data-wdf="add">' + (e.n == null ? 'Add' : 'Save') + '</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-wdf="cancel">Cancel</button></div></td></tr>';
  }
  function diffDraftsHtml(d, key) {
    var rows = '';
    d.drafts.forEach(function (c, n) {
      if (diffKey(c.file, c.side, c.line) !== key || (d.editing && d.editing.n === n)) return;
      rows += '<li><span class="wdf__dt" dir="auto">' + esc(c.text) + '</span>' +
        '<button type="button" class="wa-more" data-wdf="edit" data-n="' + n + '">Edit</button>' +
        '<button type="button" class="wa-more" data-wdf="remove" data-n="' + n + '">Remove</button></li>';
    });
    return rows ? '<tr class="wdf__dr"><td colspan="3"><ul>' + rows + '</ul></td></tr>' : '';
  }
  /** The post's PRs and MRs, when it has more than one. */
  function diffPickerHtml(d) {
    var prs = d.data.prs || [];
    if (prs.length < 2) return '';
    var held = d.drafts.length ? ' disabled title="Send or remove the drafted comments first"' : '';
    return '<div class="wdf__prs" role="group" aria-label="Pull and merge requests">' + prs.map(function (x) {
      return '<button type="button" class="chip" data-wdf="pr" data-ref="' + esc(x.ref) + '" aria-pressed="' + (x.ref === d.data.ref ? 'true' : 'false') + '"' + held + '>' +
        esc(x.ref) + (x.title ? ' · ' + esc(x.title) : '') + ' <span class="wdf__st">' + esc(x.state) + '</span></button>';
    }).join('') + '</div>';
  }
  function diffInner(p, d) {
    if (d.loading) return '<p class="ax-wall__empty">Loading the diff…</p>';
    if (d.error) return '<p class="ax-wall__empty">Diff not available: ' + esc(d.error) + '</p>' +
      // Drafts on a PR that cannot be read any more can still be let go.
      (d.drafts.length ? '<div class="wdo__row"><button type="button" class="ax-btn ax-btn--ghost" data-wdf="discard">Remove ' + d.drafts.length + (d.drafts.length === 1 ? ' draft' : ' drafts') + ' on ' + esc(d.at ? d.at.ref : '') + '</button></div>' : '');
    if (!d.data) return '';
    if (!d.data.ref) return '<section class="wdf"><p class="ax-wall__empty">No pull or merge request names this issue yet.</p></section>';
    var files = d.data.files || [];
    var where = d.data.provider === 'gitlab' ? 'GitLab' : 'GitHub';
    var out = '<section class="wdf" aria-label="Diff of ' + esc(d.data.ref) + '"><h2 class="wp__th">Diff · ' + esc(d.data.ref) +
      (d.data.headSha ? ' <span class="wdf__sha" title="Head commit read">' + esc(String(d.data.headSha).slice(0, 12)) + '</span>' : '') + '</h2>' +
      diffPickerHtml(d);
    if (d.data.truncated) out += '<p class="wdf__cut">The diff is long: only its first lines are shown. The rest is on ' + where + '.</p>';
    if (!files.length) out += '<p class="ax-wall__empty">No changed files.</p>';
    files.forEach(function (f, fi) {
      var adds = 0, dels = 0;
      (f.hunks || []).forEach(function (h) { h.lines.forEach(function (l) { if (l.kind === 'add') adds++; else if (l.kind === 'del') dels++; }); });
      var folded = !!d.folded[fi];
      out += '<div class="wdf__f"><div class="wdf__fhr"><button type="button" class="wdf__fh" data-wdf="fold" data-f="' + fi + '" aria-expanded="' + (folded ? 'false' : 'true') + '">' +
        '<span class="wdf__fn">' + esc(f.oldFile ? f.oldFile + ' → ' + f.file : f.file) + '</span>' +
        (f.status !== 'modified' ? '<span class="chip">' + esc(f.status) + '</span>' : '') +
        '<span class="wdf__ct"><b class="is-add">+' + adds + '</b> <b class="is-del">−' + dels + '</b></span></button>' +
        // The whole file at the PR's head, in the panel's File tab.
        (f.status === 'removed' || f.status === 'binary' ? '' : '<button type="button" class="wdf__open" data-cx="file" data-path="' + esc(f.file) + '" title="The whole file at the head commit">File</button>') + '</div>';
      if (!folded) {
        if (f.status === 'binary') out += '<p class="wdf__cut">Binary file: not shown.</p>';
        else {
          out += '<div class="wdf__w"><table class="wdf__t"><tbody>';
          (f.hunks || []).forEach(function (h, hi) {
            out += '<tr class="wdf__hh"><td colspan="3">' + esc(h.header) + '</td></tr>';
            h.lines.forEach(function (l, li) {
              var key = diffKey(f.file, diffSide(l), diffLineNo(l));
              var on = d.editing && d.editing.key === key;
              out += '<tr class="wdf__l is-' + l.kind + (on ? ' is-on' : '') + '" data-wdf="line" data-f="' + fi + '" data-h="' + hi + '" data-l="' + li + '" tabindex="0" title="Comment on this line">' +
                '<td class="wdf__n">' + (l.oldLine == null ? '' : l.oldLine) + '</td><td class="wdf__n">' + (l.newLine == null ? '' : l.newLine) + '</td>' +
                '<td class="wdf__c"><span class="wdf__s" aria-hidden="true">' + (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + '</span>' + esc(l.text) + '</td></tr>';
              out += diffDraftsHtml(d, key);
              if (on) out += diffEditorHtml(d);
            });
          });
          out += '</tbody></table></div>';
          if (f.truncated) out += '<p class="wdf__cut">Cut short here: the rest of this file is on ' + where + '.</p>';
        }
      }
      out += '</div>';
    });
    var n = d.drafts.length, off = d.sending || !n ? ' disabled' : '';
    out += '<div class="wdf__foot wdo__row"><span class="wdo__n">' + (n ? n + (n === 1 ? ' comment' : ' comments') + ' drafted for ' + esc(nameOf(p.owner)) : 'Select a line to comment on it.') + '</span>' +
      '<button type="button" class="ax-btn" data-wdf="send"' + off + '>Send ' + n + (n === 1 ? ' comment' : ' comments') + ' to agent</button></div>' +
      '<p class="wdo__n wdf__note" role="status">' + esc(d.note || '') + '</p>';
    return out + '</section>';
  }
  function paintDiff() {
    var t = cxActive(), p = t && t.kind === 'changes' ? findPost(t.id) : null, el = p && $('wdf');
    paintDiffButton();
    if (!p || !el) return;
    var d = diffOf(p.id);
    el.innerHTML = d.open ? diffInner(p, d) : '';
    if (d.editing && $('wdf-text') && $('wdf-text').focus) $('wdf-text').focus();
  }
  async function diffLoad(p, pr) {
    var d = diffOf(p.id);
    d.loading = true; d.error = '';
    paintDiff();
    try {
      var r = await fetch('/api/admin/wall/diff?id=' + encodeURIComponent(p.id) + (pr ? '&pr=' + encodeURIComponent(pr) : ''), { headers: headers(p.node && p.node.peer) });
      var b = await r.json().catch(function () { return {}; });
      if (r.ok) d.data = b; else d.error = b.error || ('HTTP ' + r.status);
    } catch (e) { d.error = String(e && e.message || e); }
    d.loading = false;
    paintDiff();
  }
  function diffLineAt(d, t) {
    var f = d.data && d.data.files[+t.getAttribute('data-f')];
    var h = f && f.hunks[+t.getAttribute('data-h')];
    var l = h && h.lines[+t.getAttribute('data-l')];
    return l ? { file: f.file, side: diffSide(l), line: diffLineNo(l), code: l.text } : null;
  }
  async function diffSend(p, d) {
    if (d.sending || !d.drafts.length) return;
    d.sending = true; d.note = 'Sending…';
    paintDiff();
    var comments = d.drafts.map(function (c) { return { file: c.file, side: c.side, line: c.line, text: c.text, code: c.code }; });
    // The PR and commit the drafts were written on, not the one shown now.
    var at = d.at || { ref: d.data && d.data.ref, headSha: d.data && d.data.headSha };
    var body = { id: p.id, pr: at.ref, comments: comments };
    if (at.headSha) body.headSha = at.headSha;
    var r = await act('POST', '/api/admin/wall/diff-comments', body, p.node && p.node.peer);
    d.sending = false;
    // A failed send keeps every draft.
    if (!r.ok) { d.note = 'Not sent: ' + r.error; paintDiff(); return; }
    d.drafts = []; d.editing = null;
    diffKeep(p.id);
    d.note = (r.body && r.body.message) || 'Sent.';
    if (r.body && r.body.moved) d.note += ' Careful: the pull or merge request has moved to ' + String(r.body.headSha || '').slice(0, 12) + ' since you read these lines. Reload the diff to see it.';
    paintDiff();
    loadThread(p.id);
  }
  function diffAct(t) {
    var what = t.getAttribute('data-wdf');
    // The post's Diff button opens or closes its Changes tab in the panel.
    var p = findPost(what === 'toggle' ? S.post : diffPostId());
    if (!p || !p.mergeRef) return;
    var d = diffOf(p.id);
    if (what === 'toggle') {
      var at = cxFind('changes', p.id);
      if (at >= 0 && at === S.cx.on) cxClose(at); else cxOpen('changes', p.id);
      return;
    } else if (what === 'pr') {
      var ref = t.getAttribute('data-ref');
      if (d.drafts.length || !ref || (d.data && d.data.ref === ref)) return;
      d.editing = null; d.folded = {};
      diffLoad(p, ref);
      return;
    } else if (what === 'fold') {
      var fi = t.getAttribute('data-f');
      d.folded[fi] = !d.folded[fi];
    } else if (what === 'line') {
      var at = diffLineAt(d, t);
      if (!at) return;
      var key = diffKey(at.file, at.side, at.line);
      if (d.editing && d.editing.key === key && d.editing.n == null) d.editing = null;
      else d.editing = { key: key, file: at.file, side: at.side, line: at.line, code: at.code, text: '', n: null };
    } else if (what === 'edit') {
      var c = d.drafts[+t.getAttribute('data-n')];
      if (!c) return;
      d.editing = { key: diffKey(c.file, c.side, c.line), file: c.file, side: c.side, line: c.line, code: c.code, text: c.text, n: +t.getAttribute('data-n') };
    } else if (what === 'remove') {
      d.drafts.splice(+t.getAttribute('data-n'), 1);
      d.editing = null;
      diffKeep(p.id);
    } else if (what === 'discard') {
      d.drafts = []; d.editing = null;
      diffKeep(p.id);
      d.folded = {};
      diffLoad(p);
      return;
    } else if (what === 'cancel') {
      d.editing = null;
    } else if (what === 'add') {
      var e = d.editing, text = (($('wdf-text') && $('wdf-text').value) || e && e.text || '').trim();
      if (!e) return;
      if (!text) { d.note = 'Write the comment first.'; paintDiff(); return; }
      var draft = { file: e.file, side: e.side, line: e.line, code: e.code, text: text };
      if (!d.at && d.data) d.at = { ref: d.data.ref, headSha: d.data.headSha || null };
      if (e.n == null) d.drafts.push(draft); else d.drafts[e.n] = draft;
      d.editing = null; d.note = '';
      diffKeep(p.id);
    } else if (what === 'send') {
      diffSend(p, d);
      return;
    }
    paintDiff();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-wdf]');
    if (t) diffAct(t);
  });
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (ev.key === 'Enter' && t && t.getAttribute && t.getAttribute('data-wdf') === 'line') { ev.preventDefault(); diffAct(t); }
  });
  // What is typed in the box survives a repaint.
  document.addEventListener('input', function (ev) {
    if (!ev.target || ev.target.id !== 'wdf-text' || !diffPostId()) return;
    var d = diffOf(diffPostId());
    if (d.editing) d.editing.text = ev.target.value;
  });
`

export const WALL_DIFF_CSS = `
.wdf { margin: 12px 0 0; padding: 12px 0 0; border-top: 1px solid var(--ax-border); display: flex; flex-direction: column; gap: 8px; }
.wdf__f { border: 1px solid var(--ax-border); border-radius: var(--ax-radius); overflow: hidden; }
.wdf__fh { all: unset; box-sizing: border-box; width: 100%; display: flex; gap: 8px; align-items: center; padding: 6px 10px; cursor: pointer; background: var(--ax-surface-2); font-size: var(--ax-fs-sm); }
.wdf__fh[aria-expanded="false"] { opacity: 0.85; }
.wdf__fn { font-family: var(--ax-mono); overflow-wrap: anywhere; flex: 1; }
.wdf__ct { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); white-space: nowrap; }
.wdf__ct .is-add { color: var(--ax-green); }
.wdf__ct .is-del { color: var(--ax-red-ink, var(--ax-err)); }
.wdf__w { overflow-x: auto; }
.wdf__t { border-collapse: collapse; width: 100%; font-family: var(--ax-mono); font-size: 12px; line-height: 1.5; }
.wdf__t td { padding: 0 6px; vertical-align: top; }
.wdf__hh td { color: var(--ax-muted); background: var(--ax-blue-t, var(--ax-surface-2)); padding: 2px 8px; }
.wdf__l { cursor: pointer; }
.wdf__l:hover, .wdf__l:focus, .wdf__l.is-on { outline: 1px solid var(--ax-accent); outline-offset: -1px; }
.wdf__l.is-add { background: color-mix(in srgb, var(--ax-green) 12%, transparent); }
.wdf__l.is-del { background: color-mix(in srgb, var(--ax-red) 12%, transparent); }
.wdf__n { width: 1%; min-width: 3ch; text-align: right; color: var(--ax-muted); user-select: none; white-space: nowrap; }
/* Long lines wrap: a table wider than the post would push the drafts'
   text and their Edit/Remove buttons out of sight. */
.wdf__c { white-space: pre-wrap; overflow-wrap: anywhere; }
.wdf__s { display: inline-block; width: 1.5ch; color: var(--ax-muted); user-select: none; }
.wdf__ed td, .wdf__dr td { padding: 6px 10px; font-family: var(--ax-font, inherit); background: var(--ax-surface); }
.wdf__ed .wdo__row { margin-top: 6px; }
.wdf__dr ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wdf__dr li { display: flex; gap: 8px; align-items: baseline; border-left: 3px solid var(--ax-accent); padding-left: 8px; }
.wdf__dt { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.wdf__prs { display: flex; flex-wrap: wrap; gap: 6px; }
.wdf__prs .chip[aria-pressed="true"] { outline: 1px solid var(--ax-accent); }
.wdf__st, .wdf__sha { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdf__cut { margin: 0; padding: 6px 10px; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdf__foot { position: sticky; bottom: 0; background: var(--ax-bg); padding: 6px 0; }
.wdf__foot .wdo__n { margin-right: auto; }
`
