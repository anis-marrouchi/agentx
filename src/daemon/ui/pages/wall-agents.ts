// --- The Agents manager in the Hub (#2144) ---
//
// The Hub's Agents page lists every agent the machines report. For the
// owner it is also the place to set agents up, as Orca's Bots panel is:
// a status per agent (working, needs you, idle, paused, not started), one
// form in a right Sheet to create or edit an agent, and per agent Edit and
// Pause or Resume, with Test drive and Remove in its "…" menu. Remove asks
// in an alert dialog that says what goes and what stays.
//
// Every write goes to a route that already existed, under the Hub's
// owner-only prefix (/api/admin/wall/settings/*, wall-actions.ts), so
// board-dashboard.ts refuses it without the owner's token. The fields,
// checks and call plans are the one agent form (src/agents/agent-form.ts);
// this file draws the markup and wall-agents.client.ts sends the calls.
//
// Shipped to the browser through injectFns, so each function is
// self-contained: the only calls between them are to other injected
// functions (these and agent-form.ts's agm*). Every piece of fleet text
// goes through agmEsc.

import type { AgmBound, AgmErrors, AgmForm, AgmKey } from "@/agents/agent-form"
import * as agentForm from "@/agents/agent-form"
import { hubIconMap } from "./hub-lucide"

// The bodies below call the form spec's agm* functions by their bare names.
// In the page they are globals (wall.client.ts injects them with these).
// A module import would compile, under vitest and tsx, to a namespace
// reference (__vite_ssr_import_0__.agmField) the page does not have, so on
// the server the same functions are set on globalThis instead.
declare global {
  var agmField: typeof agentForm.agmField
  var agmModelGroups: typeof agentForm.agmModelGroups
  var agmModelHelp: typeof agentForm.agmModelHelp
  var agmSlug: typeof agentForm.agmSlug
  var agmWorkspacePath: typeof agentForm.agmWorkspacePath
}
globalThis.agmField = agentForm.agmField
globalThis.agmModelGroups = agentForm.agmModelGroups
globalThis.agmModelHelp = agentForm.agmModelHelp
globalThis.agmSlug = agentForm.agmSlug
globalThis.agmWorkspacePath = agentForm.agmWorkspacePath

export type { AgmAgent, AgmBound, AgmErrors, AgmForm, AgmPlan, AgmStep } from "@/agents/agent-form"
// Re-exports only (no local binding): a local agmSlug would be what the
// bundler points the bodies' bare agmSlug at, and the page has no such name.
export { agmCreateSteps, agmEditSteps, agmFormOf, agmSlug } from "@/agents/agent-form"

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
export interface AgmTestDrive { agent: string; msgs: Array<{ kind: string; text: string }>; busy?: boolean }
/** The Sheet's state beyond the values: the note under the buttons, the
 *  fields' errors, which folds are open, the daemon's folder and the home
 *  folder (to show where the workspace resolves), and `enter` on the first
 *  paint only, so a repaint does not slide it in again. */
export interface AgmSheetOpts {
  note?: string; bound?: AgmBound; errors?: AgmErrors; open?: { channels?: boolean; advanced?: boolean }
  base?: string; home?: string; enter?: boolean
}
/** The Remove confirm: which agent, its workspace folder, and the tasks it
 *  runs now (from the server's 409; 0 until then). */
export interface AgmRemoveAsk { id: string; name: string; workspace: string; running: number }

export function agmEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

/** A lucide icon (hub-lucide.ts) by name; the SVG strings ride on the
 *  function as `svg`, written into the page by injectFns. */
export function agmIcon(name: string): string {
  return agmIcon.svg[name] || ""
}
agmIcon.svg = hubIconMap(["ellipsis", "play", "trash-2", "x"])

