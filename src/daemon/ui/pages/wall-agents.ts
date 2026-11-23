// --- The Agents manager in the Hub (#2144) ---
//
// The Hub's Agents page lists every agent the machines report. For the
// owner it is also the place to set agents up, as Orca's Bots panel is:
// a status per agent (working, needs you, idle, paused, not started), one
// form to create an agent (name, role, workspace, engine and model,
// channels), and per agent Edit, Pause or Resume, Test drive and Remove
// (after a confirm).
//
// Every write goes to a route that already existed, under the Hub's
// owner-only prefix (/api/admin/wall/settings/*, wall-actions.ts), so
// board-dashboard.ts refuses it without the owner's token. This file only
// plans the calls (agmCreateSteps, agmEditSteps) and draws the markup;
// wall-agents.client.ts sends them.
//
// Shipped to the browser through injectFns, so each function is
// self-contained: the only calls between them are to other injected
// functions of this file. Every piece of fleet text goes through agmEsc.

/** The create and edit form, as the page keeps it between repaints. */
export interface AgmForm {
  name?: string; id?: string; role?: string; workspace?: string; tier?: string; model?: string
  triggers?: string; instructions?: string; publicApi?: boolean
  telegramEnv?: string; slackBotEnv?: string; slackAppEnv?: string; discordEnv?: string
}
/** One call to make, in order, with what it does in words. */
export interface AgmStep { method: "POST" | "PATCH" | "DELETE"; path: string; body: Record<string, unknown>; what: string }
export interface AgmPlan { id: string; steps: AgmStep[]; error: string }
/** What the page knows about an agent's state right now. */
export interface AgmFacts {
  /** Tasks running now, on every machine. */
  running: number
  /** Items that wait on the owner: Needs you cards and posts. */
  needs: number
  /** Its hold from the org view: "paused", "waiting" (approval), or "". */
  hold: string
  /** A machine reports it: false for an agent saved but not started yet. */
  started: boolean
}
export interface AgmStatus { key: "needs" | "paused" | "working" | "off" | "idle"; label: string; title: string }
/** An agent as GET /api/admin/state sends it (the fields used here). */
export interface AgmAgent { id: string; name?: string; tier?: string; model?: string; mentions?: string[]; workspace?: string; access?: string; systemPrompt?: string }
export interface AgmTestDrive { agent: string; msgs: Array<{ kind: string; text: string }>; busy?: boolean }

export function agmEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

