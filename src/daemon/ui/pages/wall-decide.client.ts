// --- Needs you: answer what waits on the owner, on the Wall (#1440) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc(),
// when(), until(), stamp(), getJson(), headers(), $(), render(), findPost(),
// postHtml() and waitsOnOwner().
//
// The Needs you page (#view=decide) is the Approvals inbox: it reads
// /api/admin/approvals, the same list and count /approvals, the phone
// app's Desk and the digest show, and answers through
// /api/admin/wall/decide (served by /api/admin/approvals/decide) with the
// same body /approvals sends, so the result and its record are the same. Under it, the posts waiting on you.
// A decision card on a post is answered on the post, through the same
// call, sent to the node that keeps the post.
//
// Owner-only: the answers go under /api/admin/wall, so the Wall's
// owner-only guard (#1454, board-dashboard.ts) refuses them from anyone else. A refusal shows as a
// note, and nothing on the page changes.
//
// A pick or an edited message is kept per item in D, so the Wall's
// refreshes do not throw it away.

export const WALL_DECIDE_SCRIPT = String.raw`
  var D = { data: null, loading: false, kind: '', all: false, note: '', noteErr: false, picks: {}, texts: {}, sending: {} };
  var DEC_LABEL = { card: 'Card', schedule: 'Schedule', agent: 'New agent', memory: 'Memory fact', wiki: 'Wiki lesson', whatsapp: 'WhatsApp reply', email: 'Email reply', content: 'Post', request: 'Request' };
  var DEC_KINDS = ['card', 'schedule', 'agent', 'memory', 'wiki', 'whatsapp', 'email', 'content', 'request'];
  /** The choice the advice names: same rule as /approvals and the Mac card. */
  function decAdvised(choices, recommend) {
    var rec = String(recommend || '').trim(), low = rec.toLowerCase(), best = -1;
    (choices || []).forEach(function (c, n) {
      if (low.indexOf(c.toLowerCase()) !== 0) return;
      var r = rec.slice(c.length).replace(/^ +/, '');
      if (r && !(':,.;–—-'.indexOf(r.charAt(0)) >= 0 && (r.length === 1 || r.charAt(1) === ' '))) return;
      if (best < 0 || c.length > choices[best].length) best = n;
    });
    return best;
  }
  function decFill(draft, label) { return label ? String(draft).split('{choice}').join(label) : String(draft); }
  function decPick(o) { return D.picks[o.key] != null ? D.picks[o.key] : decAdvised(o.choices, o.recommend); }
  /** The answer part of an item: choices, the message a yes sends, the buttons. */
  function decFormHtml(o) {
    var pick = decPick(o), name = 'wdc-' + o.key;
    var choices = (o.choices || []).length ? '<fieldset class="wdc__choices"><legend>Pick one, then Yes</legend>' + o.choices.map(function (c, n) {
      return '<label class="wdc__opt"><input type="radio" name="' + esc(name) + '" value="' + n + '"' + (n === pick ? ' checked' : '') + '><span>' + esc(c) +
        (n === decAdvised(o.choices, o.recommend) ? ' <em>recommended</em>' : '') + '</span></label>';
    }).join('') + '</fieldset>' : '';
    var text = D.texts[o.key] != null ? D.texts[o.key] : o.draft ? decFill(o.draft, pick >= 0 ? o.choices[pick] : '') : '';
    var draft = o.draft ? '<label class="wdc__draft">' + (o.kind === 'email' ? 'The email that is sent (you can edit it)' : 'Message the agent gets (you can edit it)') +
      '<textarea rows="' + (o.kind === 'email' ? 7 : 4) + '" data-dtext>' + esc(text) + '</textarea></label>' : '';
    var off = D.sending[o.key] ? ' disabled' : '';
    return choices + draft + '<div class="wdc__acts">' +
      '<button type="button" class="ax-btn ax-btn--primary" data-decide="yes"' + off + '>Yes</button>' +
      '<button type="button" class="ax-btn ax-btn--danger" data-decide="no"' + off + '>No</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-decide="later"' + off + ' title="Hide it for now; a card still expires on time">Later</button>' +
      (o.popup ? '<button type="button" class="ax-btn ax-btn--ghost" data-decide="pop"' + off + ' title="Show this card on the Mac again">Show on Mac</button>' : '') +
    '</div>';
  }
  /** Where an item is answered: its key, the node that keeps it, its hash. */
  function decAttrs(key, peer, hash, title) {
    return ' data-dkey="' + esc(key) + '"' + (peer ? ' data-dpeer="' + esc(peer) + '"' : '') + (hash ? ' data-dseen="' + esc(hash) + '"' : '') +
      (title ? ' data-dtitle="' + esc(title) + '"' : '');
  }
  /** The server's answer names the item by its key: say its title instead. */
  function decSaid(msg, key, title) {
    return String(msg).split(key + ':').join(title ? '“' + title + '”:' : '').split(key).join(title ? '“' + title + '”' : 'It').replace(/^:\s*/, '');
  }
  function decRel(iso) {
    var ms = Date.parse(iso || '');
    return isNaN(ms) ? '' : ms > Date.now() ? until(ms) : ago(ms);
  }
  /** One inbox item, as /approvals shows it. */
  function decItemHtml(i) {
    var exp = i.expires ? Date.parse(i.expires) : 0;
    var soon = exp && exp - Date.now() < 864e5;
    var more = [];
    if (i.detail) more.push('<p>' + esc(i.detail) + '</p>');
    if (i.source) more.push('<p>Source: ' + linkOrText(i.source) + '</p>');
    more.push('<p>Yes: ' + esc(i.yes) + '. No: ' + esc(i.no) + '.</p>');
    var o = { key: i.key, kind: i.kind, choices: i.choices, recommend: i.recommend, draft: i.draft, popup: i.kind === 'card' && D.data && D.data.popup };
    return '<article class="wdc' + (soon ? ' is-soon' : '') + '"' + decAttrs(i.key, null, i.text_hash, i.title) + ' aria-label="' + esc((DEC_LABEL[i.kind] || 'Item') + ': ' + i.title) + '">' +
      '<div class="wdc__meta"><span class="wdc__kind">' + esc(DEC_LABEL[i.kind] || i.kind) + '</span><span>from <b>' + esc(nameOf(i.raised_by)) + '</b>' + (i.node ? ' on ' + esc(i.node) : '') + '</span>' +
        (i.created_at ? '<span>' + esc(decRel(i.created_at)) + '</span>' : '') +
        (i.snoozed_until ? '<span>put off until ' + esc(stamp(Date.parse(i.snoozed_until))) + '</span>' : '') + '</div>' +
      '<h2 class="wdc__title" dir="auto">' + esc(i.title) + '</h2>' +
      (i.ask && i.ask !== i.title ? '<p class="wdc__ask" dir="auto">' + esc(i.ask) + '</p>' : '') +
      (i.recommend ? '<p class="wdc__rec"><b>Recommends:</b> ' + esc(i.recommend) + '</p>' : '') +
      (exp ? '<p class="wdc__exp' + (soon ? ' is-soon' : '') + '" title="' + esc(stamp(exp)) + '">' + (exp <= Date.now() ? 'Expired' : 'Expires ' + esc(until(exp))) + ', then: ' + esc(i.if_silent || '') + '</p>' : '') +
      decFormHtml(o) +
      '<details class="wdc__more"><summary>Details</summary>' + more.join('') + '</details>' +
    '</article>';
  }
  /** A request whose agent asked you a question: answered with a comment on its post. */
  function decAskedHtml(c) {
    var id = String(c.key || '').replace(/^request:/, '');
    return '<article class="wdc wdc--asked">' +
      '<div class="wdc__meta"><span class="wdc__kind">Request</span>' + (c.agent ? '<span>from <b>' + esc(nameOf(c.agent)) + '</b></span>' : '') +
        (c.askedAt ? '<span>' + esc(decRel(c.askedAt)) + '</span>' : '') + '</div>' +
      '<h2 class="wdc__title" dir="auto">' + esc(c.title) + '</h2>' +
      ((c.ask || c.need) ? '<p class="wdc__ask" dir="auto">' + esc(c.ask || c.need) + '</p>' : '') +
      '<div class="wdc__acts"><a class="ax-btn" href="' + esc(hashOf(id)) + '" data-open="' + esc(id) + '">Answer on its post</a></div>' +
    '</article>';
  }
  /** What the owner's one list holds beyond the inbox: requests that asked a question. */
  function decExtra() {
    var v = D.data;
    if (!v || D.all || !v.desk) return [];
    var keys = {};
    (v.items || []).forEach(function (i) { keys[i.key] = true; });
    return (v.desk.items || []).filter(function (c) { return !keys[c.key]; });
  }
  /** How many wait for you: the owner's one list, as /approvals counts it. */
  function decideCount() {
    var v = D.data;
    if (!v || v.error) return null;
    return v.desk ? v.desk.count : (v.items || []).length;
  }
  function decCounts() {
    var c = {};
    ((D.data && D.data.items) || []).forEach(function (i) { c[i.kind] = (c[i.kind] || 0) + 1; });
    c.request = (c.request || 0) + decExtra().length;
    return c;
  }
  function decideHtml() {
    var v = D.data;
    var note = D.note ? '<p class="wdc__note' + (D.noteErr ? ' is-err' : '') + '" role="status">' + esc(D.note) + '</p>' : '<p class="wdc__note" role="status"></p>';
    if (!v) return note + '<p class="ax-wall__empty">Loading what waits for you…</p>';
    if (v.error) return note + '<p class="ax-wall__empty">Could not load what waits for you: ' + esc(v.error) + '. <button type="button" class="wa-more" data-dreload>Try again</button></p>';
    var items = v.items || [], extra = decExtra(), c = decCounts(), dk = v.desk;
    var head = '<p class="ax-wall__count">' + (dk ? dk.count + ' waiting for you' + (dk.later ? ', ' + dk.later + ' put off for later' : '') + '. The phone app’s Desk and the daily digest count the same.'
      : items.length + ' waiting for you.') + '</p>';
    var errs = (v.errors || []).map(function (e) { return '<p class="wdc__note is-err">Could not read ' + esc(DEC_LABEL[e.kind] || e.kind) + ': ' + esc(e.error) + '. The list may be incomplete.</p>'; }).join('');
    var kinds = DEC_KINDS.filter(function (k) { return c[k]; });
    var tabs = kinds.length > 1 ? '<div class="ax-wall__views wr__tabs" role="tablist" aria-label="Show">' +
      [['', 'All', items.length + extra.length]].concat(kinds.map(function (k) { return [k, DEC_LABEL[k] + (k === 'card' || k === 'request' ? 's' : ''), c[k]]; })).map(function (t) {
        var on = D.kind === t[0];
        return '<button type="button" role="tab" data-dkind="' + t[0] + '" class="' + (on ? 'is-on' : '') + '" aria-selected="' + (on ? 'true' : 'false') + '">' + esc(t[1]) + ' ' + t[2] + '</button>';
      }).join('') + '</div>' : '';
    var shown = items.filter(function (i) { return !D.kind || i.kind === D.kind; });
    var asked = !D.kind || D.kind === 'request' ? extra : [];
    var list = shown.length || asked.length ? shown.map(decItemHtml).join('') + asked.map(decAskedHtml).join('')
      : '<div class="wdc__empty"><h2>Nothing waiting for you</h2><p>Questions from agents, schedules, memory, the wiki and drafted replies show up here.</p></div>';
    var later = v.snoozed && !D.all ? '<p class="ax-wall__count wdc__foot">' + v.snoozed + ' put off for later. <button type="button" class="wa-more" data-dall="1">Show them</button></p>'
      : D.all ? '<p class="ax-wall__count wdc__foot"><button type="button" class="wa-more" data-dall="">Hide what is put off for later</button></p>' : '';
    var posts = ((S.data && S.data.posts) || []).filter(function (p) { return isOpen(p) && waitsOnOwner(p); });
    var feed = '<h2 class="wdc__h">Posts waiting on you</h2>' + (posts.length ? posts.map(function (p) { return postHtml(p); }).join('')
      : '<p class="ax-wall__empty">' + (S.data ? 'No open post waits on you.' : 'Loading posts…') + '</p>');
    return note + head + errs + tabs + list + later + feed;
  }
  async function loadDecide() {
    D.loading = true;
    try {
      var d = await getJson('/api/admin/approvals' + (D.all ? '?all=1' : ''));
      d.popup = !!(d.settings && d.settings.popup && d.settings.popup.enabled);
      D.data = d;
    } catch (e) { D.data = { error: e.message }; }
    D.loading = false;
    render();
  }
  function refreshDecide() { loadDecide(); }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderDecide(view) {
    var on = view === 'decide';
    $('wall-decide').hidden = !on;
    if (!on) return;
    $('wall-count').hidden = true;
    $('wall-profile').hidden = true;
    if (!D.data && !D.loading) loadDecide();
    var busy = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-dtext') && $('wall-decide').contains(document.activeElement);
    if (!busy) $('wall-decide').innerHTML = decideHtml();
  }
  function decNote(text, err) {
    D.note = text; D.noteErr = !!err;
    document.querySelectorAll('.wdc__note[role=status]').forEach(function (el) { el.textContent = text; el.classList.toggle('is-err', !!err); });
    // On a post, the note under its comment box says it, and keeps saying it.
    if (S.post) note(text);
  }
  /** Answer one item: the same call and body as /approvals. */
  async function decide(el, action) {
    var key = el.getAttribute('data-dkey'), peer = el.getAttribute('data-dpeer');
    if (!key || D.sending[key]) return;
    var body = { key: key, action: action };
    var picked = el.querySelector('input[type=radio]:checked');
    if (action === 'yes' && el.querySelector('input[type=radio]')) {
      if (!picked) { decNote('Pick one of the choices first.', true); el.querySelector('input[type=radio]').focus(); return; }
      body.choice = Number(picked.value) + 1;
    }
    // Only an edited message is sent: the card keeps its own suggested one.
    if (action === 'yes' && D.texts[key] != null && D.texts[key].trim()) body.text = D.texts[key];
    if (action === 'yes' && el.getAttribute('data-dseen')) body.seen = el.getAttribute('data-dseen');
    var path = action === 'pop' ? '/api/admin/wall/decide/popup' : '/api/admin/wall/decide';
    if (action === 'pop') body = { key: key };
    D.sending[key] = true;
    el.querySelectorAll('button[data-decide]').forEach(function (b) { b.disabled = true; });
    decNote(action === 'pop' ? 'Showing it on the Mac…' : 'Sending your answer…');
    var h = headers(peer);
    h['Content-Type'] = 'application/json';
    var ok = false, msg = '';
    try {
      var r = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body) });
      var b = await r.json().catch(function () { return {}; });
      ok = r.ok;
      msg = r.ok ? decSaid(b.message || 'Done.', key, el.getAttribute('data-dtitle')) : r.status === 401 || r.status === 403 ? 'Only the owner can answer this. Sign in with the dashboard key, then try again.' : (b.error || ('HTTP ' + r.status));
    } catch (e) { msg = String(e && e.message || e); }
    delete D.sending[key];
    if (!ok) {
      // Nothing changed: the item stays, with the reason over the list.
      decNote('Not answered: ' + msg, true);
      render();
      return;
    }
    decNote(msg);
    if (action === 'pop') { render(); return; }
    // The item leaves at once, here and on its post; the next reads confirm it.
    delete D.picks[key]; delete D.texts[key];
    if (D.data && D.data.items) {
      D.data.items = D.data.items.filter(function (i) { return i.key !== key; });
      if (action === 'later') D.data.snoozed = (D.data.snoozed || 0) + 1;
      if (D.data.desk && action !== 'later') D.data.desk.count = Math.max(0, D.data.desk.count - 1);
    }
    var cardId = key.indexOf('card:') === 0 ? key.slice(5) : '';
    if (cardId) ((S.data && S.data.posts) || []).concat(S.extra ? [S.extra] : []).forEach(function (p) {
      p.ownerCards = (p.ownerCards || []).filter(function (c) { return c.id !== cardId; });
    });
    render();
    loadDecide();
    if (S.post) loadThread(S.post);
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-decide],[data-dkind],[data-dall],[data-dreload]');
    if (!t) return;
    if (t.hasAttribute('data-decide')) { var el = t.closest('[data-dkey]'); if (el) decide(el, t.getAttribute('data-decide')); }
    else if (t.hasAttribute('data-dkind')) { D.kind = t.getAttribute('data-dkind'); render(); }
    else if (t.hasAttribute('data-dall')) { D.all = !!t.getAttribute('data-dall'); D.data = null; loadDecide(); render(); }
    else loadDecide();
  });
  // A pick fills the message, until the owner edits the message by hand.
  document.addEventListener('change', function (ev) {
    var t = ev.target, el = t.closest && t.closest('[data-dkey]');
    if (!el || !t.matches('input[type=radio]')) return;
    var key = el.getAttribute('data-dkey');
    D.picks[key] = Number(t.value);
    var ta = el.querySelector('textarea[data-dtext]'), o = decSource(key, el);
    if (ta && o && D.texts[key] == null) ta.value = decFill(o.draft, o.choices[D.picks[key]]);
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target, el = t.closest && t.closest('[data-dkey]');
    if (el && t.hasAttribute('data-dtext')) D.texts[el.getAttribute('data-dkey')] = t.value;
  });
  /** The choices and draft behind an item, from the inbox or its post. */
  function decSource(key, el) {
    var i = ((D.data && D.data.items) || []).find(function (x) { return x.key === key; });
    if (i) return { choices: i.choices || [], draft: i.draft || '' };
    var p = findPost(S.post), c = p && (p.ownerCards || []).find(function (x) { return 'card:' + x.id === key; });
    return c ? { choices: c.choices || [], draft: c.draft || '' } : null;
  }
`