/** One status per agent. Needs you comes first: it is what the owner acts on. */
export function agmStatus(f: AgmFacts): AgmStatus {
  if (f.hold === "waiting") return { key: "needs", label: "Needs you", title: "Waits for your approval in Waiting on you" }
  if (f.needs > 0) return { key: "needs", label: "Needs you", title: f.needs + (f.needs === 1 ? " item waits" : " items wait") + " on you" }
  if (f.hold === "paused") return { key: "paused", label: "Paused", title: "Starts no run until you resume it" }
  if (f.running > 0) return { key: "working", label: "Working", title: f.running + (f.running === 1 ? " task" : " tasks") + " running now" }
  if (!f.started) return { key: "off", label: "Not started", title: "Saved. It starts after a daemon restart." }
  return { key: "idle", label: "Idle", title: "Ready; nothing running" }
}

/** The shared state (dot and word, #2152): working runs, needs you waits;
 *  paused, not started and idle stay grey. agm-st is-<key> is the hook. */
export function agmStatusHtml(st: AgmStatus): string {
  const state = st.key === "working" ? "running" : st.key === "needs" ? "waiting" : ""
  return '<span class="ax-af-state agm-st is-' + agmEsc(st.key) + '"' + (state ? ' data-state="' + state + '"' : "") + ' title="' + agmEsc(st.title) + '">' + agmEsc(st.label) + "</span>"
}

/** Under the workspace field: where the folder resolves, in mono, or the
 *  field's help when the page does not know the daemon's folder. */
export function agmWorkspaceLine(f: AgmForm, base: string, home: string): string {
  const id = String(f.id == null ? "" : f.id).trim() || agmSlug(f.name) || "<id>"
  if (!base) return agmEsc(agmField("workspace").help)
  const w = agmWorkspacePath(f.workspace, id, base, home)
  return w.error ? agmEsc(w.error) : "Resolves to <code>" + agmEsc(w.path) + "</code>"
}

/** The one form, in a right Sheet: create (mode "new") or edit an agent.
 *  Basic fields first; Channels (new only) and Advanced fold. Field ids
 *  start with agm-f- and name the AgmForm key, so the page keeps what is
 *  typed; a field's error shows under it (agm-e-<key>, aria-invalid). */
