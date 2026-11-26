// --- Hub chat: the header and the agent's questions (#2101 P5, P6) ---
//
// The header (mock V1/V2 in docs/design/2101/v3): the agent's face (a
// letter in its colour, with a state dot), its name, "computer · engine",
// a state pill (Working · Waiting on you · Done), the tabs Chat · Plan ·
// Proofs, Stop while a run is going, and ↗ Request to the request the
// agent is on (its Hub post, #post=<id>).
//
// Plan and Proofs read the owner's open requests
// (GET /api/admin/approvals/requests, requests-panel.ts): the ones the
// agent has, or has a step in. Plan lists their steps and who has each;
// Proofs lists the steps done with their proof link.
//
// The agent's questions (P6, mock V2): its open Desk cards
// (GET /api/admin/approvals, the owner's one list) show at the end of the
// thread as cards with Accept · Ask for changes · Later. The answer goes
// through the Wall's own guarded route, POST /api/admin/wall/decide, the
// same call the Desk page makes (wall-decide.client.ts), so the card is
// not copied anywhere: answered here, it is gone from the Desk too.
//   Accept          → { key, action: 'yes' } (+ choice when the card has choices)
//   Ask for changes → { key, action: 'no', note } with what to change
//   Later           → { key, action: 'later' }
//
// It talks to the chat (wall-chat.client.ts) through window.AXHubChat:
// the chat calls onPaint(view) after each repaint of the thread; this
// script draws the header and appends the cards. Stop calls stop().

import { injectFns } from "../inject"
import { engineIconKey, engineIcon } from "./engine-icons"

/** One open Desk card, as GET /api/admin/approvals lists it (InboxItem). */
export interface HeadAsk {
  key: string
  kind?: string
  title?: string
  ask?: string
  recommend?: string
  choices?: string[]
  raised_by?: string
  created_at?: string
  node?: string
}

/** One open request, as GET /api/admin/approvals/requests lists it (RequestCard). */
export interface HeadReq {
  id: string
  agentId?: string
  summary?: string
  state?: string
  plan?: { state?: string; steps?: Array<{ idx: number; name: string; agentId?: string; state?: string; evidence?: string | null; note?: string | null; updatedAt?: number | null }> } | null
  /** From the request's record (RequestCard extends RequestRecord). */
  createdAt?: number
  updatedAt?: number
  home?: { kind: string; link: string } | null
}

/** Where and when a request is, for the line under its title in the
 *  plan views (#2101): its project and its forge home come from the Hub
 *  post when the page has it (WallPost), else from the card. */
export interface ReqMeta {
  id: string
  createdAt?: number | null
  /** Its last move: the post's lastMoveAt, else updatedAt. */
  movedAt?: number | null
  /** Its project. Null: known to have none (shows its repo, else "no
   *  project"). Undefined: not known here (shows nothing). */
  project?: string | null
  /** Its home repo ("group/project"), shown when it has no project. */
  repo?: string | null
  home?: { kind: string; link: string } | null
}

/** "24 Nov, 14:02" in the viewer's time, with the full time as its title. */
export function chDate(ms: number): string {
  if (!(ms > 0)) return ""
  const d = new Date(ms)
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]
  const p2 = (n: number) => (n < 10 ? "0" : "") + n
  return `<time datetime="${d.toISOString()}" title="${d.toISOString()}">${d.getDate()} ${mon}, ${p2(d.getHours())}:${p2(d.getMinutes())}</time>`
}

/** The line under a request's title: started · moved · project · home · History.
 *  History is the request's own timeline, its Hub post (#post=<id>). */
