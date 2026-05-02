// --- Admin page (/admin) ---
//
// Single-file settings surface with seven tabs rendered in-place via a
// client-side data-tab switcher:
//   Agents / Channels / Schedules / Webhooks / Mesh / Tokens / Advanced
//
// API is in admin-panel.ts; this module owns the HTML + CSS + client JS only.
//
// ### Why a single file (for now)
//
// The tabs share: a common data-fetch-and-render pipeline, the peer banner,
// the files modal, and mutation helpers. Splitting them into seven files
// would force those cross-tab primitives into a shared helper with a
// wider interface; the savings aren't worth the ceremony at this size.
// When the page grows past ~3k lines again, a tab-by-tab split becomes
// worth the cost — the scaffold is already ready for it under
// ui/pages/admin/<tab>.ts.

import {
  renderShell,
  pageHead, healthStrip, witBanner, sectionHead, secLabel,
  TOAST_HTML, TOAST_SCRIPT, ROW_CARD_SCRIPT,
  type TopbarPeer,
} from ".."

/** Feather-style stroked icons for each section head. Kept together at the
 *  top so we can swap the icon set in one place if/when the design calls
 *  for a change. */
const ICONS = {
  agents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>`,
  channels: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  schedules: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  webhooks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a3 3 0 1 0 3-3m-8 11a3 3 0 1 0 2.6-1.5L10 12m7 3a3 3 0 1 0-2-5.5"/></svg>`,
  mesh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><path d="M7.4 7.4l3.2 3.2M13.4 13.4l3.2 3.2M16.6 7.4l-3.2 3.2M10.6 13.4l-3.2 3.2"/></svg>`,
  tokens: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-8 8a4 4 0 1 1-6 6m6-6l5-5 3 3-5 5m-3-3l3 3"/></svg>`,
  advanced: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 13l2 2 4-4"/></svg>`,
}

export interface AdminPageOpts {
  peers?: TopbarPeer[]
  currentPeerId?: string
  localToken?: string
}

export function renderAdminPage(opts: AdminPageOpts = {}): string {
  const tokenScript = opts.localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(opts.localToken)};</script>`
    : ""

  // New page chrome — sits above the peer banner + tabs. Placeholder values
  // for the health strip live here; ADMIN_HEALTH_SCRIPT populates them from
  // /api/admin/config once the page loads.
  const chrome = pageHead({
    kicker: "Settings",
    title: "Your team's control room",
    lead: `Manage the agents, the places they answer from, and who's allowed to reach them. Everything here writes to <span class="mono muted">agentx.json</span> on your machine — nothing leaves.`,
  }) + healthStrip([
    { kind: "off", num: "—", label: "Agents online" },
    { kind: "off", num: "—", label: "Channels connected" },
    { kind: "off", num: "0", label: "Needs attention" },
    { kind: "off", num: "—", label: "Active tokens" },
  ]).replace(
    "<div class=\"ax-health-strip\">",
    `<div class="ax-health-strip" id="ax-health">`,
  )

  return renderShell({
    title: "AgentX · Settings",
    activeTab: "admin",
    subtitle: "Settings",
    peers: opts.peers,
    currentPeerId: opts.currentPeerId,
    noMain: true,
    body: chrome + ADMIN_PAGE_BODY + TOAST_HTML,
    css: ADMIN_PAGE_CSS,
    scripts: `${tokenScript}<script>${TOAST_SCRIPT}\n${ROW_CARD_SCRIPT}\n${ADMIN_HEALTH_SCRIPT}\n${ADMIN_PAGE_SCRIPT}</script>`,
  })
}

// Populates the 4-up health strip + tab count bubbles from the same
// /api/admin/config payload the main admin script already fetches. Runs
// after the admin bootstrap attaches state under window.__AX_ADMIN.
const ADMIN_HEALTH_SCRIPT = `
(function(){
  function fmt(n) { return n == null ? '—' : String(n); }
  async function refresh() {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.AX_LOCAL_TOKEN) headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
      const r = await fetch('/api/admin/config', { headers });
      if (!r.ok) return;
      const cfg = await r.json();
      const agents = Object.keys(cfg.agents || {});
      const channels = cfg.channels || {};
      const channelDefs = ['telegram','whatsapp','slack','discord','gitlab','github'];
      const enabled = channelDefs.filter(c => channels[c] && channels[c].enabled).length;
      const crons = Object.keys(cfg.crons || {}).length;
      const webhooks = Object.keys(cfg.webhooks || {}).length;
      const meshPeers = (cfg.mesh && Array.isArray(cfg.mesh.peers) ? cfg.mesh.peers.length : 0);

      // Health strip numbers
      const strip = document.getElementById('ax-health');
      if (strip) {
        const cards = strip.querySelectorAll('.ax-health-card');
        const setCard = (i, num, kind) => {
          const c = cards[i]; if (!c) return;
          const n = c.querySelector('.ax-hc-num'); if (n) n.textContent = fmt(num);
          const d = c.querySelector('.ax-hc-dot');
          if (d) { d.className = 'ax-hc-dot ax-hc-dot--' + kind; }
        };
        setCard(0, agents.length, agents.length > 0 ? 'ok' : 'off');
        setCard(1, enabled + '/' + channelDefs.length, enabled > 0 ? 'ok' : 'off');
        // "Needs attention" is a placeholder until we surface real warnings.
        setCard(2, 0, 'off');
        const tokenCount = Array.isArray(cfg.tokens) ? cfg.tokens.length : 0;
        setCard(3, tokenCount, tokenCount > 0 ? 'ok' : 'off');
      }

      // Tab counts
      const setCount = (tab, val) => {
        const btn = document.querySelector('nav.tabs button[data-tab="' + tab + '"]');
        if (!btn) return;
        let c = btn.querySelector('.ax-tab-count');
        if (!c) {
          c = document.createElement('span');
          c.className = 'ax-tab-count';
          btn.appendChild(document.createTextNode(' '));
          btn.appendChild(c);
        }
        c.textContent = String(val);
      };
      setCount('agents', agents.length);
      setCount('channels', enabled + '/' + channelDefs.length);
      setCount('crons', crons);
      setCount('webhooks', webhooks);
      setCount('mesh', meshPeers);
      const tokenCount = Array.isArray(cfg.tokens) ? cfg.tokens.length : 0;
      setCount('tokens', tokenCount);
    } catch (e) { /* best-effort */ }
  }
  refresh();
  // Refresh again after the main admin script has had a chance to mutate config.
  document.addEventListener('ax-config-saved', refresh);
})();`

