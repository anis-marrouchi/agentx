import { fitCapacity } from "../../monitor-capacity"
import { renderShell, type TopbarPeer } from ".."

/** Feather-style 24x24 stroked glyphs, sized at the call site. */
const ICON = {
  refresh: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  gavel: '<path d="M12 3 6 9"/><path d="m9 6 6 6"/><path d="M15 9 9 15"/><path d="m12 12 6 6"/><path d="M4 21h10"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  broom: '<path d="M3 21h18"/><path d="M12 3v9"/><path d="m7 12 5-3 5 3-1.5 6h-7Z"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01"/><path d="M6 17.5h.01"/>',
  inbox: '<path d="M21 12h-6l-2 3h-2l-2-3H3"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/>',
  cross: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  file: '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  chevr: '<path d="m9 6 6 6-6 6"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6"/>',
  // --- channel glyphs (generic, never brand marks) ---
  branch: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M18 11v1a3 3 0 0 1-3 3H9"/><path d="M6 9v6"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4Z"/>',
  msg: '<path d="M21 11.5a8.4 8.4 0 0 1-12.9 7.5L3 21l2-5.1A8.4 8.4 0 1 1 21 11.5Z"/>',
  code: '<path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trace: '<path d="M4 4v16h16"/><path d="m7 15 4-4 3 3 5-6"/>',
}
const svg = (d: string, size = 14) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="' + size + '" height="' + size + '" aria-hidden="true">' + d + "</svg>"

/** Segmented radio group. Values carry the payload; labels stay human. */
const seg = (id: string, label: string, opts: Array<[string, string]>, on: string) =>
  '<div class="bf-seg" id="' + id + '" role="radiogroup" aria-label="' + label + '">' +
  opts.map(([value, text]) =>
    '<button type="button" role="radio" data-value="' + value + '" aria-checked="' + (value === on) + '"' +
    (value === on ? ' class="is-on"' : "") + ">" + text + "</button>").join("") +
  "</div>"

const secLabel = (icon: string, text: string, countId?: string, rightHtml = "") =>
  '<div class="ax-sec-label"><h3>' + svg(icon, 13) + text +
  (countId ? '<span class="ax-sec-label__n" id="' + countId + '"></span>' : "") + "</h3>" + rightHtml + "</div>"

export function renderMonitorPage(opts: { peers?: TopbarPeer[] } = {}): string {
  return renderShell({
    title: "AgentX · Briefing", activeTab: "monitor", subtitle: "Session briefing", peers: opts.peers,
    body: `<div class="bf">

<div class="bf-head">
  <div>
    <span class="bf-kicker">Your attention, protected</span>
    <h1>What needs you.</h1>
  </div>
  <div class="bf-sync">
    <span class="bf-sync__t" id="synced">Gathering&hellip;</span>
    <button class="ax-btn" id="refresh" title="Refresh now">${svg(ICON.refresh)} Refresh</button>
  </div>
</div>

<p id="coverage" class="bf-sr" role="status">Gathering session reviews across your mesh&hellip;</p>
<div class="bf-strip" id="strip"></div>
<div id="coverage-note"></div>
<div id="automation"></div>
<div id="principals"></div>

<section class="bf-cap" aria-label="Your capacity">
  <div class="bf-cap__grp">
    <span class="bf-cap__lbl">Time</span>
    ${seg("minutes", "Time available", [["5", "5m"], ["15", "15m"], ["30", "30m"], ["60", "60m"]], "15")}
  </div>
  <div class="bf-cap__grp">
    <span class="bf-cap__lbl">Focus</span>
    ${seg("focus", "Focus today", [["low", "Light"], ["medium", "Normal"], ["high", "Deep"]], "medium")}
  </div>
  <div class="bf-budget">
    <div class="bf-budget__row">
      <span class="bf-cap__lbl">Planned</span>
      <span class="bf-budget__v" id="budget">&mdash;</span>
    </div>
    <div class="bf-meter"><span class="bf-meter__fill" id="meter" style="width:0%"></span></div>
  </div>
</section>

<p id="notice" role="status" aria-live="polite"></p>

<div class="bf-grid">
  <section class="bf-col">
    ${secLabel(ICON.alert, "For now", "now-count")}
    <div id="now" class="bf-col"></div>
    <details id="later-wrap">
      <summary class="bf-defer">${svg(ICON.chevr)}
        <span class="bf-defer__t">Later &amp; agent follow-ups</span>
        <span class="bf-defer__n" id="later-count"></span>
      </summary>
      <div id="later" class="bf-col"></div>
      <button class="ax-btn ax-btn--sm" id="more-actions" hidden></button>
    </details>
  </section>
  <aside class="bf-col">
    ${secLabel(ICON.pulse, "In motion", "run-count")}
    <div id="running" class="bf-col"></div>
  </aside>
</div>

${secLabel(ICON.file, "Session briefings", "brief-count")}
<div class="bf-toolbar">
  <div class="bf-search">${svg(ICON.search)}
    <input id="search" type="search" placeholder="Search sessions&hellip;" aria-label="Search sessions">
  </div>
  <div class="bf-filters" id="filters" role="group" aria-label="Filter briefings"></div>
</div>
<div id="reviews" class="bf-col"></div>

<section class="ax-panel bf-connect">
  <div class="bf-connect__head">${svg(ICON.plug, 17)}<h2>Connect a CLI session</h2>
    <span class="bf-connect__note">Daemon-owned processes only</span></div>
  <div class="bf-discover">
    <div class="ax-field"><label for="node">Node</label><select id="node"></select></div>
    <button class="ax-btn" id="discover">${svg(ICON.search)} Discover CLIs</button>
  </div>
  <div class="bf-cli" id="discovered"></div>
  <details class="bf-manual">
    <summary>${svg(ICON.chev, 12)} Register manually</summary>
    <div class="bf-forms">
      <form id="register" class="bf-form">
        <div class="ax-sec-label"><h3>Register a session</h3></div>
        <div class="bf-form__row">
          <div class="ax-field"><label for="r-id">Session ID</label>
            <input id="r-id" name="id" required maxlength="200"></div>
          <div class="ax-field"><label for="r-rt">Runtime</label>
            <select id="r-rt" name="runtime"><option>claude</option><option>codex</option>
              <option>gemini</option><option>opencode</option><option>other</option></select></div>
        </div>
        <div class="ax-field"><label for="r-lb">Label</label>
          <input id="r-lb" name="label" required maxlength="200"></div>
        <button class="ax-btn ax-btn--primary">Register session</button>
      </form>
      <form id="ended" class="bf-form">
        <div class="ax-sec-label"><h3>Submit an ended run</h3></div>
        <div class="bf-form__row">
          <div class="ax-field"><label for="registered">Registered session</label>
            <select id="registered" name="sessionId" required></select></div>
          <div class="ax-field"><label for="e-run">Run ID</label>
            <input id="e-run" name="runId" required maxlength="200" placeholder="unique per turn"></div>
        </div>
        <div class="ax-field"><label for="e-tr">Run transcript</label>
          <textarea id="e-tr" name="transcript" required maxlength="100000" rows="3"
            placeholder="Last 90 KB is submitted"></textarea></div>
        <button class="ax-btn ax-btn--primary">Review ended run</button>
      </form>
    </div>
  </details>
</section>
</div>`,
    css: MONITOR_CSS,
    scripts: `<script>const fitCapacity = ${fitCapacity.toString()};const ICON = ${JSON.stringify(ICON)};${MONITOR_SCRIPT}</script>`,
  })
}

