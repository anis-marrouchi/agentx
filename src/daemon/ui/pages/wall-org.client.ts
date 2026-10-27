// --- Wall Org page, browser side (#1419) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), nameOf(), render() and layoutOrg (injected from
// src/business/org-layout.ts). It reads S.org, the /api/admin/org reply the
// Wall already loads: `diagram` gives each card its level and half-column,
// `relations` and `people` the rest.
//
// The org as a classic top-down chart (#page=org):
//   - reports-to builds the tree; elbow lines join a boss to its reports.
//   - dotted-line is a dashed line, hidden until "Show dotted lines".
//   - acts-for is a chip on the agent's card, not a line.
//   - A card opens the agent's Wall profile; a branch folds and unfolds;
//     the chart zooms with its buttons or ctrl + wheel (a trackpad pinch).
//   - On a phone the chart is an indented list with thread lines.
//
// Read-only. "Edit org" goes to the setup page; the Wall and its API are
// behind the dashboard token, so whoever sees it is the owner.

export const WALL_ORG_SCRIPT = String.raw`
  var ORG = { dotted: false, folded: {}, zoom: 1, html: '', rail: '' };
  var ORG_STATE = { working: 'Working', idle: 'Idle', paused: 'Paused', waiting: 'Waits for your approval', unknown: 'Status not known' };
  var ORG_EDIT_HREF = '/org';
  function orgDiagram() { return S.org && S.org.diagram && S.org.diagram.boxes ? S.org.diagram : null; }
  /** Cards in the chart, for the nav; null until the org is read. */
  function orgCount() { var d = orgDiagram(); return d ? d.boxes.length : null; }
  function orgPerson(id) { return ((S.org && S.org.people) || []).find(function (p) { return p.id === id; }) || null; }
  /** A member's name from its key, agent:<id> or person:<id>, never the key itself. */
  function orgName(key) {
    var d = orgDiagram(), b = d && d.boxes.find(function (x) { return x.key === key; });
    if (b) return b.name;
    var m = /^(agent|person):(.*)$/.exec(key || '');
    if (!m) return nameOf(key);
    if (m[1] === 'person') { var p = orgPerson(m[2]); return p ? p.name : m[2]; }
    return nameOf(m[2]);
  }
  function orgRelations() { return (S.org && S.org.relations) || []; }
  /** Who a member reports to, and who reports to it, from the typed relations. */
  function orgBossOf(key) { var r = orgRelations().find(function (x) { return x.type === 'reports-to' && x.from === key; }); return r ? r.to : ''; }
  function orgReportsOf(key) { return orgRelations().filter(function (x) { return x.type === 'reports-to' && x.to === key; }).map(function (x) { return x.from; }); }
  /** A member as a link: an agent opens its profile; a person is plain text. */
  function orgWho(key) {
    var m = /^agent:(.*)$/.exec(key);
    return m ? '<button type="button" data-agent="' + esc(m[1]) + '">' + esc(orgName(key)) + '</button>' : '<span>' + esc(orgName(key)) + '</span>';
  }
  /** The profile's org rows (#1419): Reports to, Direct reports. */
  function orgProfileHtml(id) {
    if (!S.org || S.org.error) return '';
    var key = 'agent:' + id, boss = orgBossOf(key), under = orgReportsOf(key);
    var b = (orgDiagram() || { boxes: [] }).boxes.find(function (x) { return x.key === key; });
    if (!b && !boss && !under.length) return '';
    return '<dl class="wpf__orgrows">' +
      (b && b.title ? '<div><dt>Role</dt><dd>' + esc(b.title) + '</dd></div>' : '') +
      '<div><dt>Reports to</dt><dd>' + (boss ? orgWho(boss) : 'No one') + '</dd></div>' +
      '<div><dt>Direct reports</dt><dd>' + (under.length ? under.map(orgWho).join(', ') : 'None') + '</dd></div>' +
      '</dl><a class="wpf__orglink" href="#page=org">Org chart</a>';
  }

  // Folded branches: their cards leave the chart, so it is laid out again.
  function orgHidden(d) {
    var parent = {}, hidden = {};
    d.boxes.forEach(function (b) { if (b.parent) parent[b.key] = b.parent; });
    d.boxes.forEach(function (b) {
      for (var cur = parent[b.key], n = 0; cur && n < 64; cur = parent[cur], n++) if (ORG.folded[cur]) { hidden[b.key] = true; return; }
    });
    return hidden;
  }
  function orgUnder(d, key) {
    var n = 0;
    (function walk(k) { d.boxes.forEach(function (b) { if (b.parent === k) { n++; walk(b.key); } }); })(key);
    return n;
  }
  function orgCardHtml(b, at, d) {
    var person = b.kind === 'person';
    var reports = d.boxes.filter(function (x) { return x.parent === b.key; }).length;
    var folded = !!ORG.folded[b.key];
    var actsFor = d.edges.filter(function (e) { return e.type === 'acts-for' && e.from === b.key; });
    var dotted = d.edges.filter(function (e) { return e.type === 'dotted-line' && e.from === b.key; });
    var face = person ? avatar(b.name, 'sm', true) : avatar(b.id, 'sm');
    var dot = person ? '' : '<span class="wog__dot is-' + esc(b.status || 'unknown') + '" title="' + esc(ORG_STATE[b.status] || b.status) + '"></span>';
    var who = '<span class="wog__who"><b>' + esc(b.name) + dot + '</b><small>@' + esc(b.id) + '</small>' + (b.title ? '<small class="wog__title">' + esc(b.title) + '</small>' : '') + '</span>';
    var head = person ? '<div class="wog__head">' + face + who + '</div>'
      : '<button type="button" class="wog__head" data-agent="' + esc(b.id) + '" title="' + esc(b.name) + ': profile and posts">' + face + who +
        '<span class="wog__sr">' + esc(ORG_STATE[b.status] || '') + '</span></button>';
    var chips = (person ? '<span class="wog__chip is-person">person</span>' : '') +
      actsFor.map(function (e) { return '<span class="wog__chip is-acts">acts for ' + esc(orgName(e.to)) + '</span>'; }).join('') +
      dotted.map(function (e) { return '<span class="wog__chip is-dotted' + (ORG.dotted ? '' : ' is-quiet') + '">dotted line to ' + esc(orgName(e.to)) + '</span>'; }).join('');
    var fold = reports ? '<button type="button" class="wog__fold" data-org-fold="' + esc(b.key) + '" aria-expanded="' + (folded ? 'false' : 'true') + '">' +
      (folded ? 'Show ' + orgUnder(d, b.key) + ' under ' : 'Hide ' + reports + (reports === 1 ? ' report' : ' reports')) + '</button>' : '';
    return '<article class="wog__card' + (person ? ' is-person' : ' is-' + esc(b.status || 'unknown')) + (at.level ? '' : ' is-top') + '" data-org-key="' + esc(b.key) + '"' +
      ' style="grid-column: ' + at.col + ' / span 2; grid-row: ' + (at.level + 1) + '; --lvl: ' + at.level + '">' +
      head + (chips ? '<div class="wog__chips">' + chips + '</div>' : '') + fold + '</article>';
  }
  function orgLegendHtml(d) {
    var dotted = d.edges.some(function (e) { return e.type === 'dotted-line'; });
    return '<div class="wog__bar">' +
      '<ul class="wog__legend" aria-label="Legend">' +
        '<li><span class="wog__key is-card"></span>Agent</li>' +
        '<li><span class="wog__key is-person"></span>Person</li>' +
        '<li><svg width="28" height="10" aria-hidden="true"><path class="wog__ln" d="M2 5H26"/></svg>Reports to</li>' +
        '<li><svg width="28" height="10" aria-hidden="true"><path class="wog__ln is-dotted" d="M2 5H26"/></svg>Dotted line: a second boss for one topic</li>' +
        '<li><span class="wog__chip is-acts">acts for …</span>Works on behalf of a person</li>' +
      '</ul>' +
      '<span class="wog__tools">' +
        (dotted ? '<button type="button" class="wog__toggle" data-org-dotted aria-pressed="' + (ORG.dotted ? 'true' : 'false') + '">Show dotted lines</button>' : '') +
        '<span class="wog__zoom" role="group" aria-label="Zoom"><button type="button" data-org-zoom="-1" aria-label="Zoom out">−</button>' +
          '<button type="button" data-org-zoom="0" title="Back to 100%">' + Math.round(ORG.zoom * 100) + '%</button>' +
          '<button type="button" data-org-zoom="1" aria-label="Zoom in">+</button></span>' +
        '<a class="ax-btn ax-btn--ghost wog__edit" href="' + ORG_EDIT_HREF + '">Edit org</a>' +
      '</span></div>';
  }
  /** Counts and the agents not in the chart: the side rail, or under the chart when narrow. */
  function orgRailHtml(d) {
    var n = { person: 0, agent: 0 };
    d.boxes.forEach(function (b) { n[b.kind]++; });
    var outside = (S.org && S.org.outside) || [];
    return '<dl class="wog__counts"><div><dt>People</dt><dd>' + n.person + '</dd></div><div><dt>Agents</dt><dd>' + n.agent + '</dd></div><div><dt>Levels</dt><dd>' + d.levels + '</dd></div></dl>' +
      '<h3 class="wog__h3">Not in the org chart</h3>' +
      (outside.length ? '<div class="wog__outside">' + outside.map(function (a) {
        return '<button type="button" class="wa" data-agent="' + esc(a.id) + '">' + avatar(a.id, 'sm') + '<span class="wa__n"><b>' + esc(a.name) + '</b><small>@' + esc(a.id) + '</small></span></button>';
      }).join('') + '</div>' : '<p class="ax-wall__empty">Every agent is in the chart.</p>');
  }
  function orgPageHtml() {
    if (!S.org) return '<p class="ax-wall__empty">Loading…</p>';
    if (S.org.error) return '<p class="ax-wall__empty">Could not load the org chart: ' + esc(S.org.error) + '. The rest of the Wall still works.</p>';
    if (S.org.exists === false) return '<p class="ax-wall__empty">This machine has no agentx.json, so there is no org chart.</p>';
    var d = orgDiagram();
    if (!d || !d.boxes.length) return '<div class="wog__none"><h2>No org chart yet</h2><p>Give each agent a role and a boss, and the chart appears here.</p>' +
      '<a class="ax-btn" href="' + ORG_EDIT_HREF + '">Edit org</a></div>' + (d ? '<div class="wog__inrail">' + orgRailHtml(d) + '</div>' : '');
    var hidden = orgHidden(d);
    var shown = d.boxes.filter(function (b) { return !hidden[b.key]; });
    var lay = layoutOrg(shown.map(function (b) { return { key: b.key, name: b.name }; }), d.edges);
    var byKey = {};
    shown.forEach(function (b) { byKey[b.key] = b; });
    var cards = lay.boxes.map(function (at) { return orgCardHtml(byKey[at.key], at, d); }).join('');
    return orgLegendHtml(d) +
      (S.org.problem ? '<p class="wog__problem" role="alert">Something in the org chart does not hold: ' + esc(S.org.problem) + '</p>' : '') +
      (S.org.live === false ? '<p class="ax-wall__count wog__note">The daemon did not answer, so working or idle is not known.</p>' : '') +
      '<div class="wog__scroll" id="wog-scroll"><div class="wog__size" id="wog-size"><div class="wog__chart" id="wog-chart" style="--wog-cols: ' + lay.columns + '; transform: scale(' + ORG.zoom + ')">' +
        '<svg class="wog__lines" id="wog-lines" aria-hidden="true"></svg>' + cards + '</div></div></div>' +
      '<div class="wog__inrail">' + orgRailHtml(d) + '</div>';
  }

  // Lines go over the grid once the cards are in place, from their offsets
  // (a scale() on the chart does not change those).
  /** An element this page drew (not in the Wall's skeleton), or null. */
  function orgEl(id) { return document.querySelector('#' + id); }
  function orgDraw() {
    var chart = orgEl('wog-chart'), svg = orgEl('wog-lines'), size = orgEl('wog-size'), d = orgDiagram();
    if (!chart || !svg || !d) return;
    var phone = !svg.getClientRects().length;
    size.style.width = phone ? '' : chart.offsetWidth * ORG.zoom + 'px';
    size.style.height = phone ? '' : chart.offsetHeight * ORG.zoom + 'px';
    if (phone) return;
    var box = {};
    chart.querySelectorAll('[data-org-key]').forEach(function (el) {
      box[el.getAttribute('data-org-key')] = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    });
    var gap = parseFloat(getComputedStyle(chart).rowGap) || 48;
    var out = '<defs><marker id="wog-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="wog__arrow" d="M0 0L10 5L0 10z"/></marker></defs>';
    d.edges.forEach(function (e) {
      var a = box[e.from], b = box[e.to];
      if (!a || !b) return;
      if (e.type === 'reports-to') {
        var x1 = b.l + b.w / 2, x2 = a.l + a.w / 2, mid = a.t - gap / 2;
        out += '<path class="wog__ln" d="M' + x1 + ' ' + (b.t + b.h) + 'V' + mid + 'H' + x2 + 'V' + a.t + '"/>';
      } else if (e.type === 'dotted-line' && ORG.dotted) {
        // Between rows: from the report's top to the second boss's bottom,
        // beside the solid line's spot. In one row: side to side.
        var p, q, k = 50;
        if (Math.abs(a.t - b.t) > 4) {
          var up = b.t < a.t, dx = 0.3;
          p = [a.l + a.w * (0.5 + dx), up ? a.t : a.t + a.h, 0, up ? -1 : 1];
          q = [b.l + b.w * (0.5 + dx), up ? b.t + b.h : b.t, 0, up ? 1 : -1];
        } else {
          var right = b.l > a.l;
          p = [right ? a.l + a.w : a.l, a.t + a.h / 2, right ? 1 : -1, 0];
          q = [right ? b.l : b.l + b.w, b.t + b.h / 2, right ? -1 : 1, 0];
        }
        out += '<path class="wog__ln is-dotted" d="M' + p[0] + ' ' + p[1] + 'C' + (p[0] + p[2] * k) + ' ' + (p[1] + p[3] * k) + ' ' + (q[0] + q[2] * k) + ' ' + (q[1] + q[3] * k) + ' ' + q[0] + ' ' + q[1] + '" marker-end="url(#wog-arrow)"/>';
      }
    });
    svg.innerHTML = out;
  }
  var orgFrame = 0;
  function orgRedraw() {
    if (window.requestAnimationFrame) { window.cancelAnimationFrame(orgFrame); orgFrame = window.requestAnimationFrame(orgDraw); }
    else setTimeout(orgDraw, 0);
  }
  /** Called from the Wall's render(): paints the page when it is open, and the nav count always. */
  function renderOrg(page) {
    var n = $('nav-n-org'), c = orgCount();
    n.textContent = c == null ? '' : String(c);
    n.classList.toggle('is-zero', !c);
    n.setAttribute('title', c == null ? '' : c + ' in the org chart');
    var on = page === 'org';
    $('wall-org').hidden = !on;
    $('wall-org-rail').hidden = !on || !orgDiagram();
    if (!on) return;
    // Repaint only on a change, so a refresh keeps the chart's scroll and focus.
    var html = orgPageHtml();
    if (html !== ORG.html) {
      var scroll = orgEl('wog-scroll'), x = scroll ? scroll.scrollLeft : 0;
      var focus = document.activeElement && $('wall-org').contains(document.activeElement) ? document.activeElement.getAttribute('data-org-fold') : null;
      $('wall-org').innerHTML = ORG.html = html;
      if (orgEl('wog-scroll')) orgEl('wog-scroll').scrollLeft = x;
      if (focus) { var f = $('wall-org').querySelector('[data-org-fold="' + CSS.escape(focus) + '"]'); if (f) f.focus(); }
    }
    var d = orgDiagram(), rail = d ? orgRailHtml(d) : '';
    if (rail !== ORG.rail) $('wall-org-rail-body').innerHTML = ORG.rail = rail;
    orgRedraw();
  }
  function orgZoom(step) {
    ORG.zoom = step === 0 ? 1 : Math.min(1.5, Math.max(0.4, Math.round((ORG.zoom + step * 0.1) * 10) / 10));
    render();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-org-fold],[data-org-zoom],[data-org-dotted]');
    if (!t) return;
    if (t.hasAttribute('data-org-zoom')) { orgZoom(Number(t.getAttribute('data-org-zoom'))); return; }
    if (t.hasAttribute('data-org-dotted')) { ORG.dotted = !ORG.dotted; render(); return; }
    var k = t.getAttribute('data-org-fold');
    if (ORG.folded[k]) delete ORG.folded[k]; else ORG.folded[k] = true;
    render();
  });
  // A trackpad pinch arrives as ctrl + wheel: zoom the chart, not the page.
  document.addEventListener('wheel', function (ev) {
    if (!ev.ctrlKey || !ev.target.closest || !ev.target.closest('#wog-scroll')) return;
    ev.preventDefault();
    orgZoom(ev.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('resize', orgRedraw);
`

