// --- Value line on a recurring job, in the browser (#1183) ---
//
// One renderer for the Wall's Jobs page and Settings › Schedules,
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