/** An agent id from a name: lowercase letters, digits, - and _. */
export function agmSlug(name: unknown): string {
  return String(name == null ? "" : name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").replace(/-{2,}/g, "-").slice(0, 40)
}

/** One status per agent. Needs you comes first: it is what the owner acts on. */
export function agmStatus(f: AgmFacts): AgmStatus {
  if (f.hold === "waiting") return { key: "needs", label: "Needs you", title: "Waits for your approval in Needs you" }
  if (f.needs > 0) return { key: "needs", label: "Needs you", title: f.needs + (f.needs === 1 ? " item waits" : " items wait") + " on you" }
  if (f.hold === "paused") return { key: "paused", label: "Paused", title: "Starts no run until you resume it" }
  if (f.running > 0) return { key: "working", label: "Working", title: f.running + (f.running === 1 ? " task" : " tasks") + " running now" }
  if (!f.started) return { key: "off", label: "Not started", title: "Saved. It starts after a daemon restart." }
  return { key: "idle", label: "Idle", title: "Ready; nothing running" }
}

export function agmStatusHtml(st: AgmStatus): string {
  return '<span class="chip agm-st is-' + agmEsc(st.key) + '" title="' + agmEsc(st.title) + '">' + agmEsc(st.label) + "</span>"
}

/** The calls that create an agent from the form: the agent first (with its
 *  role and workspace), then its public API access and each channel. */
export function agmCreateSteps(f: AgmForm): AgmPlan {
  const P = "/api/admin/wall/settings"
  const t = (v: unknown) => String(v == null ? "" : v).trim()
  const name = t(f.name), id = t(f.id) || agmSlug(name)
  const fail = (error: string): AgmPlan => ({ id, steps: [], error })
  if (!name) return fail("Give the agent a name.")
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return fail("The agent id takes lowercase letters, digits, - and _.")
  const env = /^[A-Z][A-Z0-9_]*$/
  const envs: Array<[string, string]> = [["Telegram", t(f.telegramEnv)], ["Slack bot", t(f.slackBotEnv)], ["Slack app", t(f.slackAppEnv)], ["Discord", t(f.discordEnv)]]
  for (const [label, v] of envs) if (v && !env.test(v)) return fail(label + " token: write the environment variable's name in capitals, such as " + label.toUpperCase().replace(/ /g, "_") + "_TOKEN.")
  if (!!t(f.slackBotEnv) !== !!t(f.slackAppEnv)) return fail("Slack needs both token names: the bot token and the app token.")
  const body: Record<string, unknown> = { id, name, triggerWords: t(f.triggers) || "@" + id, tier: t(f.tier) || "claude-code" }
  if (t(f.model)) body.model = t(f.model)
  if (t(f.instructions)) body.personality = t(f.instructions)
  if (t(f.role)) body.role = t(f.role)
  if (t(f.workspace)) body.workspace = t(f.workspace)
  const steps: AgmStep[] = [{ method: "POST", path: P + "/agents", body, what: "the agent" }]
  if (f.publicApi) steps.push({ method: "POST", path: P + "/agents/access", body: { id, access: "public" }, what: "public API access" })
  if (t(f.telegramEnv)) steps.push({ method: "POST", path: P + "/channels/telegram", body: { id, agentBinding: id, botTokenEnv: t(f.telegramEnv) }, what: "Telegram" })
  if (t(f.slackBotEnv)) steps.push({ method: "POST", path: P + "/channels/slack", body: { botTokenEnv: t(f.slackBotEnv), appTokenEnv: t(f.slackAppEnv), agentBinding: id }, what: "Slack" })
  if (t(f.discordEnv)) steps.push({ method: "POST", path: P + "/channels/discord", body: { tokenEnv: t(f.discordEnv), agentBinding: id }, what: "Discord" })
  return { id, steps, error: "" }
}

/** The form for an agent that exists, filled from what is saved. */
export function agmFormOf(a: AgmAgent, role: string): AgmForm {
  return {
    name: a.name || a.id, id: a.id, role: role || "", workspace: a.workspace || "", tier: a.tier || "claude-code", model: a.model || "",
    triggers: (a.mentions || []).join(", "), instructions: a.systemPrompt || "", publicApi: a.access === "public",
  }
}

/** The calls that save an edit: only what changed. `inChart` says whether
 *  the agent is in the org chart already (its role is set, else added). */
export function agmEditSteps(a: AgmAgent, role: string, inChart: boolean, f: AgmForm): AgmPlan {
  const P = "/api/admin/wall/settings"
  const t = (v: unknown) => String(v == null ? "" : v).trim()
  const was = agmFormOf(a, role), id = a.id
  if (!t(f.name)) return { id, steps: [], error: "Give the agent a name." }
  if (!t(f.triggers)) return { id, steps: [], error: "Keep at least one wake word, such as @" + id + "." }
  const patch: Record<string, unknown> = {}
  if (t(f.name) !== t(was.name)) patch.name = t(f.name)
  if (t(f.tier) && t(f.tier) !== t(was.tier)) patch.tier = t(f.tier)
  if (t(f.model) !== t(was.model)) patch.model = t(f.model)
  if (t(f.triggers) !== t(was.triggers)) patch.triggerWords = t(f.triggers)
  if (t(f.instructions) !== t(was.instructions)) patch.systemPrompt = t(f.instructions)
  const steps: AgmStep[] = []
  if (Object.keys(patch).length) steps.push({ method: "PATCH", path: P + "/agents", body: { id, patch }, what: "its settings" })
  if (t(f.role) !== t(was.role)) {
    if (!t(f.role) && inChart) return { id, steps: [], error: "An agent in the org chart keeps a role. Remove it from the chart on the Org page." }
    if (t(f.role)) steps.push({ method: "POST", path: P + "/org/chart", body: inChart ? { op: "set-role", member: "agent:" + id, role: t(f.role) } : { op: "add-member", member: "agent:" + id, role: t(f.role) }, what: "its role" })
  }
  if (!!f.publicApi !== !!was.publicApi) steps.push({ method: "POST", path: P + "/agents/access", body: { id, access: f.publicApi ? "public" : "private" }, what: "public API access" })
  return { id, steps, error: steps.length ? "" : "Nothing changed." }
}

/** The one form: create (mode "new") or edit an agent. Field ids start
 *  with agm-f- and name the AgmForm key, so the page keeps what is typed. */
export function agmFormHtml(f: AgmForm, mode: string, engines: Array<[string, string]>, note: string): string {
  const v = (k: keyof AgmForm) => agmEsc(f[k] == null ? "" : f[k])
  const isNew = mode === "new"
  const input = (k: keyof AgmForm, label: string, hint: string, ph: string) =>
    '<label><span>' + label + (hint ? " <small>" + hint + "</small>" : "") + '</span><input id="agm-f-' + k + '" data-agm-f="' + k + '" value="' + v(k) + '" placeholder="' + agmEsc(ph) + '" autocomplete="off"></label>'
  const opts = engines.map((e) => '<option value="' + agmEsc(e[0]) + '"' + (e[0] === (f.tier || "claude-code") ? " selected" : "") + ">" + agmEsc(e[1]) + "</option>").join("")
  const id = isNew ? "" : agmEsc(f.id)
  const channels = isNew
    ? '<fieldset class="agm-ch"><legend>Channels <small>optional: where it answers besides the Hub</small></legend>' +
        '<p class="wsf__hint">Write the name of the environment variable that holds each token, not the token. Test drive works with none.</p>' +
        '<div class="wsf__row">' + input("telegramEnv", "Telegram bot token", "variable name", "SALES_TG_TOKEN") + input("discordEnv", "Discord bot token", "variable name", "DISCORD_BOT_TOKEN") + "</div>" +
        '<div class="wsf__row">' + input("slackBotEnv", "Slack bot token", "binds this machine's Slack bot", "SLACK_BOT_TOKEN") + input("slackAppEnv", "Slack app token", "", "SLACK_APP_TOKEN") + "</div>" +
        '<p class="wsf__hint">Email, WhatsApp and GitLab: <a href="#page=settings&amp;section=channels">Settings › Channels</a>.</p></fieldset>'
    : '<p class="wsf__hint">Workspace <code>' + v("workspace") + '</code>. Channels, skills and files: <a href="#page=settings&amp;section=agents&amp;agent=' + id + '">Settings</a>.</p>'
  return '<form class="wsf agm-form" data-agm-form="' + (isNew ? "new" : "edit") + '"' + (isNew ? "" : ' data-id="' + id + '"') + ">" +
    (isNew ? "<h3>New agent</h3>" : "<h3>Edit @" + id + "</h3>") +
    '<div class="wsf__row">' + input("name", "Name", "", "Sales Desk") + (isNew ? input("id", "Agent id", "from the name if empty", agmSlug(f.name) || "sales") : "") + "</div>" +
    '<div class="wsf__row">' + input("role", "Role", "on the org chart", "Sales lead") + (isNew ? input("workspace", "Workspace", "a folder; agents/&lt;id&gt; if empty", "~/work/sales") : "") + "</div>" +
    '<div class="wsf__row"><label>AI engine<select id="agm-f-tier" data-agm-f="tier">' + opts + "</select></label>" + input("model", "Model", "optional", "the engine's default") + "</div>" +
    input("triggers", "Wake words", isNew ? "@id if empty" : "comma separated", "@sales, sales") +
    '<label><span>Instructions <small>optional</small></span><textarea id="agm-f-instructions" data-agm-f="instructions" rows="3" placeholder="You answer pricing questions.">' + v("instructions") + "</textarea></label>" +
    '<label class="wsf__check"><input type="checkbox" id="agm-f-publicApi" data-agm-f="publicApi"' + (f.publicApi ? " checked" : "") + "> Answers on the public API</label>" +
    channels +
    '<div class="wsf__foot"><button type="submit" class="ax-btn">' + (isNew ? "Create agent" : "Save") + '</button><button type="button" class="ax-btn ax-btn--ghost" data-agm-act="close">Cancel</button>' +
    '<span class="wdo__n" id="agm-n-form" role="status">' + agmEsc(note) + "</span></div></form>"
}

/** The owner's buttons on an agent's card, and its confirm line. */
export function agmActsHtml(id: string, name: string, st: AgmStatus, hold: string, confirm: string): string {
  const e = agmEsc(id), paused = hold === "paused"
  const hold_ = hold === "waiting" ? '<a class="ax-btn ax-btn--ghost" href="#status=open&amp;view=decide">Approve in Needs you</a>'
    : '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="' + (paused ? "resume" : "pause") + '" data-id="' + e + '">' + (paused ? "Resume" : "Pause") + "</button>"
  const ask = confirm === id
    ? '<div class="wsk agm-confirm" role="alertdialog" aria-label="Confirm"><p>Remove @' + e + " (" + agmEsc(name) + ")? It leaves agentx.json and its Telegram bots are unbound. Its workspace folder stays on disk.</p>" +
      '<button type="button" class="ax-btn wsk__yes" data-agm-act="remove" data-id="' + e + '">Remove @' + e + '</button> <button type="button" class="ax-btn ax-btn--ghost" data-agm-act="cancel">Cancel</button></div>'
    : ""
  return '<div class="agm-acts" data-status="' + agmEsc(st.key) + '">' +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="edit" data-id="' + e + '">Edit</button>' + hold_ +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="test" data-id="' + e + '">Test drive</button>' +
    '<button type="button" class="ax-btn ax-btn--ghost agm-rm" data-agm-act="ask" data-id="' + e + '">Remove</button></div>' + ask
}

export function agmTestLogHtml(td: AgmTestDrive | null): string {
  return td && td.msgs.length ? td.msgs.map((m) => '<li class="wtd__m is-' + agmEsc(m.kind) + '">' + agmEsc(m.text) + "</li>").join("") : ""
}

/** Test drive: a message to the agent and its answer, before any channel. */
export function agmTestHtml(id: string, name: string, td: AgmTestDrive | null): string {
  return '<section class="wsc agm-td"><h3>Test drive @' + agmEsc(id) + '</h3><p class="wsf__hint">It runs for real and answers here. No channel needed.</p>' +
    '<ol class="wtd" id="agm-td-log" aria-live="polite">' + agmTestLogHtml(td && td.agent === id ? td : null) + "</ol>" +
    '<div class="wdo__row"><textarea id="agm-td-text" class="wdo__t" rows="2" maxlength="4000" placeholder="Message ' + agmEsc(name) + '… (Ctrl+Enter sends)" aria-label="Test drive message"></textarea>' +
    '<button type="button" class="ax-btn" data-agm-act="send" data-id="' + agmEsc(id) + '">Send</button>' +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="close">Close</button></div></section>'
}

/** The top of the page: New agent, what just happened, and the restart a
 *  new or removed agent waits for. Empty for anyone but the owner. */
export function agmHeadHtml(owner: boolean, flash: string, restart: string, error: string): string {
  if (!owner) return ""
  const rs = restart === "asked" ? '<p class="agm-restart">Restart asked: the daemon restarts once no task runs, then the agent answers.</p>'
    : restart ? '<p class="agm-restart">A new or removed agent applies after a daemon restart. <button type="button" class="ax-btn" data-agm-act="restart">Restart when idle</button></p>' : ""
  return '<div class="agm-head"><button type="button" class="ax-btn" data-agm-act="new">New agent</button>' +
    '<span class="wdo__n" id="agm-n" role="status">' + agmEsc(flash) + "</span></div>" +
    (error ? '<p class="wst__err">' + agmEsc(error) + "</p>" : "") + rs
}