export const WALL_DECIDE_CSS = `
.ax-wall__decide { padding: 12px 16px; }
.ax-wall__decide > .ax-wall__count { margin-bottom: 10px; }
.wdc { background: var(--ax-bg-elev); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 12px 14px; margin-bottom: 10px; font-size: var(--ax-fs-sm); }
.wdc:focus-within { border-color: var(--ax-accent); }
.wdc.is-soon { border-left: 3px solid var(--ax-red); }
.wdc__meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdc__meta b { color: var(--ax-text-2); font-weight: 600; }
.wdc__kind { text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--ax-mono); }
.wdc__title { margin: 4px 0 0; font-size: var(--ax-fs); font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.wdc__ask { margin: 4px 0 0; overflow-wrap: anywhere; }
.wdc__rec { margin: 6px 0 0; color: var(--ax-text-2); overflow-wrap: anywhere; }
.wdc__rec b { color: var(--ax-green); font-weight: 600; }
.wdc__exp { display: inline-block; margin: 6px 0 0; padding: 1px 8px; border-radius: var(--ax-radius-pill); font-size: var(--ax-fs-xs); background: var(--ax-amber-t, var(--ax-surface-2)); color: var(--ax-amber-ink, var(--ax-warn)); }
.wdc__exp.is-soon { background: var(--ax-red-t, var(--ax-surface-2)); color: var(--ax-red-ink, var(--ax-err)); }
.wdc__choices { border: 0; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wdc__choices legend { font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-bottom: 4px; padding: 0; }
.wdc__opt { display: flex; gap: 8px; align-items: flex-start; line-height: 1.4; padding: 8px 10px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-sm); cursor: pointer; overflow-wrap: anywhere; }
.wdc__opt:has(input:checked) { border-color: var(--ax-accent); background: var(--ax-accent-t, var(--ax-surface)); }
.wdc__opt input { margin-top: 3px; accent-color: var(--ax-accent); }
.wdc__opt em { font-style: normal; font-size: var(--ax-fs-xs); color: var(--ax-green); white-space: nowrap; }
.wdc__draft { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdc__draft textarea { font: inherit; font-size: var(--ax-fs-sm); line-height: 1.45; padding: 8px 10px; border-radius: var(--ax-radius-sm); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); resize: vertical; min-height: 80px; width: 100%; box-sizing: border-box; }
.wdc__acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.wdc__acts .ax-btn { min-height: 40px; min-width: 80px; }
.wdc__more { margin-top: 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wdc__more summary { cursor: pointer; color: var(--ax-muted); }
.wdc__more p { margin: 4px 0 0; overflow-wrap: anywhere; }
.wdc__more a { color: var(--ax-accent); }
.wdc__note { margin: 0 0 8px; font-size: var(--ax-fs-sm); color: var(--ax-green); }
.wdc__note:empty { display: none; }
.wdc__note.is-err { color: var(--ax-red-ink, var(--ax-err)); }
.wdc__empty { text-align: center; padding: 28px 12px; color: var(--ax-muted); border: 1px dashed var(--ax-border); border-radius: var(--ax-radius-lg); }
.wdc__empty h2 { font-size: var(--ax-fs); color: var(--ax-text); margin: 0 0 4px; }
.wdc__empty p { margin: 0; }
.wdc__foot { margin: 0 0 8px; }
.wdc__h { font-size: var(--ax-fs); font-weight: 800; margin: 18px 0 0; padding-top: 12px; border-top: 1px solid var(--ax-border); }
.ax-wall__decide .wp { padding-left: 0; padding-right: 0; }
/* A card on its post answers in place (#1440). */
.wc .wdc__acts { margin-top: 8px; }
@media (max-width: 560px) { .wdc__acts .ax-btn { flex: 1 1 0; } }
`
