// --- Needs you: answer what waits on the owner, on the Wall (#1440) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's esc(),
// when(), until(), ago(), stamp(), short(), getJson(), headers(), $(),
// render(), avatar(), nameOf(), findPost(), isOpen(), waitsOnOwner() and,
// for Reviews, R, loadReviews() and revPath() (wall-reviews.client.ts).
//
// The page follows round-2 frame 01 (notes/design/wall-v2-round-2.md §1):
//   - Waiting / Put off / Answered tabs. Waiting and Put off are the
//     owner's one list from /api/admin/approvals (`desk`), so the count is
//     the one /approvals, the phone app's Desk and the digest show.
//     Answered is the answered list (?answered=1, approvals/answered.ts).
//   - Chips by kind. Reviews are the graph's classifier reviews
//     (/api/admin/wall/reviews): shown as a chip, outside All and the
//     count, as on the frame, since /approvals does not count them.
//   - Every answer opens a one-line confirm that says what is sent;
//     Confirm sends it through the Wall's own routes, which serve the
//     /approvals calls under the owner-only guard (#1454):
//     /api/admin/wall/decide, /wall/request/*, /wall/review/*.
//   - What it unblocks: the post the card is on and the runs paused on it.
//   - Anyone else (`owner: false`) sees the same cards without buttons,
//     under "Needs the owner". The guard refuses their answer anyway.
//
// A pick, an edited message or a reply is kept per item in D, so the
// Wall's refreshes do not throw it away.