export const MONITOR_CSS = `
.bf{max-width:1240px;margin:0 auto;padding:22px 24px 48px}
.bf-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.bf :focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px;border-radius:4px}

/* Page head */
.bf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:16px}
.bf-kicker{display:inline-block;font-size:10px;letter-spacing:0.1em;color:var(--ax-muted);
  text-transform:uppercase;margin-bottom:6px;font-family:var(--ax-mono)}
.bf h1{font-size:22px;font-weight:600;letter-spacing:-0.015em;margin:0}
.bf-sync{display:flex;align-items:center;gap:12px;flex-shrink:0}
.bf-sync__t{font-size:11px;color:var(--ax-muted);font-family:var(--ax-mono);text-align:right;line-height:1.5}
.bf .ax-btn{display:inline-flex;align-items:center;gap:7px}
.bf .ax-btn--sm{padding:5px 12px;font-size:var(--ax-fs-sm);border-radius:var(--ax-radius-sm)}

/* Coverage counters */
.bf-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.bf-si--warn .ax-stat-inline__icon{background:color-mix(in oklch,var(--ax-warn) 14%,var(--ax-surface-2));color:var(--ax-warn)}
.bf-si--warn .ax-stat-inline__v{color:var(--ax-warn)}
.bf-si--err .ax-stat-inline__icon{background:color-mix(in oklch,var(--ax-err) 14%,var(--ax-surface-2));color:var(--ax-err)}
.bf-si--err .ax-stat-inline__v{color:var(--ax-err)}
#coverage-note:not(:empty){margin-bottom:16px}
.bf-callout--err{border-color:color-mix(in oklch,var(--ax-err) 30%,var(--ax-border));
  background:color-mix(in oklch,var(--ax-err) 5%,var(--ax-bg-elev))}
.bf-callout--err .ax-callout__icon{background:color-mix(in oklch,var(--ax-err) 18%,transparent);color:var(--ax-err)}

/* Capacity band */
.bf-cap{display:flex;align-items:center;gap:24px;flex-wrap:wrap;background:var(--ax-surface);
  border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-lg);
  padding:12px 18px;box-shadow:var(--ax-shadow);margin-bottom:14px}
.bf-cap__grp{display:flex;flex-direction:column;gap:6px}
.bf-cap__lbl{font-size:10px;color:var(--ax-muted);text-transform:uppercase;letter-spacing:0.08em;
  font-weight:600;font-family:var(--ax-mono)}
.bf-seg{display:flex;border:var(--ax-border-w) solid var(--ax-border-2);border-radius:var(--ax-radius);
  overflow:hidden;background:var(--ax-bg)}
.bf-seg button{background:transparent;border:none;border-right:1px solid var(--ax-border);
  color:var(--ax-text-2);font:inherit;font-size:var(--ax-fs-sm);font-weight:600;padding:5px 13px;
  cursor:pointer;white-space:nowrap}
.bf-seg button:last-child{border-right:none}
.bf-seg button:hover{color:var(--ax-text);background:var(--ax-surface-2)}
.bf-seg button.is-on{background:color-mix(in oklch,var(--ax-accent) 15%,var(--ax-surface));color:var(--ax-accent)}
.bf-budget{flex:1;min-width:200px;display:flex;flex-direction:column;gap:6px}
.bf-budget__row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.bf-budget__v{font-family:var(--ax-mono);font-size:var(--ax-fs-sm);color:var(--ax-text-2)}
.bf-budget__v b{color:var(--ax-text);font-weight:600}
.bf-meter{height:8px;border-radius:var(--ax-radius-pill);background:var(--ax-surface-3);
  border:1px solid var(--ax-border);overflow:hidden;display:flex}
.bf-meter__fill{background:var(--ax-accent);transition:width 160ms ease}
.bf-meter__fill.is-over{background:var(--ax-warn)}
#notice{margin:0 0 14px;font-size:12.5px;color:var(--ax-text-2)}
#notice:not(:empty){padding:9px 13px;border-radius:var(--ax-radius-sm);background:var(--ax-surface-2);
  border:var(--ax-border-w) solid var(--ax-border)}

/* Principals */
.bf-pr{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px}
.bf-pr__c{display:flex;flex-direction:column;gap:4px;text-align:left;font:inherit;cursor:pointer;
  background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);box-shadow:var(--ax-shadow);padding:11px 14px;color:var(--ax-text)}
.bf-pr__c:hover{background:var(--ax-surface-2)}
.bf-pr__c.is-on{border-color:var(--ax-accent);box-shadow:var(--ax-shadow-accent)}
.bf-pr__c--client{border-left:4px solid var(--ax-accent)}
.bf-pr__n{font-size:13.5px;font-weight:600;letter-spacing:-0.005em}
.bf-pr__k{font-size:10.5px;color:var(--ax-text-2);font-family:var(--ax-mono)}
.bf-pr__s{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--ax-text-2);margin-top:3px}
.bf-pr__s b{font-family:var(--ax-mono);font-size:17px;font-weight:600;color:var(--ax-text-2)}
.bf-pr__s b.bf-pr__you{color:var(--ax-err)}
.bf-pr__s i{font-style:normal}
.bf-pr__o{font-size:10.5px;color:var(--ax-text-2)}

/* Automation health */
.bf-wf{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);box-shadow:var(--ax-shadow);padding:12px 16px;margin-bottom:14px}
.bf-wf__h{display:flex;align-items:center;gap:9px;margin-bottom:9px}
.bf-wf__h h3{font-size:13px;font-weight:600;margin:0}
.bf-wf__lead{font-size:12px;color:var(--ax-err);font-weight:600}
.bf-wf__all{margin-left:auto;font-size:12px}
.bf-wf__list{display:flex;flex-direction:column;gap:2px}
.bf-wf__row{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:var(--ax-radius-sm);
  font-size:12.5px}
.bf-wf__row:hover{background:var(--ax-surface-2)}
.bf-wf__row b{font-weight:600;flex:none}
.bf-wf__st{font-size:11px;font-weight:600;padding:1px 8px;border-radius:var(--ax-radius-pill);
  border:1px solid var(--ax-border-2);background:var(--ax-surface-2);color:var(--ax-text-2);flex:none}
.bf-wf__meta{color:var(--ax-text-2);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf-wf__node{margin-left:auto;font-family:var(--ax-mono);font-size:10.5px;color:var(--ax-text-2);flex:none}
.wf--dormant{color:var(--ax-err)}
.wf--dormant .bf-wf__st{border-color:var(--ax-red-e);background:var(--ax-red-t);color:var(--ax-err)}
.wf--failing .bf-wf__st{border-color:var(--ax-amber-e);background:var(--ax-amber-t);color:var(--ax-text)}

/* Triage columns */
.bf-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:22px;
  align-items:flex-start;margin-bottom:24px}
.bf-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.bf .ax-sec-label h3{display:flex;align-items:center;gap:8px}
.ax-sec-label__n{font-family:var(--ax-mono);font-size:11px;padding:1px 7px;border-radius:var(--ax-radius);
  background:var(--ax-surface-3);color:var(--ax-text-2);letter-spacing:0}
.ax-sec-label__n:empty{display:none}

/* --- Identity: who, and where ------------------------------------------
   Every card leads with the agent avatar and a row of place tags, so the
   question "who did this, and where" is answered before any prose. */
.bf-id{display:flex;align-items:center;gap:11px;min-width:0}
.bf-id .ax-avatar{width:32px;height:32px;font-size:12px;text-transform:uppercase}
.bf-who{flex:1;min-width:0}
.bf-who__n{font-size:13.5px;font-weight:600;letter-spacing:-0.005em;display:flex;align-items:center;
  gap:7px;flex-wrap:wrap}
.bf-where{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:3px}
.bf-tag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-family:var(--ax-mono);
  color:var(--ax-muted);background:var(--ax-surface-2);border:1px solid var(--ax-border);
  border-radius:var(--ax-radius-pill);padding:1px 8px;line-height:16px;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.bf-tag{cursor:pointer;font-weight:600}
button.bf-tag:hover{border-color:var(--ax-accent);color:var(--ax-accent)}
button.bf-tag.is-on{background:color-mix(in oklch,var(--ax-accent) 14%,transparent);
  border-color:color-mix(in oklch,var(--ax-accent) 35%,transparent);color:var(--ax-accent)}
.bf-tag svg{flex-shrink:0}
.bf-time{font-size:10.5px;color:var(--ax-muted);font-family:var(--ax-mono);white-space:nowrap;
  align-self:flex-start;padding-top:2px}

/* --- Quick links: always visible, never buried in a disclosure --------- */
.bf-links{display:flex;gap:6px;flex-wrap:wrap}
.bf-lnk{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;
  padding:4px 10px;border-radius:var(--ax-radius-sm);border:var(--ax-border-w) solid var(--ax-border);
  background:var(--ax-surface-2);color:var(--ax-text-2);text-decoration:none;max-width:320px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf-lnk:hover{border-color:var(--ax-accent);color:var(--ax-accent);text-decoration:none}
.bf-lnk svg{flex-shrink:0;opacity:0.75}
.bf-lnk--go{color:var(--ax-accent);border-color:color-mix(in oklch,var(--ax-accent) 32%,var(--ax-border));
  background:color-mix(in oklch,var(--ax-accent) 8%,transparent)}

/* Action card */
.bf-act{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);padding:14px 16px;box-shadow:var(--ax-shadow);
  display:flex;flex-direction:column;gap:10px}
.bf-act--now{border-color:color-mix(in oklch,var(--ax-warn) 34%,var(--ax-border))}
.bf-act__cost{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ax-text-2);
  font-family:var(--ax-mono)}
.bf-act__cost svg{color:var(--ax-muted)}
/* One job, re-derived by N session reviews. Marking it done clears all N. */
.bf-dupe{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;
  padding:2px 9px;border-radius:var(--ax-radius-pill);color:var(--ax-red);
  background:color-mix(in oklch,var(--ax-err) 8%,var(--ax-surface));
  border:1px solid color-mix(in oklch,var(--ax-err) 30%,var(--ax-border))}
.bf-eff{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ax-muted)}
.bf-eff i{width:4px;height:10px;border-radius:1px;background:var(--ax-border-2);display:block}
.bf-eff--low i:nth-child(1),.bf-eff--medium i:nth-child(-n+2),.bf-eff--high i{background:var(--ax-text-2)}
.bf-act__text{font-size:var(--ax-fs);line-height:1.55;color:var(--ax-text);overflow-wrap:anywhere;margin:0}
.bf-act__foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bf-why{margin-top:2px}
.bf-why summary{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ax-muted);
  cursor:pointer;list-style:none;font-weight:600}
.bf-why summary::-webkit-details-marker{display:none}
.bf-why[open] summary svg{transform:rotate(180deg)}
.bf-ev{margin:8px 0 0;font-size:12px;line-height:1.6;color:var(--ax-text-2);
  border-left:2px solid var(--ax-border-2);padding-left:12px;overflow-wrap:anywhere}

/* Deferred band */
#later-wrap{border:none;padding:0}
#later-wrap>summary{list-style:none}
#later-wrap>summary::-webkit-details-marker{display:none}
#later-wrap[open]>summary svg{transform:rotate(90deg)}
.bf-defer{background:var(--ax-surface-2);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);padding:12px 16px;display:flex;align-items:center;gap:10px;
  flex-wrap:wrap;cursor:pointer}
.bf-defer:hover{border-color:var(--ax-border-2)}
.bf-defer__t{font-size:var(--ax-fs-sm);font-weight:600;color:var(--ax-text-2)}
.bf-defer__n{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bf-defer svg{color:var(--ax-muted);transition:transform 140ms ease}
#later{margin-top:10px}
#more-actions{align-self:flex-start;margin-top:10px}

/* In motion */
.bf-run{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-sm);padding:11px 13px;display:flex;flex-direction:column;gap:8px}
.bf-run__dot{width:7px;height:7px;border-radius:50%;background:var(--ax-accent);flex-shrink:0;
  box-shadow:0 0 0 3px color-mix(in oklch,var(--ax-accent) 18%,transparent)}
.bf-run__msg{font-size:12.5px;line-height:1.5;color:var(--ax-text-2);margin:0;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}

/* Briefings toolbar + filters */
.bf-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.bf-search{position:relative;flex:0 1 300px}
.bf-search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--ax-muted);
  pointer-events:none}
.bf-search input{width:100%;background:var(--ax-surface);color:var(--ax-text);
  border:var(--ax-border-w) solid var(--ax-border-2);border-radius:var(--ax-radius);
  padding:8px 14px 8px 34px;font:inherit;font-size:var(--ax-fs-sm)}
.bf-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.bf-filter{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;
  padding:5px 11px;border-radius:var(--ax-radius-pill);border:var(--ax-border-w) solid var(--ax-border);
  background:var(--ax-surface);color:var(--ax-text-2);cursor:pointer;font-family:inherit}
.bf-filter:hover{border-color:var(--ax-border-2);color:var(--ax-text)}
.bf-filter.is-on{background:color-mix(in oklch,var(--ax-accent) 14%,var(--ax-surface));
  border-color:color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border));color:var(--ax-accent)}
.bf-filter__n{font-family:var(--ax-mono);font-size:10px;opacity:0.8}
.bf-filter--clear{color:var(--ax-muted);border-style:dashed}

/* Briefing card */
.bf-brief{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);padding:14px 16px;box-shadow:var(--ax-shadow);
  display:flex;flex-direction:column;gap:10px}
.bf-brief--failed{border-color:color-mix(in oklch,var(--ax-err) 30%,var(--ax-border))}
.bf-brief__top{display:flex;align-items:flex-start;gap:10px}
.bf-brief__sum{font-size:13px;line-height:1.6;color:var(--ax-text);margin:0;overflow-wrap:anywhere}
.bf-brief__fail{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.bf-brief__fail .bf-brief__sum{flex:1;min-width:220px;color:var(--ax-text-2)}

/* Finding chips */
.bf-finds{display:flex;gap:6px;flex-wrap:wrap}
.bf-find{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 9px;
  border-radius:var(--ax-radius-pill);border:var(--ax-border-w) solid var(--ax-border);
  background:var(--ax-surface-2);color:var(--ax-muted)}
.bf-find--warn{color:var(--ax-warn);background:color-mix(in oklch,var(--ax-warn) 12%,transparent);
  border-color:color-mix(in oklch,var(--ax-warn) 32%,transparent)}
.bf-find--info{color:var(--ax-info);background:color-mix(in oklch,var(--ax-info) 12%,transparent);
  border-color:color-mix(in oklch,var(--ax-info) 32%,transparent)}
.bf-find--zero{display:none}
.bf-brief details>summary{cursor:pointer;font-size:11.5px;color:var(--ax-muted);font-weight:600;
  list-style:none;display:inline-flex;align-items:center;gap:5px}
.bf-brief details>summary::-webkit-details-marker{display:none}
.bf-brief details[open]>summary svg{transform:rotate(180deg)}
.bf-detail{border-top:1px dashed var(--ax-border);margin-top:10px;padding-top:12px;
  display:flex;flex-direction:column;gap:13px}
.bf-fgroup h4{margin:0 0 7px;font-size:10.5px;font-family:var(--ax-mono);text-transform:uppercase;
  letter-spacing:0.06em;color:var(--ax-muted);font-weight:600;display:flex;align-items:center;gap:6px}
.bf-fgroup--warn h4{color:var(--ax-warn)}
.bf-fgroup--info h4{color:var(--ax-info)}
.bf-item{display:flex;flex-direction:column;gap:4px;padding-bottom:9px}
.bf-item>p{font-size:12.5px;line-height:1.55;color:var(--ax-text);margin:0;overflow-wrap:anywhere}

/* Inline trace panel — a readable summary in place, not a JSON tab */
.bf-trace{border:var(--ax-border-w) solid var(--ax-border);border-radius:var(--ax-radius-sm);
  background:var(--ax-surface-2);padding:8px 12px}
.bf-trace>summary{cursor:pointer;font-size:11.5px;color:var(--ax-text-2);font-weight:600;
  list-style:none;display:inline-flex;align-items:center;gap:6px}
.bf-trace>summary::-webkit-details-marker{display:none}
.bf-trace>summary:hover{color:var(--ax-accent)}
.bf-trace[open]>summary{margin-bottom:10px}
.bf-trace__body{font-size:12px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.bf-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;margin:0;width:100%}
.bf-kv dt{font-family:var(--ax-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:0.06em;
  color:var(--ax-muted);align-self:center}
.bf-kv dd{margin:0;font-size:12.5px;color:var(--ax-text);overflow-wrap:anywhere}

.bf-tool{display:inline-flex;align-items:center;gap:4px;font-family:var(--ax-mono);font-size:11px;
  background:var(--ax-surface-3);border-radius:var(--ax-radius-sm);padding:1px 7px;margin-right:4px}

/* Connect a CLI session */
.bf-connect{margin-top:24px}
.bf-connect__head{display:flex;align-items:center;gap:11px;margin-bottom:14px}
.bf-connect h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-0.01em}
.bf-connect__note{margin-left:auto;font-size:10.5px;color:var(--ax-muted);font-family:var(--ax-mono)}
.bf-discover{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.bf-discover .ax-field{min-width:220px;flex:0 1 300px}
.bf-cli{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.bf-cli:not(:empty){margin-bottom:14px}
.bf-cli-card{background:var(--ax-surface-2);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-sm);padding:12px 13px;display:flex;flex-direction:column;gap:9px}
.bf-cli-card__top{display:flex;align-items:center;gap:10px;min-width:0}
.bf-cli-card__n{font-size:13px;font-weight:600}
.bf-cli-card__m{font-size:10.5px;color:var(--ax-muted);font-family:var(--ax-mono);margin-top:2px;
  overflow-wrap:anywhere}
.bf-cli-card .ax-btn{justify-content:center}
.bf-manual>summary{cursor:pointer;font-size:12px;color:var(--ax-muted);font-weight:600;list-style:none;
  display:inline-flex;align-items:center;gap:6px}
.bf-manual>summary::-webkit-details-marker{display:none}
.bf-manual[open]>summary svg{transform:rotate(180deg)}
.bf-forms{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:14px}
.bf-form{display:flex;flex-direction:column;gap:12px}
.bf-form .ax-sec-label{margin:0}
.bf-form__row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bf-form .ax-btn{align-self:flex-start}

/* Empty + loading */
.bf-empty{text-align:center;padding:30px 22px;background:var(--ax-surface);
  border:var(--ax-border-w) dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);
  color:var(--ax-muted);display:flex;flex-direction:column;align-items:center;gap:7px}
.bf-empty svg{color:var(--ax-border-2)}
.bf-empty h4{margin:0;color:var(--ax-text);font-size:14px;font-weight:600}
.bf-empty p{font-size:12.5px;line-height:1.55;max-width:380px;margin:0}
.bf-skel{background:var(--ax-surface);border:var(--ax-border-w) solid var(--ax-border);
  border-radius:var(--ax-radius-lg);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.bf-bar{display:block;height:10px;border-radius:var(--ax-radius-pill);background:var(--ax-surface-3);
  animation:bf-pulse 1.4s ease-in-out infinite}
@keyframes bf-pulse{0%,100%{opacity:1}50%{opacity:0.45}}
@media (prefers-reduced-motion:reduce){.bf-bar{animation:none}.bf-meter__fill{transition:none}}

@media(max-width:980px){
  .bf-grid{grid-template-columns:1fr}
  .bf-forms{grid-template-columns:1fr}
  .bf-strip{grid-template-columns:1fr 1fr}
}
@media(max-width:600px){
  .bf{padding:16px 14px 36px}
  .bf-head{flex-direction:column;gap:14px;align-items:stretch}
  .bf-sync{justify-content:space-between}
  .bf-cap{flex-direction:column;align-items:stretch;gap:14px}
  .bf-seg{width:100%}
  .bf-seg button{flex:1;min-height:44px;padding:6px 8px}
  .bf-act__foot .ax-btn{flex:1;justify-content:center;min-height:44px}
  .bf-form__row{grid-template-columns:1fr}
  .bf-search{flex:1 1 100%}
  .bf-lnk{max-width:100%}
}`