const ADMIN_PAGE_BODY = `
<div id="peer-banner" class="peer-banner">
  <span class="label">Managing</span>
  <span class="name" id="peer-banner-name">—</span>
  <span>from this dashboard via scoped token.</span>
  <span class="spacer"></span>
  <button id="peer-banner-back">← Back to primary</button>
</div>
<nav class="tabs">
  <button data-tab="agents" class="active">Agents</button>
  <button data-tab="channels">Channels</button>
  <button data-tab="crons">Schedules</button>
  <button data-tab="webhooks">Webhooks</button>
  <button data-tab="mesh">Mesh</button>
  <button data-tab="team">Team</button>
  <button data-tab="business">Business</button>
  <button data-tab="boards-cfg">Boards</button>
  <button data-tab="tokens">Tokens</button>
  <button data-tab="advanced">Advanced</button>
</nav>
<div id="files-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="width:min(960px,94vw);height:min(720px,90vh)">
    <header>
      <span class="chip-small" id="files-tab-label">Identity</span>
      <h3 id="files-title">Agent · Files</h3>
      <nav style="display:flex;gap:0;margin-right:10px">
        <button class="ghost" id="files-tab-identity" style="padding:6px 12px;font-size:12px;border-top-right-radius:0;border-bottom-right-radius:0">Identity</button>
        <button class="ghost" id="files-tab-skills" style="padding:6px 12px;font-size:12px;border-top-left-radius:0;border-bottom-left-radius:0;border-left:none">Skills</button>
      </nav>
      <button class="td-close" id="files-close" aria-label="Close">×</button>
    </header>
    <div class="files-split">
      <aside class="files-picker" id="files-picker"></aside>
      <div class="files-editor">
        <div id="files-editor-empty" class="files-editor-empty">Pick a file on the left to open it.</div>
        <div id="files-editor-head" class="files-editor-head" style="display:none">
          <span class="path" id="files-current-path"></span>
          <label class="ghost" style="padding:6px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--ax-border-2);border-radius:4px">
            ↑ Upload<input type="file" id="files-upload" accept=".md,.markdown,.txt,text/markdown,text/plain" style="display:none" />
          </label>
          <button class="ghost" id="files-revert" style="padding:6px 10px;font-size:12px">Revert</button>
          <button class="primary" id="files-save" style="padding:6px 14px;font-size:12px">Save</button>
        </div>
        <div class="files-editor-body" style="display:none" id="files-editor-wrap">
          <textarea id="files-editor" spellcheck="false"></textarea>
        </div>
        <div id="files-save-msg" class="msg" style="margin:10px 16px"></div>

        <div id="files-add-skill" class="files-add" style="display:none">
          <h4>Add a skill</h4>
          <div class="rowf">
            <div><label>Slug<span class="hint">(lowercase)</span></label><input id="skill-slug" placeholder="my-skill" /></div>
            <div><label>Title<span class="hint">(optional)</span></label><input id="skill-title" placeholder="What the skill does" /></div>
          </div>
          <label>Upload SKILL.md<span class="hint">(optional — otherwise we scaffold a template)</span></label>
          <input id="skill-file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" />
          <div class="actions"><button class="primary" onclick="addSkill()">Create</button><div id="skill-msg" class="msg"></div></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="tg-edit-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="height:auto;max-height:90vh;width:min(520px,94vw)">
    <header>
      <span class="chip-small">Edit</span>
      <h3 id="tg-edit-title">Telegram account</h3>
      <button class="td-close" id="tg-edit-close" aria-label="Close">×</button>
    </header>
    <div style="flex:1;overflow-y:auto;padding:16px 20px">
      <input type="hidden" id="tg-edit-id" />
      <label>Bind to agent</label>
      <select id="tg-edit-agent"></select>
      <label>Bot username<span class="hint">(optional)</span></label>
      <input id="tg-edit-user" placeholder="my_bot" />
      <label>Bot token env-var<span class="hint">(e.g. <code>TG_SUPPORT_BOT_TOKEN</code>)</span></label>
      <input id="tg-edit-env" placeholder="TG_SUPPORT_BOT_TOKEN" />
      <div class="hint-block">Token value stays in <code>.env</code>; this panel only edits the reference name.</div>
      <div id="tg-edit-msg" class="msg"></div>
    </div>
    <div class="td-footer" style="justify-content:flex-end">
      <button class="ghost" id="tg-edit-cancel" style="padding:7px 14px">Cancel</button>
      <button class="primary" id="tg-edit-save">Save changes</button>
    </div>
  </div>
</div>

<div id="edit-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="height:auto;max-height:90vh;width:min(560px,94vw)">
    <header>
      <span class="chip-small">Edit</span>
      <h3 id="edit-title">Agent</h3>
      <button class="td-close" id="edit-close" aria-label="Close">×</button>
    </header>
    <div style="flex:1;overflow-y:auto;padding:16px 20px">
      <div class="rowf">
        <div><label>Name</label><input id="e-name" /></div>
        <div><label>AI engine</label><select id="e-tier"><option value="claude-code">Claude Code</option><option value="sdk">Anthropic API (SDK)</option><option value="orchestrator">Orchestrator</option></select></div>
      </div>
      <label>Model<span class="hint">(optional)</span></label>
      <input id="e-model" />
      <label>Trigger words<span class="hint">(comma or space separated)</span></label>
      <input id="e-triggers" />
      <label>Personality / system prompt</label>
      <textarea id="e-personality" rows="5"></textarea>
      <div class="rowf">
        <div><label>Max concurrent tasks</label><input id="e-max-concurrent" type="number" min="1" max="20" /></div>
        <div><label>Max execution (minutes)</label><input id="e-max-exec" type="number" min="1" max="240" /></div>
      </div>
      <label>Permission mode<span class="hint">(default / bypassPermissions / plan)</span></label>
      <select id="e-perm"><option value="default">default</option><option value="bypassPermissions">bypassPermissions</option><option value="plan">plan</option></select>
      <label class="toggle-switch" style="margin-top:12px"><input type="checkbox" id="e-access" /> <span>Expose via public API</span></label>
      <div id="e-msg" class="msg"></div>
    </div>
    <div class="td-footer" style="justify-content:flex-end">
      <button class="ghost" id="edit-cancel" style="padding:7px 14px">Cancel</button>
      <button class="primary" id="edit-save">Save changes</button>
    </div>
  </div>
</div>
<div id="td-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true">
    <header>
      <span class="chip-small">Test drive</span>
      <h3 id="td-title">Agent</h3>
      <button class="td-close" id="td-close" aria-label="Close">×</button>
    </header>
    <div id="td-body" class="td-body"><div class="td-empty">Send a message to sanity-check this agent before wiring it to a real channel.</div></div>
    <div class="td-footer">
      <textarea id="td-input" placeholder="Message the agent…  (Cmd/Ctrl-Enter to send)" rows="1"></textarea>
      <button id="td-send">Send</button>
    </div>
    <div class="td-hint" id="td-hint"></div>
  </div>
</div>
<main>
  <div id="global-msg" class="msg"></div>

  <section id="tab-agents" class="tab active">
    ${sectionHead({
      icon: ICONS.agents,
      title: "Your agents",
      lead: "Each agent is a role with its own trigger words and workspace. Delete removes the config only — the folder on disk stays.",
    })}
    ${witBanner({
      persistKey: "agents",
      bodyHtml: `<b>What's an agent, exactly?</b> Think of it as a specialised teammate. A sales agent handles pricing questions, a support agent answers tickets, a reports agent sends a weekly summary. You decide what they do and what to say to wake them up (their "trigger words", like <code>@support</code>).`,
    })}
    <div id="agent-list" class="ax-stack"></div>
    <div class="add-form">
      <h3>Add a new agent</h3>
      <div class="rowf">
        <div><label>Agent id<span class="hint">(lowercase)</span></label><input id="a-id" placeholder="sales" /></div>
        <div><label>Agent name</label><input id="a-name" placeholder="Sales Bot" /></div>
      </div>
      <label>Trigger words<span class="hint">(comma or space separated)</span></label>
      <input id="a-triggers" placeholder="@sales, sales" />
      <div class="rowf">
        <div><label>AI engine</label><select id="a-tier"><option value="claude-code">Claude Code</option><option value="sdk">Anthropic API (SDK)</option></select></div>
        <div><label>Model<span class="hint">(optional)</span></label><input id="a-model" placeholder="claude-sonnet-4-6" /></div>
      </div>
      <label>Personality / instructions<span class="hint">(optional)</span></label>
      <textarea id="a-personality" placeholder="You are a sales agent for Acme. Qualify leads, route pricing questions to @support."></textarea>
      <label class="toggle-switch" style="margin-top:12px"><input type="checkbox" id="a-public" /> <span>Expose via public API (needs a token with <code>agent:&lt;id&gt;</code> scope)</span></label>
      <div class="actions"><button class="primary" onclick="addAgent()">Add agent</button><div id="a-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-channels" class="tab">
    ${sectionHead({
      icon: ICONS.channels,
      title: "Where your agents show up",
      lead: "Connect a chat app, and your agents can answer from there. Set up once — they'll keep working in the background.",
    })}
    ${witBanner({
      persistKey: "channels",
      bodyHtml: `<b>How does this work?</b> We give each channel a small "bridge" that forwards messages to AgentX. For chat apps (Telegram, Slack, Discord) you'll paste a bot token — we keep the value in your <code>.env</code> file and never send it over the network. For webhook-style sources (GitHub, GitLab) we hand you a URL to paste into their dashboard.`,
    })}

    <details class="add-form" style="margin-top:14px;margin-bottom:18px" id="notif-section">
      <summary class="primary">⚙ Notifications routing</summary>
      <div style="margin-top:10px">
        <p style="font-size:11px;color:var(--ax-muted);margin:0 0 10px">Where AgentX pings you when a task finishes, errors, or runs long. Mirrors <code>agentx notifications</code>.</p>
        <div id="notif-current" style="font-size:12px;margin-bottom:10px;padding:8px 10px;background:var(--ax-surface);border-radius:4px;color:var(--ax-muted)">—</div>
        <label>Channel<span class="hint">(telegram | whatsapp | slack | discord — leave blank to clear)</span></label>
        <input id="notif-channel" placeholder="telegram" />
        <label>Chat id</label>
        <input id="notif-chat-id" placeholder="-1001234567890" />
        <label>Account id <span class="hint">(optional — when the channel is multi-account, e.g. multiple Telegram bots)</span></label>
        <input id="notif-account-id" placeholder="default" />
        <label>Long-task threshold (seconds) <span class="hint">(0 disables long-task pings)</span></label>
        <input id="notif-threshold" type="number" min="0" max="3600" />
        <fieldset style="margin-top:8px;border:1px solid var(--ax-border);border-radius:4px;padding:8px 10px">
          <legend style="font-size:11px;color:var(--ax-muted);padding:0 4px">Events to ping on</legend>
          <label class="ax-inline" style="display:inline-flex;gap:6px;font-size:12px;margin-right:14px"><input type="checkbox" id="notif-on-complete" /> task complete</label>
          <label class="ax-inline" style="display:inline-flex;gap:6px;font-size:12px;margin-right:14px"><input type="checkbox" id="notif-on-error" /> task error</label>
          <label class="ax-inline" style="display:inline-flex;gap:6px;font-size:12px"><input type="checkbox" id="notif-on-queued" /> task queued</label>
        </fieldset>
        <div class="actions" style="margin-top:10px">
          <button class="primary" onclick="saveNotifications()">Save notifications</button>
          <button class="ghost" onclick="clearNotificationsDestination()">Clear destination</button>
          <div id="notif-msg" class="msg"></div>
        </div>
      </div>
    </details>

    <div id="ch-chatapps-label">${secLabel({ label: "Chat apps" })}</div>
    <div class="ax-connectors" id="ch-chatapps"></div>

    <div id="ch-devtools-label">${secLabel({ label: "Developer tools", rightHtml: `<span class="ax-pill">Send events from GitHub, GitLab, Sentry, etc.</span>` })}</div>
    <div class="ax-connectors" id="ch-devtools"></div>

    <!-- Active-channel configuration panes. One shows at a time; clicking
         a connector card above flips the 'hidden' attribute on the
         matching div. Existing render* pipelines still populate these by id. -->
    <div id="ch-panes" style="margin-top:22px">
      <div id="ch-telegram" hidden><div id="tg-section" class="section-block"></div></div>
      <div id="ch-whatsapp" hidden></div>
      <div id="ch-slack" hidden><div id="slack-section" class="section-block"></div></div>
      <div id="ch-discord" hidden></div>
      <div id="ch-gitlab" hidden></div>
      <div id="ch-github" hidden></div>
    </div>
  </section>

  <section id="tab-crons" class="tab">
    ${sectionHead({
      icon: ICONS.schedules,
      title: "Schedules",
      lead: "Make an agent do something on a timer — no one has to ask. Daily summaries, weekly reports, hourly health checks.",
    })}
    ${witBanner({
      persistKey: "crons",
      bodyHtml: `<b>What's a good schedule?</b> Anything recurring. A <i>Reports agent</i> sending Monday-morning numbers, a <i>Health agent</i> pinging you at 3am if a server's down, a <i>Standup agent</i> reminding the team. Pick a time below.`,
    })}
    <div id="cron-list" class="ax-stack" style="margin-bottom:22px"></div>

    <div class="ax-builder">
      <!-- Hidden fields shared between guided + expert modes. addCron()
           reads these canonical ids; the mode-specific inputs mirror
           their values in. -->
      <select id="c-agent" style="display:none"></select>
      <h3>Create a new schedule</h3>
      <p class="ax-builder__hint">Build your timing here. Switch to expert mode if you'd rather type a cron expression.</p>
      <div class="ax-mode-switch" id="sched-mode">
        <button data-mode="simple" class="is-active">Guided</button>
        <button data-mode="expert">Expert (cron)</button>
      </div>

      <!-- Guided mode — sentence builder. The pill-picks emit a cron
           string into the hidden #c-schedule input used by addCron(). -->
      <div id="sched-simple">
        <div class="ax-sentence">
          <span>Run</span>
          <select class="ax-pill-pick" id="s-agent"></select>
          <select class="ax-pill-pick" id="s-freq">
            <option value="daily">every day</option>
            <option value="weekly" selected>every week</option>
            <option value="weekdays">every weekday</option>
            <option value="hourly">every hour</option>
            <option value="15min">every 15 minutes</option>
          </select>
          <div id="s-days" class="ax-day-picker">
            <button data-day="1">M</button><button data-day="2">T</button><button data-day="3">W</button><button data-day="4">T</button><button data-day="5">F</button><button data-day="6">S</button><button data-day="0">S</button>
          </div>
          <span id="s-at" class="ax-sentence__when">at</span>
          <select class="ax-pill-pick ax-pill-pick--sm" id="s-hour">
            <option>6:00 am</option><option>7:00 am</option><option>8:00 am</option>
            <option selected>9:00 am</option><option>10:00 am</option><option>11:00 am</option>
            <option>12:00 pm</option><option>1:00 pm</option><option>2:00 pm</option>
            <option>3:00 pm</option><option>4:00 pm</option><option>5:00 pm</option>
            <option>6:00 pm</option><option>7:00 pm</option><option>8:00 pm</option>
            <option>9:00 pm</option><option>10:00 pm</option>
          </select>
        </div>

        <label class="ax-builder__lbl">Give it a name <span class="opt">lowercase, no spaces</span></label>
        <input class="ax-builder__inp" id="c-id" placeholder="weekly-sales-digest" />

        <label class="ax-builder__lbl">What should the agent do?</label>
        <textarea class="ax-builder__inp" id="c-prompt" placeholder="Send me the weekly sales summary, with the top 3 wins and anything that regressed."></textarea>

        <div class="ax-preview-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span id="s-preview-text"></span>
        </div>

        <div style="display:flex;gap:8px;margin-top:16px;align-items:center">
          <button class="ax-btn ax-btn--primary" onclick="addCron()">Add schedule</button>
          <div id="c-msg" class="msg"></div>
          <div style="flex:1"></div>
          <span class="muted" style="font-size:11.5px">Cron equivalent: <span class="mono" style="color:var(--ax-text-2)" id="s-cron-echo">0 9 * * 1</span></span>
        </div>
      </div>

      <!-- Expert mode — original cron + prompt form. Shares the #c-id /
           #c-prompt / #c-agent fields with guided mode so addCron() is
           mode-agnostic. -->
      <div id="sched-expert" style="display:none">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="ax-builder__lbl">Schedule id <span class="opt">lowercase, no spaces</span></label>
            <input class="ax-builder__inp" id="c-id-expert" placeholder="weekly-report" />
          </div>
          <div>
            <label class="ax-builder__lbl">Agent</label>
            <select class="ax-builder__inp" id="c-agent-expert"></select>
          </div>
        </div>
        <label class="ax-builder__lbl">Cron expression <span class="opt">standard five-field cron</span></label>
        <input class="ax-builder__inp mono" id="c-schedule" value="0 9 * * 1" />
        <div id="c-preview" class="ax-preview-box" style="margin-top:10px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span id="c-preview-text">At 9:00 AM, only on Monday</span>
        </div>
        <div class="ax-cron-hints">
          <div><code>0 9 * * 1</code>Mondays at 9am</div>
          <div><code>*/15 * * * *</code>Every 15 minutes</div>
          <div><code>0 0 1 * *</code>First of every month</div>
          <div><code>0 17 * * 5</code>Fridays at 5pm</div>
        </div>
        <label class="ax-builder__lbl" style="margin-top:12px">Prompt</label>
        <textarea class="ax-builder__inp" id="c-prompt-expert" placeholder="What should the agent do on every tick?"></textarea>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="ax-btn ax-btn--primary" onclick="addCronExpert()">Add schedule</button>
        </div>
      </div>
    </div>
  </section>

  <section id="tab-webhooks" class="tab">
    ${sectionHead({
      icon: ICONS.webhooks,
      title: "Webhooks",
      lead: "A URL you give to another service. When something happens there — a PR is merged, an error fires — they POST to that URL, and we forward it to your agent as a readable message.",
    })}
    ${witBanner({
      persistKey: "webhooks",
      bodyHtml: `<b>Not sure you need this?</b> If a service you use has a "webhooks" setting (GitHub, Stripe, Sentry, Typeform…), you probably do. It's how those services tell AgentX when something's worth looking at.`,
    })}
    <div id="webhook-list" class="ax-stack"></div>
    <div class="add-form">
      <h3>Add a webhook</h3>
      <div class="rowf">
        <div><label>Webhook id<span class="hint">(lowercase)</span></label><input id="w-id" placeholder="mtgl-gitlab" /></div>
        <div><label>Source</label><select id="w-source"><option value="gitlab">GitLab</option><option value="github">GitHub</option><option value="sentry">Sentry</option><option value="stripe">Stripe</option><option value="discord">Discord</option><option value="slack">Slack</option><option value="custom">Custom</option></select></div>
      </div>
      <div class="rowf">
        <div><label>Agent</label><select id="w-agent"></select></div>
        <div><label>Signing secret env-var<span class="hint">(optional)</span></label><input id="w-secret" placeholder="GITLAB_WEBHOOK_SECRET" /></div>
      </div>
      <label>Description<span class="hint">(optional)</span></label>
      <input id="w-desc" placeholder="MTGL main project webhooks" />
      <div class="actions"><button class="primary" onclick="addWebhook()">Add webhook</button><div id="w-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-mesh" class="tab">
    ${sectionHead({
      icon: ICONS.mesh,
      title: "Mesh",
      lead: "Link this AgentX to other machines so they share work. Good for teams running AgentX on multiple laptops or a mix of laptop + server.",
    })}
    <div id="mesh-hero" class="ax-mesh-hero"></div>
    ${witBanner({
      persistKey: "mesh",
      bodyHtml: `<b>Do I need mesh?</b> Only if you're running AgentX in more than one place. Solo users on one laptop can skip this entirely.`,
    })}
    ${secLabel({ label: "Connected peers" })}
    <div id="mesh-peers" class="ax-stack"></div>
    <div class="add-form">
      <h3>Add a peer</h3>
      <div class="rowf">
        <div><label>Peer name<span class="hint">(human label)</span></label><input id="m-name" placeholder="clawd-server" /></div>
        <div><label>URL</label><input id="m-url" placeholder="http://192.168.1.50:18800" /></div>
      </div>
      <label>Auth token<span class="hint">(optional — use a scoped token with <code>mesh:peer</code>)</span></label>
      <input id="m-token" type="password" />
      <div class="actions"><button class="primary" onclick="addMeshPeer()">Add peer</button><div id="m-msg" class="msg"></div></div>
    </div>

    <details class="add-form" style="margin-top:16px">
      <summary class="primary">⏱ Health-check cadence</summary>
      <div style="margin-top:10px">
        <p style="font-size:11px;color:var(--ax-muted);margin:0 0 10px">How often AgentX pings each peer to check if it's alive. Mirrors <code>agentx mesh health</code>. Lower interval = faster peer-down detection (more wake noise on flaky links); higher = quieter on battery-constrained mobile peers.</p>
        <div class="rowf">
          <div><label>Interval (seconds, 5..3600)<span class="hint">(default 60)</span></label><input id="mh-interval" type="number" min="5" max="3600" /></div>
          <div><label>Timeout (seconds, 1..60)<span class="hint">(default 10)</span></label><input id="mh-timeout" type="number" min="1" max="60" /></div>
        </div>
        <div class="actions"><button class="primary" onclick="saveMeshHealth()">Save</button><div id="mh-msg" class="msg"></div></div>
      </div>
    </details>
  </section>

  <section id="tab-team" class="tab">
    ${sectionHead({
      icon: ICONS.tokens,
      title: "Actors & Roles",
      lead: "Humans (Actors) and groups of humans (Roles) that workflow user-tasks can be assigned to. Mirrors <code>agentx actor</code> and <code>agentx role</code>.",
    })}
    ${witBanner({
      persistKey: "team",
      bodyHtml: `<b>Actors</b> are people. They carry one or more channel handles (Telegram, WhatsApp, Slack, Discord, email) so user-tasks land in a place they actually read. <b>Roles</b> are named groups — assigning a userTask to a role lets the engine pick a member by strategy (first-available, round-robin, all). Assignees in workflow YAML are referenced as <code>actor:&lt;id&gt;</code> or <code>role:&lt;id&gt;</code>.`,
    })}

    <div class="ax-stack" style="margin-top:14px">
      <h3 style="margin:0 0 6px;font-size:13px">Actors</h3>
      <div id="actors-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add actor</summary>
        <div style="margin-top:10px">
          <label>Actor id<span class="hint">(must start with <code>actor:</code>, e.g. <code>actor:anis</code>)</span></label>
          <input id="ac-id" placeholder="actor:anis" />
          <label>Display name</label>
          <input id="ac-name" placeholder="Anis Marrouchi" />
          <label>Email <span class="hint">(optional)</span></label>
          <input id="ac-email" placeholder="anis@noqta.tn" />
          <label>Channel handles<span class="hint">(at least one — channel:handle, comma-separated, mark preferred with *)</span></label>
          <input id="ac-channels" placeholder="telegram:marrouchi*, whatsapp:21612345678" />
          <label>Timezone <span class="hint">(optional, e.g. <code>Africa/Tunis</code>)</span></label>
          <input id="ac-timezone" placeholder="Africa/Tunis" />
          <div class="actions"><button class="primary" onclick="upsertActor()">Save actor</button><div id="ac-msg" class="msg"></div></div>
        </div>
      </details>
    </div>

    <div class="ax-stack" style="margin-top:24px">
      <h3 style="margin:0 0 6px;font-size:13px">Roles</h3>
      <div id="roles-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add role</summary>
        <div style="margin-top:10px">
          <label>Role id<span class="hint">(must start with <code>role:</code>, e.g. <code>role:on-call</code>)</span></label>
          <input id="rl-id" placeholder="role:on-call" />
          <label>Display name</label>
          <input id="rl-name" placeholder="On-call engineers" />
          <label>Assignment strategy</label>
          <select id="rl-strategy">
            <option value="first-available">first-available — first listed member sees the task</option>
            <option value="round-robin">round-robin — rotate across members</option>
            <option value="all">all — every member sees the task</option>
          </select>
          <div class="actions"><button class="primary" onclick="upsertRole()">Save role</button><div id="rl-msg" class="msg"></div></div>
        </div>
      </details>
    </div>
  </section>

  <section id="tab-business" class="tab">
    ${sectionHead({
      icon: ICONS.tokens,
      title: "Business layer",
      lead: "Org chart, projects, and contact map — the data that drives PM gating and activity-graph attribution. Mirrors <code>agentx business</code>.",
    })}
    ${witBanner({
      persistKey: "business",
      bodyHtml: `<b>Three concepts.</b> The <b>org chart</b> is who reports to whom (<code>reportsTo</code>). <b>Projects</b> map an id to a PM and client (drives the PM gate and lets the activity graph attribute work to the right client). The <b>contact map</b> tells the activity graph which client a Telegram/WhatsApp chat belongs to — without it, free-text channels fall into the catch-all "internal" bucket. Editing here writes to <code>agentx.json</code>; restart the daemon (or POST /reload) for the change to take effect.`,
    })}

    <div class="ax-stack" style="margin-top:14px">
      <h3 style="margin:0 0 6px;font-size:13px">Org chart</h3>
      <div id="business-org-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add or update org-chart entry</summary>
        <div style="margin-top:10px">
          <label>Agent id<span class="hint">(must match a configured agent — e.g. <code>devops-agent</code>)</span></label>
          <input id="bo-agentId" placeholder="devops-agent" />
          <label>Role title</label>
          <input id="bo-role" placeholder="DevOps" />
          <label>Reports to <span class="hint">(another agent id; leave blank for top-level)</span></label>
          <input id="bo-reportsTo" placeholder="coo-agent" />
          <label>Schedule <span class="hint">(start–end · days, e.g. <code>09:00 17:00 mon,tue,wed,thu,fri</code>)</span></label>
          <div style="display:flex;gap:6px"><input id="bo-start" placeholder="09:00" style="width:80px" /><input id="bo-end" placeholder="17:00" style="width:80px" /><input id="bo-days" placeholder="mon,tue,wed,thu,fri" /></div>
          <div class="actions"><button class="primary" onclick="upsertOrgEntry()">Save entry</button><div id="bo-msg" class="msg"></div></div>
        </div>
      </details>
    </div>

    <div class="ax-stack" style="margin-top:24px">
      <h3 style="margin:0 0 6px;font-size:13px">Projects</h3>
      <div id="business-project-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add or update project</summary>
        <div style="margin-top:10px">
          <label>Project id<span class="hint">(<code>owner/repo</code> for GitLab/GitHub; stable string for internal projects)</span></label>
          <input id="bp-id" placeholder="mtgl/system" />
          <label>PM <span class="hint">(agentId — drives the PM gate)</span></label>
          <input id="bp-pm" placeholder="pm-mtgl" />
          <label>Client <span class="hint">(used by the activity graph to attribute traffic)</span></label>
          <input id="bp-client" placeholder="mtgl" />
          <div class="actions"><button class="primary" onclick="upsertProject()">Save project</button><div id="bp-msg" class="msg"></div></div>
        </div>
      </details>
    </div>

    <div class="ax-stack" style="margin-top:24px">
      <h3 style="margin:0 0 6px;font-size:13px">Contact map</h3>
      <div id="business-contact-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add contact mapping</summary>
        <div style="margin-top:10px">
          <label>Channel <span class="hint">(telegram | whatsapp | slack | discord — optional)</span></label>
          <input id="bc-channel" placeholder="telegram" />
          <label>Chat id <span class="hint">(e.g. <code>-100…</code>, JID — pick at least one of these three)</span></label>
          <input id="bc-chatId" placeholder="-1003861455814" />
          <label>Username</label>
          <input id="bc-username" placeholder="anis" />
          <label>Sender id</label>
          <input id="bc-senderId" placeholder="8500203323" />
          <label>Client <span class="hint">(required)</span></label>
          <input id="bc-client" placeholder="noqta" />
          <label>Project <span class="hint">(optional — defaults to <code>&lt;client&gt;/_chat</code>)</span></label>
          <input id="bc-project" placeholder="noqta/internal" />
          <label>Display name <span class="hint">(initiator pill override)</span></label>
          <input id="bc-displayName" placeholder="Anis Marrouchi" />
          <div class="actions"><button class="primary" onclick="upsertContact()">Save mapping</button><div id="bc-msg" class="msg"></div></div>
        </div>
      </details>
    </div>
  </section>

  <section id="tab-boards-cfg" class="tab">
    ${sectionHead({
      icon: ICONS.tokens,
      title: "Kanban boards",
      lead: "Configure the boards rendered on the home page. Mirrors <code>agentx board add/edit/remove</code> + <code>agentx board column</code>. Source is GitLab today; backlog/wiki sources land when the schema unlocks them.",
    })}
    ${witBanner({
      persistKey: "boards-cfg",
      bodyHtml: `<b>Two layers.</b> A board points to one or more GitLab projects (<code>source.projects</code>) and optionally filters by a primary tool label. Inside each board, <b>columns</b> map drag-drop actions to scoped-labels (e.g. dropping a card on "Doing" adds <code>Status::Doing</code>). The default flow is Open → To Do → Doing → On Hold → Review → Closed; override per-board with the column controls below.`,
    })}

    <div class="ax-stack" style="margin-top:14px">
      <h3 style="margin:0 0 6px;font-size:13px">Boards</h3>
      <div id="boards-cfg-list"></div>
      <details class="add-form" style="margin-top:10px">
        <summary class="primary">+ Add or update board</summary>
        <div style="margin-top:10px">
          <label>Board id<span class="hint">(unique slug, e.g. <code>mtgl</code>)</span></label>
          <input id="bd-id" placeholder="mtgl" />
          <label>Display name</label>
          <input id="bd-name" placeholder="MTGL System" />
          <label>GitLab project paths<span class="hint">(comma-separated, e.g. <code>mtgl/system,mtgl/website</code>)</span></label>
          <input id="bd-projects" placeholder="mtgl/system" />
          <label>Primary tool label <span class="hint">(optional — ANDed into every query, e.g. <code>Tool::Claude</code>)</span></label>
          <input id="bd-label" placeholder="Tool::Claude" />
          <div style="display:flex;gap:6px"><label style="flex:1">Open-window days<input id="bd-days" type="number" min="1" max="365" value="30" /></label><label style="flex:1">Closed-window days<input id="bd-closed-days" type="number" min="1" max="365" value="30" /></label></div>
          <div class="actions"><button class="primary" onclick="upsertBoardCfg()">Save board</button><div id="bd-msg" class="msg"></div></div>
        </div>
      </details>
    </div>
  </section>

  <section id="tab-tokens" class="tab">
    ${sectionHead({
      icon: ICONS.tokens,
      title: "Access tokens",
      lead: "Passwords, but for software. Anything that wants to talk to AgentX from outside (a Slack bridge, another AgentX machine, a script) uses one.",
    })}
    ${witBanner({
      persistKey: "tokens",
      bodyHtml: `<b>Tokens get scopes.</b> A scope is what the token is allowed to do. Give the narrowest one that works — a Slack bridge only needs to send messages, it doesn't need to edit settings. You can't recover a token after you close this page, so copy it immediately.`,
    })}
    <div id="token-list" class="ax-stack"></div>
    <div class="add-form">
      <h3>Mint a new token</h3>
      <label>Name<span class="hint">(who or what this is for — e.g. "Slack bridge", "Mesh peer: laptop")</span></label>
      <input id="t-name" placeholder="Slack bridge" />
      <label>Scopes<span class="hint">(pick one or more)</span></label>
      <div id="t-scopes" style="display:flex;flex-direction:column;gap:4px;margin-top:4px"></div>
      <label>Expires after<span class="hint">(in days; blank = never)</span></label>
      <input id="t-expires" type="number" min="1" max="3650" placeholder="90" />
      <div class="actions"><button class="primary" onclick="createToken()">Create token</button><div id="t-msg" class="msg"></div></div>
      <div id="t-reveal" style="display:none;margin-top:14px;padding:14px 16px;border-radius:6px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3)">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Copy this now — it won't be shown again.</div>
        <code id="t-secret" style="display:block;word-break:break-all;color:var(--green);font-family:ui-monospace,monospace;font-size:12px;padding:8px;background:#0e1119;border-radius:4px"></code>
      </div>
    </div>
  </section>

  <section id="tab-advanced" class="tab">
    ${sectionHead({
      icon: ICONS.advanced,
      title: "Raw configuration",
      lead: "Everything on the other tabs writes to this file. Edit here for bulk changes, diffs, or fields we haven't put in the UI yet. Saving creates a timestamped backup.",
    })}
    ${witBanner({
      persistKey: "advanced",
      bodyHtml: `<b>Safe to look, careful editing.</b> We've pretty-printed and annotated each section so you can read it. Click any <span class="mono" style="color:var(--ax-muted)">▸</span> to fold. Switch to <b>Edit</b> to change values — invalid JSON is refused before saving.`,
    })}

    <div class="ax-jv-toolbar">
      <input class="ax-jv-search" id="jv-search" placeholder="Search keys & values…" />
      <div class="ax-jv-seg" id="jv-mode">
        <button data-jv-mode="tree" class="is-active">Tree</button>
        <button data-jv-mode="raw">Raw</button>
        <button data-jv-mode="edit">Edit</button>
      </div>
      <div class="ax-jv-spacer"></div>
      <span class="muted mono" id="jv-meta" style="font-size:11px">agentx.json</span>
      <button class="ax-btn" id="jv-expand-all">Expand all</button>
      <button class="ax-btn" id="jv-collapse-all">Collapse all</button>
      <button class="ax-btn ax-btn--primary" id="jv-save">Save</button>
    </div>
    <div class="ax-jv-viewer" id="jv-viewer"></div>
    <textarea id="raw-editor" class="raw" style="display:none" spellcheck="false"></textarea>
    <div id="r-msg" class="msg" style="margin-top:10px"></div>
    <div class="actions">
      <button class="primary" onclick="saveRaw()">Save config</button>
      <button class="ghost" onclick="loadRaw()">Reload from disk</button>
      <div id="r-msg" class="msg"></div>
    </div>
    <div class="hint-block">The schema is documented at <code>docs/reference/config-schema.md</code>. Invalid JSON is refused; schema-level errors only surface after the daemon tries to use the new config.</div>
  </section>
</main>
`
const ADMIN_PAGE_CSS = `

/* --- Inner tabs (Agents / Channels / Schedules / …) --- */
nav.tabs{display:flex;gap:4px;padding:14px 24px 0;background:var(--ax-bg-elev);
  border-bottom:1px solid var(--ax-border);overflow-x:auto}
nav.tabs button{background:transparent;border:none;color:var(--ax-muted);
  padding:8px 14px;font:inherit;font-size:12px;cursor:pointer;
  border-bottom:2px solid transparent;letter-spacing:-0.005em;
  border-top-left-radius:4px;border-top-right-radius:4px;
  transition:color 120ms,border-color 120ms,background 120ms}
nav.tabs button:hover{color:var(--ax-text);background:color-mix(in oklch,var(--ax-accent) 4%,transparent)}
nav.tabs button.active{color:var(--ax-text);border-bottom-color:var(--ax-accent);
  background:color-mix(in oklch,var(--ax-accent) 8%,transparent)}

main{max-width:960px;margin:0 auto;padding:20px 24px 60px}
section.tab{display:none}
section.tab.active{display:block}

h2{font-size:16px;margin:0 0 4px;font-weight:600;letter-spacing:-0.01em}
.lead{color:var(--ax-muted);margin:0 0 20px;font-size:12px;line-height:1.55;max-width:720px}

