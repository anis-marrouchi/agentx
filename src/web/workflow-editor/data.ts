/** Static configuration for the editor: palette items, expression-variable
 *  tree, template cards. Real data (agents, run history) comes from the API. */

import type { IconName } from "./Icons"
import type { NodeType } from "./types"

export type { NodeType }

export interface PaletteItem {
  id: string
  /** Preset config for a dropped node. Dynamic items — your own n8n
   *  workflows — arrive already pointing at the right webhook, so nobody
   *  copies a URL between two browser tabs. */
  config?: Record<string, unknown>
  /** V2 NodeType (e.g. "trigger.channel", "action.send"). Palette items
   *  drop onto the canvas with this type. */
  type: NodeType
  label: string
  hint: string
  glyph: string
  icon: IconName
}

export interface PaletteSection {
  section: string
  items: PaletteItem[]
}

export const PALETTE: PaletteSection[] = [
  // Labels say what the step DOES, in the words someone would use to describe
  // it out loud. The machine name still travels in `type` — it just is not
  // what the person building the workflow has to read.
  { section: "What starts it", items: [
    { id: "trigger.channel.whatsapp", type: "trigger.channel", label: "A WhatsApp message", hint: "Someone messages you on WhatsApp", glyph: "g-trigger", icon: "msg" },
    { id: "trigger.channel.telegram", type: "trigger.channel", label: "A Telegram message", hint: "Someone messages you on Telegram", glyph: "g-trigger", icon: "msg" },
    { id: "trigger.channel.gitlab",   type: "trigger.channel", label: "Something on GitLab", hint: "An issue, merge request or pipeline changes", glyph: "g-trigger", icon: "gitlab" },
    { id: "trigger.hook.n8n",         type: "trigger.hook",    label: "n8n hands work over", hint: "n8n calls this workflow — it keeps the connectors, you keep the agents", glyph: "g-trigger", icon: "hook" },
    { id: "trigger.hook",             type: "trigger.hook",    label: "Something calls in", hint: "Any service that can POST a webhook", glyph: "g-trigger", icon: "hook" },
    { id: "trigger.cron",             type: "trigger.cron",    label: "A time of day",    hint: "Runs on a schedule you set", glyph: "g-trigger", icon: "clock" },
    { id: "trigger.manual",           type: "trigger.manual",  label: "You start it",     hint: "Only runs when you press run", glyph: "g-trigger", icon: "play" },
    { id: "trigger.form",             type: "trigger.form",    label: "Someone fills a form", hint: "A person submits a form to begin", glyph: "g-trigger", icon: "plus" },
  ]},
  { section: "Put an agent on it", items: [
    { id: "node.agent",     type: "agent",     label: "Ask an agent",   hint: "Give an agent the job, in your own words", glyph: "g-state", icon: "box" },
    { id: "node.transform", type: "transform", label: "Reshape the data", hint: "Build a value out of earlier steps", glyph: "g-state", icon: "variable" },
  ]},
  { section: "Bring in a person", items: [
    { id: "node.userTask",   type: "userTask",   label: "Ask a person",  hint: "Send someone a form and wait for their answer", glyph: "g-state", icon: "box" },
    { id: "node.checkpoint", type: "checkpoint", label: "Wait for approval", hint: "Hold here until someone says go", glyph: "g-branch", icon: "flag" },
    { id: "node.timer.boundary", type: "timer.boundary", label: "Wait a while", hint: "Pause for an hour, a day, however long", glyph: "g-branch", icon: "clock" },
  ]},
  { section: "Decide what happens next", items: [
    { id: "node.branch",     type: "branch",     label: "If this, then that", hint: "Send the run down one path or another", glyph: "g-branch", icon: "branch" },
    { id: "node.rule",       type: "rule",       label: "A table of rules",   hint: "Several conditions at once; first match wins", glyph: "g-branch", icon: "branch" },
    { id: "node.gateway.parallel", type: "gateway.parallel", label: "Do several at once", hint: "Split into parallel paths, then join them", glyph: "g-branch", icon: "branch" },
    { id: "node.end",        type: "end",        label: "Finish",             hint: "The run ends here", glyph: "g-end", icon: "stop" },
  ]},
  { section: "Do something", items: [
    { id: "action.send",        type: "action.send",        label: "Send a message",   hint: "Post to WhatsApp, Telegram, GitLab — anywhere you have a channel", glyph: "g-action", icon: "msg" },
    { id: "action.createIssue", type: "action.createIssue", label: "Open an issue",    hint: "Create a new GitLab issue", glyph: "g-action", icon: "plus" },
    { id: "action.setLabel",    type: "action.setLabel",    label: "Change a label",   hint: "Add or remove labels", glyph: "g-action", icon: "tag" },
    { id: "action.react",       type: "action.react",       label: "React to a message", hint: "Add an emoji reaction", glyph: "g-action", icon: "msg" },
    { id: "action.editMessage", type: "action.editMessage", label: "Edit a message",    hint: "Change a message you already sent", glyph: "g-action", icon: "msg" },
    { id: "action.readLabel",   type: "action.readLabel",   label: "Read a label",      hint: "Look at the labels on an issue before deciding", glyph: "g-action", icon: "tag" },
    { id: "action.callHTTP",    type: "action.callHTTP",    label: "Call a web address", hint: "Hand work to n8n, or any service with a URL", glyph: "g-action", icon: "globe" },
    { id: "action.builtin",     type: "action.builtin",     label: "Use a built-in step", hint: "Fetch a page, extract fields, and other bundled helpers", glyph: "g-action", icon: "lightning" },
    { id: "action.run",         type: "action.run",         label: "Run a saved action", hint: "Invoke something from your action registry", glyph: "g-action", icon: "lightning" },
    { id: "action.logTime",     type: "action.logTime",     label: "Log time spent",   hint: "Record how long this took", glyph: "g-action", icon: "clock" },
  ]},
  { section: "Talk to other workflows", items: [
    { id: "node.subProcess",  type: "subProcess",  label: "Run another workflow", hint: "Call one, and carry on when it finishes", glyph: "g-state", icon: "box" },
    { id: "node.signal.emit", type: "signal.emit", label: "Tell other workflows",  hint: "Announce that something happened", glyph: "g-action", icon: "msg" },
    { id: "node.signal.wait", type: "signal.wait", label: "Wait to be told",       hint: "Hold until another workflow announces it", glyph: "g-branch", icon: "flag" },
  ]},
]

