// --- The Projects view of the Org page (#1687) ---
//
// One renderer for /org and the Hub Org page, so both show a project the
// same way: a dashed box like a department's (#1681), titled with the
// client and the project name; the lead's card and the PM's card on top;
// the team as a grid of cards under them. Members on no project are listed
// last, under "Not in a project". It reads the `projects` and
// `notInProject` of GET /api/admin/org (business/org-view.ts).
//
// ORG_PROJECTS_JS is plain browser JS spliced into each page's script. It
// holds no backtick and no "${": both pages wrap it in a template string.

import { ORG_AGENT_ICON, ORG_PERSON_ICON } from "./org-icons"

export const ORG_PROJECTS_JS = `
  /** The Projects view: one box per project, then the members on none. */
  function orgProjectsHtml(d, esc) {
    var list = (d && d.projects) || [], rest = (d && d.notInProject) || [];
    var STATE = { working: 'Working', idle: 'Idle', paused: 'Paused', waiting: 'Waits for your approval', unknown: 'Status not known' };
    var ICON = { person: '${ORG_PERSON_ICON}', agent: '${ORG_AGENT_ICON}' };
    function card(c, role) {
      var person = c.kind === 'person', st = c.status || 'unknown';
      return '<li class="opj-card is-' + (person ? 'person' : 'agent') + '" data-member="' + esc(c.key) + '">'
        + '<span class="opj-kind is-' + (person ? 'person' : 'agent') + '">' + ICON[person ? 'person' : 'agent'] + (person ? 'Person' : 'Agent') + '</span>'
        + (role ? '<span class="opj-role">' + esc(role) + '</span>' : '')
        + '<b class="opj-name">' + esc(c.name) + '</b>'
        + (c.title ? '<span class="opj-title">' + esc(c.title) + '</span>' : '')
        + (person ? '' : '<span class="opj-state is-' + esc(st) + '"><span class="opj-dot" aria-hidden="true"></span>' + esc(STATE[st] || st) + '</span>')
        + '</li>';
    }
    function box(p, i) {
      var mgr = (p.lead ? card(p.lead, 'Lead') : '') + (p.pm ? card(p.pm, 'PM') : '');
      var n = p.team.length;
      return '<section class="opj" data-project="' + esc(p.id) + '" aria-labelledby="opj-t-' + i + '">'
        + '<header class="opj-head"><span class="opj-client">' + esc(p.client) + '</span>'
        + '<h3 class="opj-t" id="opj-t-' + i + '">' + esc(p.name) + '</h3>'
        + (p.name !== p.id ? '<code class="opj-id">' + esc(p.id) + '</code>' : '') + '</header>'
        + (mgr ? '<ul class="opj-mgr" aria-label="Runs it">' + mgr + '</ul>' : '<p class="opj-empty">No lead or PM yet.</p>')
        + '<h4 class="opj-sub">Team' + (n ? ' · ' + n : '') + '</h4>'
        + (n ? '<ul class="opj-team" aria-label="Team of ' + esc(p.name) + '">' + p.team.map(function (c) { return card(c); }).join('') + '</ul>'
          : '<p class="opj-empty">No team yet.</p>')
        + '</section>';
    }
    var out = list.length ? '<div class="opj-grid">' + list.map(box).join('') + '</div>'
      : '<p class="opj-none">No projects yet. Add one under <code>business.projects</code> in <code>agentx.json</code>, or with <code>agentx business project add &lt;id&gt; --pm &lt;agent&gt;</code>.</p>';
    if (rest.length) out += '<section class="opj-rest" aria-labelledby="opj-rest-t"><h3 id="opj-rest-t" class="opj-rest-t">Not in a project · ' + rest.length + '</h3>'
      + '<ul class="opj-team">' + rest.map(function (c) { return card(c); }).join('') + '</ul></section>';
    return out;
  }
`

export const ORG_PROJECTS_CSS = `
/* Projects view (#1687): the department box, one per project. */
.opj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 16px; align-items: start; }
.opj { min-width: 0; padding: 12px 12px 14px; border: 1.5px dashed var(--ax-accent); border-radius: 16px; background: var(--ax-blue-t); }
.opj-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 0 0 10px; }
.opj-client { flex: 1 1 100%; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ax-text-2); }
.opj-t { margin: 0; font-size: 15px; font-weight: 700; color: var(--ax-accent); overflow-wrap: anywhere; }
.opj-id { font-family: var(--ax-mono); font-size: 11px; color: var(--ax-text-2); overflow-wrap: anywhere; }
.opj-sub { margin: 12px 0 6px; font-size: 12px; font-weight: 600; color: var(--ax-text-2); }
.opj-mgr, .opj-team { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.opj-mgr { grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); }
.opj-team { grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr)); }
.opj-card { position: relative; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--ax-bg); border: 1px solid var(--ax-border-2); border-radius: 12px; font-size: var(--ax-fs-xs); }
.opj-card.is-person { background: var(--ax-surface-2); border-color: var(--ax-accent); border-left-width: 4px; border-radius: 18px; }
.opj-mgr .opj-card { border-width: 1.5px; }
.opj-mgr .opj-card.is-person { border-left-width: 4px; }
.opj-kind { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; font-size: 11px; font-weight: 600; line-height: 17px; border-radius: 999px; border: 1px solid var(--ax-border-2); background: var(--ax-bg); color: var(--ax-text-2); white-space: nowrap; }
.opj-kind svg { fill: currentColor; }
.opj-kind .org-eye { fill: var(--ax-bg); }
.opj-kind.is-person { border-color: var(--ax-accent); color: var(--ax-accent); }
.opj-role { position: absolute; top: 8px; right: 10px; font-size: 11px; font-weight: 700; color: var(--ax-accent); }
.opj-name { font-size: 13px; color: var(--ax-text); overflow-wrap: anywhere; margin-top: 4px; }
.opj-title { color: var(--ax-text-2); overflow-wrap: anywhere; }
.opj-state { display: inline-flex; align-items: center; gap: 5px; color: var(--ax-text-2); }
.opj-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ax-muted); }
.opj-state.is-working .opj-dot { background: var(--ax-green); }
.opj-state.is-paused .opj-dot, .opj-state.is-waiting .opj-dot { background: var(--ax-amber); }
.opj-empty { margin: 0; font-size: var(--ax-fs-xs); color: var(--ax-text-2); }
.opj-none { margin: 0; font-size: var(--ax-fs-sm); color: var(--ax-text-2); }
.opj-none code { font-family: var(--ax-mono); font-size: 11.5px; background: var(--ax-surface-2); padding: 1px 6px; border-radius: var(--ax-radius-sm); }
.opj-rest { margin-top: 24px; }
.opj-rest-t { margin: 0 0 8px; font-size: 14px; }
`
