// --- The Wall's Cost page, browser side (#1423) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S, $,
// esc(), avatar(), nameOf(), hue(), getJson() and render(), and the
// helpers wall-cost.ts ships (wallCostModel, wallMonthSpend, costUsd,
// costShort, costFetchRange).
//
// Global spend and each agent's spend (#page=cost&range=7|30|90): this
// month against the budget, today, a 30-day sparkline and the week's
// change; then per range a chart of daily spend stacked by agent (top five
// and the rest) and one row per agent, most spent first, that opens the
// agent's profile. A side rail has the week's biggest moves and the cache
// savings. Every machine is read: this one directly, the others through
// the dashboard's peer proxy (X-Agentx-Peer); one that does not answer is
// named, and the rest still add up. Read-only (#1180 rule 4): caps and the
// CSV export stay on the classic page, /admin/cost.

import { WALL_COST_RANGES } from "./wall-cost"

export const WALL_COST_SCRIPT = String.raw`
  var COST_RANGES = ${JSON.stringify(WALL_COST_RANGES)};
  var COST_DEFAULT = 30;
  /** The machines to read: this one first, then each peer the live snapshot lists. */
  function costNodes() {
    var nodes = (S.live && S.live.nodes) || [];
    var out = nodes.map(function (n, i) { return { name: n.name, peer: i === 0 ? null : n.url, down: i > 0 && (!n.reachable || !!n.error) }; });
    return out.length ? out : [{ name: 'this machine', peer: null, down: false }];
  }
  /** Read one range from every machine; again only when asked or when the machines change. */
  function loadCost(force) {
    var range = S.costRange, nodes = costNodes();
    var sig = nodes.map(function (n) { return n.name; }).join('|');
    var had = S.cost[range];
    if (had && had.pending) return;
    if (had && had.sig === sig && !force) return;
    var slot = { sig: sig, pending: true, replies: had && had.sig === sig ? had.replies : null };
    S.cost[range] = slot;
    Promise.all(nodes.map(function (n) {
      if (n.down) return { name: n.name, error: 'does not answer' };
      return getJson('/api/admin/observability/cost?range=' + costFetchRange(range), n.peer)
        .then(function (d) { return { name: n.name, cost: d && Array.isArray(d.days) ? d : null, error: d && Array.isArray(d.days) ? '' : 'no cost in its reply' }; },
          function (e) {
            var msg = String(e && e.message || e);
            // The peer proxy reads only machines listed in dashboard.daemons, as the feed does.
            return { name: n.name, error: n.peer && msg === 'HTTP 404' ? 'not in dashboard.daemons' : msg };
          });
    })).then(function (replies) { slot.replies = replies; slot.pending = false; render(); });
  }
  /** The other machines' month against their caps; this one's is S.budgets. */
  function loadPeerBudgets() {
    var peers = costNodes().slice(1);
    if (!peers.length) { S.peerBudgets = []; return; }
    Promise.all(peers.map(function (n) {
      return n.down ? null : getJson('/api/admin/observability/budgets', n.peer).catch(function () { return null; });
    })).then(function (list) { S.peerBudgets = list; render(); });
  }
  function monthSpend() { return wallMonthSpend([S.budgets].concat(S.peerBudgets || [])); }

  function pctText(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(Math.round(x * 100)) + '%'; }
  function changeHtml(x, vs) {
    if (x == null) return '';
    return '<small class="wco__chg ' + (x > 0 ? 'is-up' : x < 0 ? 'is-down' : '') + '" title="Against ' + esc(vs) + '">' + pctText(x) + '</small>';
  }
  /** A small line of daily totals, oldest first. */
  function costSparkHtml(vals, label, cls) {
    if (!vals.length) return '';
    var W = 120, H = 28, max = Math.max.apply(null, vals.concat([0]));
    var pts = vals.map(function (v, i) {
      return (vals.length === 1 ? W : i / (vals.length - 1) * W).toFixed(1) + ',' + (H - 2 - (max > 0 ? v / max * (H - 4) : 0)).toFixed(1);
    }).join(' ');
    return '<svg class="wco__spark' + (cls ? ' ' + cls : '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
      '<polyline points="' + pts + '" fill="none" style="stroke:var(--ax-accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }
  function agentFill(id) { return id === '~' ? 'var(--ax-border-2)' : 'hsl(' + hue(id) + ',55%,46%)'; }

  // The header: this month against the budget, today, 30 days, the week.
  function costHeadHtml(month, m) {
    var monthHtml;
    if (!month) monthHtml = '<div class="wco__month"><small>This month (UTC)</small><b class="wco__big">—</b><span>' + (!S.budgetsDone ? 'Loading…' : 'Not known: the budgets could not be read.') + '</span></div>';
    else {
      var pct = month.cap ? Math.min(100, Math.round(month.spent / month.cap * 100)) : null;
      monthHtml = '<div class="wco__month"><small>This month (UTC)</small><b class="wco__big">' + costUsd(month.spent) + '</b>' +
        '<span>' + (month.cap ? 'of ' + costUsd(month.cap) + ' fleet budget (' + Math.round(month.spent / month.cap * 100) + '%)' : 'no fleet budget') +
          (month.unpriced ? ' · ' + month.unpriced + ' not priced' : '') + '</span>' +
        (pct == null ? '' : '<span class="wco__bar' + (pct >= 100 ? ' is-err' : pct >= 80 ? ' is-warn' : '') + '" role="progressbar" aria-label="This month against the fleet budget" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></span>') +
      '</div>';
    }
    var kpis = m ? '<dl class="wco__kpis">' +
      '<div><dt>Today</dt><dd>' + costUsd(m.spentToday) + '</dd></div>' +
      '<div><dt>Last 7 days</dt><dd>' + (m.weekChange == null ? 'no week before' : pctText(m.weekChange) + ' <small>vs the week before</small>') + '</dd></div>' +
      '<div><dt>30 days</dt><dd>' + costSparkHtml(m.spark, 'Daily spend, last 30 days') + '</dd></div>' +
    '</dl>' : '';
    return '<div class="wco__head">' + monthHtml + kpis + '</div>';
  }

  // The chart: one bar a day, stacked by agent (top five, then the rest).
  function costChartHtml(m) {
    var n = m.days.length, W = 600, H = 150, gap = n > 40 ? 1 : 2, bw = (W - gap * (n - 1)) / n;
    var peak = m.days.reduce(function (b, d) { return d.total > b.total ? d : b; }, m.days[0]);
    if (!peak || !(peak.total > 0)) return '<p class="ax-wall__empty">No spend in this range.</p>';
    var keys = m.top.concat(['~']);
    var bars = m.days.map(function (d, i) {
      var x = (i * (bw + gap)).toFixed(2), y = H, segs = '';
      keys.forEach(function (id) {
        var v = id === '~' ? d.others : (d.parts[id] || 0);
        if (!(v > 0)) return;
        var h = v / peak.total * H;
        y -= h;
        segs += '<rect x="' + x + '" y="' + y.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '" style="fill:' + agentFill(id) + '"/>';
      });
      var tip = d.date + ': ' + costUsd(d.total) + m.top.filter(function (id) { return d.parts[id] > 0; }).map(function (id) { return ', ' + nameOf(id) + ' ' + costUsd(d.parts[id]); }).join('') +
        (d.others > 0 ? ', others ' + costUsd(d.others) : '');
      return '<g><title>' + esc(tip) + '</title><rect x="' + x + '" y="0" width="' + bw.toFixed(2) + '" height="' + H + '" style="fill:transparent"/>' + segs + '</g>';
    }).join('');
    var legend = keys.filter(function (id) { return id !== '~' || m.days.some(function (d) { return d.others > 0; }); }).map(function (id) {
      return '<span><i style="background:' + agentFill(id) + '"></i>' + esc(id === '~' ? 'Others' : nameOf(id)) + '</span>';
    }).join('');
    var label = 'Daily spend, last ' + m.range + ' days, stacked by agent. Peak ' + costUsd(peak.total) + ' on ' + peak.date + '.';
    return '<figure class="wco__chart"><div class="wco__plot"><span class="wco__peak">' + costUsd(peak.total) + '</span>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' + bars + '</svg></div>' +
      '<div class="wco__axis"><span>' + esc(m.days[0].date) + '</span><span>' + esc(m.days[n - 1].date) + '</span></div>' +
      '<figcaption class="wco__legend">' + legend + '</figcaption></figure>' +
      // On a phone the chart folds into one line of the same days.
      costSparkHtml(m.days.map(function (d) { return d.total; }), label, 'wco__spark--range');
  }

  // One row per agent, most spent first; a row opens the agent's profile.
  function costRowsHtml(m, month) {
    if (!m.agents.length) return '<p class="ax-wall__empty">No agent ran in this range.</p>';
    var vs = 'the ' + (m.range + 1) + ' days before';
    return '<ol class="wco__list" aria-label="Spend per agent, most first">' + m.agents.map(function (a) {
      var mo = month && month.agents[a.id];
      var cap = '';
      if (mo && mo.cap) {
        var pct = Math.min(100, Math.round(mo.spent / mo.cap * 100));
        cap = '<span class="wco__cap"><span class="wco__bar' + (mo.state === 'paused' ? ' is-err' : mo.state === 'warn' ? ' is-warn' : '') + '" role="progressbar" aria-label="This month against its cap" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></span>' +
          costUsd(mo.spent) + ' of ' + costUsd(mo.cap) + ' this month' + (mo.state === 'paused' ? ' · paused' : mo.state === 'warn' ? ' · near cap' : '') + '</span>';
      } else if (mo) cap = '<span class="wco__cap">' + costUsd(mo.spent) + ' this month · no cap</span>';
      var meta = [
        a.runs + (a.runs === 1 ? ' run' : ' runs'),
        a.perRun == null ? '' : costUsd(a.perRun) + ' per run',
        a.unpriced ? '<span class="is-warn" title="Runs on a model with no price here, such as a local model">' + a.unpriced + ' not priced</span>' : '',
      ].filter(Boolean).join(' · ');
      var change = a.change != null ? changeHtml(a.change, vs) : a.prev > 0 || !(a.cost > 0) ? '' : '<small class="wco__chg" title="No spend in ' + esc(vs) + '">new</small>';
      return '<li><button type="button" class="wco__row" data-agent="' + esc(a.id) + '" title="Open ' + esc(nameOf(a.id)) + '\'s profile">' + avatar(a.id, 'side') +
        '<span class="wco__who"><b>' + esc(nameOf(a.id)) + '</b><small>@' + esc(a.id) + '</small><small class="wco__meta">' + meta + '</small>' + cap + '</span>' +
        '<span class="wco__amt"><b>' + costUsd(a.cost) + '</b>' + change + '</span>' +
      '</button></li>';
    }).join('') + '</ol>';
  }

  // The side rail: the week's biggest moves, cache savings, unpriced runs.
  function costRailHtml(m) {
    var moves = m.movers.length ? '<ul class="wco__movers">' + m.movers.map(function (x) {
      var up = x.to > x.from;
      return '<li><button type="button" class="wa" data-agent="' + esc(x.id) + '">' + avatar(x.id, 'side') + '<span class="wa__n"><b>' + esc(nameOf(x.id)) + '</b>' +
        '<small>' + costUsd(x.from) + ' → ' + costUsd(x.to) + ' <span class="wco__chg ' + (up ? 'is-up' : 'is-down') + '">' + (up ? '+' : '−') + costUsd(Math.abs(x.to - x.from)) + '</span></small></span></button></li>';
    }).join('') + '</ul>' : '<p class="ax-wall__empty">No change this week.</p>';
    return '<h2>Biggest moves</h2><p class="ax-wall__count">Last 7 days against the 7 before.</p>' + moves +
      '<h3>Cache savings</h3><p class="wco__rl"><b>' + costUsd(m.cacheSaved) + '</b> saved in the last ' + m.range + ' days by reading from the cache, estimated as on the Cost page.</p>' +
      (m.unpriced ? '<h3>Runs without a cost</h3><p class="wco__rl is-warn">' + m.unpriced + (m.unpriced === 1 ? ' run' : ' runs') + ' in the last ' + m.range + ' days had no price. <a href="#cost-unpriced">Why</a></p>' : '') +
      '<p class="wco__rl"><a href="/admin/cost">Caps and CSV export: the classic Cost page</a></p>';
  }

  function costPageHtml() {
    loadCost(false);
    var slot = S.cost[S.costRange], month = monthSpend();
    var tabs = '<div class="ax-wall__views wco__tabs" role="tablist" aria-label="Range">' + COST_RANGES.map(function (r) {
      var on = r === S.costRange;
      return '<button type="button" role="tab" data-cost-range="' + r + '" aria-selected="' + on + '"' + (on ? ' class="is-on"' : '') + '>' + r + ' days</button>';
    }).join('') + '</div>';
    if (!slot || !slot.replies) return costHeadHtml(month, null) + tabs + '<p class="ax-wall__empty">Loading…</p>';
    var m = wallCostModel(slot.replies, S.costRange);
    S.costModel = m;
    if (!m.answered.length) {
      return costHeadHtml(month, null) + tabs + '<p class="ax-wall__empty wco__err" role="alert">Could not read the cost: ' +
        esc(m.failed.map(function (f) { return f.name + ': ' + f.error; }).join('; ')) + '. The rest of the Wall still works; the classic <a href="/admin/cost">Cost page</a> may say more.</p>';
    }
    var notes = '';
    if (m.failed.length) {
      // One reason once: "a, b (not in dashboard.daemons)".
      var why = {}, order = [];
      m.failed.forEach(function (f) { if (!why[f.error]) { why[f.error] = []; order.push(f.error); } why[f.error].push(f.name); });
      notes += '<p class="wco__note is-warn" role="note">Not read: ' + esc(order.map(function (e) { return why[e].join(', ') + ' (' + e + ')'; }).join('; ')) +
        '. ' + (m.failed.length === 1 ? 'Its' : 'Their') + ' spend is not in these numbers.</p>';
    }
    if (m.unpriced) notes += '<p class="wco__note is-warn" id="cost-unpriced" role="note">' + m.unpriced + (m.unpriced === 1 ? ' run' : ' runs') +
      ' in this range used a model with no price here, such as a local model. ' + (m.unpriced === 1 ? 'It is' : 'They are') + ' counted in runs, not in the dollars.</p>';
    var sum = '<p class="wco__sum"><b>' + costUsd(m.total) + '</b> in the last ' + m.range + ' days' +
      changeHtml(m.prevTotal > 0 ? (m.total - m.prevTotal) / m.prevTotal : null, costUsd(m.prevTotal) + ' in the ' + (m.range + 1) + ' days before') +
      ' · ' + m.runs + (m.runs === 1 ? ' run' : ' runs') + ' · ' + m.answered.length + (m.answered.length === 1 ? ' machine' : ' machines') + '</p>';
    return costHeadHtml(month, m) + tabs + sum + notes + costChartHtml(m) +
      '<h2 class="wco__h">Per agent</h2>' + costRowsHtml(m, month) +
      // Under 1180 px the side rail is gone, so it follows the list.
      '<section class="wco__rail wco__rail--inline" aria-label="This week">' + costRailHtml(m) + '</section>';
  }
  function paintCost(page) {
    $('wall-cost').hidden = page !== 'cost';
    $('wall-cost-side').hidden = page !== 'cost';
    if (page !== 'cost') return;
    $('wall-cost').innerHTML = costPageHtml();
    $('wall-cost-rail').innerHTML = S.costModel && S.cost[S.costRange] && S.cost[S.costRange].replies ? costRailHtml(S.costModel) : '<p class="ax-wall__empty">Loading…</p>';
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-cost-range]');
    if (!t) return;
    var r = +t.getAttribute('data-cost-range');
    if (COST_RANGES.indexOf(r) < 0 || r === S.costRange) return;
    S.costRange = r;
    S.costModel = null;
    writeHash();
    render();
  });
`

