// --- Setup wizard page: install → model account → first agent → first answer (#2143) ---
//
// New-user feedback 2026-11-23: setup was not obvious, and the person used
// another coding agent to edit the config. This page is the one path to a
// first answer, with nothing to edit by hand:
//   1. connect the model account (found automatically; else the exact
//      command to run, or a key field),
//   2. create the first agent (a name and a folder; a second run finds it),
//   3. send it a first task and watch the answer arrive,
//   4. open the Hub's chat on that conversation.
// `agentx start` opens it on a first run, and "/" and the Hub send a person
// here while there is no agent. The steps' routes and their decisions live
// in ../../setup-flow-api.ts and ../../setup-flow.ts; this file is the HTML
// and the browser script.

import { renderShell, esc, stepCard, field, btn } from ".."
import type { WizardState } from "../../setup-wizard"
import { HUB_PATH } from "../hub-name"
import { injectFns } from "../inject"
import { markdownToHtml } from "@/utils/markdown-html"

export const FIRST_TASK = "Say hello, then tell me in two sentences what you can help me with."

export function renderSetupPage(state: WizardState, localToken?: string): string {
  const customHeader = `<header class="ax-topbar">
  <div class="ax-topbar__left">
    <div class="ax-brand">
      <span class="ax-brand__mark">AX</span>
      <span class="ax-brand__name">AgentX</span>
      <span class="ax-brand__subtitle">Setup</span>
    </div>
  </div>
  <div class="ax-topbar__right">
    ${state.agentCount > 0 ? `<a href="${HUB_PATH}" class="ax-skip">Skip, open the Hub</a>` : ""}
    <div class="ax-theme-switch" role="tablist" aria-label="Theme">
      <button data-theme-opt="dark">Dark</button>
      <button data-theme-opt="light">Light</button>
    </div>
  </div>
</header>`

  const step1 = stepCard(1, "Connect your AI model account", `
    <p class="sw-status" id="m-status" role="status">Checking this computer…</p>
    <div class="sw-cmd" id="m-cmd" hidden>
      <p class="sw-hint">Open the Terminal app, paste this command and press Return:</p>
      <div class="sw-cmd__row"><code id="m-cmd-text"></code>${btn("Copy", { id: "m-copy" })}</div>
    </div>
    <form id="m-key" class="sw-key" hidden autocomplete="off">
      ${field({ name: "key", label: "Or paste an Anthropic API key", hint: `(from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>; saved in .env on this computer only)`, type: "password", placeholder: "sk-ant-…", extraAttrs: `autocomplete="off"` })}
      ${btn("Save key", { type: "submit", id: "m-key-save" })}
    </form>
    <div class="sw-actions">
      <button type="button" class="ax-btn ax-btn--primary" id="m-switch" hidden>Use this account for my agent</button>
      ${btn("Check again", { id: "m-check" })}
    </div>
    <p class="sw-err" id="m-err" role="alert" hidden></p>`)

  const step2 = stepCard(2, "Create your first agent", `
    <div id="a-done" class="sw-status" hidden></div>
    <p class="sw-hint" id="a-more" hidden>More agents, Telegram and the agent's instructions are in the Hub's <a href="${HUB_PATH}#page=settings&amp;section=agents">Settings</a>.</p>
    <form id="a-form" autocomplete="off">
      ${field({ name: "agentName", label: "Agent name", value: "Assistant", placeholder: "Assistant", required: true })}
      ${field({ name: "workspace", label: "Its folder", hint: "(optional; leave empty to use the agents folder here)", placeholder: "agents/assistant" })}
      ${btn("Create agent", { type: "submit", primary: true, id: "a-create" })}
    </form>
    <p class="sw-err" id="a-err" role="alert" hidden></p>`)

  const step3 = stepCard(3, "Give it a first task", `
    <form id="t-form" autocomplete="off">
      ${field({ name: "message", label: "Task", type: "textarea", value: FIRST_TASK })}
      ${btn("Send", { type: "submit", primary: true, id: "t-send" })}
    </form>
    <div class="sw-answer" id="t-answer" aria-live="polite" hidden></div>
    <p class="sw-err" id="t-err" role="alert" hidden></p>`)

  const step4 = stepCard(4, "Done", `
    <p class="sw-status">Your agent answered. Keep talking to it in the Hub's chat; add Telegram or more agents later in the Hub's Settings.</p>
    <a class="ax-btn ax-btn--primary" id="d-open" href="${HUB_PATH}#chat=open">Open the chat in the Hub</a>`)

  const body = `<div class="ax-wizard">
  <h1 class="ax-wizard__h1">Get your first agent answering</h1>
  <p class="ax-wizard__lead">Four steps, all on this page. Nothing to edit by hand.</p>
  <div class="sw-step" id="s1">${step1}</div>
  <div class="sw-step is-locked" id="s2">${step2}</div>
  <div class="sw-step is-locked" id="s3">${step3}</div>
  <div class="sw-step is-locked" id="s4" hidden>${step4}</div>
</div>`

  return renderShell({
    title: "AgentX — Setup",
    activeTab: "custom",
    subtitle: "Setup",
    customHeader,
    noMain: true,
    // Before setup there is no agent to ask from the drawer.
    noAssistant: true,
    localToken,
    body,
    css: SETUP_PAGE_CSS,
    scripts: `<script>${injectFns({ markdownToHtml })}${SETUP_SCRIPT}</script>`,
  })
}