export const MONITOR_SCRIPT = String.raw`
(function(){
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ic=(n,s)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="'+(s||14)+'" height="'+(s||14)+'" aria-hidden="true">'+ICON[n]+'</svg>';
let nodes=[], actions=[], busy=false, expandedActions=false;
let minutes='15', focus='medium';
let filter={kind:'all',agent:null,node:null};
try{const p=JSON.parse(localStorage.getItem('ax-monitor-capacity')||'{}');if(p.minutes)minutes=String(p.minutes);if(p.focus)focus=String(p.focus);}catch{}
function paintSeg(id,value){for(const b of $(id).children){const on=b.dataset.value===value;b.classList.toggle('is-on',on);b.setAttribute('aria-checked',String(on));}}
paintSeg('minutes',minutes);paintSeg('focus',focus);
async function api(op,node,body){const r=await fetch('/api/monitor/'+op+'?node='+encodeURIComponent(node),{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
function message(s){$('notice').textContent=s;}
let clientFilter='';
function save(){try{localStorage.setItem('ax-monitor-capacity',JSON.stringify({minutes,focus}));}catch{}renderActions();}

/* --- Who and where ------------------------------------------------------
   session_id is "<agent>:<channel>:<target>" for trace-sourced reviews, e.g.
   "hasanah-coding:gitlab:hasanah-lab/hasanah-v1:issue:94". Native CLI session
   ids carry no place, so the tags simply fall away. */
const CHANNEL_ICON={gitlab:'branch',github:'branch',telegram:'send',whatsapp:'msg',discord:'msg',slack:'hash',api:'code',cron:'clock',mesh:'route'};
function place(sessionId){
const parts=String(sessionId||'').split(':');
if(parts.length<3)return null;
const channel=parts[1];
let target=parts.slice(2).join(':')
  .replace(/:issue:/,' #').replace(/:mr:/,' !').replace(/:pr:/,' #').replace(/:/g,' · ');
return {channel:channel,target:target};
}
function initials(name){const w=String(name||'?').split(/[-_\s.]+/).filter(Boolean);return ((w[0]||'?')[0]+(w[1]?w[1][0]:(w[0]||'?')[1]||'')).slice(0,2);}
const AV=['blue','teal','amber','coral'];
function avatarClass(name){let h=0;for(const c of String(name||'')) h=(h*31+c.charCodeAt(0))>>>0;return AV[h%AV.length];}
function tag(icon,text,attrs){return '<'+(attrs?'button type="button" '+attrs:'span')+' class="bf-tag">'+(icon?ic(icon,11):'')+esc(text)+'</'+(attrs?'button':'span')+'>';}
function idBlock(agent,nodeName,nodeUrl,sessionId,model,when,whenExact){
const p=place(sessionId);
const on=(k,v)=>filter[k]===v?' is-on':'';
return '<div class="bf-id"><div class="ax-avatar ax-avatar--'+avatarClass(agent)+'">'+esc(initials(agent))+'</div>'
 +'<div class="bf-who"><div class="bf-who__n">'
 +'<button type="button" class="bf-tag'+on('agent',agent)+'" data-fagent="'+esc(agent)+'" style="font-size:13.5px;font-family:inherit;background:none;border:none;padding:0;color:inherit">'+esc(agent)+'</button>'
 +(model?'<span class="ax-badge ax-badge--mono">'+esc(model)+'</span>':'')+'</div>'
 +'<div class="bf-where">'
 +'<button type="button" class="bf-tag'+on('node',nodeName)+'" data-fnode="'+esc(nodeName)+'" title="Filter by node">'+ic('server',11)+esc(nodeName)+'</button>'
 +(p?tag(CHANNEL_ICON[p.channel]||'hash',p.channel):'')
 +(p&&p.target?tag('',p.target):'')
 +'</div></div>'
 +(when?'<span class="bf-time" title="'+esc(whenExact||'')+'">'+esc(when)+'</span>':'')+'</div>';
}
function lnk(href,icon,text,go){return '<a class="bf-lnk'+(go?' bf-lnk--go':'')+'" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer" title="'+esc(text)+'">'+ic(icon,12)+esc(text)+'</a>';}
/* Human-friendly time. Relative on the face, exact on hover. */
function relTime(ms){
if(!ms)return '';
const d=Math.round((Date.now()-ms)/1000);
if(d<45)return 'just now';
if(d<90)return 'a minute ago';
const m=Math.round(d/60);
if(m<60)return m+' min ago';
const h=Math.round(m/60);
if(h<24)return h===1?'an hour ago':h+' hours ago';
const day=Math.round(h/24);
if(day===1)return 'yesterday';
if(day<7)return day+' days ago';
return new Date(ms).toLocaleDateString([], {month:'short',day:'numeric'});
}
function absTime(ms){return ms?new Date(ms).toLocaleString():'';}
function fmtDur(ms){
if(ms==null)return '';
if(ms<1000)return ms+' ms';
const s=Math.round(ms/1000);
if(s<60)return s+' s';
const m=Math.floor(s/60),r=s%60;
if(m<60)return m+'m'+(r?' '+r+'s':'');
const h=Math.floor(m/60);
return h+'h'+(m%60?' '+(m%60)+'m':'');
}
function tracePanel(nodeUrl,taskId){
return '<details class="bf-trace" data-node="'+esc(nodeUrl)+'" data-task="'+esc(taskId)+'">'
 +'<summary>'+ic('trace',12)+'Trace</summary>'
 +'<div class="bf-trace__body"><span class="ax-muted">Loading&hellip;</span></div></details>';
}
function renderTrace(el,d){
if(!d||d.found===false)return '<span class="ax-muted">No trace stored for this run.</span>';
const kv=[];
const add=(k,v)=>{if(v!==''&&v!=null)kv.push('<dt>'+k+'</dt><dd>'+v+'</dd>');};
add('Status','<span class="ax-pill ax-pill--'+(d.status==='ok'?'ok':d.status==='error'?'err':'off')+'"><span class="ax-pill__dot"></span>'+esc(d.status||'unknown')+'</span>');
add('Agent',esc(d.agent||''));
if(d.channel)add('Where',esc(d.channel)+(d.chatId?' &middot; '+esc(String(d.chatId).replace(/:issue:/,' #').replace(/:mr:/,' !')):''));
add('Started',d.startedAt?'<span title="'+esc(absTime(d.startedAt))+'">'+esc(relTime(d.startedAt))+'</span>':'');
add('Took',d.durationMs!=null?esc(fmtDur(d.durationMs)):'');
if(d.model)add('Model',esc(d.model));
if(d.cause)add('Cause',esc(d.cause));
// Counters are derived from steps; pruned traces report zeros that mean
// "unknown", not "none". Say so rather than showing a wall of 0s.
if(d.stepsPruned)kv.push('<dt>Detail</dt><dd class="ax-muted">Step detail was pruned &mdash; tool, token and I/O counters are no longer available.</dd>');
else{
 add('Steps',String((d.steps||[]).length));
 if(d.tools&&d.tools.length)add('Tools',d.tools.map(t=>{
  const name=esc(typeof t==='string'?t:(t.tool||t.name||'tool'));
  const used=(t&&t.used>1)?' &times;'+t.used:'';
  const failed=(t&&t.failed)?' <span class="ax-pill ax-pill--err" style="padding:0 5px">'+t.failed+' failed</span>':'';
  return '<span class="bf-tool">'+name+used+failed+'</span>';
 }).join(' '));
 if(d.outputTokens)add('Output tokens',String(d.outputTokens));
 const io=[d.reads?d.reads+' read':'',d.writes?d.writes+' write':'',d.sends?d.sends+' send':''].filter(Boolean).join(' &middot; ');
 if(io)add('I/O',io);
}
return '<dl class="bf-kv">'+kv.join('')+'</dl>'
 +'<a class="bf-lnk" href="/api/mesh/run?node='+encodeURIComponent(el.dataset.node)+'&task='+encodeURIComponent(el.dataset.task)+'" target="_blank" rel="noopener noreferrer">'+ic('ext',12)+'Raw JSON</a>';
}
/* The human task page, not the raw JSON endpoint. archived=1 reads the stored
   record; a live task streams instead. Falls back to the JSON API only when no
   agent can be resolved, because /tasks refuses a request without one. */
function taskHref(nodeUrl,taskId,agentId,archived){
return agentId
 ?'/tasks/'+encodeURIComponent(taskId)+'?agent='+encodeURIComponent(agentId)+'&node='+encodeURIComponent(nodeUrl)+(archived?'&archived=1':'')
 :'/api/mesh/run?node='+encodeURIComponent(nodeUrl)+'&task='+encodeURIComponent(taskId);
}
/* A related task usually has its own review (or is still running); either one
   tells us which agent owns it. */
function ownerOf(n,taskId){
const run=(n.data.running||[]).find(t=>t.taskId===taskId);
if(run)return run.agentId;
const rev=(n.data.reviews||[]).find(r=>r.id===taskId);
return rev?rev.agent:'';
}

/* --- Loading skeleton --------------------------------------------------- */
function skeleton(){
const bar=w=>'<i class="bf-bar" style="width:'+w+'"></i>';
const card='<div class="bf-skel">'+bar('40%')+bar('100%')+bar('64%')+'</div>';
$('strip').innerHTML=('<div class="ax-stat-inline"><div class="ax-stat-inline__icon"></div>'
 +'<div class="bf-skel" style="flex:1;gap:6px">'+bar('46px')+bar('76px')+'</div></div>').repeat(4);
$('now').innerHTML=card+card;$('reviews').innerHTML=card;$('running').innerHTML=card;
}

/* --- Coverage ----------------------------------------------------------- */
function si(icon,value,label,kind){return '<div class="ax-stat-inline'+(kind?' bf-si--'+kind:'')+'"><div class="ax-stat-inline__icon">'+ic(icon,14)+'</div><div style="min-width:0"><div class="ax-stat-inline__v">'+esc(value)+'</div><div class="ax-stat-inline__l">'+esc(label)+'</div></div></div>';}
function renderCoverage(){
const ok=nodes.filter(n=>n.ok), failed=nodes.filter(n=>!n.ok);
const reviews=ok.reduce((a,n)=>a+(n.data.reviews||[]).length,0);
const queue=ok.flatMap(n=>n.data.counts||[]);
const waiting=queue.filter(c=>c.status==='pending'||c.status==='reviewing').reduce((a,c)=>a+c.count,0);
const failures=queue.filter(c=>c.status==='failed').reduce((a,c)=>a+c.count,0);
$('strip').innerHTML=si('server',ok.length+' / '+nodes.length,'Nodes reporting',failed.length?'warn':'')
 +si('inbox',String(waiting),'Awaiting review')
 +si('cross',String(failures),failures===1?'Review failed':'Reviews failed',failures?'err':'')
 +si('file',String(reviews),'Recent briefings');
$('coverage').textContent=reviews+' recent reviews, '+waiting+' awaiting review'+(failures?', '+failures+' review failures':'')+', '+ok.length+' of '+nodes.length+' nodes reporting'+(failed.length?'. Unavailable: '+failed.map(n=>n.name+' ('+n.error+')').join(', '):'');
$('coverage-note').innerHTML=failed.length
 ?'<div class="ax-callout'+(ok.length?'':' bf-callout--err')+'"><span class="ax-callout__icon">!</span><div><b>'
  +esc(failed.map(n=>n.name).join(', '))+'</b> not reporting &mdash; '
  +failed.map(n=>'<code>'+esc(n.error)+'</code>').join(' ')+'</div></div>':'';
}

/* --- Actions ------------------------------------------------------------ */
function card(a,i,later){
const pill=a.needsHuman
 ?'<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>Needs you</span>'
 :'<span class="ax-pill ax-pill--info"><span class="ax-pill__dot"></span>Agent</span>';
const done='<button class="ax-btn ax-btn--sm ax-btn--primary" data-action="done" data-index="'+i+'">'+ic('check',13)+' Done</button>';
const foot=later
 ?done+'<button class="ax-btn ax-btn--sm ax-btn--ghost" data-action="open" data-index="'+i+'">Bring back</button>'
 :done+'<button class="ax-btn ax-btn--sm ax-btn--ghost" data-action="later" data-index="'+i+'">Later</button>';
const src=a.sources[0];
const links=(src && !String(src.reviewId).startsWith('external:'))?tracePanel(src.node,src.reviewId):'';
return '<article class="bf-act'+(!later&&a.when==='now'&&a.needsHuman?' bf-act--now':'')+'">'
 +idBlock(a.agent,a.nodes.join(' / '),src?src.node:'',a.sessionId,'',relTime(a.updatedAt),absTime(a.updatedAt))
 +'<p class="bf-act__text">'+esc(a.text)+'</p>'
 +'<div class="bf-links">'+pill
 +(a.sources.length>1?'<span class="bf-dupe" title="Re-derived by this many session reviews">'+ic('loop',12)+'seen '+a.sources.length+'&times;</span>':'')
 +'<span class="bf-act__cost">'+ic('clock',12)+'~'+esc(a.minutes)+' min</span>'
 +'<span class="bf-eff bf-eff--'+esc(a.effort)+'"><i></i><i></i><i></i>'+esc(a.effort)+'</span></div>'
 +links
 +'<div class="bf-act__foot">'+foot+'</div>'
 +(a.evidence?'<details class="bf-why"><summary>'+ic('chev',12)+'Evidence</summary><p class="bf-ev">'+esc(a.evidence)+'</p></details>':'')
 +'</article>';
}
/* --- Principals ---------------------------------------------------------- */
/* Who the work is for. Clients are derived from business.projects and
   business.contactMap, so this fills itself in; it is only empty when no
   project or contact has ever been configured. Clicking one filters the
   action list — the fastest way to answer "what does this client need". */
const KIND_LABEL={client:'client',own:'own product',internal:'internal'};
function renderPrincipals(){
const policy={};
for(const n of nodes.filter(n=>n.ok))for(const c of n.data.clients||[])policy[c.id]=c;
const by={};
for(const a of actions){
 const id=a.clientId||'unmapped';
 const g=by[id]||(by[id]={id:id,you:0,agents:0,oldest:0});
 if(a.needsHuman)g.you++;else g.agents++;
 if(a.updatedAt&&(!g.oldest||a.updatedAt<g.oldest))g.oldest=a.updatedAt;
}
const rows=Object.values(by).sort((x,y)=>y.you-x.you||y.agents-x.agents);
if(!rows.length){$('principals').innerHTML='';return;}
$('principals').innerHTML='<section class="bf-pr" aria-label="Who the work is for">'
 +rows.map(g=>{
  const p=policy[g.id]||{name:g.id,kind:'internal',declared:false};
  const on=clientFilter===g.id;
  return '<button class="bf-pr__c'+(on?' is-on':'')+(p.kind==='client'?' bf-pr__c--client':'')+'"'
   +' data-client="'+esc(g.id)+'" aria-pressed="'+(on?'true':'false')+'">'
   +'<span class="bf-pr__n">'+esc(p.name||g.id)+'</span>'
   +'<span class="bf-pr__k">'+esc(KIND_LABEL[p.kind]||'internal')+(p.respondWithinMinutes?' &middot; '+p.respondWithinMinutes+'m clock':'')+'</span>'
   +'<span class="bf-pr__s"><b class="'+(g.you?'bf-pr__you':'')+'">'+g.you+'</b> on you'
   +'<i>'+g.agents+' on agents</i></span>'
   +(g.oldest?'<span class="bf-pr__o">oldest '+relTime(g.oldest)+'</span>':'')
   +'</button>';
 }).join('')+'</section>';
$('principals').querySelectorAll('[data-client]').forEach(b=>b.onclick=()=>{
 clientFilter=clientFilter===b.dataset.client?'':b.dataset.client;renderPrincipals();renderActions();});
}

/* --- Automation health -------------------------------------------------- */
/* A workflow that stops firing reports nothing anywhere else in the product,
   so absence is what this renders. Healthy and never-run workflows are not
   shown at all — the block disappears when there is nothing to say. */
const WF_STATE={dormant:['stopped firing','alert','wf--dormant'],failing:['failing','alert','wf--failing'],
 active:['running','check','wf--active'],quiet:['idle','clock','wf--quiet'],never:['never run','clock','wf--quiet']};
function renderAutomation(){
const rows=[];
for(const n of nodes.filter(n=>n.ok))for(const w of n.data.workflows||[])
 if(w.state==='dormant'||w.state==='failing'||w.paused>0)rows.push({...w,node:n.name});
if(!rows.length){$('automation').innerHTML='';return;}
const stopped=rows.filter(w=>w.state==='dormant').length,broken=rows.filter(w=>w.state==='failing').length;
const lead=[stopped?stopped+' stopped firing':'',broken?broken+' failing':''].filter(Boolean).join(' &middot; ');
$('automation').innerHTML='<section class="bf-wf" aria-label="Automation health">'
 +'<div class="bf-wf__h">'+ic('route',14)+'<h3>Automation</h3>'
 +'<span class="bf-wf__lead">'+lead+'</span>'
 +'<a class="bf-wf__all" href="/workflows">All workflows</a></div>'
 +'<div class="bf-wf__list">'+rows.map(w=>{
   const [label,icon,cls]=WF_STATE[w.state]||WF_STATE.quiet;
   const when=w.lastRunAt?'last run '+relTime(w.lastRunAt):'never run';
   const was=w.state==='dormant'?' &middot; '+w.prior+' in the week before':'';
   const bad=w.failed?' &middot; '+w.failed+' failed':'';
   const held=w.paused?' &middot; '+w.paused+' waiting on a human':'';
   return '<div class="bf-wf__row '+cls+'">'+ic(icon,13)
    +'<b>'+esc(w.name)+'</b>'
    +'<span class="bf-wf__st">'+label+'</span>'
    +'<span class="bf-wf__meta">'+esc(when)+was+bad+held+'</span>'
    +'<span class="bf-wf__node">'+esc(w.node)+'</span></div>';
 }).join('')+'</div></section>';
}

function renderActions(){
const merged=new Map();
for(const n of nodes.filter(n=>n.ok))for(const entry of n.data.actions?.items||[]){
const a=entry.action,saved=entry.state;const key=entry.key||JSON.stringify([n.url,entry.sessionId,a.text.toLowerCase().replace(/\s+/g,' ').trim()]);const source={node:n.url,reviewId:entry.reviewId,index:entry.actionIndex};
if(merged.has(key)){const m=merged.get(key);m.sources.push(source);if(!m.nodes.includes(n.name))m.nodes.push(n.name);if(saved==='open'&&a.when==='now')m.when='now';if(entry.updatedAt>m.updatedAt){m.updatedAt=entry.updatedAt;m.text=a.text;m.evidence=a.evidence;}}
else merged.set(key,{...a,when:saved==='later'?'later':a.when,sources:[source],nodes:[n.name],agent:entry.agent,sessionId:entry.sessionId,updatedAt:entry.updatedAt,clientId:entry.clientId});
}
const unloaded=nodes.filter(n=>n.ok).reduce((s,n)=>s+Math.max(0,(n.data.actions?.total||0)-(n.data.actions?.items.length||0)),0);
$('more-actions').hidden=!unloaded;$('more-actions').textContent='Load '+unloaded+' older';
actions=[...merged.values()];
const shown=clientFilter?actions.filter(a=>(a.clientId||'unmapped')===clientFilter):actions;
const budget=Number(minutes)||15;
const fitted=fitCapacity(shown,budget,focus);
const idx=a=>actions.indexOf(a);
const now=fitted.selected.map(i=>card(shown[i],idx(shown[i]),false)),later=fitted.deferred.map(i=>card(shown[i],idx(shown[i]),true));
$('now').innerHTML=now.join('')||'<div class="bf-empty">'+ic('check',22)+'<h4>Nothing needs you in '+budget+' minutes</h4><p>Raise the budget to see deferred work, or go back to your own.</p></div>';
$('now-count').textContent=now.length?String(now.length):'';
const pct=budget>0?Math.min(100,Math.round(fitted.usedMinutes/budget*100)):0;
$('meter').style.width=pct+'%';
$('meter').className='bf-meter__fill'+(fitted.urgentDeferred?' is-over':'');
$('budget').innerHTML='<b>'+fitted.usedMinutes+'</b> of '+budget+' min &middot; '+now.length+' action'+(now.length===1?'':'s');
$('later-count').innerHTML=(fitted.urgentDeferred?'<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>'+fitted.urgentDeferred+' urgent</span>':'')
 +'<span class="ax-pill ax-pill--off">'+later.length+' waiting</span>'
 +(unloaded?'<span class="ax-pill ax-pill--off">'+unloaded+' not loaded</span>':'');
$('later').innerHTML=later.join('')||'<div class="bf-empty">'+ic('check',22)+'<h4>Nothing waiting</h4><p>No deferred actions or agent follow-ups.</p></div>';
}

/* --- Session briefings + filters ---------------------------------------- */
const GROUPS=[['warnings','Warnings','alert','warn'],['decisions','Decisions on your behalf','gavel','info'],['friction','Avoidable round trips','loop',''],['context','Context maintenance','broom','']];
function chip(n,icon,kind,one,many){return '<span class="bf-find '+(n?'bf-find--'+kind:'bf-find--zero')+'">'+ic(icon,12)+(n?n+' '+(n===1?one:many):'no '+many)+'</span>';}
function rows(){return nodes.filter(n=>n.ok).flatMap(n=>(n.data.reviews||[]).map(r=>({n:n,r:r})));}
function passes(e,ignoreKind){
const r=e.r,v=r.result;
if(filter.agent&&r.agent!==filter.agent)return false;
if(filter.node&&e.n.name!==filter.node)return false;
if(!ignoreKind){
 if(filter.kind==='failed'&&r.status!=='failed')return false;
 if(filter.kind==='warn'&&!(v&&v.warnings.length))return false;
 if(filter.kind==='needs'&&!(v&&v.actions.some(a=>a.needsHuman)))return false;
}
const q=$('search').value.toLowerCase();
return !q||JSON.stringify(r).toLowerCase().includes(q);
}
function renderFilters(){
const base=rows().filter(e=>passes(e,true));
const counts={all:base.length,
 needs:base.filter(e=>e.r.result&&e.r.result.actions.some(a=>a.needsHuman)).length,
 warn:base.filter(e=>e.r.result&&e.r.result.warnings.length).length,
 failed:base.filter(e=>e.r.status==='failed').length};
const defs=[['all','file','All'],['needs','alert','Needs you'],['warn','alert','Warnings'],['failed','cross','Failed']];
let html=defs.map(([k,icon,label])=>'<button type="button" class="bf-filter'+(filter.kind===k?' is-on':'')+'" data-fkind="'+k+'">'+ic(icon,12)+esc(label)+'<span class="bf-filter__n">'+counts[k]+'</span></button>').join('');
if(filter.agent)html+='<button type="button" class="bf-filter is-on" data-fagent="'+esc(filter.agent)+'">'+ic('hash',12)+esc(filter.agent)+ic('x',11)+'</button>';
if(filter.node)html+='<button type="button" class="bf-filter is-on" data-fnode="'+esc(filter.node)+'">'+ic('server',12)+esc(filter.node)+ic('x',11)+'</button>';
if(filter.kind!=='all'||filter.agent||filter.node)html+='<button type="button" class="bf-filter bf-filter--clear" data-fclear="1">'+ic('x',12)+'Clear</button>';
$('filters').innerHTML=html;
}
function renderReviews(){
renderFilters();
const entries=rows().filter(e=>passes(e,false)).sort((a,b)=>b.r.updated_at-a.r.updated_at).map(e=>{
const n=e.n,r=e.r,v=r.result;
const head=idBlock(r.agent,n.name,n.url,r.session_id,r.model,relTime(r.updated_at),absTime(r.updated_at));
if(r.status==='failed')return '<article class="bf-brief bf-brief--failed">'+head
 +'<div class="bf-brief__fail"><span class="ax-badge ax-badge--err">Review failed</span>'
 +'<p class="bf-brief__sum">'+esc(r.error||'Review failed')+'</p>'
 +'<button class="ax-btn ax-btn--sm" data-retry="'+esc(r.id)+'" data-node="'+esc(n.url)+'">Retry</button></div></article>';
let html='<article class="bf-brief">'+head+'<p class="bf-brief__sum">'+esc(v?v.summary:'Review '+r.status+'…')+'</p>';
// Quick access: every link the review produced, plus the trace it came from.
let links=v?v.links.filter(l=>/^https?:\/\//i.test(l.url)||/^\/(?!\/)/.test(l.url))
  .map(l=>lnk(l.url.startsWith('/')?n.url+l.url:l.url,'ext',l.label)).join(''):'';
if(v)links+=v.relatedTaskIds.map(id=>lnk(taskHref(n.url,id,ownerOf(n,id),true),'route','Related '+String(id).slice(-6))).join('');

if(links)html+='<div class="bf-links">'+links+'</div>';
if(r.source==='trace')html+=tracePanel(n.url,r.id);
if(v){
html+='<div class="bf-finds">'+chip(v.warnings.length,'alert','warn','warning','warnings')
 +chip(v.decisions.length,'gavel','info','decision','decisions')
 +chip(v.friction.length,'loop','warn','round trip','round trips')
 +chip(v.context.length,'broom','info','context note','context notes')+'</div>';
const detail=GROUPS.filter(g=>v[g[0]].length).map(g=>'<div class="bf-fgroup'+(g[3]?' bf-fgroup--'+g[3]:'')+'"><h4>'+ic(g[2],13)+esc(g[1])+'</h4>'
 +v[g[0]].map(x=>'<div class="bf-item"><p>'+esc(x.text)+'</p><p class="bf-ev">'+esc(x.evidence)+'</p></div>').join('')+'</div>').join('');
if(detail)html+='<details><summary>'+ic('chev',12)+'Findings &amp; evidence</summary><div class="bf-detail">'+detail+'</div></details>';
}
return html+'</article>';});
$('brief-count').textContent=entries.length?String(entries.length):'';
$('reviews').innerHTML=(entries.slice(0,4).join('')+(entries.length>4?'<details><summary class="bf-defer">'+ic('chevr',14)+'<span class="bf-defer__t">'+(entries.length-4)+' earlier</span></summary><div class="bf-col" style="margin-top:10px">'+entries.slice(4).join('')+'</div></details>':''))
 ||'<div class="bf-empty">'+ic('file',22)+'<h4>Nothing here</h4><p>'+(filter.kind!=='all'||filter.agent||filter.node||$('search').value?'No briefing matches the current filter.':'Runs that finish from now on are reviewed and land here.')+'</p></div>';
}
function registrations(){const n=nodes.find(n=>n.url===$('node').value);$('registered').innerHTML=(n?.data?.registrations||[]).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.label)+' · '+esc(r.runtime)+'</option>').join('');}
function renderRunning(){
const list=nodes.filter(n=>n.ok).flatMap(n=>(n.data.running||[]).map(t=>'<div class="bf-run">'
 +idBlock(t.agentId,n.name,n.url,t.sessionId||'','','')
 +'<p class="bf-run__msg">'+esc(t.messagePreview||'Running task')+'</p>'
 +tracePanel(n.url,t.taskId)+'</div>'));
$('run-count').textContent=list.length?String(list.length):'';
$('running').innerHTML=list.join('')||'<div class="bf-empty">'+ic('pulse',22)+'<h4>Nothing running</h4><p>No active AgentX runs reported.</p></div>';
}
async function refresh(){
if(busy)return;busy=true;$('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');
try{
const r=await fetch('/api/monitor');if(!r.ok)throw Error('Briefing unavailable: HTTP '+r.status);
const data=await r.json();nodes=data.nodes;expandedActions=false;
renderCoverage();
const selected=$('node').value;
$('node').innerHTML=nodes.map(n=>'<option value="'+esc(n.url)+'">'+esc(n.name)+(n.ok?'':' — unavailable')+'</option>').join('');
if(nodes.some(n=>n.url===selected))$('node').value=selected;
registrations();renderAutomation();renderActions();renderPrincipals();renderReviews();renderRunning();
$('synced').textContent='Synced '+new Date().toLocaleTimeString();
message('');
}catch(e){$('synced').textContent='Refresh failed';message(e.message);}
finally{busy=false;$('refresh').disabled=false;$('refresh').removeAttribute('aria-busy');}
}
$('more-actions').onclick=async()=>{try{for(const n of nodes.filter(n=>n.ok&&n.data.actions.items.length<n.data.actions.total)){const r=await fetch('/api/monitor/actions?node='+encodeURIComponent(n.url)+'&offset='+n.data.actions.items.length);if(!r.ok)throw Error('Could not load older actions');const d=await r.json();n.data.actions.items.push(...d.items);n.data.actions.total=d.total;}expandedActions=true;renderActions();message('Older actions loaded. Auto-refresh paused until you press Refresh.');}catch(e){message(e.message);}};
for(const [id,set] of [['minutes',v=>minutes=v],['focus',v=>focus=v]])
$(id).addEventListener('click',e=>{const b=e.target.closest('button[data-value]');if(!b)return;set(b.dataset.value);paintSeg(id,b.dataset.value);save();});
$('search').oninput=renderReviews;$('refresh').onclick=refresh;$('node').onchange=registrations;
document.addEventListener('click',async e=>{
const tr=e.target.closest('.bf-trace>summary');
if(tr){
 const el=tr.parentElement;
 if(!el.dataset.loaded){
  el.dataset.loaded='1';
  const body=el.querySelector('.bf-trace__body');
  fetch('/api/mesh/run?node='+encodeURIComponent(el.dataset.node)+'&task='+encodeURIComponent(el.dataset.task))
   .then(r=>r.json()).then(d=>{body.innerHTML=renderTrace(el,d);})
   .catch(err=>{body.innerHTML='<span class="ax-muted">Could not load the trace: '+esc(err.message)+'</span>';el.dataset.loaded='';});
 }
 return;
}
const t=e.target.closest('[data-fkind],[data-fagent],[data-fnode],[data-fclear]');
if(t){
 if(t.dataset.fclear)filter={kind:'all',agent:null,node:null};
 else if(t.dataset.fkind)filter.kind=t.dataset.fkind;
 else if(t.dataset.fagent)filter.agent=filter.agent===t.dataset.fagent?null:t.dataset.fagent;
 else if(t.dataset.fnode)filter.node=filter.node===t.dataset.fnode?null:t.dataset.fnode;
 renderReviews();
 if(t.dataset.fagent||t.dataset.fnode)$('reviews').scrollIntoView({behavior:'smooth',block:'start'});
 return;
}
const b=e.target.closest('button');if(!b)return;
try{
 if(b.dataset.action){b.disabled=true;const a=actions[Number(b.dataset.index)];await Promise.all(a.sources.map(s=>api('action',s.node,{reviewId:s.reviewId,index:s.index,state:b.dataset.action})));await refresh();}
 if(b.dataset.retry){b.disabled=true;await api('retry',b.dataset.node,{id:b.dataset.retry});await refresh();}
}catch(err){message(err.message);}finally{b.disabled=false;}});
function cliCard(glyph,name,meta,badge,cta,onclick){
const el=document.createElement('div');el.className='bf-cli-card';
el.innerHTML='<div class="bf-cli-card__top"><div class="ax-avatar ax-avatar--'+avatarClass(name)+'" style="width:30px;height:30px;font-size:11px">'+esc(glyph)+'</div>'
 +'<div style="min-width:0"><div class="bf-cli-card__n">'+esc(name)+'</div><div class="bf-cli-card__m">'+esc(meta)+'</div></div></div>'
 +badge+'<button class="ax-btn ax-btn--sm ax-btn--primary">'+esc(cta)+'</button>';
el.querySelector('button').onclick=onclick;
return el;
}
const NATIVE='<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>Reports turns natively</span>';
const PROC='<span class="ax-pill ax-pill--off">Process only</span>';
$('discover').onclick=async()=>{
try{
const node=$('node').value;const data=await api('discover',node);$('discovered').replaceChildren();
for(const s of data.sessions||[])
 $('discovered').append(cliCard('cl','claude',s.label||s.id,NATIVE,'Monitor session',async()=>{
  try{await api('register',node,{...s,label:s.label||s.id});message('Registered. Attach stop hooks will review future turns.');await refresh();}catch(e){message(e.message);}}));
for(const p of data.processes)
 $('discovered').append(cliCard(p.runtime.slice(0,2),p.runtime,'PID '+p.pid+' · '+p.started,PROC,'Register',async()=>{
  try{await api('register',node,{id:p.runtime+':'+p.pid+':'+p.started,label:p.runtime+' '+p.pid,runtime:p.runtime,pid:p.pid,started:p.started});message('Registered. Connect a stop hook or submit a transcript.');await refresh();}catch(e){message(e.message);}}));
if(!data.processes.length&&!(data.sessions||[]).length)
 $('discovered').innerHTML='<div class="bf-empty" style="grid-column:1/-1">'+ic('plug',22)+'<h4>No CLI found</h4><p>Only processes owned by the daemon account are visible. Register others manually.</p></div>';
}catch(e){message(e.message);}};
for(const op of ['register','ended'])$(op).onsubmit=async e=>{e.preventDefault();try{const body=Object.fromEntries(new FormData(e.target));await api(op,$('node').value,body);message(op==='ended'?'Run queued for review.':'Session registered.');if(op==='ended')e.target.reset();await refresh();}catch(err){message(err.message);}};
skeleton();refresh();
setInterval(()=>{
if(document.hidden||expandedActions)return;
if(document.querySelector('form :focus'))return;
if(document.querySelector('.bf-trace[open]'))return; // don't yank an open trace
refresh();
},15000);
})();`