export const WALL_COST_CSS = `
/* Cost (#1423) */
.ax-wall__cost { padding-bottom: 16px; }
.wco__head { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; padding: 14px 16px 12px; border-bottom: 1px solid var(--ax-border); }
.wco__month { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 220px; }
.wco__month small, .wco__kpis dt { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wco__month span { color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.wco__big { font-size: 32px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
.wco__kpis { display: flex; gap: 18px; margin: 0; flex-wrap: wrap; }
.wco__kpis dd { margin: 2px 0 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.wco__kpis dd small { color: var(--ax-muted); font-weight: 400; }
.wco__spark { display: block; width: 120px; height: 28px; }
.wco__spark--range { display: none; width: 100%; height: 40px; padding: 0 16px; box-sizing: border-box; }
.wco__bar { display: block; height: 6px; border-radius: 3px; background: var(--ax-surface-2); overflow: hidden; max-width: 260px; margin-top: 4px; }
.wco__bar i { display: block; height: 100%; background: var(--ax-green); }
.wco__bar.is-warn i { background: var(--ax-amber); }
.wco__bar.is-err i { background: var(--ax-red); }
.wco__tabs { border-bottom: 1px solid var(--ax-border); }
.wco__sum { margin: 0; padding: 12px 16px 4px; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wco__sum b { color: var(--ax-text); font-size: 17px; }
.wco__sum .wco__chg { margin-left: 6px; }
.wco__chg { font-size: var(--ax-fs-xs); font-weight: 600; color: var(--ax-muted); }
.wco__chg.is-up { color: var(--ax-amber-ink, var(--ax-warn)); }
.wco__chg.is-down { color: var(--ax-green-d, var(--ax-green)); }
.wco__note { margin: 8px 16px 0; padding: 8px 12px; border-radius: var(--ax-radius); background: var(--ax-surface); font-size: var(--ax-fs-sm); }
.wco__note.is-warn { background: var(--ax-amber-t); color: var(--ax-amber-ink); }
.wco__err { padding: 32px 16px; text-align: center; }
.wco__chart { margin: 12px 16px 0; }
.wco__plot { position: relative; }
.wco__plot svg { display: block; width: 100%; height: 150px; border-bottom: 1px solid var(--ax-border-2); }
.wco__plot g:hover rect:first-child { fill: var(--ax-surface) !important; }
.wco__peak { position: absolute; top: -2px; left: 0; font-size: 11px; color: var(--ax-muted); font-variant-numeric: tabular-nums; pointer-events: none; }
.wco__axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--ax-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.wco__legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.wco__legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.wco__h { font-size: var(--ax-fs); font-weight: 800; margin: 16px 0 0; padding: 0 16px 8px; border-bottom: 1px solid var(--ax-border); }
.wco__list { list-style: none; margin: 0; padding: 0; }
.wco__row { display: flex; gap: 12px; align-items: flex-start; width: 100%; padding: 12px 16px; font: inherit; color: inherit; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--ax-border); cursor: pointer; }
.wco__row:hover { background: color-mix(in srgb, var(--ax-surface) 55%, transparent); }
.wco__row:focus-visible { outline: 2px solid var(--ax-accent); outline-offset: -2px; }
.wco__row:hover .wco__who b { text-decoration: underline; }
.wco__who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wco__who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wco__who small { color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.wco__meta { margin-top: 2px; }
.wco__meta .is-warn, .wco__rl.is-warn { color: var(--ax-amber-ink, var(--ax-warn)); }
.wco__cap { display: block; color: var(--ax-muted); font-size: var(--ax-fs-xs); margin-top: 4px; }
.wco__cap .wco__bar { margin: 0 0 2px; }
.wco__amt { display: flex; flex-direction: column; align-items: flex-end; flex: none; font-variant-numeric: tabular-nums; }
.wco__amt b { font-size: 17px; }
.wco__movers { list-style: none; margin: 0; padding: 0; }
.wco__rail h3 { font-size: var(--ax-fs); margin: 12px 0 4px; }
.wco__rail h2 { font-size: 20px; font-weight: 800; margin: 0 0 4px; }
.wco__rl { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.wco__rl + .wco__rl { margin-top: 10px; }
.wco__rail--inline { display: none; margin: 16px 16px 0; padding: 12px 16px; background: var(--ax-surface); border-radius: var(--ax-radius-lg); }
@media (max-width: 1180px) {
  .ax-wall__aside > .ax-wall__costside { display: none; }
  .wco__rail--inline { display: block; }
}
@media (max-width: 640px) {
  .wco__head { flex-direction: column; align-items: stretch; }
  .wco__month { flex: none; }
  .wco__big { font-size: 28px; }
  .wco__chart { display: none; }
  .wco__spark--range { display: block; margin-top: 8px; }
  .wco__row { padding: 12px; gap: 10px; }
}
`
