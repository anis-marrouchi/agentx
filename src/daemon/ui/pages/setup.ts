// --- Setup wizard page ---
//
// First-run flow for non-technical operators: team name, first agent,
// optional Telegram, optional Anthropic key. Writes agentx.json, scaffolds
// the agent's workspace, writes .env, and points the operator at the next
// step.
//
// The server-side state machine + form handler live in ../../setup-wizard.ts
// — this file owns ONLY the HTML. That keeps the data flow inspectable
// (one place) and the visual surface hot-reloadable (edit → rebuild → view).

import { renderShell, esc, stepCard, field, row, btn } from ".."
import type { WizardState } from "../../setup-wizard"

export function renderSetupPage(state: WizardState, defaultNode: string): string {
  const heading = state.configExists
    ? (state.agentCount === 0 ? "Add your first agent" : "Add another agent")
    : "Set up your team"

  // Custom topbar: /setup is pre-dashboard, we skip the tab nav and show
  // just brand + subtitle + theme switcher + "Skip to dashboard" pill.
  const customHeader = `<header class="ax-topbar">
  <div class="ax-topbar__left">
    <div class="ax-brand">
      <span class="ax-brand__mark">AX</span>
      <span class="ax-brand__name">AgentX</span>
      <span class="ax-brand__subtitle">Setup</span>
    </div>
  </div>
  <div class="ax-topbar__right">
    <a href="/glossary" class="ax-skip">? Glossary</a>
    <a href="/live" class="ax-skip">Skip — open dashboard</a>
    <div class="ax-theme-switch" role="tablist" aria-label="Theme">
      <button data-theme-opt="dark">Dark</button>
      <button data-theme-opt="light">Light</button>
      <button data-theme-opt="crt">CRT</button>
    </div>
  </div>
</header>`

  const step1 = stepCard(1, "Team basics",
    field({
      name: "nodeName",
      label: "Team name",
      hint: "(what you'd call this AgentX install)",
      value: defaultNode,
      placeholder: "My Team",
      required: true,
    })
  )

  const step2 = stepCard(2, "First agent",
    row([
      field({ name: "agentName", label: "Agent name", value: "Assistant", placeholder: "Support Bot", required: true }),
      field({ name: "agentId", label: "Agent id", hint: "(lowercase, no spaces)", value: "assistant", pattern: "[a-z0-9][a-z0-9_-]*", required: true }),
    ]) +
    field({
      name: "triggerWords",
      label: "Trigger words",
      hint: `(comma or space separated — e.g. <code>@support, support</code>)`,
      value: "@assistant, assistant",
      required: true,
    }) +
    row([
      field({
        name: "tier",
        label: "AI engine",
        type: "select",
        options: [
          { value: "claude-code", label: "Claude Code (recommended)", selected: true },
          { value: "sdk", label: "Anthropic API (BYO key)" },
        ],
      }),
      field({
        name: "model",
        label: "Model",
        hint: "(optional)",
        value: "claude-sonnet-4-6",
        placeholder: "claude-sonnet-4-6",
      }),
    ]) +
    field({
      name: "personality",
      label: "Personality / instructions",
      hint: "(optional — what this agent does, in plain English)",
      type: "textarea",
      placeholder: "You are a support agent for Acme Co. Answer customer questions about our product, be friendly, keep replies short.",
    })
  )

  const step3 = stepCard(3, "First channel", `
    <label class="ax-toggle"><input type="checkbox" id="enableTelegram" /> Connect Telegram now</label>
    <div class="ax-optional" id="telegramFields">
      ${field({ name: "telegramAccountId", label: "Account id", hint: `(a label you choose — e.g. <code>support</code>)`, value: "default" })}
      ${field({ name: "telegramBotToken", label: "Bot token", hint: `(from <a href="https://t.me/BotFather" target="_blank">@BotFather</a>)`, placeholder: "123456:ABCdef..." })}
      ${field({ name: "telegramBotUsername", label: "Bot username", hint: `(optional — e.g. <code>my_support_bot</code>)`, placeholder: "my_support_bot" })}
    </div>
  `)

  const step4 = stepCard(4, "Anthropic API key",
    field({
      name: "anthropicApiKey",
      label: "API key",
      hint: "(optional — skip if you're using Claude Code)",
      type: "password",
      placeholder: "sk-ant-…",
      extraAttrs: `autocomplete="off"`,
    }) +
    `<div class="ax-hint-block">
      The key is written to <code>.env</code> as <code>ANTHROPIC_API_KEY</code>. AgentX never transmits it — everything stays on this machine.
    </div>`
  )

  const banner = state.configExists
    ? `<div class="ax-banner">Existing install: <b>${state.agentCount}</b> agent(s), <b>${state.channelCount}</b> channel(s) already configured. This wizard will add to it.</div>`
    : ""

  const body = `<div class="ax-wizard">
  <h1 class="ax-wizard__h1">${esc(heading)}</h1>
  <p class="ax-wizard__lead">Fill in the basics below. We'll write <code>agentx.json</code>, set up a folder for your first agent, and point you at the next step.</p>

  ${banner}

  <div id="msg" class="ax-msg"></div>

  <form id="wizard" autocomplete="off">
    ${step1}
    ${step2}
    ${step3}
    ${step4}
    <footer class="ax-actions">
      ${btn("Save and continue", { type: "submit", primary: true, id: "submitBtn" })}
      ${btn("Skip, I'll do it later", { onclick: "window.location.href='/live'" })}
    </footer>
  </form>
</div>`

  return renderShell({
    title: "AgentX — Setup",
    activeTab: "custom",
    subtitle: "Setup",
    customHeader,
    noMain: true,
    body,
    css: SETUP_PAGE_CSS,
    scripts: SETUP_SCRIPT,
  })
}