/* --- Row cards --- */
.list{display:flex;flex-direction:column;gap:6px;margin-bottom:22px}
.row-card{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:12px 14px;display:flex;align-items:center;gap:12px;
  transition:border-color 120ms}
.row-card:hover{border-color:var(--ax-border-2)}
.row-card .info{flex:1;min-width:0}
.row-card .info h3{margin:0 0 2px;font-size:13px;font-weight:600;letter-spacing:-0.005em}
.row-card .info .meta{font-size:11px;color:var(--ax-muted);font-family:var(--ax-mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5}
.row-card .info .meta b{color:var(--ax-text);font-weight:500}
.row-card .info .meta a{color:var(--ax-accent)}

/* --- Buttons --- */
button.primary,button.ghost,button.danger{font-family:inherit;font-size:12px;cursor:pointer;
  border-radius:4px;transition:background 120ms,border-color 120ms,color 120ms}
button.primary{background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface));
  border:1px solid color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border-2));
  color:var(--ax-accent);padding:6px 14px;font-weight:500}
button.primary:hover{background:color-mix(in oklch,var(--ax-accent) 20%,var(--ax-surface))}
button.primary:disabled{opacity:0.4;cursor:not-allowed}
button.ghost{background:var(--ax-surface);border:1px solid var(--ax-border-2);
  color:var(--ax-text);padding:6px 12px}
button.ghost:hover{background:var(--ax-surface-2);border-color:var(--ax-accent)}
button.danger{background:transparent;color:var(--ax-err);
  border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent);padding:5px 11px}
button.danger:hover{background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  border-color:color-mix(in oklch,var(--ax-err) 55%,transparent)}

/* --- Forms --- */
.add-form{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:16px 18px;margin-top:8px}
.add-form h3{margin:0 0 10px;font-size:12px;font-weight:600;
  text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted)}
label{display:block;margin:8px 0 4px;font-size:11px;color:var(--ax-muted);
  text-transform:uppercase;letter-spacing:0.04em}
label .hint{font-weight:400;font-size:11px;margin-left:6px;
  text-transform:none;letter-spacing:normal;color:var(--ax-muted);opacity:0.85}
input,textarea,select{width:100%;background:var(--ax-bg);color:var(--ax-text);
  border:1px solid var(--ax-border);border-radius:4px;padding:7px 10px;
  font:inherit;font-size:12px;transition:border-color 120ms}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--ax-accent)}
textarea{resize:vertical;min-height:64px;line-height:1.55}
textarea.raw{min-height:480px;font-family:var(--ax-mono);font-size:12px;line-height:1.6}

.rowf{display:flex;gap:10px}
.rowf > *{flex:1}
.actions{display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap}

/* --- Messages --- */
.msg{margin:10px 0;padding:8px 12px;border-radius:4px;font-size:12px;
  display:none;line-height:1.5}
.msg.ok{display:block;background:color-mix(in oklch,var(--ax-accent) 10%,transparent);
  color:var(--ax-accent);border:1px solid color-mix(in oklch,var(--ax-accent) 35%,transparent)}
.msg.err{display:block;background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  color:var(--ax-err);border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent)}
.msg.warn{display:block;background:color-mix(in oklch,var(--ax-warn) 10%,transparent);
  color:var(--ax-warn);border:1px solid color-mix(in oklch,var(--ax-warn) 35%,transparent)}

.empty{color:var(--ax-muted);font-style:italic;padding:28px 12px;font-size:12px;
  text-align:center;border:1px dashed var(--ax-border);border-radius:4px}

/* --- Toggles + chips --- */
.toggle-switch{display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:12px}
.toggle-switch input{width:auto;accent-color:var(--ax-accent)}
.chip{display:inline-block;font-size:10px;padding:1px 7px;line-height:16px;
  border-radius:3px;background:var(--ax-surface);border:1px solid var(--ax-border);
  color:var(--ax-muted);font-family:var(--ax-mono);margin-right:4px;
  text-transform:uppercase;letter-spacing:0.02em}
.chip.off{background:var(--ax-surface-2);color:var(--ax-muted)}
.hint-block{font-size:11px;color:var(--ax-muted);margin-top:8px;line-height:1.55}
.hint-block code{background:var(--ax-bg);padding:1px 6px;border-radius:3px;
  color:var(--ax-text);font-family:var(--ax-mono);font-size:11px;
  border:1px solid var(--ax-border)}
.section-block{margin-bottom:28px}

/* --- Channels sidemenu --- */
.ch-split{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
@media (max-width:720px){.ch-split{grid-template-columns:1fr}}
.ch-menu{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:2px;
  position:sticky;top:120px}
.ch-menu button{background:transparent;border:1px solid transparent;
  color:var(--ax-text-2);padding:8px 10px;border-radius:4px;cursor:pointer;
  font:inherit;font-size:12px;text-align:left;display:flex;align-items:center;gap:10px;
  transition:background 120ms,border-color 120ms,color 120ms}
.ch-menu button:hover{background:var(--ax-surface-2);color:var(--ax-text)}
.ch-menu button.is-active{background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface));
  color:var(--ax-text);border-color:color-mix(in oklch,var(--ax-accent) 35%,var(--ax-border-2))}
.ch-menu .ch-icon{font-family:var(--ax-mono);font-size:10px;line-height:16px;
  width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;
  background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:3px;
  color:var(--ax-muted);flex-shrink:0}
.ch-menu .ch-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-menu .ch-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--ax-border-2)}
.ch-menu .ch-dot--on{background:var(--ax-accent)}
.ch-menu .ch-dot--off{background:var(--ax-warn)}
.ch-view{display:block}
.ch-view[hidden]{display:none}

/* --- Files modal --- */
.files-split{display:flex;flex:1;min-height:0}
.files-picker{width:260px;min-width:220px;border-right:1px solid var(--ax-border);
  overflow-y:auto;padding:10px 8px;background:var(--ax-bg-elev)}
.files-picker .group{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;
  color:var(--ax-muted);padding:8px 10px 4px;font-weight:600}
.files-picker .file{display:flex;align-items:center;gap:8px;padding:8px 10px;
  border-radius:4px;cursor:pointer;font-size:12px;color:var(--ax-text);
  border-left:2px solid transparent;transition:background 120ms}
.files-picker .file:hover{background:color-mix(in oklch,var(--ax-accent) 6%,transparent)}
.files-picker .file.active{background:color-mix(in oklch,var(--ax-accent) 12%,transparent);
  border-left-color:var(--ax-accent);color:var(--ax-text)}
.files-picker .file.missing{color:var(--ax-muted);font-style:italic}
.files-picker .file .info{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files-picker .file .size{font-size:10px;color:var(--ax-muted);font-family:var(--ax-mono)}
.files-picker .file .del{background:transparent;border:none;color:var(--ax-muted);
  cursor:pointer;padding:0 4px;font-size:13px}
.files-picker .file .del:hover{color:var(--ax-err)}
.files-editor{flex:1;display:flex;flex-direction:column;overflow:hidden}
.files-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;
  color:var(--ax-muted);font-style:italic;padding:40px;text-align:center;font-size:12px}
.files-editor-head{padding:10px 16px;border-bottom:1px solid var(--ax-border);
  display:flex;align-items:center;gap:10px;background:var(--ax-bg-elev)}
.files-editor-head .path{flex:1;font-family:var(--ax-mono);font-size:12px;color:var(--ax-muted)}
.files-editor-body{flex:1;overflow:hidden;display:flex}
.files-editor-body textarea{flex:1;background:var(--ax-bg);color:var(--ax-text);
  border:none;padding:14px 16px;font-family:var(--ax-mono);font-size:12px;line-height:1.6;resize:none}
.files-editor-body textarea:focus{outline:none}
.files-add{border-top:1px solid var(--ax-border);padding:10px 16px;background:var(--ax-bg-elev)}
.files-add h4{margin:0 0 8px;font-size:11px;font-weight:600;color:var(--ax-muted);
  text-transform:uppercase;letter-spacing:0.06em}

/* --- Test drive chat modal --- */
.td-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;
  justify-content:center;padding:24px}
.td-modal.hidden{display:none}
.td-backdrop{position:absolute;inset:0;background:color-mix(in oklch,var(--ax-bg) 60%,black)}
.td-card{position:relative;width:min(640px,94vw);height:min(720px,90vh);
  background:var(--ax-surface);border:1px solid var(--ax-border-2);border-radius:8px;
  display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,0.5);overflow:hidden}
.td-card > header{display:flex;align-items:center;gap:10px;padding:12px 16px;
  border-bottom:1px solid var(--ax-border);background:var(--ax-bg-elev)}
.td-card > header h3{margin:0;font-size:14px;font-weight:600;flex:1;letter-spacing:-0.005em}
.td-card .chip-small{font-size:10px;padding:2px 7px;border-radius:3px;
  background:color-mix(in oklch,var(--ax-accent) 14%,transparent);
  color:var(--ax-accent);letter-spacing:0.04em;text-transform:uppercase;font-family:var(--ax-mono)}
.td-close{background:transparent;border:none;color:var(--ax-muted);font-size:22px;
  cursor:pointer;padding:0 6px;line-height:1}
.td-close:hover{color:var(--ax-text)}
.td-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;
  gap:10px;background:var(--ax-bg)}
.td-msg{max-width:82%;padding:8px 12px;border-radius:10px;font-size:13px;
  line-height:1.5;word-wrap:break-word;white-space:pre-wrap}
.td-msg.user{align-self:flex-end;
  background:color-mix(in oklch,var(--ax-accent) 75%,var(--ax-bg));
  color:var(--ax-bg);font-weight:500;border-bottom-right-radius:2px}
.td-msg.agent{align-self:flex-start;background:var(--ax-surface);color:var(--ax-text);
  border:1px solid var(--ax-border);border-bottom-left-radius:2px}
.td-msg.err{align-self:flex-start;background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  color:var(--ax-err);border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent);
  border-bottom-left-radius:2px}
.td-msg.thinking{align-self:flex-start;color:var(--ax-muted);font-style:italic;
  background:transparent;padding:4px 8px}
.td-empty{color:var(--ax-muted);text-align:center;padding:40px 12px;font-style:italic;font-size:13px}
.td-footer{border-top:1px solid var(--ax-border);padding:10px 12px;display:flex;
  gap:8px;align-items:flex-end;background:var(--ax-bg-elev)}
.td-footer textarea{flex:1;background:var(--ax-bg);color:var(--ax-text);
  border:1px solid var(--ax-border);border-radius:4px;padding:8px 10px;
  font:inherit;font-size:13px;min-height:40px;max-height:120px;resize:none}
.td-footer textarea:focus{outline:none;border-color:var(--ax-accent)}
.td-footer button{background:color-mix(in oklch,var(--ax-accent) 20%,var(--ax-surface));
  color:var(--ax-accent);border:1px solid color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border-2));
  border-radius:4px;padding:8px 16px;font-weight:500;font-size:13px;cursor:pointer}
.td-footer button:hover{background:color-mix(in oklch,var(--ax-accent) 28%,var(--ax-surface))}
.td-footer button:disabled{opacity:0.4;cursor:not-allowed}
.td-hint{padding:6px 16px;font-size:10px;color:var(--ax-muted);
  border-top:1px solid var(--ax-border);background:var(--ax-bg-elev);font-family:var(--ax-mono)}
.peer-banner{display:none;padding:10px 20px;background:color-mix(in oklch,var(--ax-accent) 14%,var(--ax-surface));
  border-bottom:1px solid color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border-2));
  color:var(--ax-accent);font-size:12px;align-items:center;gap:12px;font-family:var(--ax-mono)}
.peer-banner.is-active{display:flex}
.peer-banner .label{text-transform:uppercase;letter-spacing:0.06em;font-size:10px;opacity:0.8}
.peer-banner .name{font-weight:600;color:var(--ax-accent)}
.peer-banner .spacer{flex:1}
.peer-banner button{background:transparent;border:1px solid currentColor;color:var(--ax-accent);
  padding:4px 10px;border-radius:4px;font:inherit;font-size:11px;cursor:pointer}
.peer-banner button:hover{background:color-mix(in oklch,var(--ax-accent) 12%,transparent)}
`
const ADMIN_PAGE_SCRIPT = `
const $ = (id) => document.getElementById(id);
let state = null;

function currentPeer() {
  try { return localStorage.getItem('ax-peer') || 'primary'; } catch { return 'primary'; }
}
function setCurrentPeer(id) {
  try {
    if (id && id !== 'primary') localStorage.setItem('ax-peer', id);
    else localStorage.removeItem('ax-peer');
  } catch { /**/ }
}

