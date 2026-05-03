// --- Agent page (/admin/agents/<id>) ---
//
// One dedicated page per agent. Tabs:
//   Overview   — editable metadata + system prompt
//   Identity   — CLAUDE.md / SOUL.md / IDENTITY.md etc via EasyMDE
//   Skills     — per-skill directory tree, file editor, install actions
//   Channels   — read-only list of bindings
//   Handovers  — manual routing to/from this agent
//   Activity   — recent tasks
//
// API is in agent-panel.ts (keeps file-ops + handover-store imports in one
// place); this file owns ONLY the HTML/CSS/client JS.

import { renderShell, esc, type TopbarPeer } from ".."

export interface AgentPageOpts {
  agentId: string
  peers?: TopbarPeer[]
  currentPeerId?: string
  localToken?: string
}

export function renderAgentPage(opts: AgentPageOpts): string {
  const agentId = opts.agentId
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""
  const agentIdScript = `<script>window.AGENT_ID = ${JSON.stringify(agentId)};</script>`

  // Body HTML — copied verbatim from the old renderAgentHtml, with the
  // ${escapeHtml(agentId)} interpolations re-wired to our esc() helper.
  const body = AGENT_PAGE_BODY.replace(/__AGENT_ID__/g, esc(agentId))

  return renderShell({
    title: `AgentX · ${esc(agentId)}`,
    activeTab: "admin",
    subtitle: `Agent · ${esc(agentId)}`,
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    // The extracted body already carries its own <main> tag plus the
    // confirm-modal <div> that sits alongside it at the same level.
    noMain: true,
    body,
    css: AGENT_PAGE_CSS,
    headExtras: `<link rel="stylesheet" href="https://unpkg.com/easymde/dist/easymde.min.css">`,
    scripts: `${agentIdScript}${tokenScript}<script src="https://unpkg.com/easymde/dist/easymde.min.js"></script><script>${AGENT_PAGE_SCRIPT}</script>`,
  })
}