export function agmFormHtml(f: AgmForm, mode: string, engines: Array<[string, string]>, o: AgmSheetOpts): string {
  const isNew = mode === "new"
  const errors = o.errors || {}
  const open = o.open || {}
  const v = (k: AgmKey) => agmEsc(f[k] == null ? "" : f[k])
  const newId = String(f.id == null ? "" : f.id).trim() || agmSlug(f.name)
  // A field: label, control, then its error or its one line of help.
  const below = (k: AgmKey, help: string) => errors[k]
    ? '<p class="agm-err" id="agm-e-' + k + '">' + agmEsc(errors[k]) + "</p>"
    : help ? '<p class="agm-help" id="agm-h-' + k + '">' + help + "</p>" : ""
  const aria = (k: AgmKey, help: string) => errors[k] ? ' aria-invalid="true" aria-describedby="agm-e-' + k + '"' : help ? ' aria-describedby="agm-h-' + k + '"' : ""
  const field = (k: AgmKey, control: (a: string) => string, help?: string) => {
    const h = help == null ? agmEsc(agmField(k).help) : help
    return '<div class="agm-fld"><label for="agm-f-' + k + '">' + agmEsc(agmField(k).label) + "</label>" + control(aria(k, h)) + below(k, h) + "</div>"
  }
  const input = (k: AgmKey, help?: string, cls?: string, ph?: string, extra?: string) => field(k, (a) =>
    '<input id="agm-f-' + k + '" data-agm-f="' + k + '"' + (cls ? ' class="' + cls + '"' : "") + (extra || "") + ' value="' + v(k) + '" placeholder="' + agmEsc(ph == null ? agmField(k).ph : ph) + '" autocomplete="off" spellcheck="false"' + a + ">", help)
  const check = (k: AgmKey, label: string, help: string) =>
    '<div class="agm-fld"><label class="wsf__check"><input type="checkbox" id="agm-f-' + k + '" data-agm-f="' + k + '"' + (f[k] ? " checked" : "") + aria(k, help) + "> " + label + "</label>" + below(k, help) + "</div>"
  const tier = f.tier || "claude-code"
  const opts = engines.map((e) => '<option value="' + agmEsc(e[0]) + '"' + (e[0] === tier ? " selected" : "") + ">" + agmEsc(e[1]) + "</option>").join("")
  const models = agmModelGroups().filter((g) => g.tier === tier).flatMap((g) => g.models).map((m) => '<option value="' + agmEsc(m) + '"></option>').join("")
  const fold = (key: "channels" | "advanced", title: string, body: string, bad: boolean) =>
    '<details class="axp-fold agm-fold" data-agm-fold="' + key + '" data-keep-own' + (open[key] || bad ? " open" : "") + '><summary class="axp-fold__h"><span class="axp-fold__t">' + title + "</span></summary>" + body + "</details>"
  // This machine has one Slack bot and one Discord bot: say whom it answers
  // as now, and ask before taking it from another agent.
  const botLine = (ch: "slack" | "discord", label: string, k: "moveSlack" | "moveDiscord") => {
    const now = String((o.bound && o.bound[ch]) || "").trim()
    if (!now) return '<p class="agm-help">This machine has one ' + label + " bot. It answers as no agent now.</p>"
    if (now === newId) return '<p class="agm-help">' + label + "'s bot answers as @" + agmEsc(now) + " already.</p>"
    return '<p class="agm-help agm-bot">This machine has one ' + label + " bot. It answers as <b>@" + agmEsc(now) + "</b> now.</p>" +
      check(k, "Move the " + label + " bot to this agent: @" + agmEsc(now) + " stops answering on " + label, "")
  }
  const chKeys: AgmKey[] = ["telegramEnv", "discordEnv", "moveDiscord", "slackBotEnv", "slackAppEnv", "moveSlack"]
  const channels = !isNew ? "" : fold("channels", "Channels",
    '<p class="agm-help">Where it answers besides the Hub. Test drive works with none.</p>' +
    input("telegramEnv") + input("discordEnv") + botLine("discord", "Discord", "moveDiscord") +
    input("slackBotEnv") + input("slackAppEnv") + botLine("slack", "Slack", "moveSlack") +
    '<p class="agm-help">Email, WhatsApp and GitLab: <a href="#page=settings&amp;section=channels">Settings › Channels</a>.</p>',
    chKeys.some((k) => !!errors[k]))
  const advanced = fold("advanced", "Advanced",
    input("triggers", isNew ? undefined : "The words that call it in a shared chat") +
    check("publicApi", agmEsc(agmField("publicApi").label), agmEsc(agmField("publicApi").help)),
    !!(errors.triggers || errors.publicApi))
  const settings = "#page=settings&amp;section=agents&amp;agent=" + agmEsc(encodeURIComponent(String(f.id == null ? "" : f.id)))
  const workspace = isNew
    ? input("workspace", '<span id="agm-ws">' + agmWorkspaceLine(f, o.base || "", o.home || "") + "</span>")
    : '<div class="agm-fld"><span class="agm-lbl">Workspace</span><code class="agm-path">' + v("workspace") + "</code>" +
      '<p class="agm-help">Channels, skills and files: <a href="' + settings + '">Settings</a>.</p></div>'
  const title = isNew ? "New agent" : "Edit @" + agmEsc(f.id)
  return '<div class="agm-sheet' + (o.enter ? " is-enter" : "") + '" role="dialog" aria-modal="true" aria-labelledby="agm-sheet-h">' +
    '<button type="button" class="agm-sheet__scrim" data-agm-act="close" aria-label="Close" tabindex="-1"></button>' +
    '<form class="agm-sheet__panel wsf agm-form" data-agm-form="' + (isNew ? "new" : "edit") + '"' + (isNew ? "" : ' data-id="' + agmEsc(f.id) + '"') + " novalidate>" +
    '<div class="agm-sheet__head"><h2 id="agm-sheet-h">' + title + "</h2>" +
    '<button type="button" class="ha__act" data-agm-act="close" aria-label="Close" data-tip="Close" data-tip-key="Esc">' + agmIcon("x") + "</button></div>" +
    '<div class="agm-sheet__body">' +
    input("name") + (isNew ? input("id", undefined, "agm-mono", agmSlug(f.name) || agmField("id").ph) : "") + input("role") + workspace +
    field("tier", (a) => '<select id="agm-f-tier" data-agm-f="tier"' + a + ">" + opts + "</select>") +
    input("model", '<span id="agm-model-help">' + agmEsc(agmModelHelp(f.model)) + "</span>", "agm-mono", undefined, ' list="agm-models"') +
    '<datalist id="agm-models">' + models + "</datalist>" +
    field("instructions", (a) => '<textarea id="agm-f-instructions" data-agm-f="instructions" rows="4" maxlength="4000" placeholder="' + agmEsc(agmField("instructions").ph) + '"' + a + ">" + v("instructions") + "</textarea>") +
    channels + advanced + "</div>" +
    '<div class="agm-sheet__foot"><span class="wdo__n" id="agm-n-form" role="status">' + agmEsc(o.note || "") + "</span>" +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="close">Cancel</button>' +
    '<button type="submit" class="ax-btn ax-btn--primary">' + (isNew ? "Create agent" : "Save") + "</button></div></form></div>"
}