async function req(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-admin' } };
  const peer = currentPeer();
  if (peer !== 'primary') opts.headers['X-Agentx-Peer'] = peer;
  // If this dashboard has a local token configured, inject it on every
  // request so the new /api/admin/* auth gate lets us through. Peer-proxy
  // requests still work because the server-side proxy swaps this header
  // for the peer's own token before forwarding.
  if (window.AX_LOCAL_TOKEN) opts.headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(el, kind, text) {
  el.className = 'msg ' + kind;
  el.textContent = text;
  if (kind === 'ok') setTimeout(() => { el.className = 'msg'; el.textContent = ''; }, 4000);
}

async function refresh() {
  try {
    state = await req('GET', '/api/admin/state');
    if (!state.exists) {
      showMsg($('global-msg'), 'warn', 'No agentx.json found. Run the setup wizard first.');
      return;
    }
    renderAgents();
    renderChannels();
    renderCrons();
    renderWebhooks();
    renderMesh();
    renderTeam();
    wireTeamHandlers();
    renderBusiness();
    wireBusinessHandlers();
    renderBoardsCfg();
    wireBoardsCfgHandlers();
    renderNotifications();
    wireWebhookTriggerHandlers();
    initScheduleBuilder();
    initScheduleExpertAgentSelect();
  } catch (e) {
    showMsg($('global-msg'), 'err', e.message);
  }
}

function renderWebhooks() {
  const list = $('webhook-list');
  const daemonUrl = (state.daemonUrl || '').replace(/\\/+$/, '');
  const sources = {
    gitlab: { logoBg: '#FC6D26', label: 'GitLab', init: 'GL', hint: 'In GitLab → Settings → Webhooks; tick Push/Issue/Pipeline events.' },
    github: { logoBg: '#24292e', label: 'GitHub', init: 'GH', hint: 'In GitHub → Repo Settings → Webhooks; pick individual events.' },
    sentry: { logoBg: '#362D59', label: 'Sentry', init: 'SE', hint: 'In Sentry → Project Settings → Alerts → Webhooks.' },
    stripe: { logoBg: '#635BFF', label: 'Stripe', init: 'ST', hint: 'In Stripe Dashboard → Developers → Webhooks.' },
    discord: { logoBg: '#5865F2', label: 'Discord', init: 'DC', hint: 'In Discord → Channel Settings → Integrations → Webhooks.' },
    slack: { logoBg: '#4A154B', label: 'Slack', init: 'SL', hint: 'Slack Outgoing Webhooks / Events API — point at the URL below.' },
    custom: { logoBg: 'var(--ax-surface-3)', label: 'Custom', init: '?', hint: 'Any service that can POST JSON — payload is forwarded as-is.' },
  };
  if (!state.webhooks.length) {
    list.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:42px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><h3 style="margin:0 0 4px;color:var(--ax-text);font-size:15px;font-weight:600">No webhooks yet</h3><p style="margin:0;font-size:13px">Register one below and paste the URL into the external service.</p></div>';
  } else {
    list.innerHTML = '';
    for (const w of state.webhooks) {
      const meta = sources[w.source] || sources.custom;
      const url = daemonUrl + '/webhook/' + encodeURIComponent(w.agentId) + '/' + encodeURIComponent(w.source);
      const missingSecret = w.source !== 'custom' && !w.secretEnv;
      const statusPill = missingSecret
        ? '<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>signing secret missing</span>'
        : (w.enabled
          ? '<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>receiving</span>'
          : '<span class="ax-pill ax-pill--off">disabled</span>');
      const card = document.createElement('div');
      card.className = 'ax-row-card';
      if (missingSecret) card.style.borderColor = 'color-mix(in oklch, var(--ax-warn) 35%, var(--ax-border))';
      const logoStyle = 'background:' + meta.logoBg + ';color:white;border-color:' + meta.logoBg;
      card.innerHTML =
        '<div class="ax-row-card__top">' +
          '<div class="ax-avatar" style="' + logoStyle + '">' + meta.init + '</div>' +
          '<div class="ax-row-card__info">' +
            '<div class="ax-name">' + escapeHtml(w.id) + ' ' + statusPill + '</div>' +
            '<div class="ax-sub">' +
              escapeHtml(meta.label) + ' · routes to <b>' + escapeHtml(w.agentId) + '</b>' +
              (w.secretEnv ? ' · secret: <code>${' + escapeHtml(w.secretEnv) + '}</code>' : '') +
              (w.description ? ' · ' + escapeHtml(w.description) : '') +
            '</div>' +
          '</div>' +
          '<div class="ax-row-card__actions">' +
            '<button class="ax-btn" data-toggle-wh="' + escapeHtml(w.id) + '" data-enabled="' + (w.enabled ? '1' : '0') + '">' + (w.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="ax-btn ax-btn--danger" data-rm-wh="' + escapeHtml(w.id) + '">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:5px;padding:8px 10px;font-family:var(--ax-mono);font-size:11.5px;color:var(--ax-text);margin-top:10px">' +
          '<span class="muted">POST</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(url) + '</span>' +
          '<button class="ax-btn ax-btn--ghost" style="padding:3px 9px;font-size:11px" data-copy="' + escapeHtml(url) + '">Copy</button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--ax-muted);margin-top:6px">' + escapeHtml(meta.hint) + '</div>';

      // Triggers + defaultWorkflow editor — collapsed by default. Maps a
      // platform event-type (e.g. "issues.opened") to a workflow id; the
      // defaultWorkflow runs when no specific trigger matches.
      const triggers = (w.triggers && typeof w.triggers === 'object') ? w.triggers : {};
      const triggerRows = Object.keys(triggers).map(function(evt){
        return '<div style="display:flex;gap:6px;align-items:center;margin-top:4px"><code style="flex:1;font-size:11px">' + escapeHtml(evt) + ' → ' + escapeHtml(triggers[evt]) + '</code><a href="#" data-act="wh-trig-rm" data-id="' + escapeHtml(w.id) + '" data-event="' + escapeHtml(evt) + '" style="color:var(--ax-muted);font-size:11px">×</a></div>';
      }).join('');
      const trigBlock = document.createElement('details');
      trigBlock.style.marginTop = '8px';
      trigBlock.innerHTML =
        '<summary style="font-size:11px;cursor:pointer;color:var(--ax-accent,#3a7bd5)">Routing — event-type triggers + default workflow</summary>' +
        '<div style="margin-top:8px;padding:8px 10px;background:var(--ax-surface);border-radius:4px">' +
          '<div style="font-size:11px;color:var(--ax-muted);margin-bottom:4px">Event-type → workflow id (e.g. <code>issues.opened</code> → <code>triage-bug</code>):</div>' +
          (triggerRows || '<div style="font-size:11px;color:var(--ax-muted);font-style:italic">no triggers — every event uses the default workflow below</div>') +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<input data-wh-trig-event placeholder="event-type" style="flex:1;font-size:11px" />' +
            '<input data-wh-trig-wf placeholder="workflow id" style="flex:1;font-size:11px" />' +
            '<button data-act="wh-trig-add" data-id="' + escapeHtml(w.id) + '" class="ax-btn" style="padding:3px 9px;font-size:11px">Add</button>' +
          '</div>' +
          '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--ax-border)">' +
            '<div style="font-size:11px;color:var(--ax-muted);margin-bottom:4px">Default workflow (fires when no trigger matches):</div>' +
            '<div style="display:flex;gap:6px">' +
              '<input data-wh-default value="' + escapeHtml(w.defaultWorkflow || '') + '" placeholder="(none)" style="flex:1;font-size:11px" />' +
              '<button data-act="wh-default-save" data-id="' + escapeHtml(w.id) + '" class="ax-btn" style="padding:3px 9px;font-size:11px">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      card.appendChild(trigBlock);

      card.querySelector('[data-copy]').addEventListener('click', (e) => {
        const u = e.currentTarget.dataset.copy;
        navigator.clipboard.writeText(u).catch(() => {});
        if (window.showToast) window.showToast('URL copied');
      });
      card.querySelector('[data-rm-wh]').addEventListener('click', () => deleteWebhookAction(w.id));
      card.querySelector('[data-toggle-wh]').addEventListener('click', () => toggleWebhook(w.id, !w.enabled));
      list.appendChild(card);
    }
  }
  // Refresh the add-webhook agent picker.
  const sel = $('w-agent');
  const cur = sel.value;
  sel.innerHTML = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  if (cur) sel.value = cur;
}

async function addWebhook() {
  const body = {
    id: $('w-id').value.trim(),
    source: $('w-source').value,
    agentId: $('w-agent').value,
    secretEnv: $('w-secret').value.trim(),
    description: $('w-desc').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/webhooks', body);
    showMsg($('w-msg'), 'ok', r.summary);
    $('w-id').value = ''; $('w-secret').value = ''; $('w-desc').value = '';
    refresh();
  } catch (e) { showMsg($('w-msg'), 'err', e.message); }
}

async function deleteWebhookAction(id) {
  if (!confirm('Delete webhook "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/webhooks', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function toggleWebhook(id, enabled) {
  try { await req('PATCH', '/api/admin/webhooks', { id, patch: { enabled } }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderMesh() {
  const m = state.mesh || { enabled: false, peers: [], healthCheck: { interval: 60, timeout: 10 } };
  const hc = m.healthCheck || { interval: 60, timeout: 10 };
  if ($('mh-interval')) $('mh-interval').value = hc.interval ?? 60;
  if ($('mh-timeout')) $('mh-timeout').value = hc.timeout ?? 10;

  // Hero card: status message + enable toggle + SVG network viz.
  const hero = $('mesh-hero');
  if (hero) {
    const count = m.peers.length;
    const nodeName = (state.node && state.node.name) || 'this machine';
    const viz = renderMeshViz(count);
    const toggleCls = m.enabled ? 'ax-mesh-toggle is-on' : 'ax-mesh-toggle';
    const msg = !m.enabled
      ? 'Mesh is off. Turn it on to share work between AgentX machines.'
      : (count === 0
        ? 'Mesh is on, but no peers yet. Add one below to link another machine.'
        : 'Your machine (<b>' + escapeHtml(nodeName) + '</b>) is connected to ' + count + ' peer' + (count === 1 ? '' : 's') + '. Work from any of them can land here — and vice versa.');
    hero.innerHTML =
      '<div>' +
        '<h3>' + (m.enabled ? (count === 0 ? 'Mesh is on' : 'Mesh is active') : 'Mesh is off') + '</h3>' +
        '<p>' + msg + '</p>' +
        '<div class="' + toggleCls + '" onclick="toggleMesh(this)">' +
          '<div class="ax-mesh-switch"></div>' +
          '<span>Mesh networking ' + (m.enabled ? 'enabled' : 'disabled') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ax-mesh-viz">' + viz + '</div>';
  }

  const peers = $('mesh-peers');
  if (!m.peers.length) {
    peers.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:32px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><p style="margin:0;font-size:13px">No peers yet. Add one below to get started.</p></div>';
  } else {
    peers.innerHTML = '';
    for (const p of m.peers) {
      const statusPill = p.hasToken
        ? '<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>authenticated</span>'
        : '<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>no token</span>';
      const card = document.createElement('div');
      card.className = 'ax-row-card';
      card.innerHTML =
        '<div class="ax-row-card__top">' +
          '<div class="ax-avatar ax-avatar--' + avatarVariant(p.url) + '">' + escapeHtml(initialsOf(p.name, p.name)) + '</div>' +
          '<div class="ax-row-card__info">' +
            '<div class="ax-name">' + escapeHtml(p.name) + ' ' + statusPill + '</div>' +
            '<div class="ax-sub"><span class="mono muted">' + escapeHtml(p.url) + '</span></div>' +
          '</div>' +
          '<div class="ax-row-card__actions">' +
            '<button class="ax-btn ax-btn--danger" data-rm-peer="' + escapeHtml(p.url) + '">Remove</button>' +
          '</div>' +
        '</div>';
      card.querySelector('[data-rm-peer]').addEventListener('click', () => removeMeshPeer(p.url));
      peers.appendChild(card);
    }
  }
}

/** Tiny SVG showing the mesh topology with live dashed wires — YOU in the
 *  middle, up to three peers around. Decorative; scales down on narrow
 *  viewports via CSS. */
function renderMeshViz(peerCount) {
  // Fixed layout: YOU centered, three peer slots. Extra peers collapse into "+".
  const slots = [
    { x: 18, y: 8, label: peerCount >= 1 ? 'A' : '+' },
    { x: 178, y: 8, label: peerCount >= 2 ? 'B' : '+' },
    { x: 18, y: 88, label: peerCount >= 3 ? '+' + (peerCount - 2) : '+' },
  ];
  let lines = '';
  if (peerCount >= 1) lines += '<line x1="120" y1="70" x2="40" y2="30" class="live"/>';
  if (peerCount >= 2) lines += '<line x1="120" y1="70" x2="200" y2="30" class="live"/>';
  if (peerCount >= 3) lines += '<line x1="120" y1="70" x2="40" y2="110" class="live"/>';
  if (peerCount === 0) lines += '<line x1="120" y1="70" x2="40" y2="30"/><line x1="120" y1="70" x2="200" y2="30"/>';
  let dots = '<div class="ax-mesh-dot self" style="left:98px;top:48px">YOU</div>';
  for (const s of slots) {
    const cls = s.label === '+' || /^\\+\\d+$/.test(s.label) ? 'ax-mesh-dot empty' : 'ax-mesh-dot';
    dots += '<div class="' + cls + '" style="left:' + s.x + 'px;top:' + s.y + 'px">' + s.label + '</div>';
  }
  return '<svg class="ax-mesh-wires" viewBox="0 0 240 140">' + lines + '</svg>' + dots;
}

async function toggleMesh(pill) {
  const want = !pill.classList.contains('is-on');
  try {
    await req('POST', '/api/admin/mesh/toggle', { enabled: want });
    refresh();
  } catch (err) { showMsg($('global-msg'), 'err', err.message); }
}

// Keep the legacy checkbox listener for the hidden input if any calls reach it
// (the form below the hero still uses #m-url/#m-name/#m-token).
const __meshToggle = $('mesh-toggle');
if (__meshToggle) {
  __meshToggle.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/mesh/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}

async function addMeshPeer() {
  const body = { url: $('m-url').value.trim(), name: $('m-name').value.trim(), token: $('m-token').value.trim() };
  try {
    const r = await req('POST', '/api/admin/mesh/peers', body);
    showMsg($('m-msg'), 'ok', r.summary);
    $('m-url').value = ''; $('m-name').value = ''; $('m-token').value = '';
    refresh();
  } catch (e) { showMsg($('m-msg'), 'err', e.message); }
}

async function removeMeshPeer(url) {
  if (!confirm('Remove mesh peer at ' + url + '?')) return;
  try { await req('DELETE', '/api/admin/mesh/peers', { url }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function initialsOf(name, id) {
  const src = (name || id || '?').replace(/[^a-zA-Z ]/g, '').trim();
  const parts = src.split(/\\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || id || '?').slice(0, 2).toUpperCase();
}

// ---------------- Actors & Roles tab ----------------
//
// Inline onclick handlers can't pass quoted strings cleanly here — the
// whole admin page is generated via a TypeScript template literal, so
// escaped single-quotes in the JS source collapse and break the JS
// parser. We attach a single delegated click handler instead and route
// by data-act / data-id attributes.

function renderTeam() {
  const actors = state.actors || [];
  const roles = state.roles || [];

  const al = $('actors-list');
  if (al) {
    if (!actors.length) {
      al.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:24px 18px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)">No actors yet. Add one below or via <code>agentx actor add</code>.</div>';
    } else {
      al.innerHTML = actors.map(a => {
        const channels = (a.channels || []).map(c =>
          '<span class="ax-pill" style="font-size:10px;padding:2px 6px">' +
          escapeHtml(c.channel) + ':' + escapeHtml(String(c.handle).slice(0, 30)) +
          (c.preferredForTasks ? ' ★' : '') + '</span>'
        ).join(' ');
        return '<div class="ax-row-card" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:6px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap"><b>' + escapeHtml(a.name) + '</b><code style="font-size:10px;color:var(--ax-muted)">' + escapeHtml(a.id) + '</code>' +
            (a.email ? '<span style="font-size:11px;color:var(--ax-muted)">' + escapeHtml(a.email) + '</span>' : '') +
            (a.timezone ? '<span style="font-size:11px;color:var(--ax-muted)">' + escapeHtml(a.timezone) + '</span>' : '') +
            '</div>' +
            '<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">' + channels + '</div>' +
          '</div>' +
          '<button class="ghost danger" data-act="delete-actor" data-id="' + escapeHtml(a.id) + '">Delete</button>' +
        '</div>';
      }).join('');
    }
  }

  const rl = $('roles-list');
  if (rl) {
    if (!roles.length) {
      rl.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:24px 18px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)">No roles yet. Add one below or via <code>agentx role create</code>.</div>';
    } else {
      rl.innerHTML = roles.map(r => {
        const memberPills = (r.members || []).map(m => {
          const ref = m.actor || m.role || '';
          return '<span class="ax-pill" style="font-size:10px;padding:2px 6px">' + escapeHtml(ref) +
            ' <a href="#" data-act="revoke" data-role="' + escapeHtml(r.id) + '" data-member="' + escapeHtml(ref) + '" style="color:var(--ax-muted);text-decoration:none">×</a></span>';
        }).join(' ');
        const memberOptions = '<option value="">— add actor or role —</option>' +
          actors.filter(a => !(r.members || []).some(m => m.actor === a.id)).map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.id) + ' (' + escapeHtml(a.name) + ')</option>').join('') +
          roles.filter(rr => rr.id !== r.id && !(r.members || []).some(m => m.role === rr.id)).map(rr => '<option value="' + escapeHtml(rr.id) + '">' + escapeHtml(rr.id) + ' (' + escapeHtml(rr.name) + ')</option>').join('');
        return '<div class="ax-row-card" style="padding:10px 14px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:6px">' +
          '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;justify-content:space-between">' +
            '<div><b>' + escapeHtml(r.name) + '</b> <code style="font-size:10px;color:var(--ax-muted)">' + escapeHtml(r.id) + '</code> <span style="font-size:11px;color:var(--ax-muted)">strategy: ' + escapeHtml(r.assignmentStrategy) + '</span></div>' +
            '<button class="ghost danger" data-act="delete-role" data-id="' + escapeHtml(r.id) + '">Delete</button>' +
          '</div>' +
          '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">' + (memberPills || '<i style="font-size:11px;color:var(--ax-muted)">no members yet</i>') +
            '<select data-act="grant" data-role="' + escapeHtml(r.id) + '" style="margin-left:auto;font-size:11px;padding:2px 6px">' + memberOptions + '</select>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }
}

// Single delegated click + change handler for the Team tab. Wired once
// at page-init time below renderTeam in the existing DOMContentLoaded
// flow — see the wireTeamHandlers call.
function wireTeamHandlers() {
  if (window.__teamWired) return;
  window.__teamWired = true;
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const act = t.getAttribute('data-act');
    if (act === 'delete-actor') {
      const id = t.getAttribute('data-id');
      if (!confirm('Delete actor ' + id + '?')) return;
      try { await req('DELETE', '/api/admin/actors', { id }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'delete-role') {
      const id = t.getAttribute('data-id');
      if (!confirm('Delete role ' + id + '?')) return;
      try { await req('DELETE', '/api/admin/roles', { id }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'revoke') {
      ev.preventDefault();
      const role = t.getAttribute('data-role');
      const member = t.getAttribute('data-member');
      try { await req('POST', '/api/admin/roles/revoke', { role, member }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    }
  });
  document.addEventListener('change', async (ev) => {
    const t = ev.target.closest('select[data-act="grant"]');
    if (!t) return;
    const role = t.getAttribute('data-role');
    const member = t.value;
    if (!member) return;
    try { await req('POST', '/api/admin/roles/grant', { role, member }); await load(); }
    catch (e) { showMsg($('global-msg'), 'err', e.message); }
  });
}

// Form-submit shims kept on window for the inline onclick="upsertActor()"
// handlers in the add-form summary blocks.

window.upsertActor = async function() {
  const id = $('ac-id').value.trim();
  const name = $('ac-name').value.trim();
  const email = $('ac-email').value.trim();
  const channelsRaw = $('ac-channels').value.trim();
  const timezone = $('ac-timezone').value.trim();
  const channels = channelsRaw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const preferredForTasks = s.endsWith('*');
    const clean = preferredForTasks ? s.slice(0, -1) : s;
    const sep = clean.indexOf(':');
    return { channel: clean.slice(0, sep), handle: clean.slice(sep + 1), preferredForTasks };
  }).filter(c => c.channel && c.handle);
  try {
    await req('POST', '/api/admin/actors', { id, name, email: email || undefined, channels, timezone: timezone || undefined });
    $('ac-id').value = ''; $('ac-name').value = ''; $('ac-email').value = ''; $('ac-channels').value = ''; $('ac-timezone').value = '';
    showMsg($('ac-msg'), 'ok', 'Actor saved');
    await load();
  } catch (e) { showMsg($('ac-msg'), 'err', e.message); }
}

window.upsertRole = async function() {
  const id = $('rl-id').value.trim();
  const name = $('rl-name').value.trim();
  const assignmentStrategy = $('rl-strategy').value;
  try {
    await req('POST', '/api/admin/roles', { id, name, assignmentStrategy });
    $('rl-id').value = ''; $('rl-name').value = '';
    showMsg($('rl-msg'), 'ok', 'Role saved');
    await load();
  } catch (e) { showMsg($('rl-msg'), 'err', e.message); }
}

// ---------------- Business tab ----------------

function renderBusiness() {
  const b = state.business || {};
  const orgChart = b.orgChart || {};
  const projects = b.projects || [];
  const contactMap = b.contactMap || [];

  const ol = $('business-org-list');
  if (ol) {
    const entries = Object.entries(orgChart);
    if (entries.length === 0) {
      ol.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:18px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:6px;color:var(--ax-muted);font-size:12px">no org-chart entries</div>';
    } else {
      ol.innerHTML = entries.map(function(kv){
        const id = kv[0]; const e = kv[1];
        const reports = e.reportsTo ? '<span style="font-size:11px;color:var(--ax-muted)">→ ' + escapeHtml(e.reportsTo) + '</span>' : '';
        const sched = e.schedule ? '<span style="font-size:11px;color:var(--ax-muted)">' + escapeHtml((e.schedule.days || []).join(',')) + ' ' + escapeHtml(e.schedule.start || '') + '–' + escapeHtml(e.schedule.end || '') + '</span>' : '';
        return '<div class="ax-row-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:5px">' +
          '<div style="flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">' +
            '<code style="font-size:12px">' + escapeHtml(id) + '</code>' +
            '<b>' + escapeHtml(e.role || '') + '</b>' + reports + sched +
          '</div>' +
          '<button class="ghost danger" data-act="biz-org-rm" data-id="' + escapeHtml(id) + '">Remove</button>' +
        '</div>';
      }).join('');
    }
  }

  const pl = $('business-project-list');
  if (pl) {
    if (projects.length === 0) {
      pl.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:18px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:6px;color:var(--ax-muted);font-size:12px">no projects</div>';
    } else {
      pl.innerHTML = projects.map(function(p){
        const pm = p.pm ? '<span style="font-size:11px;color:var(--ax-muted)">pm=' + escapeHtml(p.pm) + '</span>' : '';
        const client = p.client ? '<span style="font-size:11px;color:var(--ax-muted)">client=' + escapeHtml(p.client) + '</span>' : '';
        return '<div class="ax-row-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:5px">' +
          '<div style="flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap"><code style="font-size:12px">' + escapeHtml(p.id) + '</code>' + pm + client + '</div>' +
          '<button class="ghost danger" data-act="biz-proj-rm" data-id="' + escapeHtml(p.id) + '">Remove</button>' +
        '</div>';
      }).join('');
    }
  }

  const cl = $('business-contact-list');
  if (cl) {
    if (contactMap.length === 0) {
      cl.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:18px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:6px;color:var(--ax-muted);font-size:12px">no contact mappings</div>';
    } else {
      cl.innerHTML = contactMap.map(function(c, idx){
        const key = c.chatId ? 'chatId=' + c.chatId : c.username ? 'username=' + c.username : c.senderId ? 'senderId=' + c.senderId : '?';
        const dn = c.displayName ? '<span style="font-size:11px;color:var(--ax-muted)">(' + escapeHtml(c.displayName) + ')</span>' : '';
        return '<div class="ax-row-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:5px">' +
          '<div style="flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">' +
            (c.channel ? '<span class="ax-pill" style="font-size:10px;padding:2px 6px">' + escapeHtml(c.channel) + '</span>' : '') +
            '<code style="font-size:12px">' + escapeHtml(key) + '</code>' +
            '<span style="font-size:11px;color:var(--ax-muted)">→ ' + escapeHtml(c.client) + (c.project ? '/' + escapeHtml(c.project) : '') + '</span>' + dn +
          '</div>' +
          '<button class="ghost danger" data-act="biz-contact-rm" data-idx="' + idx + '">Remove</button>' +
        '</div>';
      }).join('');
    }
  }
}

function wireBusinessHandlers() {
  if (window.__bizWired) return;
  window.__bizWired = true;
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act^="biz-"]');
    if (!t) return;
    const act = t.getAttribute('data-act');
    if (act === 'biz-org-rm') {
      const agentId = t.getAttribute('data-id');
      if (!confirm('Remove org-chart entry for ' + agentId + '?')) return;
      try { await req('DELETE', '/api/admin/business/orgchart', { agentId }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'biz-proj-rm') {
      const id = t.getAttribute('data-id');
      if (!confirm('Remove project ' + id + '?')) return;
      try { await req('DELETE', '/api/admin/business/project', { id }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'biz-contact-rm') {
      const idx = parseInt(t.getAttribute('data-idx') || '-1', 10);
      const list = (state.business && state.business.contactMap) || [];
      const c = list[idx];
      if (!c) return;
      const filters = {};
      if (c.channel) filters.channel = c.channel;
      if (c.chatId) filters.chatId = c.chatId;
      else if (c.username) filters.username = c.username;
      else if (c.senderId) filters.senderId = c.senderId;
      try { await req('DELETE', '/api/admin/business/contact', filters); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    }
  });
}

window.upsertOrgEntry = async function() {
  const agentId = $('bo-agentId').value.trim();
  const role = $('bo-role').value.trim();
  const reportsTo = $('bo-reportsTo').value.trim();
  const start = $('bo-start').value.trim() || '09:00';
  const end = $('bo-end').value.trim() || '17:00';
  const days = ($('bo-days').value.trim() || 'mon,tue,wed,thu,fri').split(',').map(s => s.trim()).filter(Boolean);
  try {
    await req('POST', '/api/admin/business/orgchart', { agentId, role, reportsTo, start, end, days });
    $('bo-agentId').value = ''; $('bo-role').value = ''; $('bo-reportsTo').value = '';
    showMsg($('bo-msg'), 'ok', 'Entry saved');
    await load();
  } catch (e) { showMsg($('bo-msg'), 'err', e.message); }
}

window.upsertProject = async function() {
  const id = $('bp-id').value.trim();
  const pm = $('bp-pm').value.trim();
  const client = $('bp-client').value.trim();
  try {
    await req('POST', '/api/admin/business/project', { id, pm, client });
    $('bp-id').value = ''; $('bp-pm').value = ''; $('bp-client').value = '';
    showMsg($('bp-msg'), 'ok', 'Project saved');
    await load();
  } catch (e) { showMsg($('bp-msg'), 'err', e.message); }
}

// ---------------- Boards-cfg tab ----------------

function renderBoardsCfg() {
  const boards = state.boards || [];
  const list = $('boards-cfg-list');
  if (!list) return;
  if (boards.length === 0) {
    list.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:24px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:6px;color:var(--ax-muted);font-size:12px">no boards configured</div>';
    return;
  }
  list.innerHTML = boards.map(function(b){
    const projects = ((b.source && b.source.projects) || []).map(p => '<span class="ax-pill" style="font-size:10px;padding:2px 6px">' + escapeHtml(p) + '</span>').join(' ');
    const cols = (b.columns || []).map(function(c){
      const map = c.kind === 'scoped-label' ? 'scoped=' + (c.scopedLabel || '')
                : c.kind === 'label' ? 'label=' + (c.mapsToLabel || '')
                : c.kind === 'open-backlog' ? 'prefix=' + (c.scopedPrefix || 'Status')
                : c.kind;
      return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 6px;border:1px solid var(--ax-border);border-radius:3px;margin-right:4px;margin-bottom:4px"><b>' + escapeHtml(c.title) + '</b><span style="color:var(--ax-muted)">(' + escapeHtml(map) + ')</span><a href="#" data-act="bd-col-rm" data-board="' + escapeHtml(b.id) + '" data-column="' + escapeHtml(c.id) + '" style="color:var(--ax-muted);text-decoration:none">×</a></span>';
    }).join('');
    return '<div class="ax-row-card" style="padding:10px 14px;border:1px solid var(--ax-border);border-radius:6px;margin-bottom:8px">' +
      '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;justify-content:space-between">' +
        '<div><b>' + escapeHtml(b.name) + '</b> <code style="font-size:10px;color:var(--ax-muted)">' + escapeHtml(b.id) + '</code></div>' +
        '<div style="display:flex;gap:4px">' +
          '<button class="ghost" data-act="bd-edit" data-id="' + escapeHtml(b.id) + '">Edit</button>' +
          '<button class="ghost danger" data-act="bd-rm" data-id="' + escapeHtml(b.id) + '">Remove</button>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:6px">' + projects +
        (b.primaryToolLabel ? '<span class="ax-pill" style="font-size:10px;padding:2px 6px;margin-left:4px">label: ' + escapeHtml(b.primaryToolLabel) + '</span>' : '') +
        '<span class="ax-pill" style="font-size:10px;padding:2px 6px;margin-left:4px">open=' + (b.timeRangeDays || 30) + 'd / closed=' + (b.closedWindowDays || 30) + 'd</span>' +
      '</div>' +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--ax-border)">' +
        '<div style="font-size:11px;color:var(--ax-muted);margin-bottom:4px">columns:</div>' +
        (cols || '<i style="font-size:11px;color:var(--ax-muted)">no custom columns (board uses GitLab default flow)</i>') +
        '<details style="margin-top:6px"><summary style="font-size:11px;cursor:pointer;color:var(--ax-accent,#3a7bd5)">+ add column</summary>' +
          '<div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:6px;align-items:end">' +
            '<label>Id<input data-bd-col="id" data-board="' + escapeHtml(b.id) + '" placeholder="doing" /></label>' +
            '<label>Title<input data-bd-col="title" data-board="' + escapeHtml(b.id) + '" placeholder="Doing" /></label>' +
            '<label>Kind<select data-bd-col="kind" data-board="' + escapeHtml(b.id) + '"><option value="scoped-label">scoped-label</option><option value="label">label</option><option value="open-backlog">open-backlog</option><option value="closed">closed</option></select></label>' +
            '<label>Scoped/label value<input data-bd-col="value" data-board="' + escapeHtml(b.id) + '" placeholder="Status::Doing" /></label>' +
            '<button data-act="bd-col-add" data-board="' + escapeHtml(b.id) + '">Add</button>' +
          '</div>' +
        '</details>' +
      '</div>' +
    '</div>';
  }).join('');
}

function wireBoardsCfgHandlers() {
  if (window.__boardsCfgWired) return;
  window.__boardsCfgWired = true;
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act^="bd-"]');
    if (!t) return;
    const act = t.getAttribute('data-act');
    if (act === 'bd-rm') {
      const id = t.getAttribute('data-id');
      if (!confirm('Remove board ' + id + '?')) return;
      try { await req('DELETE', '/api/admin/boards', { id }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'bd-edit') {
      // Pre-fill the add form so the operator can re-save.
      const id = t.getAttribute('data-id');
      const b = (state.boards || []).find(x => x.id === id);
      if (!b) return;
      $('bd-id').value = b.id;
      $('bd-name').value = b.name || '';
      $('bd-projects').value = ((b.source && b.source.projects) || []).join(',');
      $('bd-label').value = b.primaryToolLabel || '';
      $('bd-days').value = b.timeRangeDays || 30;
      $('bd-closed-days').value = b.closedWindowDays || 30;
      // Open the details and scroll to it
      const details = document.querySelector('#tab-boards-cfg .add-form');
      if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth' }); }
    } else if (act === 'bd-col-rm') {
      ev.preventDefault();
      const boardId = t.getAttribute('data-board');
      const columnId = t.getAttribute('data-column');
      try { await req('DELETE', '/api/admin/boards/columns', { boardId, columnId }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (act === 'bd-col-add') {
      const boardId = t.getAttribute('data-board');
      const card = t.closest('.ax-row-card');
      if (!card) return;
      const id = card.querySelector('[data-bd-col="id"]').value.trim();
      const title = card.querySelector('[data-bd-col="title"]').value.trim();
      const kind = card.querySelector('[data-bd-col="kind"]').value;
      const value = card.querySelector('[data-bd-col="value"]').value.trim();
      if (!id || !title) { showMsg($('global-msg'), 'err', 'column id and title required'); return; }
      const payload = { boardId, columnId: id, title, kind };
      if (kind === 'scoped-label') payload.scopedLabel = value;
      else if (kind === 'label') payload.mapsToLabel = value;
      try { await req('POST', '/api/admin/boards/columns', payload); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    }
  });
}

// ---------------- Notifications + Webhook triggers ----------------

function renderNotifications() {
  const n = state.notifications || {};
  const cur = $('notif-current');
  if (cur) {
    if (n.destination) {
      const acct = n.destination.accountId ? ' (account=' + escapeHtml(n.destination.accountId) + ')' : '';
      cur.innerHTML = '<b>Routing to</b> <code>' + escapeHtml(n.destination.channel) + ':' + escapeHtml(n.destination.chatId) + '</code>' + acct;
    } else {
      cur.innerHTML = '<i>No destination set — notifications go to the daemon log only.</i>';
    }
  }
  if ($('notif-channel') && n.destination) {
    $('notif-channel').value = n.destination.channel || '';
    $('notif-chat-id').value = n.destination.chatId || '';
    $('notif-account-id').value = n.destination.accountId || '';
  }
  if ($('notif-threshold')) $('notif-threshold').value = n.longTaskThreshold ?? 30;
  if ($('notif-on-complete')) $('notif-on-complete').checked = n.on?.taskComplete !== false;
  if ($('notif-on-error')) $('notif-on-error').checked = n.on?.taskError !== false;
  if ($('notif-on-queued')) $('notif-on-queued').checked = !!n.on?.taskQueued;
}

window.saveNotifications = async function() {
  const channel = $('notif-channel').value.trim();
  const chatId = $('notif-chat-id').value.trim();
  const accountId = $('notif-account-id').value.trim();
  const threshold = parseInt($('notif-threshold').value, 10);
  const body = {
    on: {
      taskComplete: $('notif-on-complete').checked,
      taskError: $('notif-on-error').checked,
      taskQueued: $('notif-on-queued').checked,
    },
    longTaskThreshold: Number.isFinite(threshold) ? threshold : 30,
  };
  if (channel && chatId) {
    body.destination = { channel, chatId, ...(accountId ? { accountId } : {}) };
  }
  try {
    await req('POST', '/api/admin/notifications', body);
    showMsg($('notif-msg'), 'ok', 'Saved');
    await load();
  } catch (e) { showMsg($('notif-msg'), 'err', e.message); }
}

window.clearNotificationsDestination = async function() {
  try {
    await req('POST', '/api/admin/notifications', { destination: null });
    showMsg($('notif-msg'), 'ok', 'Destination cleared');
    await load();
  } catch (e) { showMsg($('notif-msg'), 'err', e.message); }
}

function wireWebhookTriggerHandlers() {
  if (window.__whTrigWired) return;
  window.__whTrigWired = true;
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act^="wh-"]');
    if (!t) return;
    const id = t.getAttribute('data-id');
    if (t.getAttribute('data-act') === 'wh-trig-rm') {
      ev.preventDefault();
      const evt = t.getAttribute('data-event');
      const wh = state.webhooks.find(w => w.id === id);
      if (!wh) return;
      const next = { ...(wh.triggers || {}) };
      delete next[evt];
      try { await req('POST', '/api/admin/webhooks/triggers', { id, triggers: next }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (t.getAttribute('data-act') === 'wh-trig-add') {
      const card = t.closest('.ax-row-card');
      if (!card) return;
      const evt = card.querySelector('[data-wh-trig-event]').value.trim();
      const wf = card.querySelector('[data-wh-trig-wf]').value.trim();
      if (!evt || !wf) { showMsg($('global-msg'), 'err', 'event-type + workflow id required'); return; }
      const wh = state.webhooks.find(w => w.id === id);
      const next = { ...((wh && wh.triggers) || {}), [evt]: wf };
      try { await req('POST', '/api/admin/webhooks/triggers', { id, triggers: next }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    } else if (t.getAttribute('data-act') === 'wh-default-save') {
      const card = t.closest('.ax-row-card');
      if (!card) return;
      const defaultWorkflow = card.querySelector('[data-wh-default]').value.trim();
      try { await req('POST', '/api/admin/webhooks/triggers', { id, defaultWorkflow }); await load(); }
      catch (e) { showMsg($('global-msg'), 'err', e.message); }
    }
  });
}

window.saveMeshHealth = async function() {
  const interval = parseInt($('mh-interval').value, 10);
  const timeout = parseInt($('mh-timeout').value, 10);
  const body = {};
  if (Number.isFinite(interval)) body.interval = interval;
  if (Number.isFinite(timeout)) body.timeout = timeout;
  if (Object.keys(body).length === 0) {
    showMsg($('mh-msg'), 'err', 'set interval and/or timeout');
    return;
  }
  try {
    await req('POST', '/api/admin/mesh/health', body);
    showMsg($('mh-msg'), 'ok', 'Saved');
    await load();
  } catch (e) { showMsg($('mh-msg'), 'err', e.message); }
}

window.upsertBoardCfg = async function() {
  const id = $('bd-id').value.trim();
  const name = $('bd-name').value.trim();
  const projects = $('bd-projects').value.trim();
  const primaryToolLabel = $('bd-label').value.trim();
  const timeRangeDays = parseInt($('bd-days').value, 10) || 30;
  const closedWindowDays = parseInt($('bd-closed-days').value, 10) || 30;
  try {
    await req('POST', '/api/admin/boards', { id, name, projects, primaryToolLabel, timeRangeDays, closedWindowDays });
    showMsg($('bd-msg'), 'ok', 'Board saved');
    await load();
  } catch (e) { showMsg($('bd-msg'), 'err', e.message); }
}

window.upsertContact = async function() {
  const channel = $('bc-channel').value.trim();
  const chatId = $('bc-chatId').value.trim();
  const username = $('bc-username').value.trim();
  const senderId = $('bc-senderId').value.trim();
  const client = $('bc-client').value.trim();
  const project = $('bc-project').value.trim();
  const displayName = $('bc-displayName').value.trim();
  if (!chatId && !username && !senderId) {
    showMsg($('bc-msg'), 'err', 'one of chat-id / username / sender-id required');
    return;
  }
  try {
    await req('POST', '/api/admin/business/contact', { channel, chatId, username, senderId, client, project, displayName });
    ['bc-channel','bc-chatId','bc-username','bc-senderId','bc-client','bc-project','bc-displayName'].forEach(id => { $(id).value = ''; });
    showMsg($('bc-msg'), 'ok', 'Mapping saved');
    await load();
  } catch (e) { showMsg($('bc-msg'), 'err', e.message); }
}

/** Pick a stable avatar variant from the string hash. Gives each agent a
 *  distinct-looking square without the operator having to configure one. */
function avatarVariant(key) {
  const variants = ['teal', 'amber', 'blue', 'coral'];
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return variants[h % variants.length];
}

function renderAgents() {
  const list = $('agent-list');
  if (!state.agents.length) {
    list.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:42px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><h3 style="margin:0 0 4px;color:var(--ax-text);font-size:15px;font-weight:600">No agents yet</h3><p style="margin:0 0 16px;font-size:13px">Click <b>+ New agent</b> below to add your first one.</p></div>';
    // still refresh cron agent picker even when the list is empty
    const selE = $('c-agent'); selE.innerHTML = '';
    return;
  }
  list.innerHTML = '';
  for (const a of state.agents) {
    const accessPill = a.access === 'public'
      ? '<span class="ax-pill ax-pill--info"><span class="ax-pill__dot"></span>public API</span>'
      : '<span class="ax-pill ax-pill--off">private</span>';
    const triggers = (a.mentions || []).map(t =>
      '<span class="ax-trigger-pill">' + escapeHtml(t) + '</span>'
    ).join('') || '<span class="muted">—</span>';

    const card = document.createElement('div');
    card.className = 'ax-row-card';
    card.innerHTML =
      '<div class="ax-row-card__top">' +
        '<div class="ax-avatar ax-avatar--' + avatarVariant(a.id) + '">' + escapeHtml(initialsOf(a.name, a.id)) + '</div>' +
        '<div class="ax-row-card__info">' +
          '<div class="ax-name">' + escapeHtml(a.name) + ' ' + accessPill + '</div>' +
          '<div class="ax-sub">' +
            '<span class="mono">' + escapeHtml(a.id) + '</span>' +
            (a.model ? ' · ' + escapeHtml(a.model) : '') +
            (a.tier ? ' · ' + escapeHtml(a.tier) : '') +
          '</div>' +
        '</div>' +
        '<div class="ax-row-card__actions">' +
          '<button class="ax-btn ax-btn--primary" data-test="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '">Test drive</button>' +
          '<a class="ax-btn" href="/admin/agents/' + encodeURIComponent(a.id) + '">Manage</a>' +
          '<button class="ax-btn ax-btn--ghost" onclick="toggleCard(this)">Details <svg class="ax-chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4l3 3 3-3"/></svg></button>' +
        '</div>' +
      '</div>' +
      '<div class="ax-row-card__details">' +
        '<dl class="ax-detail-grid">' +
          '<div><dt>AI engine</dt><dd>' + escapeHtml(a.tier || '—') + (a.model ? ' · ' + escapeHtml(a.model) : '') + '</dd></div>' +
          '<div><dt>Max concurrent</dt><dd>' + escapeHtml(String(a.maxConcurrent ?? '—')) + '</dd></div>' +
          '<div style="grid-column:1/-1"><dt>Trigger words</dt><dd><div class="ax-triggers">' + triggers + '</div></dd></div>' +
        '</dl>' +
        (a.systemPrompt ? '<div><dt style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ax-muted);margin-bottom:4px;font-family:var(--ax-mono)">Personality</dt><dd style="margin:0;color:var(--ax-text-2);line-height:1.6;font-size:12.5px;white-space:pre-wrap">' + escapeHtml(a.systemPrompt) + '</dd></div>' : '') +
        '<div style="margin-top:14px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="ax-btn" data-edit="' + escapeHtml(a.id) + '">Edit</button>' +
          '<button class="ax-btn" data-files="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '">Files</button>' +
          '<button class="ax-btn" data-toggle="' + escapeHtml(a.id) + '" data-access="' + escapeHtml(a.access) + '">' + (a.access === 'public' ? 'Make private' : 'Make public') + '</button>' +
          '<div style="flex:1"></div>' +
          '<button class="ax-btn ax-btn--danger" data-delete="' + escapeHtml(a.id) + '">Delete</button>' +
        '</div>' +
      '</div>';

    card.querySelector('[data-test]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      openTestDrive(btn.dataset.test, btn.dataset.name);
    });
    card.querySelector('[data-edit]').addEventListener('click', () => openAgentEdit(a));
    card.querySelector('[data-files]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      openFilesModal(btn.dataset.files, btn.dataset.name);
    });
    card.querySelector('[data-toggle]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const want = btn.dataset.access === 'public' ? 'private' : 'public';
      setAgentAccess(btn.dataset.toggle, want);
    });
    card.querySelector('[data-delete]').addEventListener('click', () => deleteAgent(a.id));
    list.appendChild(card);
  }
  // Refresh the cron agent picker so new agents show up.
  const sel = $('c-agent');
  const current = sel.value;
  sel.innerHTML = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  if (current) sel.value = current;
}

async function addAgent() {
  const body = {
    id: $('a-id').value.trim(),
    name: $('a-name').value.trim(),
    triggerWords: $('a-triggers').value.trim(),
    tier: $('a-tier').value,
    model: $('a-model').value.trim() || undefined,
    personality: $('a-personality').value.trim() || undefined,
    access: $('a-public').checked ? 'public' : 'private',
  };
  try {
    const r = await req('POST', '/api/admin/agents', body);
    if (body.access === 'public') {
      await req('POST', '/api/admin/agents/access', { id: body.id, access: 'public' }).catch(() => {});
    }
    showMsg($('a-msg'), 'ok', r.summary || 'Added.');
    $('a-id').value = ''; $('a-name').value = ''; $('a-triggers').value = ''; $('a-personality').value = '';
    $('a-public').checked = false;
    refresh();
  } catch (e) { showMsg($('a-msg'), 'err', e.message); }
}

async function setAgentAccess(id, access) {
  try {
    await req('POST', '/api/admin/agents/access', { id, access });
    refresh();
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function deleteAgent(id) {
  if (!confirm('Delete agent "' + id + '"? The config entry is removed; the workspace folder on disk is kept.')) return;
  try { await req('DELETE', '/api/admin/agents', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderChannels() {
  renderChannelsMenu();
  renderChannelsGrid();
  const t = state.telegram || { enabled: false, accounts: [] };
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  const accountRows = t.accounts.length === 0
    ? '<div class="empty">No Telegram accounts yet.</div>'
    : t.accounts.map((acc) =>
      '<div class="row-card"><div class="info"><h3>' + escapeHtml(acc.id) + '</h3>' +
      '<div class="meta">' +
        '<span class="chip ' + (t.enabled ? '' : 'off') + '">' + (t.enabled ? 'enabled' : 'disabled') + '</span>' +
        'bot: <b>' + escapeHtml(acc.botUsername || '—') + '</b> · agent: <b>' + escapeHtml(acc.agentBinding || '—') + '</b> · token ref: <b>' + escapeHtml(acc.botTokenRef || '—') + '</b>' +
      '</div></div>' +
      '<button class="ghost" data-tg-edit="' + escapeHtml(acc.id) + '" style="margin-right:6px">Edit</button>' +
      '<button class="danger" data-id="' + escapeHtml(acc.id) + '">Delete</button></div>').join('');
  $('tg-section').innerHTML =
    '<div class="toggle-switch"><input type="checkbox" id="tg-toggle"' + (t.enabled ? ' checked' : '') + ' /><label for="tg-toggle" style="color:var(--text);margin:0">Telegram connector enabled</label></div>' +
    '<div class="list">' + accountRows + '</div>' +
    '<div class="add-form"><h3>Add a Telegram account</h3>' +
      '<div class="rowf"><div><label>Account id<span class="hint">(e.g. support)</span></label><input id="tg-id" /></div>' +
      '<div><label>Bind to agent</label><select id="tg-agent">' + agentOptions + '</select></div></div>' +
      '<label>Bot username<span class="hint">(optional)</span></label><input id="tg-user" placeholder="my_bot" />' +
      '<label>Bot token env-var<span class="hint">(name of the <code>.env</code> variable holding the token)</span></label><input id="tg-env" placeholder="TG_SUPPORT_BOT_TOKEN" />' +
      '<div class="actions"><button class="primary" onclick="addTelegram()">Add account</button><div id="tg-msg" class="msg"></div></div>' +
      '<div class="hint-block">We reference the token as <code>\${TG_..._BOT_TOKEN}</code> in <code>agentx.json</code>. The actual value lives in <code>.env</code> — this panel never reads or transmits it.</div>' +
    '</div>';
  $('tg-toggle').addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/telegram/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); }
  });
  for (const btn of document.querySelectorAll('#tg-section button.danger')) {
    btn.addEventListener('click', () => deleteTelegram(btn.dataset.id));
  }
  for (const btn of document.querySelectorAll('#tg-section button[data-tg-edit]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tgEdit;
      const acc = (state.telegram.accounts || []).find((a) => a.id === id);
      if (acc) openTelegramEdit(acc);
    });
  }
  renderSlackSection();
}

const CHANNEL_DEFS = [
  { id: 'telegram', icon: 'TG', label: 'Telegram' },
  { id: 'whatsapp', icon: 'WA', label: 'WhatsApp' },
  { id: 'slack',    icon: 'SL', label: 'Slack' },
  { id: 'discord',  icon: 'DC', label: 'Discord' },
  { id: 'gitlab',   icon: 'GL', label: 'GitLab' },
  { id: 'github',   icon: 'GH', label: 'GitHub' },
];

/** Per-connector card metadata — logo color, long description, setup time.
 *  Keeps renderChannelsGrid() focused on wiring rather than content. */
const CONNECTOR_META = {
  telegram: { group: 'chat', brand: '#229ED9', desc: 'Replies in Telegram DMs and groups when tagged. Paste your BotFather token; we keep the value in .env.' },
  whatsapp: { group: 'chat', brand: '#25D366', desc: 'Answer on WhatsApp via a local session. Scan a QR once; AgentX pairs as an extra device.' },
  slack:    { group: 'chat', brand: '#4A154B', desc: 'Agents can DM or be mentioned in channels. Uses the Events API with socket mode.' },
  discord:  { group: 'chat', brand: '#5865F2', desc: 'Works in servers, threads, and DMs. Create a Discord bot, grant Read/Send Messages, paste the token.' },
  gitlab:   { group: 'dev',  brand: '#FC6D26', desc: 'Pings your agent on MRs, issues, and pipeline events. Works with self-hosted too.' },
  github:   { group: 'dev',  brand: '#24292e', desc: 'Pings your agent on PRs, issues, and CI runs. Configure per-repo.' },
};

function renderChannelsGrid() {
  const chat = $('ch-chatapps');
  const dev = $('ch-devtools');
  if (!chat || !dev) return;
  chat.innerHTML = ''; dev.innerHTML = '';
  for (const def of CHANNEL_DEFS) {
    const meta = CONNECTOR_META[def.id] || { group: 'chat', brand: 'var(--ax-surface-3)', desc: '' };
    const status = channelStatus(def.id);
    const active = state.__activeChannel === def.id;
    const statusPill = status === 'on'
      ? '<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>live</span>'
      : status === 'off'
        ? '<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>off</span>'
        : '<span class="ax-pill ax-pill--off">not set up</span>';
    const sub = channelSubtext(def.id, status);
    const card = document.createElement('div');
    card.className = 'ax-connector' + (status === 'on' ? ' is-on' : '') + (active ? ' is-active' : '');
    card.innerHTML =
      '<div class="ax-connector__top">' +
        '<div class="ax-connector__logo" style="background:' + meta.brand + ';color:#fff;border-color:' + meta.brand + '">' + def.icon + '</div>' +
        '<div class="ax-connector__meta">' +
          '<div class="ax-connector__name">' + def.label + '</div>' +
          '<div class="ax-connector__sub">' + sub + '</div>' +
        '</div>' +
        '<div class="ax-connector__status">' + statusPill + '</div>' +
      '</div>' +
      '<div class="ax-connector__desc">' + meta.desc + '</div>' +
      '<div class="ax-connector__foot">' +
        '<span>' + (status === 'none' ? '~5 min setup' : 'Configured') + '</span>' +
        '<span class="ax-connector__cta">' + (status === 'none' ? 'Set up' : 'Manage') + ' <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 2l4 4-4 4"/></svg></span>' +
      '</div>';
    card.addEventListener('click', () => showChannelPane(def.id));
    (meta.group === 'chat' ? chat : dev).appendChild(card);
  }
  if (!state.__activeChannel) {
    // Default to telegram pane showing if nothing picked yet.
    showChannelPane('telegram');
  } else {
    showChannelPane(state.__activeChannel);
  }
}

/** Human-readable sub-text for the connector card under the name. */
function channelSubtext(id, status) {
  if (id === 'telegram') {
    const t = state.telegram || {};
    const n = (t.accounts || []).length;
    if (n === 0) return 'Not set up';
    return n + ' bot' + (n === 1 ? '' : 's') + ' configured';
  }
  if (id === 'whatsapp') {
    const w = state.whatsapp || {};
    return w.routeCount ? w.routeCount + ' route' + (w.routeCount === 1 ? '' : 's') : 'Not set up';
  }
  if (id === 'slack') {
    const s = state.slack || {};
    return s.botTokenRef ? (s.workspace ? 'Workspace: ' + s.workspace : 'Token set') : 'Not set up';
  }
  if (id === 'discord') return status === 'none' ? 'Not set up' : 'Token set';
  if (id === 'gitlab') return status === 'none' ? 'Not set up' : 'Token set';
  if (id === 'github') {
    const n = ((state.webhooks || []).filter((w) => w.source === 'github')).length;
    return n ? n + ' webhook' + (n === 1 ? '' : 's') : 'Not set up';
  }
  return status === 'none' ? 'Not set up' : 'Configured';
}

/** Show the pane for the given channel id, hide the others, and highlight
 *  the matching connector card. */
function showChannelPane(id) {
  state.__activeChannel = id;
  const panes = ['telegram','whatsapp','slack','discord','gitlab','github'];
  for (const p of panes) {
    const el = document.getElementById('ch-' + p);
    if (el) el.hidden = (p !== id);
  }
  // Reflect active on connector cards
  const chat = $('ch-chatapps');
  const dev = $('ch-devtools');
  [chat, dev].forEach((container) => {
    if (!container) return;
    container.querySelectorAll('.ax-connector').forEach((c, i) => {
      const defs = CHANNEL_DEFS.filter(d => (CONNECTOR_META[d.id]?.group === (container === chat ? 'chat' : 'dev')));
      const def = defs[i];
      if (def) c.classList.toggle('is-active', def.id === id);
    });
  });
  // Lazy-render the panes whose content isn't filled by renderChannels(). TG
  // and Slack are populated unconditionally there; the rest need an explicit
  // call or their panes stay empty when switched via the connector card.
  if (id === 'discord') renderDiscordPane();
  else if (id === 'gitlab') renderGitLabPane();
  else if (id === 'github') renderGitHubPane();
  else if (id === 'whatsapp') renderWhatsAppPane();
}

function channelStatus(id) {
  if (id === 'telegram') {
    const t = state.telegram || {};
    const configured = (t.accounts || []).length > 0;
    if (!configured) return 'none';
    return t.enabled ? 'on' : 'off';
  }
  if (id === 'whatsapp') {
    const w = state.whatsapp || {};
    if (!w.routeCount) return 'none';
    return w.enabled ? 'on' : 'off';
  }
  if (id === 'slack') {
    const s = state.slack || {};
    if (!s.botTokenRef || !s.appTokenRef) return 'none';
    return s.enabled ? 'on' : 'off';
  }
  if (id === 'discord') {
    const d = state.discord || {};
    if (!d.tokenRef) return 'none';
    return d.enabled ? 'on' : 'off';
  }
  if (id === 'gitlab') {
    const g = state.gitlab || {};
    if (!g.tokenRef) return 'none';
    return g.enabled ? 'on' : 'off';
  }
  if (id === 'github') {
    const webhooks = (state.webhooks || []).filter((w) => w.source === 'github');
    if (webhooks.length === 0) return 'none';
    return webhooks.some((w) => w.enabled) ? 'on' : 'off';
  }
  return 'none';
}

function renderChannelsMenu() {
  const menu = $('ch-menu');
  if (!menu) return;
  const activeId = menu.dataset.active || 'telegram';
  menu.innerHTML = CHANNEL_DEFS.map((c) => {
    const s = channelStatus(c.id);
    const dotCls = s === 'on' ? 'ch-dot ch-dot--on' : s === 'off' ? 'ch-dot ch-dot--off' : 'ch-dot';
    const dotTitle = s === 'on' ? 'enabled' : s === 'off' ? 'configured but off' : 'not set up';
    const isActive = c.id === activeId;
    return '<button data-ch="' + c.id + '" class="' + (isActive ? 'is-active' : '') + '">' +
      '<span class="ch-icon">' + c.icon + '</span>' +
      '<span class="ch-label">' + c.label + '</span>' +
      '<span class="' + dotCls + '" title="' + dotTitle + '"></span>' +
    '</button>';
  }).join('');
  for (const btn of menu.querySelectorAll('button')) {
    btn.addEventListener('click', () => selectChannel(btn.dataset.ch));
  }
  // Re-render the currently-selected pane's content.
  selectChannel(activeId, true);
}

function selectChannel(id, keep) {
  const menu = $('ch-menu');
  if (menu) menu.dataset.active = id;
  for (const btn of menu.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.ch === id);
  }
  for (const v of document.querySelectorAll('.ch-view')) {
    v.hidden = v.id !== 'ch-' + id;
  }
  // Lazy-render the more static panes; telegram + slack re-render via their existing calls.
  if (id === 'discord') renderDiscordPane();
  else if (id === 'gitlab') renderGitLabPane();
  else if (id === 'github') renderGitHubPane();
  else if (id === 'whatsapp') renderWhatsAppPane();
}

function renderDiscordPane() {
  const d = state.discord || {};
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '"' +
    (a.id === (d.agentBinding || '') ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  const configured = !!d.tokenRef;
  const statusChip = configured
    ? (d.enabled ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>' : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';
  $('ch-discord').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>Discord bot</h3>' +
      '<div class="meta">' + statusChip +
        (d.tokenRef ? ' token: <code style="font-family:var(--ax-mono)">' + escapeHtml(d.tokenRef) + '</code>' : '') +
        (d.agentBinding ? ' · agent: <b>' + escapeHtml(d.agentBinding) + '</b>' : '') +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="dc-toggle"' + (d.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit Discord' : 'Connect Discord') + '</h3>' +
      '<label>Bot token env-var<span class="hint">(from the Discord Developer Portal)</span></label>' +
      '<input id="dc-env" placeholder="DISCORD_BOT_TOKEN" value="' + escapeHtml(stripRef(d.tokenRef)) + '" />' +
      '<label>Default agent<span class="hint">(optional)</span></label>' +
      '<select id="dc-agent"><option value="">(none)</option>' + agentOptions + '</select>' +
      '<div class="actions"><button class="primary" onclick="configureDiscord()">' + (configured ? 'Save' : 'Connect') + '</button><div id="dc-msg" class="msg"></div></div>' +
      '<div class="hint-block">Bot needs <code>MESSAGE_CONTENT</code> intent enabled in the Developer Portal. Routing: @-mention in channels, always in DMs.</div>' +
    '</div>';
  const t = $('dc-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/discord/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}
async function configureDiscord() {
  const body = { tokenEnv: $('dc-env').value.trim(), agentBinding: $('dc-agent').value };
  try { const r = await req('POST', '/api/admin/channels/discord', body); showMsg($('dc-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : '')); refresh(); }
  catch (e) { showMsg($('dc-msg'), 'err', e.message); }
}

function renderGitLabPane() {
  const g = state.gitlab || {};
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const configured = !!g.tokenRef;
  const statusChip = configured
    ? (g.enabled ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>' : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';
  $('ch-gitlab').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>GitLab</h3>' +
      '<div class="meta">' + statusChip +
        (g.host ? ' <code style="font-family:var(--ax-mono)">' + escapeHtml(g.host) + '</code>' : '') +
        (g.tokenRef ? ' · token: <code style="font-family:var(--ax-mono)">' + escapeHtml(g.tokenRef) + '</code>' : '') +
        ' · ' + g.routeCount + ' route(s) · ' + g.agentMappingCount + ' agent mapping(s)' +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="gl-toggle"' + (g.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit GitLab' : 'Connect GitLab') + '</h3>' +
      '<label>Host<span class="hint">(e.g. <code>https://gitlab.com</code> or your self-hosted URL)</span></label>' +
      '<input id="gl-host" placeholder="https://gitlab.com" value="' + escapeHtml(g.host || 'https://gitlab.com') + '" />' +
      '<label>Admin token env-var<span class="hint">(personal access token with <code>api</code> scope)</span></label>' +
      '<input id="gl-env" placeholder="GITLAB_TOKEN" value="' + escapeHtml(stripRef(g.tokenRef)) + '" />' +
      '<label>Webhook listen port<span class="hint">(incoming GitLab webhooks)</span></label>' +
      '<input id="gl-port" type="number" min="1" max="65535" value="' + (g.webhookPort || 18810) + '" />' +
      '<div class="actions"><button class="primary" onclick="configureGitLab()">' + (configured ? 'Save' : 'Connect') + '</button><div id="gl-msg" class="msg"></div></div>' +
      '<div class="hint-block">Per-project routes and per-agent tokens stay in the <b>Advanced</b> tab (raw JSON). Webhooks from GitLab are also registered in the <b>Webhooks</b> tab with source=<code>gitlab</code>.</div>' +
    '</div>';
  const t = $('gl-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/gitlab/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}
async function configureGitLab() {
  const body = {
    host: $('gl-host').value.trim(),
    tokenEnv: $('gl-env').value.trim(),
    webhookPort: parseInt($('gl-port').value, 10),
  };
  try { const r = await req('POST', '/api/admin/channels/gitlab', body); showMsg($('gl-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : '')); refresh(); }
  catch (e) { showMsg($('gl-msg'), 'err', e.message); }
}

function renderGitHubPane() {
  const daemonUrl = (state.daemonUrl || '').replace(/\\/+$/, '');
  const ghHooks = (state.webhooks || []).filter((w) => w.source === 'github');
  const hookList = ghHooks.length === 0
    ? '<div class="empty">No GitHub webhooks registered yet.</div>'
    : ghHooks.map((w) => {
        const url = daemonUrl + '/webhook/' + encodeURIComponent(w.agentId) + '/github';
        const status = w.enabled
          ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
          : '<span class="chip off">disabled</span>';
        return '<div class="row-card"><div class="info"><h3>' + escapeHtml(w.id) + '</h3>' +
          '<div class="meta">' + status + ' agent: <b>' + escapeHtml(w.agentId) + '</b> · ' +
            '<code style="font-family:var(--ax-mono);font-size:11px">' + escapeHtml(url) + '</code>' +
          '</div></div></div>';
      }).join('');
  $('ch-github').innerHTML =
    '<div class="hint-block" style="margin-bottom:14px">GitHub doesn&rsquo;t need a bot adapter — it speaks webhooks. Register one in the <b>Webhooks</b> tab with <code>source=github</code>, bind it to an agent, then paste the generated URL into the repo&rsquo;s <i>Settings → Webhooks</i>.</div>' +
    '<div class="list">' + hookList + '</div>' +
    '<div class="actions"><button class="primary" onclick="jumpToWebhooks()">Add a GitHub webhook →</button></div>';
}
function jumpToWebhooks() {
  for (const btn of document.querySelectorAll('nav.tabs button')) {
    if (btn.dataset.tab === 'webhooks') btn.click();
  }
  const src = document.getElementById('w-source');
  if (src) src.value = 'github';
}

function renderWhatsAppPane() {
  const w = state.whatsapp || {};
  const enabled = !!w.enabled;
  const statusChip = enabled
    ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
    : '<span class="chip off">disabled</span>';
  $('ch-whatsapp').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>WhatsApp</h3>' +
      '<div class="meta">' + statusChip +
        ' · session dir: <code style="font-family:var(--ax-mono)">' + escapeHtml(w.sessionDir) + '</code>' +
        ' · ' + w.routeCount + ' route(s)' +
      '</div></div></div>' +
    '<div id="wa-pairing" class="add-form"><h3>Pairing</h3>' +
      '<div id="wa-status" style="margin-bottom:10px;font-size:12px;color:var(--ax-muted)">checking…</div>' +
      '<div id="wa-qr-wrap" style="display:none;text-align:center;padding:14px;background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:6px">' +
        '<img id="wa-qr" alt="WhatsApp QR" style="width:260px;height:260px;background:#fff;padding:8px;border-radius:4px" />' +
        '<div style="margin-top:10px;font-size:11px;color:var(--ax-muted);line-height:1.55">Open WhatsApp on your phone → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b> and scan. The code refreshes every ~20s.</div>' +
      '</div>' +
      '<div id="wa-connected" style="display:none;padding:14px;background:color-mix(in oklch,var(--ax-accent) 10%,transparent);border:1px solid color-mix(in oklch,var(--ax-accent) 35%,transparent);border-radius:6px;color:var(--ax-accent);font-size:13px">✓ Paired — the daemon is signed in.</div>' +
      '<div id="wa-disabled" style="display:none;padding:14px;font-size:12px;color:var(--ax-muted);line-height:1.6">WhatsApp is currently disabled in <code>agentx.json</code>. Enable it there (or via the Advanced tab) and restart the daemon; the QR will appear once Baileys needs it.</div>' +
      '<div class="hint-block" style="margin-top:12px">Routes, phone numbers, and allow-lists live under <code>channels.whatsapp</code> in the <b>Advanced</b> tab. Requires <code>@whiskeysockets/baileys</code> installed in the daemon&rsquo;s dir.</div>' +
    '</div>' +
    '<details class="add-form" style="margin-top:14px"><summary class="primary">📥 Wiki ingest from WhatsApp</summary>' +
      '<div style="margin-top:10px">' +
        '<p style="font-size:11px;color:var(--ax-muted);margin:0 0 10px">Sweep observed WhatsApp chats/contacts into an agent\'s wiki. Mirrors <code>agentx whatsapp ingest-all/list-chats/list-contacts</code>.</p>' +
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<button class="ax-btn" onclick="loadWhatsAppLists()">Reload chats + contacts</button>' +
          '<label class="ax-inline" style="display:inline-flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="wa-ingest-dry" checked /> dry-run</label>' +
          '<label class="ax-inline" style="display:inline-flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="wa-ingest-force" /> force (override <code>ingest.enabled=false</code>)</label>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<input id="wa-ingest-agent" placeholder="agent id (defaults to channels.whatsapp.defaultAgent)" style="flex:1" />' +
          '<button class="ax-btn ax-btn--primary" onclick="runWhatsAppIngest()">Sweep now</button>' +
        '</div>' +
        '<div id="wa-ingest-msg" class="msg" style="margin-bottom:10px"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div><h4 style="font-size:11px;color:var(--ax-muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:0.04em">Chats</h4><div id="wa-chats" style="max-height:200px;overflow-y:auto;border:1px solid var(--ax-border);border-radius:4px;padding:6px;font-family:\'IBM Plex Mono\',monospace;font-size:11px">click reload</div></div>' +
          '<div><h4 style="font-size:11px;color:var(--ax-muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:0.04em">Contacts</h4><div id="wa-contacts" style="max-height:200px;overflow-y:auto;border:1px solid var(--ax-border);border-radius:4px;padding:6px;font-family:\'IBM Plex Mono\',monospace;font-size:11px">click reload</div></div>' +
        '</div>' +
      '</div>' +
    '</details>';
  startWhatsAppPolling();
}

window.loadWhatsAppLists = async function() {
  try {
    const [chats, contacts] = await Promise.all([
      req('GET', '/api/admin/channels/whatsapp/chats').catch(() => ({chats:[]})),
      req('GET', '/api/admin/channels/whatsapp/contacts').catch(() => ({contacts:[]})),
    ]);
    const cl = $('wa-chats');
    const cs = chats.chats || [];
    cl.innerHTML = cs.length ? cs.slice(0, 100).map(c => '<div>' + escapeHtml(c.name || c.jid || '?') + ' <span style="color:var(--ax-muted)">' + (c.kind || '') + '</span></div>').join('') : '<i style="color:var(--ax-muted)">empty</i>';
    const xl = $('wa-contacts');
    const xs = contacts.contacts || [];
    xl.innerHTML = xs.length ? xs.slice(0, 100).map(c => '<div>' + escapeHtml(c.name || c.jid || '?') + '</div>').join('') : '<i style="color:var(--ax-muted)">empty</i>';
  } catch (e) { showMsg($('wa-ingest-msg'), 'err', e.message); }
}

window.runWhatsAppIngest = async function() {
  const agent = $('wa-ingest-agent').value.trim();
  const dryRun = $('wa-ingest-dry').checked;
  const force = $('wa-ingest-force').checked;
  const body = { dryRun, force };
  if (agent) body.agent = agent;
  showMsg($('wa-ingest-msg'), 'info', 'sweeping…');
  try {
    const r = await req('POST', '/api/admin/channels/whatsapp/ingest', body);
    showMsg($('wa-ingest-msg'), 'ok', 'Done — ' + (r.summary || JSON.stringify(r).slice(0, 120)));
  } catch (e) { showMsg($('wa-ingest-msg'), 'err', e.message); }
}

const _wa = { timer: null, lastQRSeen: '' };
function startWhatsAppPolling() {
  stopWhatsAppPolling();
  _wa.timer = setInterval(pollWhatsAppState, 3000);
  pollWhatsAppState();
}
function stopWhatsAppPolling() {
  if (_wa.timer) { clearInterval(_wa.timer); _wa.timer = null; }
}
async function pollWhatsAppState() {
  // Stop polling if the user switched away from the WhatsApp pane.
  const pane = $('ch-whatsapp');
  if (!pane || pane.hidden) { stopWhatsAppPolling(); return; }
  try {
    const s = await req('GET', '/api/admin/channels/whatsapp/state');
    const enabled = !!(state.whatsapp && state.whatsapp.enabled);
    const status = $('wa-status');
    const qrWrap = $('wa-qr-wrap');
    const connected = $('wa-connected');
    const disabled = $('wa-disabled');
    const qrImg = $('wa-qr');
    if (!enabled) {
      status.textContent = 'disabled in config';
      qrWrap.style.display = 'none'; connected.style.display = 'none'; disabled.style.display = 'block';
      return;
    }
    disabled.style.display = 'none';
    const connState = s.connection || 'init';
    const detail = s.detail ? ' — ' + s.detail : '';
    if (connState === 'open') {
      status.innerHTML = '<span style="color:var(--ax-accent)">● connected</span>';
      qrWrap.style.display = 'none'; connected.style.display = 'block';
    } else if (s.qr) {
      status.innerHTML = '<span style="color:var(--ax-warn)">● waiting for scan</span>' + (detail ? escapeHtml(detail) : '');
      connected.style.display = 'none'; qrWrap.style.display = 'block';
      // Bust cache when the QR actually changed.
      if (s.qrUpdatedAt !== _wa.lastQRSeen) {
        _wa.lastQRSeen = s.qrUpdatedAt;
        qrImg.src = '/api/admin/channels/whatsapp/qr.svg?t=' + encodeURIComponent(s.qrUpdatedAt || Date.now());
      }
    } else {
      status.textContent = connState + detail + ' — waiting for the daemon to emit a QR…';
      qrWrap.style.display = 'none'; connected.style.display = 'none';
    }
  } catch (e) {
    $('wa-status').innerHTML = '<span style="color:var(--ax-err)">' + escapeHtml(e.message) + '</span>';
  }
}

function renderSlackSection() {
  const s = state.slack || {};
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '"' +
    (a.id === (s.agentBinding || '') ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  // Strip dollar-brace wrappers so the edit form shows just the env-var name.
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const configured = s.botTokenRef && s.appTokenRef;
  const statusChip = configured
    ? (s.enabled
      ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
      : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';

  $('slack-section').innerHTML =
    '<h3 style="margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted)">Slack</h3>' +
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3># slack workspace</h3>' +
      '<div class="meta">' + statusChip +
        (s.botTokenRef ? ' bot: <code style="font-family:var(--ax-mono)">' + escapeHtml(s.botTokenRef) + '</code>' : '') +
        (s.appTokenRef ? ' · app: <code style="font-family:var(--ax-mono)">' + escapeHtml(s.appTokenRef) + '</code>' : '') +
        (s.agentBinding ? ' · agent: <b>' + escapeHtml(s.agentBinding) + '</b>' : '') +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="slack-toggle"' + (s.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit Slack connection' : 'Connect Slack') + '</h3>' +
      '<div class="rowf">' +
        '<div><label>Bot token env-var<span class="hint">(<code>xoxb-…</code>)</span></label><input id="slack-bot-env" placeholder="SLACK_BOT_TOKEN" value="' + escapeHtml(stripRef(s.botTokenRef)) + '" /></div>' +
        '<div><label>App token env-var<span class="hint">(<code>xapp-…</code> — Socket Mode)</span></label><input id="slack-app-env" placeholder="SLACK_APP_TOKEN" value="' + escapeHtml(stripRef(s.appTokenRef)) + '" /></div>' +
      '</div>' +
      '<label>Default agent<span class="hint">(optional — used when a Slack message has no explicit @mention of another agent)</span></label>' +
      '<select id="slack-agent"><option value="">(none)</option>' + agentOptions + '</select>' +
      '<div class="actions"><button class="primary" onclick="configureSlack()">' + (configured ? 'Save changes' : 'Connect') + '</button>' +
        '<div id="slack-msg" class="msg"></div></div>' +
      '<div class="hint-block">Create the Slack app at <code>api.slack.com/apps</code>, enable Socket Mode, and generate an app-level token with <code>connections:write</code>. Bot needs scopes <code>chat:write</code>, <code>app_mentions:read</code>, <code>channels:history</code>, <code>im:history</code>, <code>users:read</code>, and event subscriptions for <code>app_mention</code> + <code>message.*</code>. Add <code>xoxb-…</code> and <code>xapp-…</code> to <code>.env</code>, then install <code>@slack/socket-mode</code> + <code>@slack/web-api</code>.</div>' +
    '</div>';
  const t = $('slack-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/slack/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}

async function configureSlack() {
  const body = {
    botTokenEnv: $('slack-bot-env').value.trim(),
    appTokenEnv: $('slack-app-env').value.trim(),
    agentBinding: $('slack-agent').value,
  };
  try {
    const r = await req('POST', '/api/admin/channels/slack', body);
    showMsg($('slack-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : ''));
    refresh();
  } catch (e) { showMsg($('slack-msg'), 'err', e.message); }
}

function openTelegramEdit(acc) {
  const modal = $('tg-edit-modal');
  $('tg-edit-title').textContent = 'Edit Telegram · ' + acc.id;
  $('tg-edit-agent').innerHTML = state.agents.map((a) =>
    '<option value="' + escapeHtml(a.id) + '"' + (a.id === acc.agentBinding ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  $('tg-edit-user').value = acc.botUsername || '';
  // Current token ref is a dollar-brace placeholder — strip the wrapper for the form.
  const ref = acc.botTokenRef || '';
  $('tg-edit-env').value = ref.replace(/^\\\$\\{|\\}$/g, '');
  $('tg-edit-id').value = acc.id;
  $('tg-edit-msg').className = 'msg';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTelegramEdit() {
  const modal = $('tg-edit-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

async function saveTelegramEdit() {
  const id = $('tg-edit-id').value;
  const patch = {
    agentBinding: $('tg-edit-agent').value,
    botUsername: $('tg-edit-user').value.trim(),
    botTokenEnv: $('tg-edit-env').value.trim(),
  };
  try {
    await req('PATCH', '/api/admin/channels/telegram', { id, patch });
    showMsg($('tg-edit-msg'), 'ok', 'Saved.');
    setTimeout(() => { closeTelegramEdit(); refresh(); }, 500);
  } catch (e) { showMsg($('tg-edit-msg'), 'err', e.message); }
}

async function addTelegram() {
  const body = {
    id: $('tg-id').value.trim(),
    agentBinding: $('tg-agent').value,
    botUsername: $('tg-user').value.trim(),
    botTokenEnv: $('tg-env').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/channels/telegram', body);
    showMsg($('tg-msg'), 'ok', (r.summary || 'Added.') + (r.hint ? ' — ' + r.hint : ''));
    refresh();
  } catch (e) { showMsg($('tg-msg'), 'err', e.message); }
}

async function deleteTelegram(id) {
  if (!confirm('Delete Telegram account "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/channels/telegram', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderCrons() {
  const list = $('cron-list');
  if (!state.crons.length) {
    list.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:42px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><h3 style="margin:0 0 4px;color:var(--ax-text);font-size:15px;font-weight:600">No schedules yet</h3><p style="margin:0;font-size:13px">Create one below to nudge an agent on a timer.</p></div>';
    return;
  }
  list.innerHTML = '';
  for (const c of state.crons) {
    const card = document.createElement('div');
    card.className = 'ax-row-card';
    card.innerHTML =
      '<div class="ax-row-card__top">' +
        '<div class="ax-avatar ax-avatar--' + avatarVariant(c.id) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '</div>' +
        '<div class="ax-row-card__info">' +
          '<div class="ax-name">' + escapeHtml(c.id) + '</div>' +
          '<div class="ax-sub">' +
            '<span class="ax-pill"><span class="ax-pill__dot" style="background:var(--ax-accent)"></span>' + escapeHtml(c.schedule) + '</span>' +
            ' runs <b>' + escapeHtml(c.agent) + '</b>' +
            (c.prompt ? ' · ' + escapeHtml(c.prompt.slice(0, 80) + (c.prompt.length > 80 ? '…' : '')) : '') +
          '</div>' +
        '</div>' +
        '<div class="ax-row-card__actions">' +
          '<button class="ax-btn ax-btn--danger" data-id="' + escapeHtml(c.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    card.querySelector('[data-id]').addEventListener('click', () => deleteCron(c.id));
    list.appendChild(card);
  }
}

async function addCron() {
  const body = {
    id: $('c-id').value.trim(),
    schedule: $('c-schedule').value.trim(),
    agent: $('c-agent').value,
    prompt: $('c-prompt').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/crons', body);
    showMsg($('c-msg'), 'ok', r.summary || 'Added.');
    $('c-id').value = ''; $('c-schedule').value = ''; $('c-prompt').value = '';
    refresh();
  } catch (e) { showMsg($('c-msg'), 'err', e.message); }
}

async function deleteCron(id) {
  if (!confirm('Delete schedule "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/crons', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

/* ========== Schedule builder (Guided mode) ==========
 * Translates sentence-builder selections (agent/frequency/days/hour) into a
 * cron expression and populates the hidden #c-schedule input used by
 * addCron(). Also keeps the /preview endpoint happy with the natural-
 * language preview line. */

let __scheduleState = { agent: '', freq: 'weekly', days: [1], hour: 9 };

function scheduleCronFromState() {
  const s = __scheduleState;
  if (s.freq === 'hourly') return '0 * * * *';
  if (s.freq === '15min')  return '*/15 * * * *';
  if (s.freq === 'daily')  return '0 ' + s.hour + ' * * *';
  if (s.freq === 'weekdays') return '0 ' + s.hour + ' * * 1-5';
  // weekly → days
  const dow = s.days.length ? s.days.slice().sort().join(',') : '1';
  return '0 ' + s.hour + ' * * ' + dow;
}

function schedulePreviewText() {
  const s = __scheduleState;
  const hh = ((s.hour + 11) % 12) + 1;
  const ap = s.hour < 12 ? 'am' : 'pm';
  const time = hh + ':00 ' + ap;
  if (s.freq === 'hourly') return 'Every hour on the hour';
  if (s.freq === '15min')  return 'Every 15 minutes';
  if (s.freq === 'daily')  return 'Every day at ' + time;
  if (s.freq === 'weekdays') return 'Weekdays at ' + time;
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const pretty = s.days.slice().sort().map(d => names[d]).join(', ');
  return (pretty || 'No day picked') + ' at ' + time;
}

function updateSchedulePreview() {
  const cron = scheduleCronFromState();
  const $id = (x) => document.getElementById(x);
  const preview = $id('s-preview-text');
  if (preview) preview.innerHTML = '<b>' + schedulePreviewText() + '</b> &nbsp;·&nbsp; cron: <span class="mono" style="color:var(--ax-text)">' + cron + '</span>';
  const echo = $id('s-cron-echo');
  if (echo) echo.textContent = cron;
  // Keep the hidden #c-schedule + #c-agent in sync so addCron() reads them.
  const schedInp = $id('c-schedule');
  if (schedInp) schedInp.value = cron;
  const agentSel = $id('c-agent');
  if (agentSel) agentSel.value = __scheduleState.agent || (agentSel.options[0] && agentSel.options[0].value);
}

function initScheduleBuilder() {
  const freq = document.getElementById('s-freq');
  const hour = document.getElementById('s-hour');
  const agent = document.getElementById('s-agent');
  const sAt = document.getElementById('s-at');
  if (!freq || !hour || !agent) return;
  // Default active day = Monday
  const dayBtns = document.querySelectorAll('#s-days button');
  dayBtns.forEach((b) => {
    if (b.dataset.day === '1') b.classList.add('is-active');
    b.addEventListener('click', () => {
      b.classList.toggle('is-active');
      __scheduleState.days = [...document.querySelectorAll('#s-days button.is-active')]
        .map(el => parseInt(el.dataset.day, 10));
      updateSchedulePreview();
    });
  });
  // Populate agent select from state
  agent.innerHTML = state.agents.map((a) =>
    '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>'
  ).join('');
  if (agent.options.length) __scheduleState.agent = agent.options[0].value;

  // Mode switch
  document.querySelectorAll('#sched-mode button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#sched-mode button').forEach((x) => x.classList.toggle('is-active', x === b));
      const simple = document.getElementById('sched-simple');
      const expert = document.getElementById('sched-expert');
      if (!simple || !expert) return;
      const mode = b.dataset.mode;
      simple.style.display = mode === 'simple' ? '' : 'none';
      expert.style.display = mode === 'expert' ? '' : 'none';
    });
  });

  // Hide day-picker + "at" unless frequency is weekly
  const reflectFreq = () => {
    const days = document.getElementById('s-days');
    const show = __scheduleState.freq === 'weekly';
    if (days) days.style.display = show ? '' : 'none';
    const alwaysTimeless = (__scheduleState.freq === 'hourly' || __scheduleState.freq === '15min');
    if (sAt) sAt.style.display = alwaysTimeless ? 'none' : '';
    hour.style.display = alwaysTimeless ? 'none' : '';
  };

  agent.addEventListener('change', () => { __scheduleState.agent = agent.value; updateSchedulePreview(); });
  freq.addEventListener('change', () => { __scheduleState.freq = freq.value; reflectFreq(); updateSchedulePreview(); });
  hour.addEventListener('change', () => {
    // "9:00 am" → 9, "2:00 pm" → 14
    const text = hour.value.trim().toLowerCase();
    const m = text.match(/^(\\d+):\\d+\\s*(am|pm)/);
    if (m) {
      let h = parseInt(m[1], 10);
      if (m[2] === 'pm' && h !== 12) h += 12;
      if (m[2] === 'am' && h === 12) h = 0;
      __scheduleState.hour = h;
    }
    updateSchedulePreview();
  });

  reflectFreq();
  updateSchedulePreview();
}

async function addCronExpert() {
  // Expert mode has its own id/agent/prompt inputs; mirror them into
  // the canonical #c-* ids before dispatching.
  const $id = (x) => document.getElementById(x);
  $id('c-id').value = $id('c-id-expert').value.trim();
  const expertAgent = $id('c-agent-expert');
  if (expertAgent && expertAgent.value) {
    $id('c-agent').value = expertAgent.value;
  }
  $id('c-prompt').value = $id('c-prompt-expert').value.trim();
  await addCron();
}

// Expert-mode agent dropdown mirrors the guided one.
function initScheduleExpertAgentSelect() {
  const sel = document.getElementById('c-agent-expert');
  if (!sel) return;
  sel.innerHTML = state.agents.map((a) =>
    '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>'
  ).join('');
}

// Live cron preview — debounced so each keystroke doesn't hit the server.
let cronPreviewTimer = null;
function scheduleCronPreview() {
  if (cronPreviewTimer) clearTimeout(cronPreviewTimer);
  cronPreviewTimer = setTimeout(runCronPreview, 300);
}
async function runCronPreview() {
  const expr = $('c-schedule').value.trim();
  const box = $('c-preview');
  if (!expr) { box.textContent = ''; return; }
  try {
    const r = await req('POST', '/api/admin/crons/preview', { schedule: expr });
    const fires = r.next.map((iso) => new Date(iso).toLocaleString()).slice(0, 3);
    box.innerHTML =
      '<div style="color:var(--text)"><b>' + escapeHtml(r.human) + '</b></div>' +
      '<div style="margin-top:4px">Next runs (' + escapeHtml(r.timezone) + '): ' + fires.map(escapeHtml).join(' · ') + '</div>';
  } catch (e) {
    box.innerHTML = '<div style="color:var(--red)">' + escapeHtml(e.message) + '</div>';
  }
}
$('c-schedule').addEventListener('input', scheduleCronPreview);

// --- Files modal (identity + skills) ---
const filesModal = {
  el: $('files-modal'),
  agentId: null,
  agentName: null,
  currentTab: 'identity',  // 'identity' | 'skills'
  currentPath: null,       // path of file being edited
  originalContent: '',     // for revert
};

async function openFilesModal(agentId, agentName) {
  filesModal.agentId = agentId;
  filesModal.agentName = agentName;
  $('files-title').textContent = agentName + ' · Files';
  filesModal.el.classList.remove('hidden');
  filesModal.el.setAttribute('aria-hidden', 'false');
  switchFilesTab('identity');
}

function closeFilesModal() {
  filesModal.el.classList.add('hidden');
  filesModal.el.setAttribute('aria-hidden', 'true');
  filesModal.agentId = null;
  filesModal.currentPath = null;
  hideFileEditor();
}

function switchFilesTab(tab) {
  filesModal.currentTab = tab;
  filesModal.currentPath = null;
  $('files-tab-label').textContent = tab === 'skills' ? 'Skills' : 'Identity';
  $('files-tab-identity').style.background = tab === 'identity' ? 'rgba(99,102,241,0.15)' : 'transparent';
  $('files-tab-skills').style.background = tab === 'skills' ? 'rgba(99,102,241,0.15)' : 'transparent';
  $('files-add-skill').style.display = tab === 'skills' ? 'block' : 'none';
  hideFileEditor();
  loadFileList();
}

async function loadFileList() {
  const picker = $('files-picker');
  picker.innerHTML = '<div class="empty" style="padding:20px 10px;color:var(--muted)">loading…</div>';
  try {
    const r = await req('GET', '/api/admin/files?agent=' + encodeURIComponent(filesModal.agentId));
    filesModal.overview = r;
    renderFilesPicker(r);
  } catch (e) {
    picker.innerHTML = '<div class="empty" style="color:var(--red);padding:14px">' + escapeHtml(e.message) + '</div>';
  }
}

function renderFilesPicker(overview) {
  const picker = $('files-picker');
  if (filesModal.currentTab === 'identity') {
    const rows = overview.identity.map((f) => {
      const activeCls = filesModal.currentPath === f.path ? ' active' : '';
      const missingCls = f.exists ? '' : ' missing';
      const sizeLabel = f.exists ? formatBytes(f.size) : 'create';
      return '<div class="file' + activeCls + missingCls + '" data-path="' + escapeHtml(f.path) + '">' +
        '<span class="info">' + escapeHtml(f.title) + '</span>' +
        '<span class="size">' + sizeLabel + '</span>' +
      '</div>';
    }).join('');
    picker.innerHTML = '<div class="group">Identity files</div>' + (rows || '<div class="empty">No files.</div>');
  } else {
    if (overview.skills.length === 0) {
      picker.innerHTML = '<div class="group">Skills</div><div class="empty" style="padding:14px;color:var(--muted)">No skills yet.</div>';
    } else {
      const rows = overview.skills.map((s) => {
        const activeCls = filesModal.currentPath === s.path ? ' active' : '';
        return '<div class="file' + activeCls + '" data-path="' + escapeHtml(s.path) + '" data-slug="' + escapeHtml(s.slug) + '">' +
          '<span class="info">' + escapeHtml(s.title) + '<br><span class="size">' + escapeHtml(s.slug) + '</span></span>' +
          '<button class="del" data-rm-skill="' + escapeHtml(s.slug) + '" title="Delete skill">🗑</button>' +
        '</div>';
      }).join('');
      picker.innerHTML = '<div class="group">Skills</div>' + rows;
    }
  }
  for (const row of picker.querySelectorAll('.file')) {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-rm-skill]')) return;
      openFileInEditor(row.dataset.path);
    });
  }
  for (const btn of picker.querySelectorAll('[data-rm-skill]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSkill(btn.dataset.rmSkill);
    });
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\\.0$/, '') + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

async function openFileInEditor(path) {
  filesModal.currentPath = path;
  renderFilesPicker(filesModal.overview);  // restyle active row
  try {
    const r = await req('GET', '/api/admin/files/read?agent=' + encodeURIComponent(filesModal.agentId) + '&path=' + encodeURIComponent(path));
    filesModal.originalContent = r.content;
    $('files-current-path').textContent = path;
    $('files-editor').value = r.content;
    $('files-editor-empty').style.display = 'none';
    $('files-editor-head').style.display = 'flex';
    $('files-editor-wrap').style.display = 'flex';
    $('files-save-msg').className = 'msg';
  } catch (e) { showMsg($('files-save-msg'), 'err', e.message); }
}

function hideFileEditor() {
  $('files-editor-empty').style.display = 'flex';
  $('files-editor-head').style.display = 'none';
  $('files-editor-wrap').style.display = 'none';
  $('files-save-msg').className = 'msg';
  $('files-editor').value = '';
}

async function saveCurrentFile() {
  if (!filesModal.currentPath) return;
  const content = $('files-editor').value;
  try {
    const r = await req('PUT', '/api/admin/files', {
      agent: filesModal.agentId,
      path: filesModal.currentPath,
      content,
    });
    filesModal.originalContent = content;
    showMsg($('files-save-msg'), 'ok', r.summary);
    loadFileList();
  } catch (e) { showMsg($('files-save-msg'), 'err', e.message); }
}

function revertCurrentFile() {
  $('files-editor').value = filesModal.originalContent;
  $('files-save-msg').className = 'msg';
}

async function addSkill() {
  const slug = $('skill-slug').value.trim();
  const title = $('skill-title').value.trim();
  const fileInput = $('skill-file');
  const file = fileInput && fileInput.files && fileInput.files[0];
  let content;
  if (file) {
    try { content = await readFileAsText(file); }
    catch (e) { showMsg($('skill-msg'), 'err', 'Could not read file: ' + e.message); return; }
    if (content.length > 200 * 1024) {
      showMsg($('skill-msg'), 'err', 'File too large (>200 KB). Edit in-place after creation instead.');
      return;
    }
  }
  try {
    const body = { agent: filesModal.agentId, slug, title };
    if (content != null) body.content = content;
    const r = await req('POST', '/api/admin/files/skill', body);
    showMsg($('skill-msg'), 'ok', r.summary);
    $('skill-slug').value = ''; $('skill-title').value = '';
    if (fileInput) fileInput.value = '';
    await loadFileList();
    openFileInEditor(r.path);
  } catch (e) { showMsg($('skill-msg'), 'err', e.message); }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsText(file);
  });
}

// Upload-into-editor: replaces the current file's buffer with the uploaded text.
// User still has to click Save for the write to land on disk, so accidents are reversible.
function wireFilesUpload() {
  const input = $('files-upload');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      if (text.length > 200 * 1024) throw new Error('File too large (>200 KB).');
      $('files-editor').value = text;
      showMsg($('files-save-msg'), 'ok', 'Loaded into editor — click Save to persist.');
    } catch (err) {
      showMsg($('files-save-msg'), 'err', err.message);
    }
    e.target.value = '';
  });
}
wireFilesUpload();

async function removeSkill(slug) {
  if (!confirm('Delete skill "' + slug + '"? The skill folder and SKILL.md will be removed from disk.')) return;
  try {
    await req('DELETE', '/api/admin/files/skill', { agent: filesModal.agentId, slug });
    if (filesModal.currentPath && filesModal.currentPath.includes('/' + slug + '/')) hideFileEditor();
    loadFileList();
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

$('files-close').addEventListener('click', closeFilesModal);
$('files-modal').querySelector('.td-backdrop').addEventListener('click', closeFilesModal);
$('files-tab-identity').addEventListener('click', () => switchFilesTab('identity'));
$('files-tab-skills').addEventListener('click', () => switchFilesTab('skills'));
$('files-save').addEventListener('click', saveCurrentFile);
$('files-revert').addEventListener('click', revertCurrentFile);
$('files-editor').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !filesModal.el.classList.contains('hidden')) closeFilesModal();
});

// --- Edit agent modal ---
const editModal = {
  el: $('edit-modal'),
  currentId: null,
};

function openAgentEdit(agent) {
  editModal.currentId = agent.id;
  $('edit-title').textContent = agent.name + ' · ' + agent.id;
  $('e-name').value = agent.name || '';
  $('e-tier').value = agent.tier || 'claude-code';
  $('e-model').value = agent.model || '';
  $('e-triggers').value = (agent.mentions || []).join(', ');
  $('e-personality').value = agent.systemPrompt || '';
  $('e-max-concurrent').value = agent.maxConcurrent || 1;
  $('e-max-exec').value = agent.maxExecutionMinutes || 20;
  $('e-perm').value = agent.permissionMode || 'default';
  $('e-access').checked = agent.access === 'public';
  $('e-msg').className = 'msg';
  editModal.el.classList.remove('hidden');
  editModal.el.setAttribute('aria-hidden', 'false');
}

function closeAgentEdit() {
  editModal.el.classList.add('hidden');
  editModal.el.setAttribute('aria-hidden', 'true');
  editModal.currentId = null;
}

async function saveAgentEdit() {
  if (!editModal.currentId) return;
  const id = editModal.currentId;
  const maxConcurrent = parseInt($('e-max-concurrent').value, 10);
  const maxExecutionMinutes = parseInt($('e-max-exec').value, 10);
  const patch = {
    name: $('e-name').value.trim(),
    tier: $('e-tier').value,
    model: $('e-model').value.trim(),
    triggerWords: $('e-triggers').value.trim(),
    systemPrompt: $('e-personality').value,
    maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : undefined,
    maxExecutionMinutes: Number.isFinite(maxExecutionMinutes) ? maxExecutionMinutes : undefined,
    permissionMode: $('e-perm').value,
    access: $('e-access').checked ? 'public' : 'private',
  };
  try {
    await req('PATCH', '/api/admin/agents', { id, patch });
    showMsg($('e-msg'), 'ok', 'Saved. The change is live (hot-reloaded).');
    setTimeout(() => { closeAgentEdit(); refresh(); }, 600);
  } catch (e) { showMsg($('e-msg'), 'err', e.message); }
}

// Telegram edit wiring
$('tg-edit-close').addEventListener('click', closeTelegramEdit);
$('tg-edit-cancel').addEventListener('click', closeTelegramEdit);
$('tg-edit-save').addEventListener('click', saveTelegramEdit);
$('tg-edit-modal').querySelector('.td-backdrop').addEventListener('click', closeTelegramEdit);

$('edit-close').addEventListener('click', closeAgentEdit);
$('edit-cancel').addEventListener('click', closeAgentEdit);
$('edit-save').addEventListener('click', saveAgentEdit);
editModal.el.querySelector('.td-backdrop').addEventListener('click', closeAgentEdit);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !editModal.el.classList.contains('hidden')) closeAgentEdit();
});

// --- Test drive chat modal ---
const testDrive = {
  modal: $('td-modal'),
  body: $('td-body'),
  title: $('td-title'),
  input: $('td-input'),
  sendBtn: $('td-send'),
  hint: $('td-hint'),
  closeBtn: $('td-close'),
  agentId: null,
  chatId: null,  // stable per modal open so follow-ups share session context
  thinkingEl: null,
  busy: false,
};

function openTestDrive(agentId, agentName) {
  testDrive.agentId = agentId;
  testDrive.chatId = 'admin-' + Date.now();
  testDrive.title.textContent = agentName + ' · ' + agentId;
  testDrive.body.innerHTML = '<div class="td-empty">Send a message to sanity-check this agent before wiring it to a real channel.</div>';
  testDrive.hint.textContent = 'Session: ' + testDrive.chatId + ' · channel: test-drive';
  testDrive.input.value = '';
  testDrive.modal.classList.remove('hidden');
  testDrive.modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => testDrive.input.focus(), 50);
}

function closeTestDrive() {
  testDrive.modal.classList.add('hidden');
  testDrive.modal.setAttribute('aria-hidden', 'true');
  testDrive.agentId = null;
  testDrive.chatId = null;
}

function appendChat(kind, text) {
  const empty = testDrive.body.querySelector('.td-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'td-msg ' + kind;
  el.textContent = text;
  testDrive.body.appendChild(el);
  testDrive.body.scrollTop = testDrive.body.scrollHeight;
  return el;
}

async function sendTestDrive() {
  if (testDrive.busy) return;
  const msg = testDrive.input.value.trim();
  if (!msg || !testDrive.agentId) return;
  appendChat('user', msg);
  testDrive.input.value = '';
  testDrive.input.style.height = 'auto';
  testDrive.thinkingEl = appendChat('thinking', 'thinking…');
  testDrive.busy = true;
  testDrive.sendBtn.disabled = true;
  try {
    const r = await req('POST', '/api/admin/agents/test', {
      agent: testDrive.agentId,
      message: msg,
      chatId: testDrive.chatId,
    });
    testDrive.thinkingEl?.remove();
    testDrive.thinkingEl = null;
    const reply = r?.response?.content || r?.response?.error || '(empty reply)';
    appendChat(r?.response?.error ? 'err' : 'agent', reply);
  } catch (e) {
    testDrive.thinkingEl?.remove();
    testDrive.thinkingEl = null;
    appendChat('err', e.message);
  } finally {
    testDrive.busy = false;
    testDrive.sendBtn.disabled = false;
    testDrive.input.focus();
  }
}

testDrive.sendBtn.addEventListener('click', sendTestDrive);
testDrive.closeBtn.addEventListener('click', closeTestDrive);
testDrive.modal.querySelector('.td-backdrop').addEventListener('click', closeTestDrive);
testDrive.input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendTestDrive(); }
});
testDrive.input.addEventListener('input', () => {
  // Autogrow the textarea up to 120px.
  testDrive.input.style.height = 'auto';
  testDrive.input.style.height = Math.min(testDrive.input.scrollHeight, 120) + 'px';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !testDrive.modal.classList.contains('hidden')) closeTestDrive();
});

// --- Tokens tab ---
const SCOPE_CHOICES = [
  { value: 'dashboard:read', label: 'Read dashboard + live view' },
  { value: 'dashboard:write', label: 'Write (admin + config) — full control' },
  { value: 'agent:*', label: 'Message any public agent' },
  { value: 'mesh:peer', label: 'Mesh peer auth (cross-node)' },
];

function renderScopeChoices() {
  const publicAgents = state.agents.filter((a) => a.access === 'public');
  const agentScopes = publicAgents.map((a) => ({ value: 'agent:' + a.id, label: 'Message agent: ' + a.name + ' (' + a.id + ')' }));
  const all = SCOPE_CHOICES.concat(agentScopes);
  const host = $('t-scopes');
  host.innerHTML = all.map((c) => {
    return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);font-weight:400;margin:0">' +
      '<input type="checkbox" value="' + escapeHtml(c.value) + '" style="width:auto" /> ' +
      '<code style="background:#0e1119;padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace;font-size:11px;color:var(--accent)">' + escapeHtml(c.value) + '</code>' +
      '<span style="color:var(--muted)">— ' + escapeHtml(c.label) + '</span>' +
    '</label>';
  }).join('');
}

async function loadTokens() {
  renderScopeChoices();
  try {
    const tokens = await req('GET', '/api/admin/tokens');
    const list = $('token-list');
    if (!tokens.length) {
      list.innerHTML = '<div class="ax-empty-card" style="text-align:center;padding:42px 22px;background:var(--ax-surface);border:1px dashed var(--ax-border-2);border-radius:var(--ax-radius-lg);color:var(--ax-muted)"><h3 style="margin:0 0 4px;color:var(--ax-text);font-size:15px;font-weight:600">No tokens yet</h3><p style="margin:0;font-size:13px">Create one below to let a script, a chat bridge, or another AgentX machine talk to this one.</p></div>';
      return;
    }
    list.innerHTML = '';
    for (const t of tokens) {
      const now = Date.now();
      const expired = t.expiresAt && Date.parse(t.expiresAt) < now;
      const stale = t.lastUsedAt && (now - Date.parse(t.lastUsedAt)) > 30 * 24 * 60 * 60 * 1000 && !t.revokedAt;
      const statusPill = t.revokedAt
        ? '<span class="ax-pill ax-pill--off">revoked</span>'
        : (expired
          ? '<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>expired</span>'
          : (stale
            ? '<span class="ax-pill ax-pill--warn"><span class="ax-pill__dot"></span>stale</span>'
            : '<span class="ax-pill ax-pill--ok"><span class="ax-pill__dot"></span>active</span>'));
      const sub = [
        (t.scopes && t.scopes.length) ? 'scopes: ' + t.scopes.map(escapeHtml).join(', ') : 'no scopes',
        t.lastUsedAt ? 'last used ' + new Date(t.lastUsedAt).toLocaleString() : 'never used',
        t.expiresAt ? 'expires ' + new Date(t.expiresAt).toLocaleDateString() : 'no expiry',
      ].join(' · ');
      const avClass = t.revokedAt ? '' : (stale || expired ? 'ax-avatar--amber' : 'ax-avatar--teal');
      const card = document.createElement('div');
      card.className = 'ax-row-card';
      card.innerHTML =
        '<div class="ax-row-card__top">' +
          '<div class="ax-avatar ' + avClass + '">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2"/></svg>' +
          '</div>' +
          '<div class="ax-row-card__info">' +
            '<div class="ax-name">' + escapeHtml(t.name) + ' ' + statusPill + '</div>' +
            '<div class="ax-sub"><span class="mono">' + escapeHtml(t.prefix) + '…</span> · ' + sub + '</div>' +
          '</div>' +
          '<div class="ax-row-card__actions">' +
            (t.revokedAt ? '' : '<button class="ax-btn ax-btn--danger" data-revoke="' + escapeHtml(t.id) + '">Revoke</button>') +
          '</div>' +
        '</div>';
      const del = card.querySelector('[data-revoke]');
      if (del) del.addEventListener('click', () => revokeToken(t.id));
      list.appendChild(card);
    }
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function createToken() {
  const name = $('t-name').value.trim();
  const scopes = [...document.querySelectorAll('#t-scopes input:checked')].map((el) => el.value);
  const expires = $('t-expires').value.trim();
  try {
    const body = { name, scopes, expiresInDays: expires ? parseInt(expires, 10) : undefined };
    const r = await req('POST', '/api/admin/tokens', body);
    $('t-secret').textContent = r.token;
    $('t-reveal').style.display = 'block';
    showMsg($('t-msg'), 'ok', r.summary);
    $('t-name').value = ''; $('t-expires').value = '';
    document.querySelectorAll('#t-scopes input:checked').forEach((el) => { el.checked = false; });
    loadTokens();
  } catch (e) { showMsg($('t-msg'), 'err', e.message); }
}

async function revokeToken(id) {
  if (!confirm('Revoke this token? Any callers using it will immediately fail.')) return;
  try { await req('DELETE', '/api/admin/tokens', { id }); loadTokens(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

/* ========== Advanced tab: JSON tree viewer ==========
 *
 * Three modes:
 *   tree  — collapsible key/value tree with search + inline hints
 *   raw   — pretty-printed read-only JSON
 *   edit  — writable textarea (same behavior as the legacy Advanced tab)
 *
 * All three populate from the SAME /api/admin/config payload. When saving,
 * we send the text back to /api/admin/config/raw (only "edit" mode has a
 * writable textarea; tree and raw are read-only). */

const JV_HINTS = {
  'node.name': 'friendly name of this daemon',
  'node.id': 'stable identifier, used in logs',
  'agents[].id': 'lowercase handle, used in logs',
  'agents[].tier': 'which AI engine runs this agent (claude-code / sdk / orchestrator)',
  'agents[].mentions': 'trigger words that wake this agent',
  'channels.telegram.accounts[].botToken': 'reference to an env-var, not the token itself',
  'channels.telegram.accounts[].agentBinding': 'which agent answers messages to this bot',
  'crons[].schedule': 'standard five-field cron',
  'mesh.peers[].url': 'full URL including port',
  'tokens[].scopes': 'permissions this token grants',
};

let __jvMode = 'tree';
let __jvRawConfig = null;

function renderJvLine(value, path, keyLabel, parent) {
  const isArr = Array.isArray(value);
  const isObj = value && typeof value === 'object' && !isArr;
  const line = document.createElement('div');
  line.className = 'ax-jv-line';
  line.dataset.path = path;

  const tog = document.createElement('span');
  tog.className = 'ax-jv-toggle';
  const empty = (isArr ? value.length === 0 : (isObj ? Object.keys(value).length === 0 : true));
  if ((isArr || isObj) && !empty) {
    tog.textContent = '▾';
    tog.addEventListener('click', () => {
      const kids = line.nextElementSibling;
      if (kids && kids.classList.contains('ax-jv-children')) {
        const willCollapse = !kids.classList.contains('is-collapsed');
        kids.classList.toggle('is-collapsed');
        tog.textContent = willCollapse ? '▸' : '▾';
      }
    });
  } else {
    tog.className += ' empty';
  }
  line.appendChild(tog);

  if (keyLabel !== null) {
    const k = document.createElement('span');
    k.className = 'ax-jv-key';
    k.textContent = '"' + keyLabel + '"';
    line.appendChild(k);
    const colon = document.createElement('span');
    colon.className = 'ax-jv-punc';
    colon.textContent = ': ';
    line.appendChild(colon);
  }

  if (isArr || isObj) {
    const open = document.createElement('span');
    open.className = 'ax-jv-punc';
    open.textContent = isArr ? '[' : '{';
    line.appendChild(open);
    if (empty) {
      const close = document.createElement('span');
      close.className = 'ax-jv-empty-brace';
      close.textContent = isArr ? ']' : '}';
      line.appendChild(close);
    }
  } else if (value === null) {
    const v = document.createElement('span'); v.className = 'ax-jv-null'; v.textContent = 'null'; line.appendChild(v);
  } else if (typeof value === 'boolean') {
    const v = document.createElement('span'); v.className = 'ax-jv-bool'; v.textContent = String(value); line.appendChild(v);
  } else if (typeof value === 'number') {
    const v = document.createElement('span'); v.className = 'ax-jv-number'; v.textContent = String(value); line.appendChild(v);
  } else {
    const v = document.createElement('span'); v.className = 'ax-jv-string'; v.textContent = '"' + String(value) + '"'; line.appendChild(v);
  }

  const hintKey = path.replace(/\\[\\d+\\]/g, '[]');
  const hint = JV_HINTS[hintKey];
  if (hint) {
    const c = document.createElement('span');
    c.className = 'ax-jv-comment';
    c.textContent = '// ' + hint;
    line.appendChild(c);
  }

  parent.appendChild(line);

  if ((isArr || isObj) && !empty) {
    const wrap = document.createElement('div');
    wrap.className = 'ax-jv-children';
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    entries.forEach(([k, v]) => {
      const childPath = isArr ? path + '[' + k + ']' : (path ? path + '.' + k : String(k));
      renderJvLine(v, childPath, isArr ? null : k, wrap);
    });
    parent.appendChild(wrap);
    const close = document.createElement('div');
    close.className = 'ax-jv-line';
    const spacer = document.createElement('span');
    spacer.className = 'ax-jv-toggle empty';
    close.appendChild(spacer);
    const b = document.createElement('span');
    b.className = 'ax-jv-punc';
    b.textContent = isArr ? ']' : '}';
    close.appendChild(b);
    parent.appendChild(close);
  }
}

function renderJvTree(cfg) {
  const root = document.getElementById('jv-viewer');
  if (!root) return;
  root.innerHTML = '';
  root.style.whiteSpace = '';
  renderJvLine(cfg, '', null, root);
}

function renderJvRaw(cfg) {
  const root = document.getElementById('jv-viewer');
  if (!root) return;
  root.innerHTML = '<pre style="margin:0;font:inherit;color:var(--ax-text-2);white-space:pre-wrap">' +
    escapeHtml(JSON.stringify(cfg, null, 2)) + '</pre>';
}

function renderJvEdit(cfg) {
  const root = document.getElementById('jv-viewer');
  const ta = document.getElementById('raw-editor');
  if (!root || !ta) return;
  root.innerHTML = '';
  ta.value = JSON.stringify(cfg, null, 2);
  ta.style.cssText = 'display:block;width:100%;min-height:500px;background:var(--ax-bg-elev);color:var(--ax-text);border:1px solid var(--ax-border);border-top:0;border-radius:0 0 var(--ax-radius) var(--ax-radius);font:inherit;font-family:var(--ax-mono);font-size:12.5px;padding:14px 18px;resize:vertical;outline:none';
  root.style.display = 'none';
}

function applyJvMode(mode) {
  __jvMode = mode;
  const root = document.getElementById('jv-viewer');
  const ta = document.getElementById('raw-editor');
  if (!root || !ta) return;
  if (mode !== 'edit') { root.style.display = ''; ta.style.display = 'none'; }
  if (mode === 'tree') renderJvTree(__jvRawConfig);
  if (mode === 'raw')  renderJvRaw(__jvRawConfig);
  if (mode === 'edit') renderJvEdit(__jvRawConfig);
  document.querySelectorAll('#jv-mode button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.jvMode === mode);
  });
}

async function loadRaw() {
  try {
    const r = await fetch('/api/admin/config');
    const txt = await r.text();
    // Try parsing; if it fails, fall back to edit mode with the raw text.
    try {
      __jvRawConfig = JSON.parse(txt);
      applyJvMode(__jvMode);
      const meta = document.getElementById('jv-meta');
      if (meta) {
        const kb = (txt.length / 1024).toFixed(1);
        meta.textContent = 'agentx.json · ' + kb + ' KB';
      }
      showMsg($('r-msg'), 'ok', 'Loaded.');
    } catch (pe) {
      __jvRawConfig = null;
      applyJvMode('edit');
      $('raw-editor').value = txt;
      showMsg($('r-msg'), 'err', 'Config is not valid JSON — open Edit mode to fix it.');
    }
  } catch (e) { showMsg($('r-msg'), 'err', e.message); }
}

async function saveRaw() {
  // Save from the editor textarea if in edit mode; otherwise serialize the
  // in-memory config (useful after users read the Tree view and just click
  // Save to re-validate).
  const raw = __jvMode === 'edit' ? $('raw-editor').value : JSON.stringify(__jvRawConfig, null, 2);
  try {
    const r = await req('POST', '/api/admin/config/raw', { raw });
    showMsg($('r-msg'), 'ok', (r.summary || 'Saved.') + (r.backupPath ? ' (backup: ' + r.backupPath.split('/').pop() + ')' : ''));
    refresh();
    loadRaw();
  } catch (e) { showMsg($('r-msg'), 'err', e.message); }
}

function initJvControls() {
  const modeWrap = document.getElementById('jv-mode');
  if (modeWrap) {
    modeWrap.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => applyJvMode(b.dataset.jvMode));
    });
  }
  const search = document.getElementById('jv-search');
  if (search) {
    search.addEventListener('input', (e) => {
      const q = String(e.target.value || '').trim().toLowerCase();
      document.querySelectorAll('.ax-jv-line').forEach((line) => {
        const text = line.textContent.toLowerCase();
        line.classList.toggle('is-match', !!q && text.includes(q));
      });
      if (q) {
        document.querySelectorAll('.ax-jv-children.is-collapsed').forEach((c) => {
          if (c.textContent.toLowerCase().includes(q)) {
            c.classList.remove('is-collapsed');
            const sib = c.previousElementSibling;
            const tog = sib && sib.querySelector('.ax-jv-toggle:not(.empty)');
            if (tog) tog.textContent = '▾';
          }
        });
      }
    });
  }
  const expand = document.getElementById('jv-expand-all');
  if (expand) expand.addEventListener('click', () => {
    document.querySelectorAll('.ax-jv-children').forEach((c) => c.classList.remove('is-collapsed'));
    document.querySelectorAll('.ax-jv-toggle').forEach((t) => { if (!t.classList.contains('empty')) t.textContent = '▾'; });
  });
  const collapse = document.getElementById('jv-collapse-all');
  if (collapse) collapse.addEventListener('click', () => {
    document.querySelectorAll('.ax-jv-children').forEach((c) => c.classList.add('is-collapsed'));
    document.querySelectorAll('.ax-jv-toggle').forEach((t) => { if (!t.classList.contains('empty')) t.textContent = '▸'; });
  });
  const save = document.getElementById('jv-save');
  if (save) save.addEventListener('click', () => saveRaw());
}
// Wire up once on script load (doesn't depend on /api/admin/state).
initJvControls();

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tab switching
for (const btn of document.querySelectorAll('nav.tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'advanced') loadRaw();
    if (btn.dataset.tab === 'tokens') loadTokens();
  });
}

// --- Peer-proxy banner: shown when admin writes target a non-primary peer ---
(function(){
  var cur = currentPeer();
  if (cur === 'primary') return;
  // Try to resolve a friendly name from the topbar menu (server-rendered).
  var friendly = cur;
  var picked = document.querySelector('.ax-mesh-menu a[data-peer-id="' + CSS.escape(cur) + '"]');
  if (picked) {
    var span = picked.querySelector('.row > span:last-child');
    if (span) friendly = span.textContent.replace(/ · primary/,'').trim();
  }
  $('peer-banner-name').textContent = friendly;
  $('peer-banner').classList.add('is-active');
  $('peer-banner-back').addEventListener('click', function(){
    setCurrentPeer('primary');
    location.reload();
  });
})();

refresh();
`