export function chReqMetaHtml(m: ReqMeta, now: number): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  const bits: string[] = []
  if (m.createdAt && m.createdAt > 0) bits.push(`Started ${chDate(m.createdAt)}`)
  const moved = m.movedAt && m.movedAt > 0 ? chAgo(m.movedAt, now) : ""
  if (moved) bits.push(`moved ${esc(moved)}`)
  const where = m.project || m.repo || ""
  if (where) bits.push(`<b>${esc(where)}</b>`)
  else if (m.project === null) bits.push(`no project`)
  if (m.home && /^https?:\/\//.test(m.home.link)) {
    const ref = m.home.link.replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\//, "/").replace(/\/(issues|pull|merge_requests)\//, (_s, k) => (k === "merge_requests" ? "!" : "#"))
    bits.push(`<a href="${esc(m.home.link)}" target="_blank" rel="noopener" title="Its ${esc(m.home.kind)} home">${esc(ref)}</a>`)
  }
  bits.push(`<a href="#post=${encodeURIComponent(m.id)}" title="Everything that happened on this request">History</a>`)
  return `<div class="hc__planm">${bits.join(" · ")}</div>`
}

/** What the answer box under a card holds while it is being written. */
export interface AskDraft { open?: boolean; text?: string; sending?: boolean; err?: string }

