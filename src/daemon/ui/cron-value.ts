// --- Value line on a recurring job, in the browser (#1183) ---
//
// One renderer for the Wall's Recurring jobs view and Settings › Schedules,
// so both say the same thing. `esc` is the page's own HTML escaper.

export const NO_VALUE_LINE = "no value line"

export const CRON_VALUE_SCRIPT = `
function axCronValueHtml(v, esc) {
  if (!v || !v.why || !v.metric) return '<span class="ax-cron-value is-missing">${NO_VALUE_LINE}</span>';
  return '<span class="ax-cron-value">Why: ' + esc(v.why) + ' · Proves it: <b>' + esc(v.metric) + '</b></span>';
}
`

export const CRON_VALUE_CSS = `
.ax-cron-value { color: var(--ax-text-2); overflow-wrap: anywhere; }
.ax-cron-value b { font-weight: 500; color: var(--ax-text); }
.ax-cron-value.is-missing { color: var(--ax-warn); font-style: italic; }
`

/** The Wall's Recurring jobs view: every node's jobs, each with its value
 *  line. `nodes` is the live fleet snapshot (name, crons). */
export const CRON_JOBS_SCRIPT = `
function axCronJobsHtml(nodes, esc) {
  var rows = [];
  (nodes || []).forEach(function (n) {
    (n.crons || []).forEach(function (j) {
      rows.push('<li><b>' + esc(j.id) + '</b> on ' + esc(n.name) + ' · ' + esc(j.schedule) + ' · runs ' + esc(j.agent) + (j.enabled ? '' : ' · <i>off</i>') +
        '<div>' + axCronValueHtml(j.value, esc) + '</div></li>');
    });
  });
  if (!nodes) return '<p class="ax-wall__empty">Loading…</p>';
  return rows.length ? '<div class="wf"><h3>Recurring jobs</h3><ul>' + rows.join('') + '</ul></div>' : '<p class="ax-wall__empty">No recurring jobs.</p>';
}
`