const SETUP_PAGE_CSS = `
.ax-topbar__right a.ax-skip {
  padding: 4px 10px; border: 1px solid var(--ax-border-2); border-radius: 4px;
  color: var(--ax-text-2); font-size: var(--ax-fs-xs); text-decoration: none;
}
.ax-topbar__right a.ax-skip:hover { color: var(--ax-accent); border-color: var(--ax-accent); }
.ax-wizard { max-width: 680px; margin: 0 auto; padding: 36px 22px 80px; }
.ax-wizard__h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.015em; }
.ax-wizard__lead { color: var(--ax-muted); margin: 0 0 24px; font-size: var(--ax-fs); line-height: 1.55; }
.ax-wizard [hidden] { display: none !important; }
.sw-step.is-locked { opacity: .45; pointer-events: none; }
.sw-step.is-locked form, .sw-step.is-locked .sw-actions { display: none; }
.sw-status { margin: 4px 0 10px; color: var(--ax-text); line-height: 1.55; }
.sw-status.is-ok::before { content: "✓ "; color: var(--ax-accent); font-weight: 600; }
.sw-hint { margin: 0 0 6px; color: var(--ax-muted); font-size: var(--ax-fs-sm); }
.sw-cmd { margin: 8px 0 12px; }
.sw-cmd__row { display: flex; gap: 8px; align-items: center; }
.sw-cmd__row code { flex: 1; background: var(--ax-surface-2); padding: 8px 10px; border-radius: 4px; font-family: var(--ax-mono); font-size: var(--ax-fs-sm); overflow-x: auto; white-space: nowrap; }
.sw-key { margin: 8px 0; }
.sw-actions { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.sw-err { margin: 10px 0 0; padding: 10px 14px; border-radius: var(--ax-radius); line-height: 1.5;
  background: color-mix(in oklch, var(--ax-err) 12%, transparent); color: var(--ax-err);
  border: 1px solid color-mix(in oklch, var(--ax-err) 40%, transparent); }
.sw-answer { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius);
  background: var(--ax-bg-elev); line-height: 1.55; min-height: 2.5em; }
.sw-answer.is-pending::after { content: "▍"; color: var(--ax-accent); animation: sw-blink 1s steps(2) infinite; }
@keyframes sw-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sw-answer.is-pending::after { animation: none; } }`