/** An agent's face: its first letter, and a colour that stays the same for its id. */
export function chFace(id: string, name: string): { letter: string; colour: string } {
  // Inside the function: it is shipped to the page as its own text (inject.ts).
  const colours = ["#2979FF", "#0E9F8A", "#3949AB", "#F59E0B", "#0EA5E9", "#16A34A", "#E11D48", "#475569"]
  const src = String(name || id || "?").replace(/^[^A-Za-z0-9]+/, "")
  let h = 0
  for (const c of String(id || name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return { letter: (src.charAt(0) || "?").toUpperCase(), colour: colours[h % colours.length] }
}

/** The engine's name, from the agent's tier. */
export function chEngine(tier: string): string {
  const t = String(tier || "")
  if (t === "claude-code") return "Claude Code"
  if (t === "codex-cli" || t === "codex") return "Codex"
  if (t === "gemini-cli" || t === "gemini") return "Gemini"
  if (t === "opencode") return "OpenCode"
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ""
}

/** The state pill: a run going wins, then something waiting on the owner, then a finished answer. */
export function chState(o: { pending: boolean; asks: number; waiting: boolean; done: boolean }): { key: string; word: string } | null {
  if (o.pending) return { key: "work", word: "Working" }
  if (o.asks > 0 || o.waiting) return { key: "wait", word: "Waiting on you" }
  if (o.done) return { key: "done", word: "Done" }
  return null
}

/** "12m ago", from two times in ms. */
export function chAgo(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (!(then > 0)) return ""
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function chEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** The agent's open Desk cards: only cards (decisions), raised by this agent. */
export function chAsksFor(items: HeadAsk[], agent: string): HeadAsk[] {
  return (items || []).filter((i) => i && i.key && String(i.key).indexOf("card:") === 0 && (i.kind == null || i.kind === "card") && i.raised_by === agent)
}

/** The requests this agent has, or has a step in, newest last as listed. */
export function chReqsFor(items: HeadReq[], agent: string): HeadReq[] {
  return (items || []).filter((r) => r && (r.agentId === agent || ((r.plan && r.plan.steps) || []).some((s) => s.agentId === agent)))
}

/** One question card in the thread (mock V2). */
export function chAskHtml(a: HeadAsk, o: { name: string; now: number; draft?: AskDraft }): string {
  const d = o.draft || {}
  const key = chEsc(a.key)
  const when = chAgo(Date.parse(String(a.created_at || "")), o.now)
  const q = a.ask || a.title || ""
  const dis = d.sending ? " disabled" : ""
  const choices = (a.choices || []).filter(Boolean)
  const rec = String(a.recommend || "").toLowerCase()
  // A card with choices: one button a choice (the suggested one in blue); else Accept.
  const yes = choices.length
    ? choices.map((c, n) => `<button type="button" class="hc__ab${rec.indexOf(c.toLowerCase()) === 0 ? " hc__ab--pri" : ""}" data-hc-ask="yes" data-hc-choice="${n + 1}"${dis}>${chEsc(c)}</button>`).join("")
    : `<button type="button" class="hc__ab hc__ab--pri" data-hc-ask="yes"${dis}>Accept</button>`
  const changes = d.open
    ? `<div class="hc__askch"><textarea data-hc-ask-text rows="2" placeholder="What should ${chEsc(o.name)} change?" aria-label="What to change">${chEsc(d.text || "")}</textarea>` +
      `<div class="hc__askrow"><button type="button" class="hc__ab hc__ab--pri" data-hc-ask="no"${dis}>Send</button><button type="button" class="hc__ab hc__ab--ghost" data-hc-ask="cancel"${dis}>Cancel</button></div></div>`
    : ""
  return `<div class="hc__ask" data-hc-askkey="${key}">` +
    `<div class="hc__askhd"><span class="hc__askdot" aria-hidden="true"></span><b>${chEsc(o.name)}</b> asks you${when ? `<span class="hc__askt">${chEsc(when)}</span>` : ""}</div>` +
    `<div class="hc__askq">${chEsc(q)}</div>` +
    (a.title && a.ask && a.title !== a.ask ? `<div class="hc__askd">${chEsc(a.title)}</div>` : "") +
    (d.open ? changes : `<div class="hc__askrow">${yes}<button type="button" class="hc__ab" data-hc-ask="changes"${dis}>Ask for changes</button><button type="button" class="hc__ab hc__ab--ghost" data-hc-ask="later"${dis}>Later</button></div>`) +
    (d.err ? `<p class="hc__askerr" role="alert">${chEsc(d.err)}</p>` : d.sending ? `<p class="hc__askwait" role="status">Sending your answer…</p>` : "") +
    `</div>`
}

/** The Plan tab: each request's steps, who has each, and where it is. */
export function chPlanHtml(reqs: HeadReq[], name: string, o: { now?: number; post?: (id: string) => { project?: string | null; repo?: string | null; home?: { kind: string; link: string } | null; createdAt?: number; lastMoveAt?: number } | null } = {}): string {
  const words: Record<string, string> = { done: "done", active: "now", pending: "next", blocked: "blocked", skipped: "skipped", failed: "failed" }
  const now = o.now || Date.now()
  if (!reqs.length) return `<p class="hc__tabe">${chEsc(name)} has no open request with a plan.</p>`
  return reqs.map((r) => {
    const steps = (r.plan && r.plan.steps) || []
    const p = (o.post && o.post(r.id)) || null
    const meta = chReqMetaHtml({ id: r.id, createdAt: (p && p.createdAt) || r.createdAt, movedAt: (p && p.lastMoveAt) || r.updatedAt, project: p ? p.project || null : undefined, repo: p ? p.repo : null, home: (p && p.home) || r.home || null }, now)
    const head = `<div class="hc__planh"><a href="#post=${encodeURIComponent(r.id)}">${chEsc(r.summary || r.id)}</a><span class="hc__pill">${steps.length ? `${steps.length} steps` : "no plan"}</span></div>` + meta
    if (!steps.length) return `<section class="hc__plan">${head}</section>`
    return `<section class="hc__plan">${head}<ol>` + steps.map((s) => {
      const st = String(s.state || "pending")
      const ago = s.updatedAt && st !== "pending" ? chAgo(s.updatedAt, now) : ""
      const at = ago ? ` · ${chEsc(ago)}` : ""
      return `<li class="is-${chEsc(st)}"><span class="hc__planno" aria-hidden="true">${st === "done" ? "✓" : chEsc(s.idx)}</span><span><b>${chEsc(s.name)}</b><small>${chEsc(s.agentId || "")}${words[st] ? ` · ${words[st]}` : ""}${at}</small></span></li>`
    }).join("") + `</ol></section>`
  }).join("")
}

/** The Proofs tab: the steps done, each with its proof. */
export function chProofsHtml(reqs: HeadReq[], name: string): string {
  const rows: string[] = []
  for (const r of reqs) {
    for (const s of (r.plan && r.plan.steps) || []) {
      if (s.state !== "done" || !s.evidence) continue
      const ev = String(s.evidence)
      const link = /^https?:\/\//.test(ev) ? `<a href="${chEsc(ev)}" target="_blank" rel="noopener">${chEsc(ev)}</a>` : `<span>${chEsc(ev)}</span>`
      rows.push(`<li><b>${chEsc(s.name)}</b><small>${chEsc(r.summary || r.id)} · ${chEsc(s.agentId || "")}</small>${link}</li>`)
    }
  }
  return rows.length ? `<ul class="hc__proofs">${rows.join("")}</ul>` : `<p class="hc__tabe">No proofs yet for ${chEsc(name)}'s open requests.</p>`
}

/** The header's parts, after the ← back button (wall-chat.client.ts wallChatPanelHtml). */
export function wallChatHeadHtml(): string {
  return `<span class="hc__face" id="hc-face" aria-hidden="true" hidden></span>
      <div class="hc__title"><b id="hc-who">Chat</b><small><span id="hc-where"></span><span id="hc-sub">New conversation</span></small></div>
      <span class="hc__pill" id="hc-pill" hidden></span>
      <div class="hc__tabs" id="hc-tabs" role="tablist" aria-label="View"><button type="button" role="tab" data-hc-tab="chat" aria-selected="true">Chat</button><button type="button" role="tab" data-hc-tab="plan" aria-selected="false">Plan</button><button type="button" role="tab" data-hc-tab="proofs" aria-selected="false">Proofs</button></div>
      <span class="hc__sp"></span>
      <button type="button" class="hc__hb" id="hc-hstop" hidden><span class="hc__sq" aria-hidden="true"></span>Stop</button>
      <a class="hc__hb" id="hc-req" hidden>↗ Request</a>`
}

export const WALL_CHAT_HEAD_SCRIPT = String.raw`
// The Hub chat's header and the agent's questions (wall-chat-head.client.ts).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.AXHubChat;
  if (!api || !$('hc-form') || !$('hc-face')) return;
  ${injectFns({ engineIconKey, engineIcon })}
  ${injectFns({ chFace, chEngine, chState, chAgo, chAsksFor, chReqsFor, chAskHtml, chDate, chReqMetaHtml, chPlanHtml, chProofsHtml, chEsc })}
  var asks = [], reqs = [], drafts = {}, view = null, tab = 'chat', loadedAt = 0, timer = null;

  function load() {
    loadedAt = Date.now();
    var h = api.headers();
    var a = fetch('/api/admin/approvals', { headers: h }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) asks = (d.items || []).filter(function (i) { return !i.snoozed_until; }); }, function () { /* keep the last list */ });
    var q = fetch('/api/admin/approvals/requests', { headers: h }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) reqs = d.items || []; }, function () { /* keep the last list */ });
    return Promise.all([a, q]).then(function () { paint(); });
  }
  // Read again every 30 s while the chat is open, so a new question shows.
  function tick() {
    clearTimeout(timer);
    timer = setTimeout(function () { if (!$('hc').hidden) load(); tick(); }, 30000);
  }

  function setTab(t) {
    tab = t;
    var bs = $('hc-tabs').querySelectorAll ? $('hc-tabs').querySelectorAll('[data-hc-tab]') : [];
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-selected', String(bs[i].getAttribute('data-hc-tab') === t));
    $('hc-log').hidden = t !== 'chat';
    $('hc-tabview').hidden = t === 'chat';
    paint();
  }

  function paint() {
    if (!view) return;
    var id = view.agent, name = view.name || id;
    var mine = id ? chAsksFor(asks, id) : [], rq = id ? chReqsFor(reqs, id) : [];
    var face = $('hc-face');
    if (id) {
      var f = chFace(id, name);
      face.textContent = f.letter;
      face.setAttribute('style', 'background:' + f.colour);
      face.hidden = false;
    } else face.hidden = true;
    // The engine with its own logo (engine-icons.ts, #2272).
    var eng = chEngine(view.tier || '');
    $('hc-where').innerHTML = [view.node ? chEsc(view.node) : '', eng ? engineIcon(view.tier, 'ax-eng') + ' ' + chEsc(eng) : ''].filter(Boolean).join(' · ');
    var st = id ? chState({ pending: !!view.pending, asks: mine.length, waiting: rq.some(function (r) { return r.agentId === id && r.state === 'waiting_owner'; }), done: !!view.done }) : null;
    var pill = $('hc-pill');
    pill.hidden = !st;
    if (st) { pill.textContent = st.word; pill.setAttribute('data-state', st.key); face.setAttribute('data-state', st.key); }
    else face.setAttribute('data-state', '');
    var stop = $('hc-hstop');
    stop.hidden = !view.pending;
    stop.disabled = false;
    var req = $('hc-req'), r = rq[0];
    req.hidden = !r;
    if (r) { req.setAttribute('href', '#post=' + encodeURIComponent(r.id)); req.setAttribute('title', r.summary || r.id); }
    // The questions, at the end of the thread.
    var log = $('hc-log');
    log.querySelectorAll('.hc__asks').forEach(function (card) { card.remove(); });
    if (tab === 'chat' && mine.length) {
      var now = Date.now();
      var html = '<div class="hc__asks">' + mine.map(function (a) { return chAskHtml(a, { name: name, now: now, draft: drafts[a.key] }); }).join('') + '</div>';
      // Appended, not re-parsed: the live answer and its open folds stay as they are.
      if (log.insertAdjacentHTML) log.insertAdjacentHTML('beforeend', html); else log.innerHTML += html;
      var hcApi = window.AXHubChat;
      if (hcApi && hcApi.follow) hcApi.follow.stick(); else log.scrollTop = log.scrollHeight;
    }
    if (tab === 'plan') $('hc-tabview').innerHTML = chPlanHtml(rq, name, { now: Date.now(), post: window.AXCtx && window.AXCtx.post });
    if (tab === 'proofs') $('hc-tabview').innerHTML = chProofsHtml(rq, name);
  }

  api.onPaint = function (v) {
    var was = view && view.agent;
    view = v;
    if (v.agent !== was && Date.now() - loadedAt > 5000) { load(); return; }
    paint();
  };

  $('hc-tabs').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-hc-tab]') : null;
    if (b) setTab(b.getAttribute('data-hc-tab'));
  });
  $('hc-hstop').addEventListener('click', function () {
    $('hc-hstop').disabled = true;
    if (typeof api.stop === 'function') api.stop();
  });

  function repaintLog() { if (typeof api.repaint === 'function') api.repaint(); else paint(); }
  function answer(key, action, extra) {
    var d = drafts[key] = drafts[key] || {};
    d.sending = true; d.err = '';
    repaintLog();
    var body = Object.assign({ key: key, action: action }, extra || {});
    return fetch('/api/admin/wall/decide', { method: 'POST', headers: api.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Only the owner can answer this. Sign in, then try again.' : (b.error || 'HTTP ' + r.status));
          // Answered: it leaves the thread here and the Desk everywhere.
          delete drafts[key];
          asks = asks.filter(function (a) { return a.key !== key; });
          repaintLog();
        });
      })
      .catch(function (e) { d.sending = false; d.err = 'Not answered: ' + String(e && e.message || e); repaintLog(); });
  }
  $('hc-log').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-hc-ask]') : null;
    if (!b) return;
    var card = b.closest('[data-hc-askkey]'), key = card && card.getAttribute('data-hc-askkey');
    if (!key) return;
    var act = b.getAttribute('data-hc-ask'), d = drafts[key] = drafts[key] || {};
    if (act === 'changes') { d.open = true; d.err = ''; repaintLog(); var ta = $('hc-log').querySelector && $('hc-log').querySelector('[data-hc-askkey="' + key + '"] textarea'); if (ta) ta.focus(); return; }
    if (act === 'cancel') { d.open = false; d.err = ''; repaintLog(); return; }
    if (act === 'no') {
      if (!String(d.text || '').trim()) { d.err = 'Write what to change first.'; repaintLog(); return; }
      answer(key, 'no', { note: d.text });
      return;
    }
    if (act === 'later') { answer(key, 'later'); return; }
    if (act === 'yes') { var c = Number(b.getAttribute('data-hc-choice')); answer(key, 'yes', c > 0 ? { choice: c } : null); }
  });
  $('hc-log').addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-hc-ask-text')) return;
    var card = t.closest('[data-hc-askkey]'), key = card && card.getAttribute('data-hc-askkey');
    if (key) (drafts[key] = drafts[key] || {}).text = t.value;
  });

  load();
  tick();
})();
`