export const WALL_DECIDE_SCRIPT = String.raw`
  var D = { data: null, loading: false, reqs: null, tab: 'waiting', kind: '', note: '', noteErr: false, picks: {}, texts: {}, replies: {}, hand: {}, sending: {}, confirm: null };
  var DEC_BADGE = { card: 'Decision', schedule: 'Schedule', agent: 'New agent', memory: 'Memory', wiki: 'Wiki', whatsapp: 'Draft', email: 'Draft', content: 'Draft', request: 'Request', review: 'Review' };
  var DEC_CHIPS = [['decisions', 'Decisions', ['card', 'agent']], ['schedules', 'Schedules', ['schedule']], ['memory', 'Memory', ['memory']], ['wiki', 'Wiki', ['wiki']],
    ['drafts', 'Drafts', ['whatsapp', 'email', 'content']], ['requests', 'Requests', ['request']], ['reviews', 'Reviews', []]];
  var DEC_SILENT = { discard: 'the agent drops it', keep: 'nothing is approved', pause: 'the agent pauses this work' };
  var DEC_REACH = { all: 'all', urgent: 'urgent only', off: 'off' };
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
  /** False only when the dashboard says this is not the owner. */
  function decOwner() { return !(D.data && D.data.owner === false); }
  function decCap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // --- The confirm: one line that says exactly what is sent ---
  function decSays(o, action) {
    var who = nameOf(o.agent || ''), t = '“' + (o.title || '') + '”', pick = decPick(o);
    if (action === 'later') {
      var h = (D.data && D.data.settings && D.data.settings.laterHours) || 24;
      return { lead: 'Put ' + t + ' off for ' + h + ' h.', tail: 'It comes back on Waiting then; a card still expires on time.' };
    }
    var lead;
    if (action === 'reply') lead = 'Send ' + who + ' your reply.';
    else if (action === 'handoff') lead = 'Hand ' + t + ' to ' + nameOf(D.hand[o.key] || '') + '.';
    else if (action === 'done') lead = 'Close ' + t + ' as done.';
    else if (action === 'drop') lead = 'Drop ' + t + '.';
    else if (action === 'approve') lead = 'Approve ' + t + ': it is added to the graph.';
    else if (action === 'reject') lead = 'Reject ' + t + ': nothing is added.';
    else if (o.kind === 'card') {
      var label = action === 'yes' && pick >= 0 && o.choices && o.choices[pick] ? ', ' + o.choices[pick] : '';
      lead = 'Send ' + who + ': ' + (action === 'yes' ? 'Yes' : 'No') + label + '.' + (action === 'yes' && D.texts[o.key] != null ? ' With your edited message.' : '');
    } else lead = decCap(action === 'yes' ? o.yes : o.no) + '.';
    return { lead: lead, tail: 'It is recorded as your answer, as on the Desk, and cannot be taken back.' };
  }
  function decConfirmHtml(o) {
    var c = D.confirm;
    if (!c || c.key !== o.key) return '';
    var s = decSays(o, c.action), off = D.sending[o.key] ? ' disabled' : '';
    return '<div class="wdc__confirm" role="group" aria-label="Confirm your answer"><p><b>' + esc(s.lead) + '</b> ' + esc(s.tail) + '</p>' +
      '<span class="wdc__cbtns"><button type="button" class="ax-btn ax-btn--primary" data-dgo' + off + '>Confirm</button>' +
      '<button type="button" class="ax-btn ax-btn--ghost" data-dback' + off + '>Back</button></span></div>';
  }
  function decBtn(action, label, primary, o) {
    var on = D.confirm && D.confirm.key === o.key && D.confirm.action === action;
    return '<button type="button" class="ax-btn' + (primary ? ' ax-btn--primary' : ' ax-btn--ghost') + (on ? ' is-on' : '') + '" data-decide="' + action + '"' +
      (D.sending[o.key] ? ' disabled' : '') + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
  }

  /** The answer part of an item: choices, folded draft, buttons, confirm. */
  function decFormHtml(o) {
    if (!decOwner()) return '';
    var pick = decPick(o), name = 'wdc-' + o.key, adv = decAdvised(o.choices, o.recommend);
    var choices = (o.choices || []).length ? '<fieldset class="wdc__choices"><legend>Pick one</legend>' + o.choices.map(function (c, n) {
      return '<label class="wdc__opt"><input type="radio" name="' + esc(name) + '" value="' + n + '"' + (n === pick ? ' checked' : '') + '><span>' + esc(c) +
        (n === adv ? ' <em>advised</em>' : '') + '</span></label>';
    }).join('') + '</fieldset>' : '';
    var text = D.texts[o.key] != null ? D.texts[o.key] : o.draft ? decFill(o.draft, pick >= 0 ? o.choices[pick] : '') : '';
    var fold = [];
    if (o.draft) fold.push('<label class="wdc__draft">' + (o.kind === 'email' ? 'The email that is sent (you can edit it)' : 'The message ' + esc(nameOf(o.agent || '') || 'the agent') + ' gets (you can edit it)') +
      '<textarea rows="' + (o.kind === 'email' ? 7 : 4) + '" data-dtext>' + esc(text) + '</textarea></label>');
    if (o.yes) fold.push('<p>Yes: ' + esc(o.yes) + '. No: ' + esc(o.no) + '.</p>');
    if (o.detail) fold.push('<p>' + esc(o.detail) + '</p>');
    if (o.source) fold.push('<p>Source: ' + linkOrText(o.source) + '</p>');
    if (o.popup) fold.push('<p><button type="button" class="ax-btn ax-btn--ghost" data-dpop>Show it on the Mac again</button></p>');
    var more = fold.length ? '<details class="wdc__more"><summary>' + (o.draft ? 'The draft, and what Yes and No do' : 'Details, and what Yes and No do') + '</summary>' + fold.join('') + '</details>' : '';
    var yesL = o.kind === 'memory' ? 'Keep' : 'Yes', noL = o.kind === 'memory' ? 'Drop' : 'No';
    var reply = o.kind === 'card' && o.post ? '<a class="ax-btn ax-btn--ghost wdc__alt" href="' + esc(hashOf(o.post)) + '" data-open="' + esc(o.post) + '">Reply instead</a>' : '';
    return choices + more + (o.unblocks || '') + '<div class="wdc__acts">' + decBtn('yes', yesL, true, o) + decBtn('no', noL, false, o) + decBtn('later', 'Later', false, o) + reply + '</div>' + decConfirmHtml(o);
  }
  /** A request that waits on the owner: a reply, a hand-off, done or drop. */
  function decRequestForm(o) {
    if (!decOwner()) return '';
    var agents = (D.reqs && D.reqs.agents) || [], off = D.sending[o.key] ? ' disabled' : '';
    var hand = agents.length ? '<select class="wdc__hand" data-dhand aria-label="Hand it to"' + off + '><option value="">Hand to…</option>' + agents.filter(function (a) { return a.id !== o.agent; }).map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (D.hand[o.key] === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('') + '</select>' : '';
    return '<label class="wdc__draft">Your reply<textarea rows="3" data-dreply placeholder="Write a reply to ' + esc(nameOf(o.agent || '')) + '">' + esc(D.replies[o.key] || '') + '</textarea></label>' +
      '<div class="wdc__acts">' + decBtn('reply', 'Send reply', true, o) + hand + decBtn('done', 'Done', false, o) + decBtn('drop', 'Drop', false, o) + '</div>' + decConfirmHtml(o);
  }
  function decReviewForm(o) {
    if (!decOwner()) return '';
    return '<div class="wdc__acts">' + decBtn('approve', 'Approve', true, o) + decBtn('reject', 'Reject', false, o) + '</div>' + decConfirmHtml(o);
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

  // --- What an answer unblocks: the post the card is on, the runs paused on it ---
  function decPostOf(key) {
    var id = key.indexOf('card:') === 0 ? key.slice(5) : '';
    if (key.indexOf('request:') === 0) return findPost(key.slice(8)) || null;
    return id ? ((S.data && S.data.posts) || []).find(function (p) { return (p.ownerCards || []).some(function (c) { return c.id === id; }); }) || null : null;
  }
  function decHeld(key) {
    var id = key.indexOf('card:') === 0 ? key.slice(5) : '';
    return id ? ((S.wf && S.wf.runs) || []).filter(function (r) { return r.status === 'paused' && r.pausedAt && r.pausedAt.kind === 'ownerDecision' && r.pausedAt.cardId === id; }) : [];
  }
  function decRunsWords(runs) {
    var by = {};
    runs.forEach(function (r) { var n = r.homeNode || 'this computer'; by[n] = (by[n] || 0) + 1; });
    return Object.keys(by).map(function (n) { return by[n] + ' run' + (by[n] > 1 ? 's' : '') + ' on ' + n; }).join(', ');
  }
  function decNodes(runs) {
    var seen = {};
    runs.forEach(function (r) { seen[r.homeNode || 'this computer'] = true; });
    return Object.keys(seen).join(', ');
  }
  function decUnblocks(o, compact) {
    if (o.kind === 'memory' || o.kind === 'wiki' || o.kind === 'review') return '';
    var p = decPostOf(o.key), runs = decHeld(o.key), parts = [];
    if (p) parts.push('the post ' + (compact ? esc(p.headline) : '<a href="' + esc(hashOf(p.id)) + '" data-open="' + esc(p.id) + '">' + esc(p.headline) + '</a>') +
      (o.at ? ' (waiting ' + esc(short(o.at)) + ')' : ''));
    if (runs.length) parts.push(esc(decRunsWords(runs)));
    if (compact) return parts.length ? '<p class="wdc__sub">Answering unblocks ' + parts.join(' and ') + '.</p>' : '';
    if (!parts.length) return '<p class="wdc__sub">Unblocks: nothing waits on it.</p>';
    return '<div class="wdc__unb"><h3>Answering unblocks</h3><p>' + decCap(parts.join(' and ')) + ', paused until you answer.</p></div>';
  }

  // --- One card, in the frame's shape ---
  function decCardHtml(o) {
    var exp = o.expires ? Date.parse(o.expires) : 0, ro = !decOwner();
    var soon = exp && exp - Date.now() < 864e5;
    var stall = o.stall ? '<span class="wdc__badge is-warn">' + (ro ? 'Stalled' : 'Stalled on you') + '</span>' : '';
    var expTxt = exp ? (exp <= Date.now() ? 'Expired' : 'Expires ' + until(exp)) + (o.if_silent ? ', then ' + (DEC_SILENT[o.if_silent] || o.if_silent) : '') : '';
    var who = o.agent ? '<b>' + esc(nameOf(o.agent)) + '</b>' + (ro ? '' : ' <span class="h">@' + esc(o.agent) + '</span>') : '<b>Classifier</b>';
    var meta = '<div class="wdc__meta">' + who + (o.node && !ro ? '<span aria-hidden="true">·</span><span>' + esc(o.node) + '</span>' : '') +
      (o.at ? '<span aria-hidden="true">·</span><span title="' + esc(stamp(o.at)) + '">' + esc(short(o.at)) + '</span>' : '') +
      '<span class="wdc__badge is-' + esc(o.kind) + '">' + esc(DEC_BADGE[o.kind] || 'Item') + '</span>' + stall +
      (o.snoozed ? '<span class="wdc__badge">Put off until ' + esc(stamp(o.snoozed)) + '</span>' : '') +
      (expTxt && !ro ? '<span class="wdc__exp' + (soon ? ' is-soon' : '') + '">' + esc(expTxt) + '</span>' : '') + '</div>';
    var title = '<h2 class="wdc__title' + (o.kind === 'card' ? ' is-q' : '') + '" dir="auto">' + esc(o.title) + '</h2>';
    var ask = o.ask && o.ask !== o.title ? '<p class="wdc__ask" dir="auto">' + esc(o.ask) + '</p>' : '';
    var rec = o.recommend ? '<p class="wdc__sub">' + (ro ? 'Advice' : esc(nameOf(o.agent || '')) + '’s advice') + ': <span>' + esc(o.recommend) + '</span></p>' : '';
    var body;
    if (ro) body = ask + rec + decUnblocks(o, true) + (expTxt ? '<p class="wdc__sub">' + esc(expTxt) + '.</p>' : '');
    else if (o.form === 'request') body = ask + decUnblocks(o) + decRequestForm(o);
    else if (o.form === 'review') body = ask + decReviewForm(o);
    else body = ask + rec + decFormHtml(Object.assign({}, o, { unblocks: decUnblocks(o) }));
    return '<article class="wdc' + (soon ? ' is-soon' : '') + '"' + decAttrs(o.key, null, o.hash, o.title) + ' aria-label="' + esc((DEC_BADGE[o.kind] || 'Item') + ': ' + o.title) + '">' +
      (o.agent ? avatar(o.agent, 'sm') : '<span class="av av--sm" aria-hidden="true">Gr</span>') + '<div class="wdc__b">' + meta + title + body + '</div></article>';
  }
  /** Every source in one shape: inbox items, requests asking the owner, reviews. */
  function decAll() {
    var v = D.data, out = [], seen = {};
    if (!v || v.error) return out;
    var reqs = {};
    ((D.reqs && D.reqs.items) || []).forEach(function (r) { reqs['request:' + r.id] = r; });
    (v.items || []).forEach(function (i) {
      seen[i.key] = true;
      out.push({ key: i.key, kind: i.kind, title: i.title, ask: i.ask, yes: i.yes, no: i.no, recommend: i.recommend, choices: i.choices, draft: i.draft,
        if_silent: i.if_silent, expires: i.expires, agent: i.raised_by, node: i.node, at: Date.parse(i.created_at) || 0, detail: i.detail, source: i.source,
        hash: i.text_hash, snoozed: i.snoozed_until ? Date.parse(i.snoozed_until) : 0, popup: i.kind === 'card' && v.popup,
        post: (decPostOf(i.key) || {}).id });
    });
    // Requests whose agent asked the owner (the Desk's list): answered with a reply.
    ((v.desk && v.desk.items) || []).forEach(function (c) {
      if (seen[c.key] || c.key.indexOf('request:') !== 0) return;
      var r = reqs[c.key];
      out.push({ key: c.key, kind: 'request', form: 'request', title: c.title, ask: c.ask || c.need, agent: c.agent, at: Date.parse(c.askedAt || '') || 0, stall: r && r.stall,
        snoozed: c.column === 'later' ? 1 : 0 });
    });
    return out;
  }
  function decReviews() {
    return ((R.data && R.data.reviews) || []).filter(function (r) { return r.status === 'pending'; }).map(function (r) {
      return { key: 'review:' + r.id, kind: 'review', form: 'review', title: revPath(r.path), ask: r.message ? plainMarkerText(r.message) : '', agent: r.agentId || '', at: Date.parse(r.proposedAt) || 0, rid: r.id };
    });
  }
  function decChipOf(o) {
    for (var n = 0; n < DEC_CHIPS.length; n++) if (DEC_CHIPS[n][2].indexOf(o.kind) >= 0) return DEC_CHIPS[n][0];
    return o.kind === 'review' ? 'reviews' : 'decisions';
  }
  /** How many wait for you: the owner's one list, as /approvals counts it. */
  function decideCount() {
    var v = D.data;
    if (!v || v.error) return null;
    return v.desk ? v.desk.count : (v.items || []).filter(function (i) { return !i.snoozed_until; }).length;
  }
  function decLater() { var v = D.data; return v && v.desk ? v.desk.later || 0 : ((v && v.items) || []).filter(function (i) { return i.snoozed_until; }).length; }

  // --- The page ---
  function decTabs() {
    var tabs = [['waiting', 'Waiting', decideCount()], ['later', 'Put off', decLater()], ['answered', 'Answered', null]];
    return '<div class="ax-wall__views wdc__tabs" role="tablist" aria-label="Show">' + tabs.map(function (t) {
      var on = D.tab === t[0];
      return '<button type="button" role="tab" data-dtab="' + t[0] + '" class="' + (on ? 'is-on' : '') + '" aria-selected="' + (on ? 'true' : 'false') + '">' + t[1] +
        (t[2] ? ' <span class="n">' + t[2] + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function decChips(list, reviews) {
    var c = {};
    list.forEach(function (o) { var k = decChipOf(o); c[k] = (c[k] || 0) + 1; });
    c.reviews = reviews.length;
    var chips = [['', 'All', list.length]].concat(DEC_CHIPS.map(function (k) { return [k[0], k[1], c[k[0]] || 0]; }));
    return '<div class="wdc__chips" role="group" aria-label="Kind">' + chips.map(function (t) {
      var on = D.kind === t[0];
      return '<button type="button" data-dkind="' + t[0] + '" class="wdc__chip' + (on ? ' is-on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + t[1] + ' <span class="n">' + t[2] + '</span></button>';
    }).join('') + '</div>';
  }
  function decAnsweredHtml(list) {
    if (!list.length) return '<div class="wdc__empty"><h2>Nothing answered yet</h2><p>Your answers show here, from this page, the Desk, the phone app and the Mac card.</p></div>';
    return '<ol class="wdc__done">' + list.map(function (a) {
      var verb = a.kind === 'memory' ? (a.answer === 'yes' ? 'Kept' : 'Dropped') : a.answer === 'yes' ? 'Yes' : 'No';
      return '<li><b>' + verb + '</b>' + (a.choice ? ' (' + esc(a.choice) + ')' : '') + ' · ' + esc(nameOf(a.raised_by)) + ' · <span dir="auto">' + esc(a.title) + '</span> · <time title="' + esc(stamp(Date.parse(a.at))) + '">' + esc(stamp(Date.parse(a.at))) + '</time>' +
        '<span class="k"> by ' + esc(a.by) + '</span></li>';
    }).join('') + '</ol>';
  }
  function decEmpty() {
    var week = ((D.data && D.data.answered) || []).filter(function (a) { return Date.now() - Date.parse(a.at) < 7 * 864e5; }).length;
    if (D.tab === 'later') return '<div class="wdc__empty"><h2>Nothing put off</h2><p>What you answer Later waits here until it comes back.</p></div>';
    if (D.kind) return '<div class="wdc__empty"><h2>Nothing of this kind</h2><p><button type="button" class="wa-more" data-dkind="">Show all</button></p></div>';
    return '<div class="wdc__empty"><h2>' + (decOwner() ? 'Nothing needs you' : 'Nothing needs the owner') + '</h2><p>When an agent asks ' + (decOwner() ? 'you' : 'the owner') + ' something, it shows here.' +
      (week ? ' ' + week + ' answered this week.' : '') + '</p></div>';
  }
  function decideHtml() {
    var v = D.data;
    var note = '<p class="wdc__note' + (D.noteErr ? ' is-err' : '') + '" role="status">' + esc(D.note) + '</p>';
    if (!v) return note + '<div class="wdc__skel" aria-label="Loading what waits for you"><i></i><i></i><i></i><b></b></div>';
    if (v.error) return note + '<div class="wdc__err"><p>Could not read what waits for you: ' + esc(v.error) + '.</p><button type="button" class="ax-btn ax-btn--ghost" data-dreload>Try again</button></div>';
    var all = decAll(), reviews = decReviews();
    var errs = (v.errors || []).map(function (e) { return 'the ' + (DEC_BADGE[e.kind] || e.kind).toLowerCase() + ' items'; });
    if (D.reqs && D.reqs.error) errs.push('the requests');
    var err = errs.length ? '<div class="wdc__err is-part"><p>Could not read ' + esc(errs.join(', ')) + '. The rest is shown.</p><button type="button" class="ax-btn ax-btn--ghost" data-dreload>Try again</button></div>' : '';
    var head = '<p class="ax-wall__count wdc__head">' + decideCount() + ' waiting for ' + (decOwner() ? 'you' : 'the owner') + (decLater() ? ', ' + decLater() + ' put off for later' : '') +
      '<span class="k">Same count as the Desk and the digest</span></p>';
    var ro = decOwner() ? '' : '<p class="wdc__ro">Only the owner can answer these. You see them read only.</p>';
    if (D.tab === 'answered') return note + head + decTabs() + ro + decAnsweredHtml(v.answered || []);
    var tabList = all.filter(function (o) { return D.tab === 'later' ? o.snoozed : !o.snoozed; });
    var shown = D.kind === 'reviews' ? (D.tab === 'waiting' ? reviews : []) : tabList.filter(function (o) { return !D.kind || decChipOf(o) === D.kind; });
    var reviewNote = D.kind === 'reviews' && R.data && R.data.error ? '<div class="wdc__err is-part"><p>Could not read the reviews: ' + esc(R.data.error) + '.</p></div>' : '';
    return note + head + decTabs() + (decOwner() ? decChips(tabList, D.tab === 'waiting' ? reviews : []) : '') + ro + err + reviewNote +
      (shown.length ? shown.map(decCardHtml).join('') : decEmpty());
  }
  /** The side column: what waits, what was answered today, how the inbox reaches you. */
  function decSideHtml() {
    var v = D.data;
    if (!v || v.error) return '';
    var posts = ((S.data && S.data.posts) || []).filter(function (p) { return isOpen(p) && waitsOnOwner(p); }).length;
    var held = ((S.wf && S.wf.runs) || []).filter(function (r) { return r.status === 'paused' && r.pausedAt && r.pausedAt.kind === 'ownerDecision'; });
    var waiting = decAll().filter(function (o) { return !o.snoozed && o.at; }).sort(function (a, b) { return a.at - b.at; });
    var old = waiting[0];
    var waits = '<section class="ax-wall__box"><h2>What waits on ' + (decOwner() ? 'you' : 'the owner') + '</h2>' +
      '<p><b>' + posts + ' post' + (posts === 1 ? '' : 's') + '</b> paused on an answer</p>' +
      '<p><b>' + held.length + ' run' + (held.length === 1 ? '' : 's') + '</b> held' + (held.length ? ' on ' + esc(decNodes(held)) : '') + '</p>' +
      (old ? '<p><b>Oldest:</b> <span class="wdc__age">' + esc(ago(old.at).replace(/ ago$/, '')) + '</span> (' + esc(nameOf(old.agent || '')) + ', ' + esc(old.title) + ')</p>' : '') + '</section>';
    var today = new Date().toDateString();
    var done = (v.answered || []).filter(function (a) { return new Date(Date.parse(a.at)).toDateString() === today; });
    var answered = '<section class="ax-wall__box"><h2>Answered today</h2>' + (done.length ? done.slice(0, 5).map(function (a) {
      var verb = a.kind === 'memory' ? (a.answer === 'yes' ? 'Kept' : 'Dropped') : a.answer === 'yes' ? 'Yes' : 'No';
      var t = new Date(Date.parse(a.at));
      return '<p><b>' + verb + '</b> · ' + esc(nameOf(a.raised_by)) + ' · ' + esc(a.title) + ' · ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + '</p>';
    }).join('') : '<p class="k">Nothing yet today.</p>') + '<p><button type="button" class="wa-more" data-dtab="answered">All answered →</button></p></section>';
    var s = v.settings || {}, d = s.desk || {}, dg = s.digest || {};
    var reach = '<section class="ax-wall__box"><h2>Reaching ' + (decOwner() ? 'you' : 'the owner') + '</h2><p>Phone: ' + esc(DEC_REACH[d.phone] || 'off') + '. Computer: ' + esc(DEC_REACH[d.computer] || 'off') + '. ' +
      (dg.enabled ? 'Digest at ' + esc(dg.time || '—') + '.' : 'No daily digest.') + (decOwner() ? ' <a href="/approvals#settings">Change in Settings</a>' : '') + '</p></section>';
    return waits + answered + reach;
  }
  async function loadDecide() {
    D.loading = true;
    try {
      var d = await getJson('/api/admin/approvals?all=1&answered=1');
      d.popup = !!(d.settings && d.settings.popup && d.settings.popup.enabled);
      D.data = d;
    } catch (e) { D.data = { error: e.message }; }
    D.loading = false;
    render();
  }
  async function loadRequests() {
    try { D.reqs = await getJson('/api/admin/approvals/requests'); } catch (e) { D.reqs = { error: e.message, items: [], agents: [] }; }
    render();
  }
  function refreshDecide() { loadDecide(); if (D.reqs) loadRequests(); }
  /** Called from the Wall's render(), after its own views are painted. */
  function renderDecide(view) {
    var on = view === 'decide';
    $('wall-decide').hidden = !on;
    $('wall-aside').classList.toggle('is-dec', on);
    if (!on) return;
    $('wall-count').hidden = true;
    $('wall-profile').hidden = true;
    if (!decOwner()) $('wall-title').textContent = 'Needs the owner';
    if (!D.data && !D.loading) loadDecide();
    if (!D.reqs) { D.reqs = { items: [], agents: [] }; loadRequests(); }
    if (!R.data && !R.loading) loadReviews();
    var a = document.activeElement;
    var busy = a && a.matches && a.matches('textarea,select') && $('wall-decide').contains(a);
    if (!busy) $('wall-decide').innerHTML = decideHtml();
    $('wall-dec-side').innerHTML = decSideHtml();
  }
  function decNote(text, err) {
    D.note = text; D.noteErr = !!err;
    document.querySelectorAll('.wdc__note[role=status]').forEach(function (el) { el.textContent = text; el.classList.toggle('is-err', !!err); });
    // On a post, the note under its comment box says it, and keeps saying it.
    if (S.post) note(text);
  }
  /** The call an answer makes: the Wall's guarded route and its body. */
  function decCall(el, key, action) {
    if (key.indexOf('review:') === 0) return { path: '/api/admin/wall/review/' + action, body: { msgHash: key.slice(7) } };
    var rid = key.slice(8);
    if (action === 'reply') return { path: '/api/admin/wall/request/reply', body: { id: rid, text: D.replies[key] || '' } };
    if (action === 'handoff') return { path: '/api/admin/wall/request/handoff', body: { id: rid, agentId: D.hand[key] || '' } };
    if (action === 'done' || action === 'drop') return { path: '/api/admin/wall/request/close', body: { id: rid, action: action } };
    if (action === 'pop') return { path: '/api/admin/wall/decide/popup', body: { key: key } };
    var body = { key: key, action: action }, picked = el.querySelector('input[type=radio]:checked');
    if (action === 'yes' && picked) body.choice = Number(picked.value) + 1;
    // Only an edited message is sent: the card keeps its own suggested one.
    if (action === 'yes' && D.texts[key] != null && D.texts[key].trim()) body.text = D.texts[key];
    if (action === 'yes' && el.getAttribute('data-dseen')) body.seen = el.getAttribute('data-dseen');
    return { path: '/api/admin/wall/decide', body: body };
  }
  /** Ask first: the confirm line opens under the buttons. */
  function decAsk(el, action) {
    var key = el.getAttribute('data-dkey');
    if (!key || D.sending[key]) return;
    if (action === 'yes' && el.querySelector('input[type=radio]') && !el.querySelector('input[type=radio]:checked')) {
      decNote('Pick one of the choices first.', true); el.querySelector('input[type=radio]').focus(); return;
    }
    if (action === 'reply' && !(D.replies[key] || '').trim()) { decNote('Write the reply first.', true); var ta = el.querySelector('textarea[data-dreply]'); if (ta) ta.focus(); return; }
    D.confirm = { key: key, action: action };
    decNote('');
    render();
    var go = document.querySelector('.wdc__confirm [data-dgo]');
    if (go) go.focus();
  }
  /** Send the confirmed answer: the same call and body as /approvals. */
  async function decide(el, action) {
    var key = el.getAttribute('data-dkey'), peer = el.getAttribute('data-dpeer');
    if (!key || D.sending[key]) return;
    var call = decCall(el, key, action);
    D.sending[key] = true;
    decNote(action === 'pop' ? 'Showing it on the Mac…' : 'Sending your answer…');
    render();
    var h = headers(peer);
    h['Content-Type'] = 'application/json';
    var ok = false, msg = '';
    try {
      var r = await fetch(call.path, { method: 'POST', headers: h, body: JSON.stringify(call.body) });
      var b = await r.json().catch(function () { return {}; });
      ok = r.ok;
      msg = r.ok ? decSaid(b.message || 'Done.', key.replace(/^request:/, ''), el.getAttribute('data-dtitle'))
        : r.status === 401 || r.status === 403 ? 'Only the owner can answer this. Sign in with the dashboard key, then try again.' : (b.error || ('HTTP ' + r.status));
    } catch (e) { msg = String(e && e.message || e); }
    delete D.sending[key];
    if (!ok) {
      // Nothing changed: the item stays, with the reason over the list.
      decNote('Not answered: ' + msg, true);
      render();
      return;
    }
    D.confirm = null;
    decNote(msg);
    if (action === 'pop') { render(); return; }
    // The item leaves at once, here and on its post; the next reads confirm it.
    delete D.picks[key]; delete D.texts[key]; delete D.replies[key]; delete D.hand[key];
    if (key.indexOf('review:') === 0) { loadReviews(); return; }
    var v = D.data;
    if (v && v.items) {
      if (action === 'later') v.items.forEach(function (i) { if (i.key === key) i.snoozed_until = new Date(Date.now() + 864e5).toISOString(); });
      else v.items = v.items.filter(function (i) { return i.key !== key; });
    }
    if (v && v.desk) {
      v.desk.items = (v.desk.items || []).filter(function (c) { return c.key !== key; });
      v.desk.count = Math.max(0, v.desk.count - 1);
      if (action === 'later') v.desk.later = (v.desk.later || 0) + 1;
    }
    var cardId = key.indexOf('card:') === 0 ? key.slice(5) : '';
    if (cardId) ((S.data && S.data.posts) || []).concat(S.extra ? [S.extra] : []).forEach(function (p) {
      p.ownerCards = (p.ownerCards || []).filter(function (c) { return c.id !== cardId; });
    });
    render();
    loadDecide();
    if (key.indexOf('request:') === 0) loadRequests();
    if (S.post) loadThread(S.post);
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-decide],[data-dgo],[data-dback],[data-dpop],[data-dkind],[data-dtab],[data-dreload]');
    if (!t) return;
    var el = t.closest ? t.closest('[data-dkey]') : null;
    if (t.hasAttribute('data-decide')) { if (el) decAsk(el, t.getAttribute('data-decide')); }
    else if (t.hasAttribute('data-dgo')) { if (el && D.confirm) decide(el, D.confirm.action); }
    else if (t.hasAttribute('data-dback')) { D.confirm = null; render(); }
    else if (t.hasAttribute('data-dpop')) { if (el) decide(el, 'pop'); }
    else if (t.hasAttribute('data-dkind')) { D.kind = t.getAttribute('data-dkind'); D.confirm = null; render(); }
    else if (t.hasAttribute('data-dtab')) { D.tab = t.getAttribute('data-dtab'); D.kind = ''; D.confirm = null; if (S.view !== 'decide') setView('decide'); else render(); }
    else { D.data = null; render(); loadDecide(); loadRequests(); }
  });
  // A pick fills the message, until the owner edits the message by hand.
  document.addEventListener('change', function (ev) {
    var t = ev.target, el = t.closest && t.closest('[data-dkey]');
    if (!el) return;
    var key = el.getAttribute('data-dkey');
    if (t.matches('select[data-dhand]')) { D.hand[key] = t.value; if (t.value) decAsk(el, 'handoff'); return; }
    if (!t.matches('input[type=radio]')) return;
    D.picks[key] = Number(t.value);
    if (D.confirm && D.confirm.key === key) D.confirm = null;
    var ta = el.querySelector('textarea[data-dtext]'), o = decSource(key, el);
    if (ta && o && D.texts[key] == null) ta.value = decFill(o.draft, o.choices[D.picks[key]]);
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target, el = t.closest && t.closest('[data-dkey]');
    if (!el) return;
    if (t.hasAttribute('data-dtext')) D.texts[el.getAttribute('data-dkey')] = t.value;
    if (t.hasAttribute('data-dreply')) D.replies[el.getAttribute('data-dkey')] = t.value;
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
.ax-wall__decide { padding: 0 0 12px; }
.wdc__head { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0 16px 6px; }
.wdc__head .k { color: var(--ax-muted); }
.wdc__tabs { display: flex; border-bottom: 1px solid var(--ax-border); }
.wdc__tabs button { flex: 1 1 0; }
.wdc__tabs .n { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); font-size: var(--ax-fs-xs); }
.wdc__chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--ax-border); }
.wdc__chip { font: inherit; font-size: var(--ax-fs-sm); padding: 5px 14px; min-height: 36px; border-radius: var(--ax-radius-pill); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); cursor: pointer; }
.wdc__chip.is-on { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wdc__chip .n { opacity: .75; }
.wdc__ro { margin: 0; padding: 12px 16px; background: var(--ax-accent-t, var(--ax-surface)); color: var(--ax-text); }
.wdc { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--ax-border); font-size: var(--ax-fs-sm); }
.wdc:focus-within { background: var(--ax-surface); }
.wdc.is-soon { box-shadow: inset 3px 0 0 var(--ax-red); }
.wdc__b { flex: 1 1 auto; min-width: 0; }
.wdc__meta { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; color: var(--ax-muted); }
.wdc__meta b { color: var(--ax-text); font-weight: 700; }
.wdc__badge { display: inline-block; padding: 1px 8px; border-radius: var(--ax-radius-pill); font-size: var(--ax-fs-xs); font-weight: 600; background: var(--ax-accent-t, var(--ax-surface-2)); color: var(--ax-accent); }
.wdc__badge.is-card, .wdc__badge.is-warn { background: var(--ax-amber-t, var(--ax-surface-2)); color: var(--ax-amber-ink, var(--ax-warn)); }
.wdc__exp { margin-left: auto; font-size: var(--ax-fs-xs); }
.wdc__exp.is-soon { color: var(--ax-red-ink, var(--ax-err)); }
.wdc__title { margin: 4px 0 0; font-size: var(--ax-fs); font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; }
.wdc__title.is-q { font-weight: 700; }
.wdc__ask { margin: 4px 0 0; overflow-wrap: anywhere; }
.wdc__sub { margin: 6px 0 0; color: var(--ax-muted); overflow-wrap: anywhere; }
.wdc__sub span { color: var(--ax-text); }
.wdc__choices { border: 0; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wdc__choices legend { font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-bottom: 4px; padding: 0; }
.wdc__opt { display: flex; gap: 10px; align-items: center; line-height: 1.4; padding: 6px 8px; border-radius: var(--ax-radius-sm); cursor: pointer; overflow-wrap: anywhere; }
.wdc__opt input { accent-color: var(--ax-accent); }
.wdc__opt em { font-style: normal; font-size: var(--ax-fs-xs); padding: 1px 8px; border-radius: var(--ax-radius-pill); background: var(--ax-surface-2); color: var(--ax-text-2); white-space: nowrap; }
.wdc__draft { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 0; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wdc__draft textarea { font: inherit; font-size: var(--ax-fs-sm); line-height: 1.45; padding: 8px 10px; border-radius: var(--ax-radius-sm); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); resize: vertical; min-height: 72px; width: 100%; box-sizing: border-box; }
.wdc__more { margin-top: 8px; color: var(--ax-text-2); }
.wdc__more summary { cursor: pointer; color: var(--ax-accent); }
.wdc__more p { margin: 4px 0 0; overflow-wrap: anywhere; }
.wdc__more a { color: var(--ax-accent); }
.wdc__unb { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); background: var(--ax-bg-elev); }
.wdc__unb h3 { margin: 0; font-size: var(--ax-fs-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--ax-text-2); }
.wdc__unb p { margin: 4px 0 0; overflow-wrap: anywhere; }
.wdc__unb a, .wdc__sub a { color: var(--ax-accent); }
.wdc__acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.wdc__acts .ax-btn { min-height: 40px; min-width: 72px; border-radius: var(--ax-radius-pill); }
.wdc__acts .ax-btn.is-on { outline: 2px solid var(--ax-accent); outline-offset: 1px; }
.wdc__alt { margin-left: auto; }
.wdc__hand { font: inherit; min-height: 40px; padding: 0 12px; border-radius: var(--ax-radius-pill); border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text); }
.wdc__confirm { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 8px; padding: 10px 14px; border: 1px solid var(--ax-accent); border-radius: var(--ax-radius-lg); background: var(--ax-accent-t, var(--ax-surface)); }
.wdc__confirm p { flex: 1 1 260px; margin: 0; overflow-wrap: anywhere; }
.wdc__cbtns { display: flex; gap: 8px; }
.wdc__cbtns .ax-btn { min-height: 40px; border-radius: var(--ax-radius-pill); }
.wdc__note { margin: 0; padding: 8px 16px 0; font-size: var(--ax-fs-sm); color: var(--ax-green); }
.wdc__note:empty { display: none; }
.wdc__note.is-err { color: var(--ax-red-ink, var(--ax-err)); }
.wdc__empty { text-align: center; padding: 36px 16px; color: var(--ax-muted); }
.wdc__empty h2 { font-size: var(--ax-fs-lg, var(--ax-fs)); color: var(--ax-text); margin: 0 0 6px; }
.wdc__empty p { margin: 0; }
.wdc__err { text-align: center; padding: 0 0 16px; }
.wdc__err p { margin: 0 0 10px; padding: 10px 16px; text-align: left; background: var(--ax-red-t, var(--ax-surface-2)); color: var(--ax-red-ink, var(--ax-err)); }
.wdc__err.is-part { padding-bottom: 0; text-align: left; }
.wdc__err.is-part p { margin: 0; }
.wdc__err.is-part .ax-btn { margin: 8px 16px; }
.wdc__skel { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.wdc__skel i, .wdc__skel b { display: block; height: 12px; border-radius: 6px; background: var(--ax-surface-2); }
.wdc__skel i:nth-child(1) { width: 30%; } .wdc__skel i:nth-child(2) { width: 75%; } .wdc__skel i:nth-child(3) { width: 55%; }
.wdc__skel b { width: 90px; height: 28px; border-radius: 14px; }
.wdc__done { list-style: none; margin: 0; padding: 0; }
.wdc__done li { padding: 10px 16px; border-bottom: 1px solid var(--ax-border); overflow-wrap: anywhere; }
.wdc__done .k { color: var(--ax-muted); }
.wdc__age { color: var(--ax-amber-ink, var(--ax-warn)); }
.wdc__side .ax-wall__box p { margin: 6px 0 0; }
.wdc__side .ax-wall__box .k { color: var(--ax-muted); }
.wdc__side a { color: var(--ax-accent); }
.wdc__side { display: none; }
.ax-wall__aside.is-dec > :not(.wdc__side) { display: none; }
.ax-wall__aside.is-dec > .wdc__side { display: block; }
/* A card on its post answers in place (#1440). */
.wc .wdc__acts { margin-top: 8px; }
@media (max-width: 560px) {
  .wdc__tabs .n { display: none; }
  .wdc__acts .ax-btn { flex: 1 1 0; }
  .wdc__alt { margin-left: 0; }
  .wdc__exp { margin-left: 0; flex-basis: 100%; }
}
`