const SETUP_SCRIPT = `
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var agent = null, model = null, node = null, threadId = null, es = null, poll = null, live = '';
  function headers(h) {
    h = h || {}; h['X-Requested-With'] = 'agentx-board';
    if (window.AX_LOCAL_TOKEN) h.Authorization = 'Bearer ' + window.AX_LOCAL_TOKEN;
    return h;
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: headers(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.error) throw new Error(d.error || ('AgentX did not answer (HTTP ' + r.status + '). Run agentx start in Terminal, then reload this page.'));
        return d;
      }); }, function () { throw new Error('This page lost contact with AgentX. Run agentx start in Terminal, then reload this page.'); });
  }
  function err(id, e) { var el = $(id); el.textContent = e ? (e.message || String(e)) : ''; el.hidden = !e; }
  function busy(id, on, label) { var b = $(id); b.disabled = on; if (label) b.textContent = label; }
  function unlock(n, on) { $('s' + n).classList.toggle('is-locked', !on); }
  function status(id, text, ok) { var el = $(id); el.textContent = text; el.classList.toggle('is-ok', !!ok); }

  function paintModel(m) {
    model = m;
    status('m-status', m.message, m.ready);
    $('m-cmd').hidden = m.ready || !m.command;
    $('m-cmd-text').textContent = m.command || '';
    $('m-key').hidden = m.ready || !m.keyVar;
    $('m-switch').hidden = m.ready || !m.switchTo;
    $('m-check').hidden = m.ready;
    unlock(2, m.ready);
    unlock(3, m.ready && !!agent);
  }
  function paintAgent(a, created) {
    agent = a;
    $('a-more').hidden = !a;
    if (!a) { $('a-form').hidden = false; $('a-done').hidden = true; return; }
    $('a-form').hidden = true; $('a-done').hidden = false;
    status('a-done', (created ? 'Created ' : 'Your agent is ready: ') + a.name + (a.workspace ? ', in ' + a.workspace : '') + '.', true);
    unlock(3, !!(model && model.ready));
  }
  function load() {
    err('m-err');
    return api('GET', '/api/setup/state').then(function (d) { paintAgent(d.agent); paintModel(d.model); })
      .catch(function (e) { status('m-status', ''); err('m-err', e); });
  }
  $('m-check').addEventListener('click', function () { busy('m-check', true, 'Checking…'); load().then(function () { busy('m-check', false, 'Check again'); }); });
  $('m-copy').addEventListener('click', function () {
    try { navigator.clipboard.writeText($('m-cmd-text').textContent); $('m-copy').textContent = 'Copied'; } catch (e) { /* select it by hand */ }
  });
  $('m-key').addEventListener('submit', function (e) {
    e.preventDefault(); err('m-err'); busy('m-key-save', true, 'Saving…');
    api('POST', '/api/setup/model-key', { key: e.target.key.value }).then(function (d) { e.target.key.value = ''; paintModel(d.model); })
      .catch(function (x) { err('m-err', x); }).then(function () { busy('m-key-save', false, 'Save key'); });
  });
  $('m-switch').addEventListener('click', function () {
    err('m-err'); busy('m-switch', true);
    api('POST', '/api/setup/engine', { engine: model && model.switchTo }).then(function (d) { paintModel(d.model); })
      .catch(function (x) { err('m-err', x); }).then(function () { busy('m-switch', false); });
  });
  $('a-form').addEventListener('submit', function (e) {
    e.preventDefault(); err('a-err'); busy('a-create', true, 'Creating and starting… (up to 30 s)');
    api('POST', '/api/setup/agent', { name: e.target.agentName.value, workspace: e.target.workspace.value })
      .then(function (d) { paintAgent(d.agent, d.created); })
      .catch(function (x) { err('a-err', x); return load(); })
      .then(function () { busy('a-create', false, 'Create agent'); });
  });

  // --- Step 3: the answer, streamed while the run's id is known ---
  function paintAnswer(text, pending) {
    var box = $('t-answer'); box.hidden = false; box.classList.toggle('is-pending', !!pending);
    try { box.innerHTML = markdownToHtml(text || ''); } catch (e) { box.textContent = text || ''; }
  }
  function closeStream() { if (es) { try { es.close(); } catch (e) { /* closed */ } } es = null; }
  function stream(taskId) {
    if (es || !taskId || !window.EventSource || !node || !agent) return;
    try { es = new EventSource('/api/task/stream?node=' + encodeURIComponent(node) + '&agent=' + encodeURIComponent(agent.id) + '&task=' + encodeURIComponent(taskId)); } catch (e) { return; }
    es.addEventListener('chunk', function (ev) {
      try { var t = JSON.parse(ev.data).text || ''; if (t && t.indexOf('[task finished]') < 0) { live += t; paintAnswer(live, true); } } catch (e) { /* skip */ }
    });
    es.addEventListener('end', function () { closeStream(); check(); });
    es.addEventListener('error', closeStream);
  }
  function finish(ok) { busy('t-send', false, ok ? 'Send another' : 'Try again'); }
  function check() {
    clearTimeout(poll);
    api('GET', '/api/setup/first-task?thread=' + encodeURIComponent(threadId)).then(function (d) {
      if (d.status === 'pending') { stream(d.taskId); if (!live) paintAnswer('', true); poll = setTimeout(check, es ? 4000 : 1500); return; }
      closeStream();
      if (d.status === 'error') { $('t-answer').hidden = !live; err('t-err', new Error(d.error)); finish(false); return; }
      paintAnswer(d.answer, false); finish(true);
      $('s4').hidden = false; unlock(4, true);
      try { localStorage.setItem('ax-assistant-thread', threadId); localStorage.setItem('ax-hub-chat-node', node); } catch (e) { /* private mode */ }
    }).catch(function (x) { closeStream(); err('t-err', x); finish(false); });
  }
  $('t-form').addEventListener('submit', function (e) {
    e.preventDefault(); err('t-err'); live = ''; closeStream(); busy('t-send', true, 'Waiting for the answer…');
    $('t-answer').hidden = true;
    api('POST', '/api/setup/first-task', { message: e.target.message.value }).then(function (d) {
      threadId = d.threadId; node = d.node; check();
    }).catch(function (x) { err('t-err', x); finish(false); });
  });
  load();
})();
`
