// --- Hand off, Done and Drop on an open post (#1440) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S,
// esc(), $(), act(), note(), nameOf(), findPost(), isOpen() and load().
//
// /approvals listed every open request with Hand to agent, Done and Drop
// (its Open requests section). Needs you has them for a request that waits
// on the owner; this puts them on every open post, so nothing was lost when
// /approvals began to redirect to the Hub. Owner only: the server says who
// that is with window.AX_WALL_SETTINGS (wall.ts), and the guard refuses
// anyone else anyway (#1454). The calls are Needs you's,
// /api/admin/wall/request/handoff and /close, sent to the node that keeps
// the post, like a comment. The words in the comment box go with it: the
// hand-off note, or why it is done or dropped. They are read when Confirm is
// pressed, so an edit made while the confirm line shows is what is sent.

export const WALL_CLOSE_SCRIPT = String.raw`
  /** The agents on the post's node: a request is handed to one of those,
   *  its own agent included, to make it try again (as /approvals had it). */
  function closeAgents(p) {
    var node = ((S.live && S.live.nodes) || []).filter(function (n) { return p.node && n.name === p.node.name; })[0];
    return (node && node.agents) || [];
  }
  /** The row under the comment box: Hand to…, Done and Drop, then the confirm. */
  function closeWords() { return ($('wdo-text') && $('wdo-text').value || '').trim(); }
  function closeHtml(p) {
    if (!window.AX_WALL_SETTINGS || !isOpen(p)) return '';
    var c = S.closing && S.closing.id === p.id ? S.closing : null, off = c && c.sending ? ' disabled' : '';
    var agents = closeAgents(p);
    var hand = agents.length ? '<select id="wdo-hand" aria-label="Hand it to"' + off + '><option value="">Hand to…</option>' + agents.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (c && c.kind === 'handoff' && c.agent === a.id ? ' selected' : '') + '>' + esc(a.name || a.id) + (a.id === p.owner ? ' (has it: try again)' : '') + '</option>';
    }).join('') + '</select>' : '';
    var confirm = '';
    if (c) {
      var t = '“' + (p.headline || p.id) + '”';
      var lead = c.kind === 'handoff' ? 'Hand ' + t + ' to ' + nameOf(c.agent) + '.' : c.kind === 'done' ? 'Close ' + t + ' as done.' : 'Drop ' + t + '.';
      var said = closeWords() ? ' Your words above go with it.' : '';
      confirm = '<div class="wdc__confirm" role="group" aria-label="Confirm"><p><b>' + esc(lead) + '</b>' + esc(said) + ' It cannot be taken back.</p>' +
        '<span class="wdc__cbtns"><button type="button" class="ax-btn ax-btn--primary" data-act="close-go"' + off + '>Confirm</button>' +
        '<button type="button" class="ax-btn ax-btn--ghost" data-act="close-back"' + off + '>Back</button></span></div>';
    }
    return '<div class="wdo__row" aria-label="Close or hand off">' + hand +
      '<button type="button" class="ax-btn ax-btn--ghost" data-act="close-done"' + off + '>Done</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-act="close-drop"' + off + '>Drop</button></div>' + confirm;
  }
  function paintClose() {
    var p = findPost(S.post), el = $('wdo-close');
    if (p && el) el.innerHTML = closeHtml(p);
  }
  /** Arm one of them; Confirm sends it. */
  function closeAsk(kind, agent) {
    var p = findPost(S.post);
    if (!p) return;
    S.closing = { id: p.id, kind: kind, agent: agent || '', said: !!closeWords() };
    paintClose();
  }
  async function closeSend() {
    var p = findPost(S.post), c = S.closing;
    if (!p || !c || c.id !== p.id || c.sending) return;
    c.sending = true;
    c.text = closeWords();
    paintClose();
    note('Sending…');
    var r = c.kind === 'handoff'
      ? await act('POST', '/api/admin/wall/request/handoff', { id: p.id, agentId: c.agent, note: c.text }, p.node && p.node.peer)
      : await act('POST', '/api/admin/wall/request/close', c.kind === 'done' ? { id: p.id, action: 'done', evidence: c.text } : { id: p.id, action: 'drop', reason: c.text }, p.node && p.node.peer);
    S.closing = null;
    paintClose();
    if (!r.ok) { note('Not sent: ' + r.error); return; }
    if (c.text) { delete S.drafts[p.id]; if ($('wdo-text')) $('wdo-text').value = ''; }
    note(r.body.message || 'Done.');
    load();
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.id === 'wdo-hand' && t.value) closeAsk('handoff', t.value);
  });
  /** The confirm line says whether the box's words go with it; keep it true as they are typed. */
  document.addEventListener('input', function (ev) {
    var c = S.closing;
    if (!ev.target || ev.target.id !== 'wdo-text' || !c || c.sending || c.id !== S.post) return;
    var has = !!closeWords();
    if (has !== !!c.said) { c.said = has; paintClose(); }
  });
`
