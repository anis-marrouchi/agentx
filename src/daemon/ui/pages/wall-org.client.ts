// --- The org on the Wall, browser side (#1398) ---
//
// Spliced into WALL_PAGE_SCRIPT's closure, so it uses that script's S,
// esc() and getJson(). Reads GET /api/admin/org once, when the Wall opens,
// and keeps, per agent in the org chart, its role title, the boss the chart
// places it under and how many report to it. The agent profile and each
// Agents-page card show that line; the boss opens its own profile.
//
// Read-only (#1180 rule 4): no Pause or Resume here, that stays on /org.
// When the read fails, or an agent is not in the chart, nothing is shown.

export const WALL_ORG_SCRIPT = String.raw`
  /** Index the org tree by agent: title, boss (as placed in the tree) and direct reports. */
  function orgIndex(d) {
    var by = {};
    function walk(list, boss) {
      (list || []).forEach(function (n) {
        if (!n || !n.id) return;
        by[n.id] = { title: n.title || '', boss: boss || '', reports: (n.reports || []).length };
        walk(n.reports, n.id);
      });
    }
    if (d && d.exists !== false) walk(d.roots, '');
    return by;
  }
  function loadOrg() {
    getJson('/api/admin/org').then(function (d) { S.org = orgIndex(d); render(); }).catch(function () { S.org = {}; });
  }
  /** "Title · reports to @boss · 2 report to it", or '' for an agent not in the chart. */
  function orgHtml(id) {
    var o = S.org && Object.prototype.hasOwnProperty.call(S.org, id) ? S.org[id] : null;
    if (!o) return '';
    var parts = [];
    if (o.title) parts.push('<b>' + esc(o.title) + '</b>');
    if (o.boss) parts.push('reports to <button type="button" class="name" data-agent="' + esc(o.boss) + '">@' + esc(o.boss) + '</button>');
    if (o.reports) parts.push(o.reports + (o.reports === 1 ? ' reports' : ' report') + ' to it');
    return parts.length ? '<p class="wpf__org">' + parts.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</p>' : '';
  }
`

export const WALL_ORG_CSS = `
.wpf__org { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 6px 0 0; font-size: var(--ax-fs-sm); color: var(--ax-muted); }
.wpf__org b { color: var(--ax-text); font-weight: 600; }
.wpf__org .name { font: inherit; color: var(--ax-accent); background: none; border: 0; padding: 0; cursor: pointer; }
.wpf__org .name:hover, .wpf__org .name:focus-visible { text-decoration: underline; }
`