/** CSS that's specific to the setup page — wizard layout + optional-fields
 *  toggle + result messaging. Everything reusable (form fields, step cards,
 *  buttons) comes from AX_COMPONENTS_CSS. */
const SETUP_PAGE_CSS = `
/* Pre-dashboard topbar variant — no tab nav, the pills are the only chrome. */
.ax-topbar__right a.ax-skip {
  padding: 4px 10px; border: 1px solid var(--ax-border-2); border-radius: 4px;
  color: var(--ax-text-2); font-size: var(--ax-fs-xs); text-decoration: none;
}
.ax-topbar__right a.ax-skip:hover { color: var(--ax-accent); border-color: var(--ax-accent); }

/* Wizard frame */
.ax-wizard { max-width: 680px; margin: 0 auto; padding: 36px 22px 80px; }
.ax-wizard__h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.015em; }
.ax-wizard__lead { color: var(--ax-muted); margin: 0 0 24px; font-size: var(--ax-fs); line-height: 1.55; }
.ax-wizard__lead code { background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px; color: var(--ax-text); font-size: var(--ax-fs-sm); }

/* Info banner ("You already have N agents…") */
.ax-banner {
  background: color-mix(in oklch, var(--ax-accent) 10%, var(--ax-bg-elev));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 30%, var(--ax-border-2));
  border-radius: var(--ax-radius);
  padding: 10px 14px; margin-bottom: 18px;
  color: var(--ax-text-2); font-size: var(--ax-fs-sm);
}
.ax-banner b { color: var(--ax-text); font-weight: 600; }

/* "Connect Telegram now" toggle + collapsible fields */
.ax-toggle { display: flex; align-items: center; gap: 8px; margin: 4px 0 6px; font-size: var(--ax-fs); color: var(--ax-text); cursor: pointer; user-select: none; }
.ax-toggle input { width: auto; accent-color: var(--ax-accent); }
.ax-optional { border-left: 2px solid var(--ax-border-2); padding-left: 14px; margin-top: 10px; display: none; }
.ax-optional.is-show { display: block; }
.ax-hint-block { font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-top: 8px; line-height: 1.55; }
.ax-hint-block code { background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px; color: var(--ax-text); font-family: var(--ax-mono); font-size: var(--ax-fs-xs); }

/* Form footer */
.ax-actions {
  display: flex; gap: 10px; padding: 20px 0 0; align-items: center;
  border-top: 1px solid var(--ax-border); margin-top: 20px;
}

/* Server-response messaging (success / error blocks) */
.ax-msg { margin: 14px 0; padding: 12px 16px; border-radius: var(--ax-radius); font-size: var(--ax-fs); display: none; }
.ax-msg.is-ok {
  display: block;
  background: color-mix(in oklch, var(--ax-accent) 12%, transparent);
  color: var(--ax-accent);
  border: 1px solid color-mix(in oklch, var(--ax-accent) 40%, transparent);
}
.ax-msg.is-err {
  display: block;
  background: color-mix(in oklch, var(--ax-err) 12%, transparent);
  color: var(--ax-err);
  border: 1px solid color-mix(in oklch, var(--ax-err) 40%, transparent);
}
.ax-next-steps { margin-top: 12px; padding-left: 20px; color: var(--ax-text-2); }
.ax-next-steps li { margin: 4px 0; }
.ax-next-steps code { background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px; color: var(--ax-text); font-family: var(--ax-mono); font-size: var(--ax-fs-sm); }
.ax-startd { margin-top: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ax-startd__status { color: var(--ax-text-2); font-size: var(--ax-fs-sm); }
.ax-startd__status a { color: var(--ax-accent); }`