/** The owner's buttons on an agent's card: Edit and Pause or Resume, then
 *  the "…" menu with Test drive and, last after a line, Remove in red. */
export function agmActsHtml(id: string, name: string, st: AgmStatus, hold: string, menu: string): string {
  const e = agmEsc(id), paused = hold === "paused", open = menu === id
  const hold_ = hold === "waiting" ? '<a class="ax-btn ax-btn--ghost" href="#status=open&amp;view=decide">Approve in Waiting on you</a>'
    : '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="' + (paused ? "resume" : "pause") + '" data-id="' + e + '">' + (paused ? "Resume" : "Pause") + "</button>"
  const items = open
    ? '<div class="ha-menu agm-menu" id="agm-menu" role="menu" aria-label="' + agmEsc("More for " + name) + '">' +
      '<button type="button" role="menuitem" data-agm-act="test" data-id="' + e + '">' + agmIcon("play") + "Test drive</button><hr>" +
      '<button type="button" role="menuitem" class="is-danger" data-agm-act="ask" data-id="' + e + '">' + agmIcon("trash-2") + "Remove…</button></div>"
    : ""
  return '<div class="agm-acts" data-status="' + agmEsc(st.key) + '">' +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="edit" data-id="' + e + '">Edit</button>' + hold_ +
    '<span class="agm-more"><button type="button" class="ha__act" data-agm-act="menu" data-id="' + e + '" aria-haspopup="menu" aria-expanded="' + open + '" aria-label="' + agmEsc("More for " + name) + '" data-tip="More">' +
    agmIcon("ellipsis") + "</button>" + items + "</span></div>"
}

/** Remove, as an alert dialog that names what goes and what stays. With
 *  tasks running (the server's 409), the default is to pause it and remove
 *  it once idle; Remove now sends `force`. */
export function agmRemoveHtml(r: AgmRemoveAsk): string {
  const e = agmEsc(r.id)
  const busy = r.running > 0
  const lead = busy ? "@" + e + " has " + r.running + (r.running === 1 ? " task" : " tasks") + " running." : "Remove @" + e + " (" + agmEsc(r.name) + ")?"
  const acts = busy
    ? '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="cancel">Cancel</button>' +
      '<button type="button" class="ax-btn ax-btn--danger" data-agm-act="remove-now" data-id="' + e + '">Remove now</button>' +
      '<button type="button" class="ax-btn ax-btn--primary" id="agm-rm-go" data-agm-act="remove-idle" data-id="' + e + '">Pause and remove when idle</button>'
    : '<button type="button" class="ax-btn ax-btn--ghost" id="agm-rm-go" data-agm-act="cancel">Cancel</button>' +
      '<button type="button" class="ax-btn ax-btn--danger" data-agm-act="remove" data-id="' + e + '">Remove @' + e + "</button>"
  return '<div class="wsd agm-rm" role="alertdialog" aria-modal="true" aria-labelledby="agm-rm-h" aria-describedby="agm-rm-d">' +
    '<button type="button" class="wsd__scrim" data-agm-act="cancel" aria-label="Cancel" tabindex="-1"></button>' +
    '<div class="wsd__box"><h3 id="agm-rm-h">' + lead + "</h3>" +
    '<div id="agm-rm-d">' +
    (busy ? "<p>Remove now ends them at the next daemon restart. Pause and remove when idle starts no new run and removes it once they end, while this page stays open.</p>" : "") +
    "<p><b>Goes:</b> its entry in agentx.json, its place and lines on the org chart, and the Telegram, Slack and Discord bots that answer as it.</p>" +
    "<p><b>Stays:</b> its workspace folder" + (r.workspace ? " <code>" + agmEsc(r.workspace) + "</code>" : "") + " with its files, and its past tasks. Create @" + e + " again with the same folder to bring it back.</p></div>" +
    '<div class="wsd__acts">' + acts + "</div></div></div>"
}