export const WALL_ORG_CSS = `
/* Org (#1419): a top-down chart; an indented list on a phone. */
.ax-wall__org { padding: 0 0 24px; }
.wog__bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--ax-border); }
.wog__legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wog__legend li { display: inline-flex; align-items: center; gap: 6px; }
.wog__key { display: inline-block; width: 18px; height: 12px; border: 1px solid var(--ax-border-2); border-radius: 4px; background: var(--ax-bg); }
.wog__key.is-person { border-style: dashed; border-color: var(--ax-accent); border-radius: 9999px; }
.wog__tools { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: var(--ax-fs-xs); }
.wog__toggle { font: inherit; font-weight: 600; background: var(--ax-bg); color: var(--ax-text); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); padding: 3px 12px; cursor: pointer; }
.wog__toggle[aria-pressed="true"] { background: var(--ax-text); color: var(--ax-bg); border-color: var(--ax-text); }
.wog__zoom { display: inline-flex; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-pill); overflow: hidden; }
.wog__zoom button { font: inherit; font-weight: 600; background: none; border: 0; color: var(--ax-text); padding: 3px 10px; cursor: pointer; min-width: 32px; }
.wog__zoom button:hover { background: var(--ax-surface); }
.wog__edit { font-size: var(--ax-fs-xs); padding: 3px 12px; }
.wog__problem { margin: 10px 16px 0; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-amber-t); color: var(--ax-amber-ink); font-size: var(--ax-fs-sm); }
.wog__note { padding: 8px 16px 0; }
.wog__scroll { overflow: auto; padding: 16px; }
.wog__size { position: relative; margin: 0 auto; }
.wog__chart { --wog-half: 118px; position: relative; display: grid; grid-template-columns: repeat(var(--wog-cols, 2), var(--wog-half)); row-gap: 48px; width: max-content; transform-origin: 0 0; }
.wog__lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.wog__ln { fill: none; stroke: var(--ax-border-2); stroke-width: 2; }
.wog__ln.is-dotted { stroke: var(--ax-muted); stroke-width: 1.5; stroke-dasharray: 6 5; }
.wog__arrow { fill: var(--ax-muted); }
.wog__card { position: relative; z-index: 1; width: 220px; justify-self: center; align-self: start; display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius-lg); }
.wog__card.is-person { border: 1.5px dashed var(--ax-accent); background: var(--ax-blue-t); }
.wog__card.is-paused, .wog__card.is-waiting { box-shadow: inset 3px 0 0 var(--ax-amber); }
.wog__head { display: flex; gap: 10px; align-items: center; min-width: 0; text-align: left; font: inherit; color: var(--ax-text); background: none; border: 0; padding: 0; }
button.wog__head { cursor: pointer; border-radius: var(--ax-radius); }
button.wog__head:hover b { text-decoration: underline; }
.wog__head .av { cursor: inherit; }
.wog__who { display: flex; flex-direction: column; min-width: 0; }
.wog__who b { display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wog__who small { color: var(--ax-muted); font-size: var(--ax-fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wog__who .wog__title { color: var(--ax-text-2); }
.wog__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ax-border-2); }
.wog__dot.is-working { background: var(--ax-green); }
.wog__dot.is-paused, .wog__dot.is-waiting { background: var(--ax-amber); }
.wog__dot.is-unknown { background: none; border: 1.5px solid var(--ax-border-2); }
.wog__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wog__chips { display: flex; flex-wrap: wrap; gap: 4px; }
.wog__chip { font-size: 12px; line-height: 1.5; border-radius: var(--ax-radius-pill); padding: 0 8px; background: var(--ax-surface-2); color: var(--ax-text-2); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.wog__chip.is-person { background: var(--ax-bg); color: var(--ax-accent); border: 1px solid var(--ax-accent); }
.wog__chip.is-acts { background: var(--ax-blue-t); color: var(--ax-accent); }
.wog__chip.is-dotted { border: 1px dashed var(--ax-border-2); background: none; }
.wog__chip.is-quiet { display: none; }
.wog__fold { align-self: flex-start; font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; padding: 0; color: var(--ax-accent); cursor: pointer; }
.wog__none { padding: 32px 16px; text-align: center; }
.wog__none h2 { margin: 0 0 6px; font-size: 20px; }
.wog__none p { margin: 0 0 12px; color: var(--ax-muted); }
.wog__counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 8px; }
.wog__counts div { background: var(--ax-bg); border-radius: var(--ax-radius); padding: 6px 10px; }
.wog__counts dt { font-size: var(--ax-fs-xs); color: var(--ax-muted); }
.wog__counts dd { margin: 0; font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
.wog__h3 { font-size: var(--ax-fs); margin: 10px 0 4px; }
.wog__outside { display: flex; flex-direction: column; }
/* The rail sits in the side column on a wide screen, under the chart otherwise. */
.wog__inrail { display: none; margin: 8px 16px 0; padding: 12px 16px; background: var(--ax-surface); border-radius: var(--ax-radius-lg); }
/* The profile's org rows (#1419). */
.wpf__orgrows { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: var(--ax-fs-sm); }
.wpf__orgrows div { display: contents; }
.wpf__orgrows dt { color: var(--ax-muted); }
.wpf__orgrows dd { margin: 0; }
.wpf__orgrows button { padding: 0; border: 0; background: none; color: var(--ax-accent); font: inherit; cursor: pointer; }
.wpf__orglink { display: inline-block; margin-top: 4px; font-size: var(--ax-fs-sm); color: var(--ax-accent); text-decoration: none; }
@media (max-width: 1180px) {
  .ax-wall__orgrail { display: none; }
  .wog__inrail { display: block; }
}
/* Phone: an indented list, each card on a thread line from its boss. */
@media (max-width: 640px) {
  .wog__scroll { overflow: visible; padding: 12px 12px 0; }
  .wog__size { width: auto !important; height: auto !important; }
  .wog__chart { display: flex; flex-direction: column; gap: 8px; width: auto; transform: none !important; }
  .wog__lines, .wog__zoom { display: none; }
  .wog__card { width: auto; align-self: stretch; margin-left: calc(min(var(--lvl, 0), 5) * 18px); }
  .wog__chip { white-space: normal; }
  .wog__card:not(.is-top)::before { content: ""; position: absolute; left: -12px; top: -9px; width: 10px; height: 30px;
    border-left: 2px solid var(--ax-border-2); border-bottom: 2px solid var(--ax-border-2); border-bottom-left-radius: 8px; }
  .wog__chip.is-quiet { display: inline; }
  .wog__inrail { margin: 12px; }
}
`