const SETUP_SCRIPT = `<script>
document.getElementById('enableTelegram').addEventListener('change', (e) => {
  document.getElementById('telegramFields').classList.toggle('is-show', e.target.checked);
});
document.getElementById('wizard').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');
  msg.className = 'ax-msg'; msg.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Saving…';
  const telegramEnabled = document.getElementById('enableTelegram').checked;
  const payload = {
    nodeName: f.nodeName.value.trim(),
    agent: {
      id: f.agentId.value.trim(),
      name: f.agentName.value.trim(),
      triggerWords: f.triggerWords.value.trim(),
      tier: f.tier.value,
      model: f.model.value.trim() || undefined,
      personality: f.personality.value.trim() || undefined,
    },
    anthropicApiKey: f.anthropicApiKey.value.trim() || undefined,
  };
  if (telegramEnabled) {
    payload.telegram = {
      accountId: f.telegramAccountId.value.trim() || 'default',
      botToken: f.telegramBotToken.value.trim(),
      botUsername: f.telegramBotUsername.value.trim() || undefined,
    };
    if (!payload.telegram.botToken) {
      msg.className = 'ax-msg is-err'; msg.textContent = 'Bot token is required when Telegram is enabled.';
      btn.disabled = false; btn.textContent = 'Save and continue'; return;
    }
  }
  try {
    const r = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-wizard' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    const steps = data.nextSteps.map((s) => '<li>' + s.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>') + '</li>').join('');
    msg.className = 'ax-msg is-ok';
    msg.innerHTML = '<b>' + data.summary + '</b><ol class="ax-next-steps">' + steps + '</ol>'
      + '<div class="ax-startd"><button type="button" id="startDaemonBtn" class="ax-btn ax-btn--primary">Start daemon now</button>'
      + ' <span id="startDaemonStatus" class="ax-startd__status"></span></div>';
    btn.textContent = 'Done';
    btn.disabled = true;
    document.getElementById('startDaemonBtn').addEventListener('click', async () => {
      const sb = document.getElementById('startDaemonBtn');
      const ss = document.getElementById('startDaemonStatus');
      sb.disabled = true; sb.textContent = 'Starting…'; ss.textContent = '';
      try {
        const r = await fetch('/api/setup/start-daemon', { method: 'POST' });
        const d = await r.json();
        if (d.ok) {
          sb.textContent = d.alreadyRunning ? 'Already running' : 'Daemon up';
          ss.innerHTML = 'Open <a href="' + d.url + '" target="_blank" rel="noopener">' + d.url + '</a>';
        } else {
          sb.disabled = false; sb.textContent = 'Try again';
          ss.textContent = d.error + (d.manualUrl ? '  Manual: ' + d.manualUrl : '');
        }
      } catch (e) {
        sb.disabled = false; sb.textContent = 'Try again';
        ss.textContent = e.message;
      }
    });
  } catch (err) {
    msg.className = 'ax-msg is-err'; msg.textContent = err.message;
    btn.disabled = false; btn.textContent = 'Save and continue';
  }
});
</script>`