export interface ExprVariable {
  path: string
  type: string
}

export const EXPR_VARS: Array<{ group: string; items: ExprVariable[] }> = [
  { group: "issue", items: [
    { path: "issue.title",     type: "string" },
    { path: "issue.labels",    type: "string[]" },
    { path: "issue.assignee",  type: "string?" },
    { path: "issue.author",    type: "string" },
    { path: "issue.body",      type: "string" },
    { path: "issue.iid",       type: "number" },
    { path: "issue.url",       type: "string" },
  ]},
  { group: "run", items: [
    { path: "run.id",          type: "string" },
    { path: "run.state",       type: "string" },
    { path: "run.workflow",    type: "string" },
    { path: "run.homeNode",    type: "string" },
  ]},
  { group: "pipeline", items: [
    { path: "pipeline.status", type: "enum" },
    { path: "pipeline.ref",    type: "string" },
    { path: "pipeline.id",     type: "number" },
  ]},
  { group: "state", items: [
    { path: "state.previous",  type: "string?" },
    { path: "state.next",      type: "string?" },
  ]},
  { group: "env", items: [
    { path: "env.GITLAB_TOKEN", type: "secret (allowlist req.)" },
    { path: "env.GITLAB_HOST",  type: "string (allowlist req.)" },
  ]},
]

export interface TemplateCard {
  id: string
  title: string
  hint: string
  dots: number
}

export const TEMPLATES: TemplateCard[] = [
  { id: "tpl.gitlab", title: "GitLab issue lifecycle", hint: "Triage → Review → QA → Done · 5 states", dots: 3 },
  { id: "tpl.mr",     title: "MR review loop",         hint: "Agent-driven 3-state review",           dots: 2 },
  { id: "tpl.blank",  title: "Blank canvas",           hint: "Start from a single trigger",           dots: 1 },
]

// Fallback mock agents if /api/agents can't be reached. Real list comes from
// the daemon — see api.ts::fetchAgents.
export interface AgentInfo {
  id: string
  name: string
  tags: string[]
  color: number
}

export const MOCK_AGENTS: AgentInfo[] = [
  { id: "triage-agent", name: "Triage Agent", tags: ["default"], color: 200 },
  { id: "dev-agent",    name: "Dev Agent",    tags: ["default"], color: 145 },
  { id: "code-reviewer",name: "Code Reviewer",tags: ["default"], color: 28 },
]


/** The words a node wears on the canvas. A node should read the same as the
 *  palette item you dragged to create it — showing "trigger.manual" there
 *  makes the canvas a different, more technical product than the palette. */
export function friendlyKind(type: string): string {
  for (const section of PALETTE) {
    const hit = section.items.find(i => i.type === type)
    if (hit) return hit.label
  }
  return type
}


/** One line describing what THIS node will actually do, from its config.
 *  The canvas used to print the node id and the machine type — "review",
 *  "callHTTP" — which tells you what it is called, never what it does.
 *  Returns "" when there is genuinely nothing to say, so the caller can
 *  render no row rather than an empty one. */
export function nodeSummary(type: string, cfg: Record<string, unknown>): string {
  const str = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string).trim() : "")
  const clip = (v: string, n = 70) => (v.length > n ? v.slice(0, n - 1) + "…" : v)
  switch (type) {
    case "trigger.channel": return str("source") ? `when ${str("source")} has activity` : ""
    case "trigger.cron":    return str("schedule") ? `at ${str("schedule")}` : ""
    case "trigger.hook":    return str("event") === "on:n8n" ? "when n8n calls" : str("event") ? `on ${str("event")}` : ""
    case "trigger.form":    return str("formId") ? `form: ${str("formId")}` : ""
    case "agent": {
      const who = str("agentId") || str("agent")
      const ask = str("prompt") || str("message")
      return [who && `ask ${who}`, ask && clip(ask)].filter(Boolean).join(" — ")
    }
    case "action.send":      return clip(str("text") || str("body")) || (str("channel") && `to ${str("channel")}`)
    case "action.callHTTP":  return clip(str("url"))
    case "action.builtin":   return str("name")
    case "action.run":       return str("action") || str("name")
    case "action.createIssue": return clip(str("title"))
    case "action.setLabel":  return str("label") ? `label: ${str("label")}` : ""
    case "subProcess":       return str("workflowId") ? `runs ${str("workflowId")}` : ""
    case "signal.emit":
    case "signal.wait":      return str("signal") ? `signal: ${str("signal")}` : ""
    case "timer.boundary":   return str("duration") ? `waits ${str("duration")}` : ""
    case "userTask":         return str("assignTo") ? `asks ${str("assignTo")}` : ""
    case "branch": {
      const n = Array.isArray(cfg.cases) ? (cfg.cases as unknown[]).length : 0
      return n ? `${n} way${n === 1 ? "" : "s"} out` : ""
    }
    default: return ""
  }
}
