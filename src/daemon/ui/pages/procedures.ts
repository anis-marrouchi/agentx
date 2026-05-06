// --- Procedures page (Tier 3 — reusable building blocks) ---
//
// Surfaces the verb library that workflows compose. Three sections:
//   1. Built-in actions     — typed, schema-validated steps registered
//                              process-globally via src/actions/builtin/.
//                              Workflow nodes invoke these via type:
//                              "action.builtin" with config.name + input.
//   2. Workflow templates   — scaffolds emitted by `agentx workflow init
//                              --template <name>`. The base shape an
//                              operator starts from before refining.
//   3. Agent skills          — per-agent toolkits surfaced for visibility;
//                              actual editing happens under Settings.
//
// Reads come from existing daemon endpoints (no new server work):
//   GET /api/actions/builtin             — built-in catalog (each entry
//                                          has inputSchema, outputSchema,
//                                          description, timeoutMs)
// Templates and skills are bundled with the daemon (filesystem-served).
// We surface only the names + summaries here; the editor is the place
// to wire one into a real workflow.
//
// This page is intentionally read-only. Procedures are added by writing
// code (new action.builtin module or new template YAML), not by the UI.

import { renderShell, esc, type TopbarPeer } from ".."

export interface ProceduresPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
}

export function renderProceduresPage(opts: ProceduresPageOpts = {}): string {
  const body = `<div class="ax-proc__root">
  <header class="ax-proc__header">
    <h1>Procedures</h1>
    <p class="hint">Reusable building blocks workflows compose. See <a href="/admin/wiki/architecture/three-tier" target="_blank">three-tier model</a> for how this fits with System and Processes.</p>
  </header>

  <section class="ax-proc__panel">
    <header>
      <h2>Built-in actions</h2>
      <span id="ax-proc__actions-count" class="hint">0</span>
    </header>
    <p class="hint">Typed steps registered at boot. Reference from any workflow as <code>type: action.builtin</code> with <code>config.name</code> matching the action's name and <code>config.input</code> matching its input schema.</p>
    <ul id="ax-proc__actions" class="ax-proc__list" aria-live="polite"></ul>
  </section>

  <section class="ax-proc__panel">
    <header>
      <h2>Sub-workflows</h2>
      <span id="ax-proc__subworkflows-count" class="hint">0</span>
    </header>
    <p class="hint">Active workflows whose trigger is <code>trigger.manual</code> with a typed <code>inputSchema</code> can be reused as procedures. Reference from another workflow as <code>type: subProcess</code> with <code>config.workflowId</code> and an <code>inputMap</code>.</p>
    <ul id="ax-proc__subworkflows" class="ax-proc__list" aria-live="polite"></ul>
  </section>

  <section class="ax-proc__panel">
    <header>
      <h2>Workflow templates</h2>
      <span class="hint">scaffold via <code>agentx workflow init &lt;id&gt; --template &lt;name&gt;</code></span>
    </header>
    <ul class="ax-proc__list">
      <li class="ax-proc__item"><div class="ax-proc__item-head"><strong>linear</strong><span class="hint">trigger → agent → end (smallest valid graph)</span></div></li>
      <li class="ax-proc__item"><div class="ax-proc__item-head"><strong>branching</strong><span class="hint">classify, then route on RESULT to one of N branches</span></div></li>
      <li class="ax-proc__item"><div class="ax-proc__item-head"><strong>extract</strong><span class="hint">extract.structured with a JSON-schema-shaped output</span></div></li>
      <li class="ax-proc__item"><div class="ax-proc__item-head"><strong>human-in-the-loop</strong><span class="hint">userTask form pause + resume</span></div></li>
      <li class="ax-proc__item"><div class="ax-proc__item-head"><strong>retry</strong><span class="hint">per-node retry policy with a branch fallback path</span></div></li>
    </ul>
  </section>

  <section class="ax-proc__panel">
    <header>
      <h2>Architecture</h2>
    </header>
    <p class="hint">AgentX is layered: <strong>System</strong> (agents, channels, mesh) → <strong>Processes</strong> (workflows that turn intent into work) → <strong>Procedures</strong> (this page: reusable steps a process composes). Higher tiers depend on lower; never the reverse.</p>
    <p class="hint">Adding a new procedure is a code change (a new <code>action.builtin</code> module under <code>src/actions/builtin/</code> or a new template YAML in <code>src/workflows/templates/</code>) — not a UI flow. This page is the read-only catalog.</p>
  </section>
</div>`

  return renderShell({
    title: "AgentX · Procedures",
    activeTab: "procedures",
    subtitle: "Procedures",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    body,
    css: PROCEDURES_PAGE_CSS,
    scripts: `<script>${PROCEDURES_PAGE_SCRIPT}</script>`,
  })
}