/** The log; the answer waited for shows the shared loader (#2152, the markup of afLoaderHtml). */
export function agmTestLogHtml(td: AgmTestDrive | null): string {
  let rays = ""
  for (let i = 0; i < 8; i++) rays += '<span style="rotate:' + i * 45 + "deg;animation-delay:" + ((i - 8) * 0.1).toFixed(1) + 's"></span>'
  const text = (m: { kind: string; text: string }) => m.kind === "wait"
    ? '<span class="ax-af-loader" role="status"><span class="ax-af-loader__rays" aria-hidden="true">' + rays + "</span>" + agmEsc(m.text) + "</span>" : agmEsc(m.text)
  return td && td.msgs.length ? td.msgs.map((m) => '<li class="wtd__m is-' + agmEsc(m.kind) + '">' + text(m) + "</li>").join("") : ""
}

/** Test drive: a message to the agent and its answer, before any channel.
 *  `draft` fills the message box (the first test after a create). */
export function agmTestHtml(id: string, name: string, td: AgmTestDrive | null, draft?: string): string {
  return '<section class="wsc agm-td"><h3>Test drive @' + agmEsc(id) + '</h3><p class="wsf__hint">It runs for real and answers here. No channel needed.</p>' +
    '<ol class="wtd" id="agm-td-log" aria-live="polite">' + agmTestLogHtml(td && td.agent === id ? td : null) + "</ol>" +
    '<div class="wdo__row"><textarea id="agm-td-text" class="wdo__t" rows="2" maxlength="4000" placeholder="Message ' + agmEsc(name) + '… (Ctrl+Enter sends)" aria-label="Test drive message">' + agmEsc(draft || "") + "</textarea>" +
    '<button type="button" class="ax-btn" id="agm-td-send" data-agm-act="send" data-id="' + agmEsc(id) + '">Send</button>' +
    '<button type="button" class="ax-btn ax-btn--ghost" data-agm-act="close">Close</button></div></section>'
}

/** The top of the page: New agent, what just happened, and the restart a
 *  new or removed agent waits for. `waitFor` is the agent just created:
 *  after the restart the page waits until /api/live reports it, then opens
 *  its Test drive. Empty for anyone but the owner. */
export function agmHeadHtml(owner: boolean, flash: string, restart: string, error: string, waitFor?: string): string {
  if (!owner) return ""
  const who = waitFor ? "@" + agmEsc(waitFor) : ""
  const rs = restart === "asked"
    ? '<p class="agm-restart" role="status">' + (who ? "Restart asked. Waiting for " + who + " to start; its Test drive opens here." : "Restart asked: the daemon restarts once no task runs.") + "</p>"
    : restart ? '<p class="agm-restart">' + (who ? "Restart when idle to start " + who + "." : "A new or removed agent applies after a daemon restart.") +
      ' <button type="button" class="ax-btn" data-agm-act="restart">Restart when idle</button></p>' : ""
  return '<div class="agm-head"><button type="button" class="ax-btn" data-agm-act="new">New agent</button>' +
    '<span class="wdo__n" id="agm-n" role="status">' + agmEsc(flash) + "</span></div>" +
    (error ? '<p class="wst__err">' + agmEsc(error) + "</p>" : "") + rs
}