const AGENT_PAGE_BODY = `
<!-- Breadcrumb -->
<div class="ax-crumb">
  <a href="/admin">Settings</a>
  <span class="ax-crumb__sep">/</span>
  <a href="/admin#agents">Agents</a>
  <span class="ax-crumb__sep">/</span>
  <span class="ax-crumb__cur" id="a-crumb-name">__AGENT_ID__</span>
</div>

<!-- Hero -->
<div class="ax-hero">
  <div class="ax-hero__ava" id="a-ava">??<span class="ax-hero__on"></span></div>
  <div class="ax-hero__title">
    <h1><span id="a-name">__AGENT_ID__</span></h1>
    <div class="ax-hero__sub">
      <span class="mono muted" id="a-id">__AGENT_ID__</span>
      <span class="ax-hero__dot"></span>
      <span id="a-short-desc">Agent workspace &amp; behavior</span>
      <span class="ax-hero__dot"></span>
      <span id="a-chips"></span>
    </div>
  </div>
  <div class="ax-hero__actions">
    <button class="ax-btn ax-btn--ghost" id="btn-test-drive">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Test drive
    </button>
    <button class="ax-btn ax-btn--primary" id="btn-save-meta">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      Save changes
    </button>
  </div>
</div>

<!-- Inline stats -->
<div class="ax-stats-inline" id="a-stats">
  <div class="ax-stat-inline">
    <div class="ax-stat-inline__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
    <div><div class="ax-stat-inline__v" id="stat-today">—</div><div class="ax-stat-inline__l">messages today</div></div>
  </div>
  <div class="ax-stat-inline">
    <div class="ax-stat-inline__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
    <div><div class="ax-stat-inline__v" id="stat-avg">—</div><div class="ax-stat-inline__l">avg response</div></div>
  </div>
  <div class="ax-stat-inline">
    <div class="ax-stat-inline__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
    <div><div class="ax-stat-inline__v" id="stat-resolved">—</div><div class="ax-stat-inline__l">resolved today</div></div>
  </div>
  <div class="ax-stat-inline">
    <div class="ax-stat-inline__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
    <div><div class="ax-stat-inline__v" id="stat-handling">—</div><div class="ax-stat-inline__l">handling right now</div></div>
  </div>
</div>

<!-- Layout: rail + main + test-drive -->
<div class="ax-layout">

  <!-- LEFT RAIL -->
  <nav class="ax-rail" id="a-rail">
    <div class="ax-rail__label">Configure</div>
    <a data-tab="overview" class="is-active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      Overview
    </a>
    <a data-tab="identity">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Personality
    </a>
    <a data-tab="skills">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      Skills
      <span class="ax-rail__count" id="rail-skills-count">0</span>
    </a>
    <a data-tab="channels">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      Channels
      <span class="ax-rail__count" id="rail-channels-count">0</span>
    </a>
    <a data-tab="handovers">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
      Handovers
      <span class="ax-rail__count" id="rail-handovers-count">0</span>
    </a>
    <a data-tab="capability">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      Capability
    </a>

    <div class="ax-rail__sep"></div>
    <div class="ax-rail__label">Observe</div>
    <a data-tab="activity">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity
    </a>

    <div class="ax-rail__sep"></div>
    <a data-tab="danger" style="color:var(--ax-text-2)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ax-err)"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Danger zone
    </a>
  </nav>

  <!-- MAIN COLUMN -->
  <div>
    <div id="msg" class="msg"></div>

    <!-- Overview -->
    <section id="tab-overview" class="ax-panel__tab is-active">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Basics</h2>
            <p class="ax-lead" style="margin:0">Give your agent a name and describe what it does. This is how it'll show up in lists and the topbar.</p>
          </div>
        </div>
        <div class="ax-grid-2">
          <div class="ax-field"><label class="lbl">Display name</label><input class="inp" id="f-name" /></div>
          <div class="ax-field"><label class="lbl">Short id <span class="opt">used in URLs &amp; configs</span></label><input class="inp mono" id="f-slug" value="__AGENT_ID__" readonly style="font-family:var(--ax-mono)" /></div>
        </div>
        <div class="ax-field">
          <label class="lbl">Wake words <span class="opt">what gets its attention in a chat</span></label>
          <div class="ax-triggers-edit" id="f-triggers" onclick="this.querySelector('input').focus()">
            <input placeholder="Type a word and press Enter…" onkeydown="addTrigger(event)"/>
          </div>
          <!-- The canonical persisted value: comma-separated mentions. Kept
               hidden so existing saveAgent() wiring still reads it. -->
          <input id="f-mentions" type="hidden" />
          <div class="hint">Messages containing any of these wake the agent. Other messages are ignored — unless the message is a direct reply to the agent.</div>
        </div>
      </div>

      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Brains</h2>
            <p class="ax-lead" style="margin:0">Which AI does the thinking? <b>Claude Code</b> is what most people want — it runs locally and has access to tools.</p>
          </div>
        </div>
        <div class="ax-grid-3">
          <div class="ax-field">
            <label class="lbl">AI engine</label>
            <select class="inp" id="f-tier">
              <option value="claude-code">Claude Code (recommended)</option>
              <option value="sdk">Anthropic API (SDK)</option>
              <option value="orchestrator">Orchestrator (any LLM)</option>
            </select>
          </div>
          <div class="ax-field">
            <label class="lbl">Model</label>
            <input class="inp" id="f-model" placeholder="claude-sonnet-4-6" />
          </div>
          <div class="ax-field">
            <label class="lbl">Visibility</label>
            <select class="inp" id="f-access">
              <option value="private">Private (only this node)</option>
              <option value="public">Public API</option>
            </select>
            <div id="public-api-hint" style="display:none;margin-top:6px;padding:8px 10px;background:var(--ax-surface);border-radius:4px;font-size:11px;color:var(--ax-muted)">
              Public API enabled. External callers POST to <code id="public-api-url" style="font-family:'IBM Plex Mono',monospace"></code> with a token scoped <code>agent:<span id="public-api-scope"></span></code> or <code>agent:*</code>. Mint one in the <a href="/admin#tokens">Tokens tab</a>.
            </div>
          </div>
        </div>
      </div>

      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Limits &amp; safety</h2>
            <p class="ax-lead" style="margin:0">Reasonable boundaries. Agents that go too long or too wide can burn tokens quickly.</p>
          </div>
        </div>
        <div class="ax-slider-row">
          <label>Conversations at once</label>
          <span class="ax-hint">How many people can this agent talk to in parallel? Lower = more focused, more waits.</span>
          <div class="ax-opts" data-field="maxConcurrent">
            <button data-v="1">1</button><button data-v="3">3</button>
            <button data-v="5">5</button><button data-v="10">10</button>
          </div>
          <input id="f-maxc" type="hidden" />
        </div>
        <div class="ax-slider-row">
          <label>Max task length</label>
          <span class="ax-hint">If a reply takes longer than this, the agent gives up. Protects against runaway loops.</span>
          <div class="ax-opts" data-field="maxExecutionMinutes">
            <button data-v="5">5 min</button><button data-v="20">20 min</button>
            <button data-v="60">1 h</button><button data-v="0">no limit</button>
          </div>
          <input id="f-maxt" type="hidden" />
        </div>
        <div class="ax-slider-row">
          <label>Tool permissions</label>
          <span class="ax-hint"><b>Ask first</b> = you approve each tool call. <b>Trusted</b> = it just goes.</span>
          <div class="ax-opts" data-field="permissionMode">
            <button data-v="default">Ask first</button>
            <button data-v="acceptEdits">Accept edits</button>
            <button data-v="plan">Plan only</button>
            <button data-v="bypassPermissions">Trusted</button>
          </div>
          <input id="f-pmode" type="hidden" />
        </div>
      </div>
    </section>

    <!-- Personality — left-docked vertical file list + MD editor -->
    <section id="tab-identity" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Personality &amp; instructions</h2>
            <p class="ax-lead" style="margin:0">This is the most important thing about your agent. It's how you tell it who it is, what it can and can't do, and how to speak.</p>
          </div>
        </div>

        <div class="ax-callout">
          <span class="ax-callout__icon">?</span>
          <div>These files live in the agent's workspace and are injected at the top of every conversation. Markdown is supported; changes hot-reload on the next turn.</div>
        </div>

        <div class="ax-identity">
          <!-- Vertical file list -->
          <aside class="ax-identity__files" id="identity-files-tabs"></aside>

          <!-- MD editor for the active file -->
          <div class="ax-identity__editor">
            <div class="ax-identity__head">
              <span class="mono muted" id="id-path" style="font-size:11.5px">—</span>
              <span class="ax-pbadge" id="id-chars">0 chars</span>
              <span style="flex:1"></span>
              <button class="ax-btn ax-btn--primary" id="btn-save-id">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save
              </button>
            </div>
            <textarea id="id-editor"></textarea>
            <div style="margin-top:6px;display:flex;align-items:center;gap:8px">
              <span class="mono muted" id="id-saved-note" style="font-size:11px"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Overview-style system-prompt summary (read + quick-edit) -->
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Quick system prompt</h2>
            <p class="ax-lead" style="margin:0">The <code>systemPrompt</code> field in agentx.json, a short one-liner injected before any CLAUDE.md file loads.</p>
          </div>
        </div>
        <textarea class="inp" id="sp-editor" style="min-height:120px;line-height:1.55" placeholder="(Optional) A one-liner that sets the top of every prompt."></textarea>
      </div>
    </section>

    <!-- Skills -->
    <section id="tab-skills" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Skills</h2>
            <p class="ax-lead" style="margin:0">Little plug-ins that give this agent new abilities — look up docs, create tickets, summarise PDFs, you name it.</p>
          </div>
          <button class="ax-btn ax-btn--primary" id="btn-install-pkg-open">+ Install package</button>
        </div>

        <div class="ax-skill-toolbar">
          <div class="ax-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input class="inp" id="skill-search" placeholder="Search skills…" />
          </div>
          <button class="ax-btn" id="btn-new-skill">+ New skill</button>
        </div>

        <div class="ax-sec-label-d"><h3 id="skills-count-label">Installed</h3></div>
        <div class="ax-skill-grid" id="skills-list"></div>

        <!-- Selected-skill file tree + editor (inline below the grid). -->
        <div id="skill-editor-wrap" style="display:none;margin-top:16px">
          <div class="ax-sec-label-d">
            <h3 id="skill-editor-slug">Skill files</h3>
            <div style="display:flex;gap:6px">
              <button class="ax-btn" id="btn-install-deps" disabled>Install deps…</button>
              <button class="ax-btn ax-btn--danger" id="btn-delete-skill" disabled>Delete skill</button>
            </div>
          </div>
          <div class="ax-grid-2">
            <div class="ax-panel" style="padding:14px">
              <div id="skill-tree"></div>
            </div>
            <div class="ax-panel" style="padding:14px">
              <div id="sk-editor-wrap" style="display:none">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11.5px">
                  <span class="mono muted" id="sk-path">—</span>
                  <span style="flex:1"></span>
                  <button class="ax-btn ax-btn--primary" id="btn-save-sk" style="padding:4px 10px;font-size:11.5px">Save file</button>
                </div>
                <textarea class="inp mono" id="sk-editor" style="min-height:300px;line-height:1.55;font-family:var(--ax-mono);font-size:12px"></textarea>
              </div>
              <div id="sk-editor-empty" style="color:var(--ax-muted);padding:20px;text-align:center;font-size:12px">Select a file in the tree to edit.</div>
            </div>
          </div>
        </div>

        <!-- Install-package dispatcher output + dependencies. -->
        <details id="pkg-details" style="margin-top:14px">
          <summary style="cursor:pointer;color:var(--ax-muted);font-size:12px;padding:6px 0">Install from package (advanced) ▾</summary>
          <div class="ax-panel" style="margin-top:10px">
            <div class="ax-grid-2">
              <div class="ax-field">
                <label class="lbl">Package</label>
                <input class="inp mono" id="pkg-input" placeholder="owner/repo  or  owner/repo/skill" />
              </div>
              <div class="ax-field" style="display:flex;align-items:flex-end">
                <button class="ax-btn ax-btn--primary" id="btn-install-pkg" style="width:100%">Install</button>
              </div>
            </div>
            <pre id="dispatch-output" style="margin:10px 0 0;padding:10px;background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:5px;font-family:var(--ax-mono);font-size:11px;color:var(--ax-text-2);max-height:240px;overflow:auto;white-space:pre-wrap;display:none"></pre>
          </div>
        </details>
      </div>
    </section>

    <!-- Channels -->
    <section id="tab-channels" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Where this agent lives</h2>
            <p class="ax-lead" style="margin:0">Places this agent shows up. Connections are configured in the global <a href="/admin#channels">Channels</a> tab — here you see which ones route to this agent.</p>
          </div>
        </div>
        <div id="channels-list"></div>
      </div>
    </section>

    <!-- Handovers -->
    <section id="tab-handovers" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Route a conversation somewhere else</h2>
            <p class="ax-lead" style="margin:0">Sometimes you'll want to pass a chat to another agent — say Support has been trying to explain pricing, and Sales should take over. <b>Every message from that chat will go to the new agent until you release the handover.</b></p>
          </div>
        </div>

        <div class="ax-handover-viz">
          <div class="ax-ho-side ax-ho-side--from">
            <div class="ax-ho-side__av" id="ho-from-av">??</div>
            <div class="ax-ho-side__nm" id="ho-from-nm">__AGENT_ID__</div>
            <div class="ax-ho-side__rl">from</div>
          </div>
          <div class="ax-ho-wire">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="ax-ho-side ax-ho-side--to">
            <div class="ax-ho-side__av" id="ho-to-av">—</div>
            <div class="ax-ho-side__nm" id="ho-to-nm">pick one</div>
            <div class="ax-ho-side__rl">to</div>
          </div>
        </div>

        <div class="ax-grid-3">
          <div class="ax-field">
            <label class="lbl">Channel</label>
            <select class="inp" id="ho-channel">
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
          <div class="ax-field">
            <label class="lbl">Chat id <span class="opt">who's the person?</span></label>
            <input class="inp mono" id="ho-chatid" placeholder="1816212449 or +21612345678" />
          </div>
          <div class="ax-field">
            <label class="lbl">Hand off to</label>
            <select class="inp" id="ho-target"></select>
          </div>
        </div>
        <div class="ax-field">
          <label class="lbl">Account <span class="opt">optional, e.g. "default" for a multi-bot setup</span></label>
          <input class="inp mono" id="ho-account" placeholder="default" />
        </div>
        <div class="ax-field">
          <label class="lbl">Brief the receiving agent <span class="opt">one-shot note</span></label>
          <textarea class="inp" id="ho-summary" style="min-height:100px" placeholder="Customer is asking about enterprise pricing. They've already seen the standard tier..."></textarea>
          <div class="hint">The note is injected into the next reply's context. The agent will know <i>why</i> it received the handover.</div>
        </div>
        <div class="ax-grid-2">
          <div class="ax-field" style="margin-bottom:0">
            <label class="lbl">Expires <span class="opt">ISO date; blank = never</span></label>
            <input class="inp mono" id="ho-expires" placeholder="2026-04-20T00:00:00Z" />
          </div>
          <div style="display:flex;align-items:flex-end;justify-content:flex-end">
            <button class="ax-btn ax-btn--primary lg" id="btn-handover">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              Hand off
            </button>
          </div>
        </div>
      </div>

      <div class="ax-panel">
        <div class="ax-panel__head"><div><h2>Currently routed elsewhere</h2><p class="ax-lead" style="margin:0">Chats this agent has handed to someone else.</p></div></div>
        <div id="ho-outgoing"></div>
      </div>

      <div class="ax-panel">
        <div class="ax-panel__head"><div><h2>Taken over from somewhere</h2><p class="ax-lead" style="margin:0">Chats other agents routed <i>to</i> this agent.</p></div></div>
        <div id="ho-incoming"></div>
      </div>
    </section>

    <!-- Capability — mirrors agentx agent capability -->
    <section id="tab-capability" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>Capability flags</h2>
            <p class="ax-lead" style="margin:0">Phase 5 typed dispatch, Phase 8 delegation depth, and per-agent context-engine overrides. Mirrors <code>agentx agent capability</code>. <b>Restart the daemon</b> after changes for them to take effect.</p>
          </div>
        </div>
        <div class="ax-panel__body">
          <label class="ax-field">
            <span class="ax-field__label">Allowed intents <span class="ax-hint">(comma-separated allow-list — leave blank for permissive default)</span></span>
            <input id="cap-intents" type="text" placeholder="issue.opened, merge_request.opened" />
            <span class="ax-hint">Set to limit this agent to specific intents. The org-chart canHandle() check rejects anything not on the list.</span>
          </label>
          <label class="ax-field">
            <span class="ax-field__label">Max delegation depth <span class="ax-hint">(0..50; lower for agents at the bottom of a chain)</span></span>
            <input id="cap-mdd" type="number" min="0" max="50" />
            <span class="ax-hint">Caps cascade chains where A → B → A. Default 5.</span>
          </label>
          <label class="ax-field">
            <span class="ax-field__label">Context references</span>
            <select id="cap-cref">
              <option value="false">off — skip the [Verified References] block</option>
              <option value="true">on — render deterministic references in the prompt</option>
            </select>
            <span class="ax-hint">Turn on for agents (PMs, devops) that need cited facts. Requires a <code>references/</code> registry in the workspace.</span>
          </label>
          <label class="ax-field">
            <span class="ax-field__label">Context strategy <span class="ax-hint">(per-agent override; blank = global default)</span></span>
            <select id="cap-cstrat">
              <option value="">(global default)</option>
              <option value="layered">layered — full context, larger prompt</option>
              <option value="planner">planner — smaller prompt, more tool-driven exploration</option>
            </select>
          </label>
          <label class="ax-field">
            <span class="ax-field__label">Max execution minutes <span class="ax-hint">(1..240; SIGTERM after this)</span></span>
            <input id="cap-mxm" type="number" min="1" max="240" />
            <span class="ax-hint">Wall-clock cap on a single Claude Code invocation. Default 20m. Bump for devops/coder agents that do long investigations.</span>
          </label>
          <div class="ax-form-actions" style="margin-top:14px">
            <button class="ax-btn ax-btn--primary" id="cap-save">Save capability</button>
            <span id="cap-msg" class="ax-hint" style="margin-left:10px"></span>
          </div>
        </div>
      </div>

      <!-- MCP servers — synced to <workspace>/.mcp.json by agent-mcp.ts at boot -->
      <div class="ax-panel" style="margin-top:14px">
        <div class="ax-panel__head">
          <div>
            <h2>MCP servers</h2>
            <p class="ax-lead" style="margin:0">Each entry becomes a server in the agent\'s <code>.mcp.json</code>. Operator-edited entries in that file are respected (the sync layer marks them operator-owned and skips them); this tab only writes to <code>agentx.json</code>.</p>
          </div>
        </div>
        <div class="ax-panel__body">
          <div id="mcp-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px"></div>
          <details>
            <summary style="cursor:pointer;font-size:12px;color:var(--ax-accent,#3a7bd5)">+ Add or update server</summary>
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
              <label class="ax-field">
                <span class="ax-field__label">Name <span class="ax-hint">(identifier; will key the entry in agent.mcp)</span></span>
                <input id="mcp-name" type="text" placeholder="filesystem, gitlab, brave-search…" />
              </label>
              <label class="ax-field">
                <span class="ax-field__label">Command</span>
                <input id="mcp-command" type="text" placeholder="npx" />
              </label>
              <label class="ax-field">
                <span class="ax-field__label">Args <span class="ax-hint">(comma-separated)</span></span>
                <input id="mcp-args" type="text" placeholder="-y, @modelcontextprotocol/server-filesystem, /Users/me/code" />
              </label>
              <label class="ax-field">
                <span class="ax-field__label">Env <span class="ax-hint">(KEY=value, comma-separated; optional)</span></span>
                <input id="mcp-env" type="text" placeholder="GITLAB_TOKEN=glpat-…, GITLAB_HOST=https://gitlab.example.com" />
              </label>
              <div class="ax-form-actions">
                <button class="ax-btn ax-btn--primary" id="mcp-save">Save MCP server</button>
                <span id="mcp-msg" class="ax-hint" style="margin-left:10px"></span>
              </div>
            </div>
          </details>
        </div>
      </div>
    </section>

    <!-- Activity -->
    <section id="tab-activity" class="ax-panel__tab">
      <div class="ax-panel">
        <div class="ax-panel__head">
          <div>
            <h2>How it's doing</h2>
            <p class="ax-lead" style="margin:0">Activity across every channel this agent answers from.</p>
          </div>
        </div>
        <div id="activity"></div>
      </div>
    </section>

    <!-- Danger zone -->
    <section id="tab-danger" class="ax-panel__tab">
      <div class="ax-panel ax-panel--danger">
        <div class="ax-panel__head">
          <div>
            <h2 style="color:var(--ax-err)">Danger zone</h2>
            <p class="ax-lead" style="margin:0">Actions here are hard to undo. They affect this agent only — other agents are safe.</p>
          </div>
        </div>
        <div class="ax-danger-item">
          <div class="ax-danger-item__info">
            <div class="ax-danger-item__name" style="color:var(--ax-err)">Delete this agent</div>
            <div class="ax-danger-item__desc">Permanently removes the agent from agentx.json. The workspace folder on disk is preserved; the config entry is gone. You'll need to recreate it from scratch to bring it back.</div>
          </div>
          <button class="ax-btn ax-btn--danger" id="btn-delete-agent">Delete agent…</button>
        </div>
      </div>
    </section>

  </div>


</div>

<!-- TEST DRIVE SIDE PANEL — docked to the right, toggled by the Test drive
     button in the hero. Closed by default; slides in when opened. -->
<aside class="ax-td-panel" id="td-panel" aria-hidden="true">
  <div class="ax-td-head">
    <div class="ax-td-head__dot"></div>
    <div>
      <div class="ax-td-head__t">Test drive</div>
      <div class="ax-td-head__sub">not recorded · sandbox</div>
    </div>
    <div style="flex:1"></div>
    <div class="ax-td-head__seg">
      <button class="is-active">Live</button>
      <button>Dry</button>
    </div>
    <button class="ax-btn ax-btn--ghost" id="td-close" aria-label="Close" style="padding:4px 9px;font-size:14px;line-height:1;margin-left:4px">×</button>
  </div>

  <div class="ax-td-scenarios">
    <div class="ax-td-scenarios__lbl">Quick scenarios</div>
    <span class="ax-td-scenario" onclick="sendScenario(this.textContent)">Who are you?</span>
    <span class="ax-td-scenario" onclick="sendScenario(this.textContent)">What can you help with?</span>
    <span class="ax-td-scenario" onclick="sendScenario(this.textContent)">Show me your skills</span>
  </div>

  <div class="ax-td-chat" id="td-chat">
    <div class="ax-td-chat__msg-wrap is-bot">
      <div class="ax-td-chat__bubble is-bot" id="td-greeting">Hey! I'm ready. Send a message to try me out.</div>
      <div class="ax-td-chat__meta">Sandbox · nothing here is recorded</div>
    </div>
  </div>

  <form class="ax-td-input" onsubmit="sendTestMessage(event)">
    <input id="td-input-el" placeholder="Test a message…" autocomplete="off"/>
    <button type="submit">Send</button>
  </form>
</aside>

<!-- Confirm modal (legacy — used by install/delete flows) -->
<div class="ax-modal-bd" id="confirm-modal-bd">
  <div class="ax-modal" style="width:min(480px,94vw)">
    <header>
      <h3 id="confirm-title">Confirm</h3>
      <button class="ax-modal__close" onclick="closeConfirm()">×</button>
    </header>
    <div class="ax-modal__body" id="confirm-detail"></div>
    <div class="ax-modal__foot">
      <button class="ax-btn" id="confirm-cancel" onclick="closeConfirm()">Cancel</button>
      <button class="ax-btn ax-btn--primary" id="confirm-ok">Confirm</button>
    </div>
  </div>
</div>
`
const AGENT_PAGE_CSS = `
/* Agent-specific layout + legacy styles for bits the migration left in
 * place (EasyMDE theming, skills tree, plain-editor). Shared chrome + tab
 * primitives live in components.css.ts. */

/* Personality tab — vertical file list on the left, MD editor on the right */
.ax-identity {
  display: grid; grid-template-columns: 220px 1fr; gap: 16px; align-items: flex-start;
}
.ax-identity__files {
  display: flex; flex-direction: column; gap: 2px;
  background: var(--ax-bg); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); padding: 6px;
}
.ax-identity__files button {
  background: transparent; border: 0; color: var(--ax-text-2);
  padding: 8px 10px; font: inherit; font-size: 12.5px; cursor: pointer;
  border-radius: 5px; text-align: left;
  display: flex; align-items: center; gap: 8px;
  font-family: var(--ax-mono);
}
.ax-identity__files button:hover { background: var(--ax-surface); color: var(--ax-text); }
.ax-identity__files button.is-active {
  background: color-mix(in oklch, var(--ax-accent) 14%, var(--ax-surface));
  color: var(--ax-accent); font-weight: 500;
}
.ax-identity__files button .ax-f-glyph {
  color: var(--ax-muted); font-size: 11px; width: 14px; text-align: center;
}
.ax-identity__files button.is-active .ax-f-glyph { color: var(--ax-accent); }
.ax-identity__files button .ax-f-new {
  margin-left: auto; font-size: 10px; color: var(--ax-muted);
  letter-spacing: 0.06em; text-transform: uppercase;
  font-family: var(--ax-mono);
}
.ax-identity__editor {
  background: var(--ax-bg); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-sm); padding: 10px;
}
.ax-identity__head {
  display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 1px solid var(--ax-border);
}

/* EasyMDE theme tweaks to match AgentX tokens */
.EasyMDEContainer .editor-toolbar {
  border-color: var(--ax-border) !important;
  background: var(--ax-surface); border-radius: 5px 5px 0 0;
}
.EasyMDEContainer .editor-toolbar button {
  color: var(--ax-text-2) !important;
}
.EasyMDEContainer .editor-toolbar button:hover,
.EasyMDEContainer .editor-toolbar button.active {
  background: var(--ax-surface-2) !important; color: var(--ax-accent) !important;
  border-color: var(--ax-border-2) !important;
}
.EasyMDEContainer .editor-toolbar i.separator {
  border-color: var(--ax-border) !important;
}
.EasyMDEContainer .CodeMirror {
  border-color: var(--ax-border) !important;
  background: var(--ax-bg-elev) !important;
  color: var(--ax-text) !important;
  font-family: var(--ax-mono) !important;
  font-size: 12.5px;
  border-radius: 0 0 5px 5px;
}
.EasyMDEContainer .CodeMirror-cursor { border-left-color: var(--ax-accent) !important; }
.EasyMDEContainer .CodeMirror-selected { background: color-mix(in oklch, var(--ax-accent) 25%, transparent) !important; }
.EasyMDEContainer .editor-statusbar { color: var(--ax-muted) !important; border-color: var(--ax-border) !important; }
.EasyMDEContainer .editor-preview,
.EasyMDEContainer .editor-preview-side {
  background: var(--ax-bg-elev) !important; color: var(--ax-text) !important;
  border-color: var(--ax-border) !important;
}
.EasyMDEContainer.sided--no-fullscreen .editor-preview-side {
  border-color: var(--ax-border) !important;
}
.cm-s-easymde .cm-header, .cm-s-easymde .cm-hr { color: var(--ax-accent) !important; }
.cm-s-easymde .cm-keyword, .cm-s-easymde .cm-link { color: var(--ax-info) !important; }
.cm-s-easymde .cm-string, .cm-s-easymde .cm-strong { color: var(--ax-text) !important; }
.cm-s-easymde .cm-comment { color: var(--ax-muted) !important; }

@media (max-width: 900px) {
  .ax-identity { grid-template-columns: 1fr; }
}

.msg { font-size: 12px; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; display: none; }
.msg.ok { background: color-mix(in oklch, var(--ax-accent) 12%, transparent); color: var(--ax-accent); display: block; }
.msg.err { background: color-mix(in oklch, var(--ax-err) 12%, transparent); color: var(--ax-err); display: block; }

/* Form labels + hints used inside panels */
label.lbl, .lbl {
  display: block; font-size: 11px; color: var(--ax-muted);
  letter-spacing: 0.03em; text-transform: uppercase; margin: 0 0 6px;
  font-weight: 500;
}
label.lbl .opt, .lbl .opt {
  text-transform: none; letter-spacing: 0; font-weight: 400;
  opacity: 0.75; margin-left: 6px;
}
input.inp, textarea.inp, select.inp {
  width: 100%; background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border); border-radius: 5px;
  padding: 8px 11px; font: inherit; font-size: 13px;
  transition: all 120ms;
}
input.inp:focus, textarea.inp:focus, select.inp:focus {
  outline: none; border-color: var(--ax-accent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ax-accent) 18%, transparent);
}
textarea.inp { min-height: 100px; line-height: 1.55; resize: vertical; font-family: inherit; }
textarea.inp.mono { font-family: var(--ax-mono); }
.ax-field { margin-bottom: 14px; }
.hint { font-size: 11.5px; color: var(--ax-muted); margin-top: 5px; line-height: 1.5; }

/* Agent-specific button variant used in rail context (no ax-btn wrapper) */
.ax-btn.lg { padding: 9px 16px; font-size: 13px; }
`
const AGENT_PAGE_SCRIPT = `
const $ = (id) => document.getElementById(id);
const state = { agent: null, activeSkill: null, activeSkillFile: null, identityPath: null };

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.AX_LOCAL_TOKEN) headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(kind, text){ const m = $('msg'); m.className='msg '+kind; m.textContent=text; setTimeout(()=>{m.className='msg';}, 4000); }

// --- confirm modal ---
function confirmAction(title, detail, onConfirm){
  $('confirm-title').textContent = title;
  $('confirm-detail').textContent = detail;
  const bd = $('confirm-modal-bd');
  if (bd) bd.classList.add('is-show');
  $('confirm-ok').onclick = () => { closeConfirm(); onConfirm(); };
}
function closeConfirm(){ const bd = $('confirm-modal-bd'); if (bd) bd.classList.remove('is-show'); }
window.closeConfirm = closeConfirm;

// --- Tabs (rail) ---
function switchTab(name) {
  document.querySelectorAll('.ax-rail a').forEach(a => a.classList.toggle('is-active', a.dataset.tab === name));
  document.querySelectorAll('.ax-panel__tab').forEach(s => s.classList.toggle('is-active', s.id === 'tab-' + name));
  try { localStorage.setItem('ax-agent-tab', name); } catch(_) {}
  if (name === 'skills' && !state.skillsLoaded) { loadSkills(); state.skillsLoaded = true; }
  if (name === 'identity' && !state.identityLoaded) { loadIdentity(); state.identityLoaded = true; }
  if (name === 'channels') loadChannels();
  if (name === 'handovers') loadHandovers();
  if (name === 'activity') loadActivity();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('.ax-rail a[data-tab]').forEach(a => {
  a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.tab); });
});
try {
  const s = localStorage.getItem('ax-agent-tab');
  if (s && document.querySelector('#tab-' + s)) switchTab(s);
} catch(_) {}

// --- Hero avatar initials/color mirror the Settings agents list helpers. ---
function initialsOf(name, id) {
  const src = (name || id || '?').replace(/[^a-zA-Z ]/g, '').trim();
  const parts = src.split(/\\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || id || '?').slice(0, 2).toUpperCase();
}

// --- Trigger-pill editing: render from a string array into #f-triggers.
// Persists the canonical value as comma-separated into the hidden #f-mentions
// input so saveAgent() doesn't need new wiring. ---
function renderTriggers(mentions) {
  const host = $('f-triggers');
  if (!host) return;
  // Remove existing pills (keep the <input> at the end).
  host.querySelectorAll('.ax-trig-pill').forEach(n => n.remove());
  const input = host.querySelector('input');
  for (const m of (mentions || [])) {
    const pill = document.createElement('span');
    pill.className = 'ax-trig-pill';
    pill.innerHTML = esc(m) + ' <button type="button">×</button>';
    pill.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      pill.remove();
      syncTriggersHidden();
    });
    host.insertBefore(pill, input);
  }
  syncTriggersHidden();
}
function syncTriggersHidden() {
  const pills = [...document.querySelectorAll('#f-triggers .ax-trig-pill')]
    .map(p => p.firstChild?.textContent?.trim() || p.textContent.replace(/×$/, '').trim())
    .filter(Boolean);
  const hidden = $('f-mentions');
  if (hidden) hidden.value = pills.join(', ');
}
window.addTrigger = function(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (!v) return;
  const input = e.target;
  const pill = document.createElement('span');
  pill.className = 'ax-trig-pill';
  pill.innerHTML = esc(v) + ' <button type="button">×</button>';
  pill.querySelector('button').addEventListener('click', (ev) => {
    ev.stopPropagation(); pill.remove(); syncTriggersHidden();
  });
  input.parentElement.insertBefore(pill, input);
  input.value = '';
  syncTriggersHidden();
};

// Slider-row segmented toggles: one button per value. Click writes the
// value into the sibling hidden input so the existing saveAgent() flow reads
// it. Call on page load to hydrate from state.
function initOptsToggles() {
  document.querySelectorAll('.ax-opts').forEach((grp) => {
    grp.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !grp.contains(b)) return;
      grp.querySelectorAll('button').forEach(x => x.classList.toggle('is-active', x === b));
      // Find the hidden input that the parent slider-row owns
      const row = grp.closest('.ax-slider-row');
      if (!row) return;
      const hidden = row.querySelector('input[type=hidden]');
      if (hidden) hidden.value = b.dataset.v || '';
    });
  });
}
function setOpt(field, value) {
  const v = String(value);
  document.querySelectorAll('.ax-opts[data-field="' + field + '"] button').forEach((b) => {
    b.classList.toggle('is-active', String(b.dataset.v || '') === v);
  });
  // also populate the hidden input
  const row = document.querySelector('.ax-opts[data-field="' + field + '"]')?.closest('.ax-slider-row');
  const hidden = row?.querySelector('input[type=hidden]');
  if (hidden) hidden.value = v;
}

// --- Overview ---
async function loadAgent(){
  try {
    const a = await req('GET', '/api/admin/agent/' + AGENT_ID);
    state.agent = a;

    // Hero
    const displayName = a.name || AGENT_ID;
    $('a-name').textContent = displayName;
    $('a-id').textContent = AGENT_ID;
    const crumb = $('a-crumb-name'); if (crumb) crumb.textContent = displayName;
    const ava = $('a-ava');
    if (ava) {
      // Strip the pulse dot, rewrite initials, keep the dot.
      ava.textContent = initialsOf(a.name, AGENT_ID);
      const dot = document.createElement('span');
      dot.className = 'ax-hero__on';
      ava.appendChild(dot);
    }
    // Hero chips (tier/access/public-API)
    const chipsParts = [];
    chipsParts.push('<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>online</span>');
    if (a.access === 'public') chipsParts.push('<span class="ax-pill ax-pill--info">public API</span>');
    if (a.tier) chipsParts.push('<span class="ax-pill">' + esc(a.tier) + '</span>');
    $('a-chips').innerHTML = chipsParts.join(' ');

    // Overview form
    $('f-name').value = a.name || '';
    $('f-tier').value = a.tier || 'claude-code';
    $('f-model').value = a.model || '';
    $('f-access').value = a.access || 'private';
    // Public-API hint — show endpoint + scope when access is public.
    const hintEl = document.getElementById('public-api-hint');
    if (hintEl) {
      const isPublic = a.access === 'public';
      hintEl.style.display = isPublic ? '' : 'none';
      if (isPublic) {
        const daemonUrl = (state && state.daemonUrl) || (location.origin || '').replace(':4202', ':18800');
        const urlEl = document.getElementById('public-api-url');
        const scopeEl = document.getElementById('public-api-scope');
        if (urlEl) urlEl.textContent = daemonUrl + '/api/public/agents/' + AGENT_ID + '/messages';
        if (scopeEl) scopeEl.textContent = AGENT_ID;
      }
    }
    // Also re-render when the operator flips the dropdown.
    $('f-access').addEventListener('change', () => {
      if (hintEl) hintEl.style.display = $('f-access').value === 'public' ? '' : 'none';
    }, { once: true });
    setOpt('maxConcurrent', a.maxConcurrent ?? 1);
    setOpt('maxExecutionMinutes', a.maxExecutionMinutes ?? 20);
    setOpt('permissionMode', a.permissionMode || 'default');
    renderTriggers(a.mentions || []);

    // Quick system prompt + personality editor share the systemPrompt field.
    const sp = $('sp-editor'); if (sp) sp.value = a.systemPrompt || '';

    // Stats placeholders; loadActivity() fills real numbers once the tab is visited.
    const handling = (a.runningTasks?.length) || 0;
    $('stat-handling').textContent = String(handling);

    // Capability tab — Phase 5/8 fields. Mirrors the agentx agent capability CLI.
    const intentsEl = $('cap-intents');
    if (intentsEl) {
      intentsEl.value = Array.isArray(a.intents) ? a.intents.join(', ') : '';
      $('cap-mdd').value = a.maxDelegationDepth ?? 5;
      $('cap-cref').value = a.contextReferences ? 'true' : 'false';
      $('cap-cstrat').value = a.contextStrategy || '';
      $('cap-mxm').value = a.maxExecutionMinutes ?? 20;
    }
    // MCP servers list
    const mcpListEl = document.getElementById('mcp-list');
    if (mcpListEl) {
      const mcp = a.mcp || {};
      const names = Object.keys(mcp);
      if (names.length === 0) {
        mcpListEl.innerHTML = '<div style="font-size:11px;color:var(--ax-muted);font-style:italic;padding:8px;border:1px dashed var(--ax-border);border-radius:4px">no MCP servers configured</div>';
      } else {
        mcpListEl.innerHTML = names.map(function(n){
          const s = mcp[n];
          const args = (s.args || []).map(function(x){ return esc(x); }).join(' ');
          const envCount = s.env ? Object.keys(s.env).length : 0;
          return '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--ax-border);border-radius:4px">' +
            '<div style="flex:1;min-width:0">' +
              '<div><b>' + esc(n) + '</b> <code style="font-size:11px;color:var(--ax-muted);margin-left:4px">' + esc(s.command) + ' ' + args + '</code></div>' +
              (envCount ? '<div style="font-size:11px;color:var(--ax-muted);margin-top:2px">env: ' + envCount + ' var(s)</div>' : '') +
            '</div>' +
            '<button class="ax-btn ax-btn--danger" data-mcp-rm="' + esc(n) + '">Remove</button>' +
          '</div>';
        }).join('');
        mcpListEl.querySelectorAll('[data-mcp-rm]').forEach(function(b){
          b.addEventListener('click', async function(){
            const n = b.getAttribute('data-mcp-rm');
            if (!confirm('Remove MCP server "' + n + '"?')) return;
            try {
              await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/mcp', { name: n });
              await loadAgent();
            } catch (e) { showMsg('err', e.message); }
          });
        });
      }
    }
  } catch (e) { showMsg('err', e.message); }
}

// MCP save — adds or updates one server entry on the agent.
(function(){
  const btn = document.getElementById('mcp-save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const name = document.getElementById('mcp-name').value.trim();
    const command = document.getElementById('mcp-command').value.trim();
    const argsRaw = document.getElementById('mcp-args').value.trim();
    const envRaw = document.getElementById('mcp-env').value.trim();
    const args = argsRaw ? argsRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    const env = {};
    if (envRaw) {
      envRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(pair){
        const eq = pair.indexOf('=');
        if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      });
    }
    const body = { name, command, args };
    if (Object.keys(env).length > 0) body.env = env;
    const msg = document.getElementById('mcp-msg');
    try {
      await req('POST', '/api/admin/agent/' + AGENT_ID + '/mcp', body);
      if (msg) { msg.textContent = '✓ saved — agent picks it up at next daemon boot'; msg.style.color = 'var(--ax-success)'; }
      ['mcp-name','mcp-command','mcp-args','mcp-env'].forEach(function(id){ document.getElementById(id).value = ''; });
      await loadAgent();
    } catch (e) {
      if (msg) { msg.textContent = e.message; msg.style.color = 'var(--ax-err)'; }
    }
  });
})();

// Capability save — POST to the same agent-config write path the
// CLI uses, so both surfaces persist identically. (See agentx agent
// capability in the CLI for the cli mirror.)
(function(){
  const capSaveBtn = document.getElementById('cap-save');
  if (!capSaveBtn) return;
  capSaveBtn.addEventListener('click', async () => {
    const intentsRaw = document.getElementById('cap-intents').value.trim();
    const intents = intentsRaw ? intentsRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    const body = {
      intents: intents,
      maxDelegationDepth: parseInt(document.getElementById('cap-mdd').value, 10) || 5,
      contextReferences: document.getElementById('cap-cref').value === 'true',
      maxExecutionMinutes: parseInt(document.getElementById('cap-mxm').value, 10) || 20,
    };
    const cstrat = document.getElementById('cap-cstrat').value;
    if (cstrat) body.contextStrategy = cstrat;
    const msg = document.getElementById('cap-msg');
    try {
      await req('PATCH', '/api/admin/agent/' + AGENT_ID + '/capability', body);
      if (msg) { msg.textContent = '✓ saved — restart the daemon for changes to take effect'; msg.style.color = 'var(--ax-success)'; }
      await loadAgent();
    } catch (e) {
      if (msg) { msg.textContent = e.message; msg.style.color = 'var(--ax-err)'; }
    }
  });
})();

$('btn-save-meta').addEventListener('click', async () => {
  const body = {
    name: $('f-name').value.trim(),
    tier: $('f-tier').value,
    model: $('f-model').value.trim(),
    access: $('f-access').value,
    maxConcurrent: Number($('f-maxc').value) || 1,
    maxExecutionMinutes: Number($('f-maxt').value) || 20,
    permissionMode: $('f-pmode').value,
    mentions: $('f-mentions').value.split(',').map(s=>s.trim()).filter(Boolean),
    systemPrompt: $('sp-editor').value,
  };
  try {
    await req('PATCH', '/api/admin/agent/' + AGENT_ID, body);
    showMsg('ok', 'Saved. Restart the daemon for tier/model changes to take effect.');
  } catch (e) { showMsg('err', e.message); }
});

// --- Identity (Personality tab) ---
// Vertical file list + EasyMDE editor. The file list stays docked on the
// left; clicking a file swaps the editor's contents. Unsaved edits are
// persisted per-file in state.idDrafts so switching doesn't lose them.
let idMde = null;
state.idDrafts = {};

async function loadIdentity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity');
    const host = $('identity-files-tabs');
    host.innerHTML = '';
    for (const f of r.identity) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.path = f.path;
      // Derive a small 2-3 char glyph from the filename (CLAUDE.md → CL, etc.).
      const base = (f.path.split('/').pop() || f.path).replace(/\\.md$/i, '');
      const glyph = base.slice(0, 2).toUpperCase();
      btn.innerHTML =
        '<span class="ax-f-glyph">' + esc(glyph) + '</span>' +
        '<span>' + esc(f.title) + '</span>' +
        (f.exists ? '' : '<span class="ax-f-new">new</span>');
      btn.addEventListener('click', () => {
        host.querySelectorAll('button').forEach(x => x.classList.toggle('is-active', x === btn));
        loadIdentityFile(f.path);
      });
      host.appendChild(btn);
    }
    if (r.identity.length) {
      host.firstElementChild.classList.add('is-active');
      await loadIdentityFile(r.identity[0].path);
    }
  } catch (e) { showMsg('err', e.message); }
}

function ensureIdMde() {
  if (idMde) return idMde;
  if (typeof EasyMDE === 'undefined') return null;
  const el = document.getElementById('id-editor');
  if (!el) return null;
  idMde = new EasyMDE({
    element: el, spellChecker: false, autoDownloadFontAwesome: true,
    status: ['lines','words'], autofocus: false,
    minHeight: '360px',
    toolbar: ['bold','italic','heading','|','quote','code','unordered-list','ordered-list','|','link','table','|','preview','side-by-side','fullscreen','|','guide'],
  });
  idMde.codemirror.on('change', () => {
    updateIdCharCount();
    if (state.identityPath) state.idDrafts[state.identityPath] = idMde.value();
  });
  return idMde;
}

async function loadIdentityFile(path){
  // Stash current draft before switching
  if (state.identityPath && idMde) state.idDrafts[state.identityPath] = idMde.value();
  state.identityPath = path;
  $('id-path').textContent = path;
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity/file?path=' + encodeURIComponent(path));
    const mde = ensureIdMde();
    const initial = state.idDrafts[path] !== undefined ? state.idDrafts[path] : (f.content || '');
    if (mde) mde.value(initial);
    else $('id-editor').value = initial;
    updateIdCharCount();
  } catch (e) {
    showMsg('err', e.message);
    if (idMde) idMde.value(''); else $('id-editor').value = '';
  }
}

function updateIdCharCount() {
  const val = idMde ? idMde.value() : ($('id-editor')?.value || '');
  const chars = $('id-chars');
  if (chars) chars.textContent = val.length.toLocaleString() + ' chars';
}

$('btn-save-id').addEventListener('click', async () => {
  if (!state.identityPath) return;
  const content = idMde ? idMde.value() : $('id-editor').value;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/identity/file', {
      path: state.identityPath, content,
    });
    showMsg('ok', 'Saved ' + state.identityPath);
    const note = $('id-saved-note');
    if (note) note.textContent = 'saved ' + new Date().toLocaleTimeString();
    // Clear the draft now that it's persisted
    delete state.idDrafts[state.identityPath];
  } catch (e) { showMsg('err', e.message); }
});

// --- Skills ---
async function loadSkills(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills');
    const list = $('skills-list');
    const countLabel = $('skills-count-label');
    const railCount = $('rail-skills-count');
    if (!r.skills.length) {
      list.innerHTML = '<div class="ax-empty-card" style="grid-column:1/-1;text-align:center;padding:32px;background:var(--ax-bg-elev);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><p style="margin:0;font-size:13px">No skills installed yet. Install a package below or create a new one.</p></div>';
      if (countLabel) countLabel.textContent = 'Installed';
      if (railCount) railCount.textContent = '0';
    } else {
      list.innerHTML = r.skills.map(s =>
        '<div class="ax-skill-card is-on" data-slug="' + esc(s.slug) + '">' +
          '<div class="ax-skill-card__top">' +
            '<div class="ax-skill-card__icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' +
            '</div>' +
            '<div><div class="ax-skill-card__name">' + esc(s.title || s.slug) + '</div><div class="ax-skill-card__slug">' + esc(s.slug) + '</div></div>' +
          '</div>' +
          '<div class="ax-skill-card__desc">' + esc(s.description || 'No description.') + '</div>' +
          '<div class="ax-skill-card__foot"><span>' + esc(s.source || 'installed') + '</span><span>' + esc(s.version || '') + '</span></div>' +
        '</div>'
      ).join('');
      list.querySelectorAll('[data-slug]').forEach(el =>
        el.addEventListener('click', () => selectSkill(el.dataset.slug))
      );
      if (countLabel) countLabel.textContent = 'Installed — ' + r.skills.length + ' active';
      if (railCount) railCount.textContent = String(r.skills.length);
    }
  } catch (e) { showMsg('err', e.message); }
}

async function selectSkill(slug){
  state.activeSkill = slug;
  state.activeSkillFile = null;
  document.querySelectorAll('#skills-list [data-slug]').forEach(r=>{
    r.classList.toggle('ax-skill-card--active', r.dataset.slug === slug);
  });
  // Reveal the tree + editor area and set the section label
  const wrap = $('skill-editor-wrap');
  if (wrap) wrap.style.display = 'block';
  const slugLabel = $('skill-editor-slug');
  if (slugLabel) slugLabel.textContent = slug;
  $('btn-delete-skill').disabled = false;
  $('btn-install-deps').disabled = true;
  $('sk-editor-wrap').style.display = 'none';
  $('sk-editor-empty').style.display = 'block';
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/tree?slug=' + encodeURIComponent(slug));
    $('btn-install-deps').disabled = !r.deps?.manager;
    $('btn-install-deps').title = r.deps?.command || 'No package manifest detected';
    const host = $('skill-tree');
    host.innerHTML = r.tree.map(e => {
      const depth = (e.path.match(/\\//g) || []).length;
      const pad = 'padding-left:' + (depth * 10) + 'px';
      const icon = e.kind === 'dir' ? '▸' : '·';
      const cls = 'tree-entry ' + e.kind + (e.editable ? '' : ' readonly');
      return '<div class="'+cls+'" style="'+pad+'" data-path="'+esc(e.path)+'" data-editable="'+(e.editable?'1':'0')+'">'
        + '<span>'+icon+' '+esc(e.path.split('/').filter(Boolean).pop() || e.path)+'</span>'
        + '<span style="color:var(--ax-muted);font-size:10px">'+(e.kind==='file'?formatBytes(e.size):'')+'</span>'
      + '</div>';
    }).join('');
    host.querySelectorAll('[data-path]').forEach(r=>r.addEventListener('click', ()=>{
      if (r.dataset.editable === '1') openSkillFile(r.dataset.path);
    }));
    // Auto-open SKILL.md
    const skillMd = r.tree.find(e => e.path === 'SKILL.md' && e.editable);
    if (skillMd) openSkillFile('SKILL.md');
  } catch (e) { showMsg('err', e.message); }
}

function formatBytes(n){ if (!n) return ''; if (n < 1024) return n+'b'; if (n<1048576) return (n/1024).toFixed(1)+'k'; return (n/1048576).toFixed(1)+'M'; }

async function openSkillFile(path){
  state.activeSkillFile = path;
  $('sk-path').textContent = state.activeSkill + '/' + path;
  $('sk-editor-empty').style.display = 'none';
  $('sk-editor-wrap').style.display = 'block';
  document.querySelectorAll('#skill-tree [data-path]').forEach(r=>r.classList.toggle('active', r.dataset.path === path));
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/file?slug=' + encodeURIComponent(state.activeSkill) + '&path=' + encodeURIComponent(path));
    $('sk-editor').value = f.content || '';
  } catch (e) { showMsg('err', e.message); }
}

$('btn-save-sk').addEventListener('click', async () => {
  if (!state.activeSkill || !state.activeSkillFile) return;
  const content = $('sk-editor').value;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/skills/file', {
      slug: state.activeSkill, path: state.activeSkillFile, content,
    });
    showMsg('ok', 'Saved ' + state.activeSkill + '/' + state.activeSkillFile);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-new-skill').addEventListener('click', async () => {
  const slug = prompt('New skill slug (lowercase, letters/digits/-/_):');
  if (!slug) return;
  try {
    await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
    showMsg('ok', 'Skill created: ' + slug);
    await loadSkills();
    selectSkill(slug);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-delete-skill').addEventListener('click', () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  confirmAction(
    'Delete skill "' + slug + '"?',
    'This removes .claude/skills/' + slug + ' and all files inside it. This cannot be undone.',
    async () => {
      try {
        await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
        state.activeSkill = null;
        state.activeSkillFile = null;
        $('skill-tree').innerHTML = '';
        $('sk-editor-wrap').style.display = 'none';
        $('sk-editor-empty').style.display = 'block';
        $('btn-delete-skill').disabled = true;
        $('btn-install-deps').disabled = true;
        showMsg('ok', 'Deleted ' + slug);
        loadSkills();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

$('btn-install-pkg').addEventListener('click', () => {
  const pkg = $('pkg-input').value.trim();
  if (!pkg) { showMsg('err', 'Enter a package like "owner/repo".'); return; }
  const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
  confirmAction(
    'Install skills.sh package?',
    'Package: ' + pkg + '\\n\\nWorker agent: ' + worker + '\\n\\nThe worker will run: npx skills add ' + pkg + '\\n\\nInside: ' + (state.agent?.workspace || '(agent workspace)') + '\\n\\nOutput will appear below.',
    async () => {
      $('dispatch-output').style.display = 'block';
      $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
      try {
        const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/install', { package: pkg });
        $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        loadSkills();
      } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
    }
  );
});

$('btn-install-deps').addEventListener('click', async () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  try {
    const hint = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/deps?slug=' + encodeURIComponent(slug));
    if (!hint.manager) { showMsg('err', 'No package manifest in skill dir.'); return; }
    const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
    confirmAction(
      'Install dependencies?',
      'Skill: ' + slug + '\\nManifest: ' + hint.file + '\\nCommand: ' + hint.command + '\\n\\nWorker agent: ' + worker + '\\n\\nRunning install scripts executes third-party code. Confirm only if you trust this skill\\'s source.',
      async () => {
        $('dispatch-output').style.display = 'block';
        $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
        try {
          const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/deps', { slug });
          $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
      }
    );
  } catch (e) { showMsg('err', e.message); }
});

// --- Channels + Activity ---
const CH_LOGO = {
  telegram: { bg: '#229ED9', init: 'TG' },
  whatsapp: { bg: '#25D366', init: 'WA' },
  slack:    { bg: '#4A154B', init: 'SL' },
  discord:  { bg: '#5865F2', init: 'DC' },
  gitlab:   { bg: '#FC6D26', init: 'GL' },
  github:   { bg: '#24292e', init: 'GH' },
  webhook:  { bg: 'var(--ax-surface-3)', init: 'WH' },
};

async function loadChannels(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/channels');
    const host = $('channels-list');
    const railCount = $('rail-channels-count');
    if (railCount) railCount.textContent = String(r.bindings.length);
    if (!r.bindings.length) {
      host.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:32px;background:var(--ax-bg-elev);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><p style="margin:0;font-size:13px">No channels route to this agent yet. <a href="/admin#channels">Wire one up in Settings → Channels</a>.</p></div>';
      return;
    }
    host.innerHTML = r.bindings.map((b) => {
      const meta = CH_LOGO[b.channel] || { bg: 'var(--ax-surface-3)', init: b.channel.slice(0, 2).toUpperCase() };
      return '<div class="ax-chan-row">' +
        '<div class="ax-chan-row__logo" style="background:' + meta.bg + '">' + meta.init + '</div>' +
        '<div class="ax-chan-row__info">' +
          '<div class="ax-chan-row__name">' + esc(b.channel) + (b.account ? ' · ' + esc(b.account) : '') + '</div>' +
          '<div class="ax-chan-row__desc">' + esc(b.detail || '—') + '</div>' +
        '</div>' +
        '<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>bound</span>' +
      '</div>';
    }).join('');
  } catch (e) { showMsg('err', e.message); }
}

async function loadHandovers(){
  try {
    // Populate the "Transfer to" dropdown with every local agent except self.
    const targets = $('ho-target');
    if (!targets.options.length) {
      const raw = await fetch('/api/admin/state', { headers: window.AX_LOCAL_TOKEN ? { Authorization: 'Bearer ' + window.AX_LOCAL_TOKEN } : {} });
      const st = await raw.json();
      targets.innerHTML = '<option value="">Pick a target…</option>' + (st.agents || [])
        .filter(a => a.id !== AGENT_ID)
        .map(a => '<option value="'+esc(a.id)+'" data-name="'+esc(a.name || a.id)+'">'+esc(a.name || a.id)+'</option>')
        .join('');
      targets.addEventListener('change', () => {
        const sel = targets.options[targets.selectedIndex];
        const name = sel?.dataset?.name || sel?.textContent || '—';
        const id = targets.value;
        $('ho-to-nm').textContent = name;
        $('ho-to-av').textContent = id ? initialsOf(name, id) : '—';
      });
    }
    // Hydrate the "from" side from the current agent
    const a = state.agent;
    if (a) {
      $('ho-from-av').textContent = initialsOf(a.name, AGENT_ID);
      $('ho-from-nm').textContent = a.name || AGENT_ID;
    }
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/handovers');
    const railCount = $('rail-handovers-count');
    if (railCount) railCount.textContent = String((r.incoming?.length || 0) + (r.outgoing?.length || 0));
    renderHandoverList($('ho-incoming'), r.incoming, 'incoming');
    renderHandoverList($('ho-outgoing'), r.outgoing, 'outgoing');
  } catch (e) { showMsg('err', e.message); }
}

function renderHandoverList(host, list, direction){
  if (!list.length) {
    host.innerHTML = '<div style="text-align:center;padding:20px;color:var(--ax-muted);font-size:12.5px;font-style:italic">' + (direction === 'incoming'
      ? 'No chats are currently routed to this agent.'
      : 'No chats are currently routed away from this agent.') + '</div>';
    return;
  }
  host.innerHTML = list.map(o => {
    const who = direction === 'incoming'
      ? '<b>' + esc(o.chatId) + '</b> from <b>' + esc(o.fromAgent) + '</b>'
      : '<b>' + esc(o.chatId) + '</b> → handed to <b>' + esc(o.toAgent) + '</b>';
    const expires = o.expiresAt ? 'expires ' + esc(o.expiresAt) : 'never expires';
    const consumed = o.summaryConsumedAt ? ' · briefing delivered' : (o.summary ? ' · briefing pending' : '');
    return '<div class="ax-ho-list-row">' +
      '<span class="ax-pill ax-pill--info">' + esc(o.channel) + '</span>' +
      '<span class="ax-who">' + who + consumed + '</span>' +
      '<span class="ax-when">' + esc(o.createdAt) + ' · ' + expires + '</span>' +
      '<button class="ax-btn ax-btn--danger" data-release="' + esc(o.channel) + '::' + esc(o.chatId) + '::' + esc(o.accountId || '') + '">Release</button>' +
    '</div>';
  }).join('');
  host.querySelectorAll('[data-release]').forEach(btn => btn.addEventListener('click', () => {
    const [ch, cid, acct] = btn.dataset.release.split('::');
    releaseHandover(ch, cid, acct || undefined);
  }));
}

async function releaseHandover(channel, chatId, accountId){
  if (!confirm('Release the handover for ' + channel + ':' + chatId + '? Routing will revert to the config default on the next message.')) return;
  try {
    await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/handovers', { channel, chatId, accountId });
    showMsg('ok', 'Handover released.');
    loadHandovers();
  } catch (e) { showMsg('err', e.message); }
}

$('btn-handover').addEventListener('click', () => {
  const channel = $('ho-channel').value;
  const chatId = $('ho-chatid').value.trim();
  const accountId = $('ho-account').value.trim() || undefined;
  const toAgent = $('ho-target').value;
  const summary = $('ho-summary').value.trim() || undefined;
  const expiresAt = $('ho-expires').value.trim() || undefined;
  if (!chatId || !toAgent) { showMsg('err', 'chat id and target agent are required'); return; }
  confirmAction(
    'Hand off this chat?',
    channel + ':' + chatId + (accountId ? ':'+accountId : '') + '\\n\\n'
    + 'From: ' + AGENT_ID + '\\nTo: ' + toAgent + '\\n\\n'
    + 'Every next message from this chat will be routed to ' + toAgent + ' until you release the handover. '
    + (summary ? 'The target agent will see your briefing note on its first reply.' : 'No briefing note set — the target agent will not know why.'),
    async () => {
      try {
        await req('POST', '/api/admin/agent/' + AGENT_ID + '/handovers',
          { channel, chatId, accountId, toAgent, summary, expiresAt });
        $('ho-summary').value = '';
        showMsg('ok', 'Handed off.');
        loadHandovers();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

async function loadActivity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/activity');
    const host = $('activity');
    host.innerHTML =
      '<div class="ax-activity-grid">' +
        '<div class="ax-activity-cell"><div class="ax-v">' + (r.totalTasks ?? 0) + '</div><div class="ax-l">Total tasks</div></div>' +
        '<div class="ax-activity-cell"><div class="ax-v">' + (r.activeTasks ?? 0) + '</div><div class="ax-l">Handling now</div></div>' +
        '<div class="ax-activity-cell"><div class="ax-v">' + (r.errors ?? 0) + '</div><div class="ax-l">Errors</div></div>' +
        '<div class="ax-activity-cell"><div class="ax-v" style="font-size:13px;font-family:var(--ax-mono)">' + esc(r.lastActive || '—') + '</div><div class="ax-l">Last active</div></div>' +
      '</div>' +
      (r.lastSummary
        ? '<div class="ax-sec-label-d"><h3>Last reply</h3></div>' +
          '<div style="background:var(--ax-bg-elev);border:1px solid var(--ax-border);border-radius:var(--ax-radius-sm);padding:14px;font-size:12.5px;color:var(--ax-text-2);line-height:1.6">' +
            esc((r.lastSummary.text || '').slice(0, 400)) +
          '</div>'
        : '');
    // Update hero stats from the activity payload.
    const sToday = $('stat-today'); if (sToday) sToday.textContent = String(r.totalTasks ?? '—');
    const sHand = $('stat-handling'); if (sHand) sHand.textContent = String(r.activeTasks ?? 0);
  } catch (e) { showMsg('err', e.message); }
}

/* ===== Test drive (sandbox chat) ===== */
let __tdBusy = false;
function appendTdBubble(kind, text, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'ax-td-chat__msg-wrap is-' + kind;
  wrap.innerHTML =
    '<div class="ax-td-chat__bubble is-' + kind + '">' + esc(text) + '</div>' +
    '<div class="ax-td-chat__meta">' + esc(meta || '') + '</div>';
  const chat = $('td-chat');
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}
function appendTdTyping() {
  const el = document.createElement('div');
  el.className = 'ax-td-chat__typing';
  el.id = 'td-typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  $('td-chat').appendChild(el);
  $('td-chat').scrollTop = $('td-chat').scrollHeight;
}
function removeTdTyping() {
  const el = document.getElementById('td-typing');
  if (el) el.remove();
}

window.sendScenario = function(text) {
  const inp = $('td-input-el');
  if (inp) inp.value = text;
  dispatchTd(text);
};
window.sendTestMessage = function(e) {
  e.preventDefault();
  const inp = $('td-input-el');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  dispatchTd(text);
};
async function dispatchTd(text) {
  if (__tdBusy) return;
  __tdBusy = true;
  const now = new Date().toLocaleTimeString();
  appendTdBubble('user', text, now + ' · you');
  appendTdTyping();
  const t0 = Date.now();
  try {
    const r = await req('POST', '/task', { agent: AGENT_ID, message: text, context: { channel: 'test-drive', sender: 'admin-ui' } });
    removeTdTyping();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    appendTdBubble('bot', r.content || '(empty reply)', new Date().toLocaleTimeString() + ' · ' + elapsed);
  } catch (e) {
    removeTdTyping();
    appendTdBubble('bot', '[error] ' + e.message, 'failed');
  } finally {
    __tdBusy = false;
  }
}

/* ===== Delete agent ===== */
$('btn-delete-agent')?.addEventListener('click', () => {
  confirmAction(
    'Delete this agent?',
    'Agent "' + AGENT_ID + '" will be removed from agentx.json. The workspace folder on disk is preserved; the config entry is gone. You will need to recreate it from scratch to bring it back.',
    async () => {
      try {
        await req('DELETE', '/api/admin/agents', { id: AGENT_ID });
        window.location.href = '/admin';
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

/* ===== Test-drive side panel: open/close ===== */
function openTestDrive() {
  const p = $('td-panel');
  if (!p) return;
  p.classList.add('is-open');
  p.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('td-input-el')?.focus(), 250);
}
function closeTestDrive() {
  const p = $('td-panel');
  if (!p) return;
  p.classList.remove('is-open');
  p.setAttribute('aria-hidden', 'true');
}
$('btn-test-drive')?.addEventListener('click', openTestDrive);
$('td-close')?.addEventListener('click', closeTestDrive);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('td-panel')?.classList.contains('is-open')) closeTestDrive();
});

/* ===== Boot ===== */
initOptsToggles();
loadAgent();
`