const PROCEDURES_PAGE_CSS = `
.ax-proc__root { padding: 18px 24px 40px; max-width: 1100px; margin: 0 auto; color: var(--ax-text); }
.ax-proc__header h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.ax-proc__header .hint { color: var(--ax-muted); font-size: 12px; margin: 0 0 18px; }
.ax-proc__panel { margin: 18px 0; padding: 14px 16px; border: 1px solid var(--ax-border); border-radius: 6px; background: var(--ax-bg-elev); }
.ax-proc__panel > header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; gap: 10px; flex-wrap: wrap; }
.ax-proc__panel h2 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: -0.005em; }
.ax-proc__panel .hint { color: var(--ax-muted); font-size: 11px; }
.ax-proc__panel code { font-family: var(--ax-mono); font-size: 11px; padding: 1px 5px; background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: 3px; }
.ax-proc__list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ax-proc__item { padding: 10px 12px; background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: 4px; }
.ax-proc__item-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ax-proc__item strong { font-size: 13px; font-family: var(--ax-mono); }
.ax-proc__item-head .hint { font-size: 11px; color: var(--ax-muted); flex: 1; text-align: right; }
.ax-proc__schema { margin-top: 6px; }
.ax-proc__schema summary { font-size: 11px; color: var(--ax-muted); cursor: pointer; padding: 4px 0; user-select: none; }
.ax-proc__schema summary:hover { color: var(--ax-text); }
.ax-proc__schema pre { margin: 6px 0 0; padding: 8px 10px; font-family: var(--ax-mono); font-size: 11px; line-height: 1.4; background: var(--ax-bg); border: 1px solid var(--ax-border); border-radius: 3px; overflow: auto; max-height: 240px; white-space: pre-wrap; word-break: break-word; }
.ax-proc__io { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0 0; }
.ax-proc__io th { text-align: left; font-weight: 500; color: var(--ax-muted); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--ax-border); }
.ax-proc__io td { padding: 6px 8px; border-bottom: 1px solid var(--ax-border); vertical-align: top; }
.ax-proc__io td.ax-proc__io-name { font-family: var(--ax-mono); color: var(--ax-text); font-weight: 500; white-space: nowrap; }
.ax-proc__io td.ax-proc__io-type { font-family: var(--ax-mono); font-size: 11px; color: var(--ax-text-2); }
.ax-proc__req { display: inline-block; padding: 1px 6px; font-size: 10px; font-family: var(--ax-mono); border: 1px solid color-mix(in oklch, var(--ax-warn, #f59e0b) 40%, var(--ax-border)); border-radius: 3px; color: var(--ax-warn, #f59e0b); }
.ax-proc__link { color: var(--ax-accent, #6366f1); text-decoration: none; font-size: 11px; }
.ax-proc__link:hover { text-decoration: underline; }
`

const PROCEDURES_PAGE_SCRIPT = `
(function(){
  function $(sel){ return document.querySelector(sel) }
  function esc(s){ return String(s||"").replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] }) }
  function token(){ try { return localStorage.getItem('ax_token') || '' } catch { return '' } }
  function headers(){ var h = { 'Accept':'application/json' }; var t = token(); if (t) h.Authorization = 'Bearer ' + t; return h }

  async function loadActions(){
    try {
      var r = await fetch('/api/actions/builtin', { headers: headers() })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      var data = await r.json()
      var actions = Array.isArray(data) ? data : (data.actions || data.builtins || [])
      $('#ax-proc__actions-count').textContent = String(actions.length)
      if (!actions.length) {
        $('#ax-proc__actions').innerHTML = '<li class="ax-proc__item"><div class="ax-proc__item-head"><span class="hint">No built-in actions registered. Check src/actions/builtin/index.ts is wired at daemon boot.</span></div></li>'
        return
      }
      $('#ax-proc__actions').innerHTML = actions.map(function(a){
        var schemaIn  = a.inputSchema  ? '<details class="ax-proc__schema"><summary>Input schema</summary><pre>'  + esc(JSON.stringify(a.inputSchema, null, 2))  + '</pre></details>' : ''
        var schemaOut = a.outputSchema ? '<details class="ax-proc__schema"><summary>Output schema</summary><pre>' + esc(JSON.stringify(a.outputSchema, null, 2)) + '</pre></details>' : ''
        var t = a.timeoutMs ? '<span class="hint">timeout=' + Math.round(a.timeoutMs/1000) + 's</span>' : ''
        return '<li class="ax-proc__item">' +
          '<div class="ax-proc__item-head"><strong>' + esc(a.name || 'unnamed') + '</strong>' + t + '</div>' +
          (a.description ? '<p class="hint" style="margin:6px 0 0">' + esc(a.description) + '</p>' : '') +
          schemaIn + schemaOut +
        '</li>'
      }).join('')
    } catch (e) {
      $('#ax-proc__actions').innerHTML = '<li class="ax-proc__item"><div class="ax-proc__item-head"><span class="hint">Failed to load actions: ' + esc(e.message) + '</span></div></li>'
    }
  }

  /** A workflow qualifies as a "procedure" — i.e. composable as a
   *  subProcess from another workflow — when:
   *   - it's active (state=active, status=active or unspecified)
   *   - its trigger is trigger.manual (no live channel race)
   *   - it declares a non-empty inputSchema (the contract)
   * Without inputSchema, callers wouldn't know what to pass; without
   * trigger.manual, dispatching it from a parent would race with the
   * channel's own delivery. */
  function isProcedureShaped(wf){
    if (!wf || wf.state !== 'active') return false
    if (wf.status && wf.status !== 'active') return false
    var trig = (wf.nodes || []).find(function(n){ return n && n.type === 'trigger.manual' })
    if (!trig) return false
    var schema = trig.config && trig.config.inputSchema
    if (!schema || !schema.properties) return false
    return Object.keys(schema.properties).length > 0
  }

  async function loadSubWorkflows(){
    try {
      var r = await fetch('/api/workflows', { headers: headers() })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      var data = await r.json()
      var workflows = (data.workflows || []).filter(isProcedureShaped)
      $('#ax-proc__subworkflows-count').textContent = String(workflows.length)
      if (!workflows.length) {
        $('#ax-proc__subworkflows').innerHTML = '<li class="ax-proc__item"><div class="ax-proc__item-head"><span class="hint">No active workflows currently expose a typed inputSchema. Promote a draft from /workflows once its inputSchema is defined.</span></div></li>'
        return
      }
      $('#ax-proc__subworkflows').innerHTML = workflows.map(function(wf){
        var trig = (wf.nodes || []).find(function(n){ return n.type === 'trigger.manual' })
        var schema = trig && trig.config && trig.config.inputSchema || { properties: {}, required: [] }
        var required = new Set(Array.isArray(schema.required) ? schema.required : [])
        var rows = Object.keys(schema.properties || {}).map(function(k){
          var p = schema.properties[k] || {}
          var enumStr = Array.isArray(p['enum']) ? ' [' + p['enum'].map(esc).join(' | ') + ']' : ''
          var def = p['default'] !== undefined ? ' default=' + esc(JSON.stringify(p['default'])) : ''
          var req = required.has(k) ? '<span class="ax-proc__req">required</span>' : ''
          return '<tr><td class="ax-proc__io-name">' + esc(k) + '</td>' +
                 '<td class="ax-proc__io-type">' + esc(String(p.type || 'any')) + esc(enumStr) + esc(def) + '</td>' +
                 '<td>' + req + '</td>' +
                 '<td class="hint">' + esc(p.description || '') + '</td></tr>'
        }).join('')
        var inputCount = Object.keys(schema.properties || {}).length
        var ownerLine = wf.ownerAgent ? ' · owner: ' + esc(wf.ownerAgent) : ''
        return '<li class="ax-proc__item">' +
          '<div class="ax-proc__item-head"><strong>' + esc(wf.id) + '</strong>' +
            '<span class="hint">' + inputCount + ' input' + (inputCount === 1 ? '' : 's') + ownerLine + '</span></div>' +
          (wf.title ? '<p class="hint" style="margin:6px 0 0">' + esc(wf.title) + '</p>' : '') +
          '<div style="margin-top:6px">' +
            '<a href="/workflows#' + esc(wf.id) + '" class="ax-proc__link">Open in /workflows ↗</a>' +
            ' · <code style="font-size:11px">subProcess { workflowId: "' + esc(wf.id) + '" }</code>' +
          '</div>' +
          (rows ? '<details class="ax-proc__schema"><summary>Input contract</summary>' +
            '<table class="ax-proc__io"><thead><tr><th>field</th><th>type</th><th></th><th>description</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '</details>' : '') +
        '</li>'
      }).join('')
    } catch (e) {
      $('#ax-proc__subworkflows').innerHTML = '<li class="ax-proc__item"><div class="ax-proc__item-head"><span class="hint">Failed to load sub-workflows: ' + esc(e.message) + '</span></div></li>'
    }
  }

  function bootAll(){ loadActions(); loadSubWorkflows() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAll)
  else bootAll()
})();
`
