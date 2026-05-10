/** Static configuration for the editor: palette items, expression-variable
 *  tree, template cards. Real data (agents, run history) comes from the API. */

import type { IconName } from "./Icons"
import type { NodeType } from "./types"

export type { NodeType }

export interface PaletteItem {
  id: string
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
  { section: "Triggers", items: [
    { id: "trigger.channel.whatsapp", type: "trigger.channel", label: "WhatsApp", hint: "On incoming WhatsApp message", glyph: "g-trigger", icon: "msg" },
    { id: "trigger.channel.telegram", type: "trigger.channel", label: "Telegram", hint: "On incoming Telegram message", glyph: "g-trigger", icon: "msg" },
    { id: "trigger.channel.gitlab",   type: "trigger.channel", label: "GitLab",   hint: "Issue / pipeline events", glyph: "g-trigger", icon: "gitlab" },
    { id: "trigger.channel.sentry",   type: "trigger.channel", label: "Sentry",   hint: "On any webhook event", glyph: "g-trigger", icon: "hook" },
    { id: "trigger.channel.whatsapp",   type: "trigger.channel", label: "Webhooks",   hint: "On any available webhook event", glyph: "g-trigger", icon: "hook" },
    { id: "trigger.cron",             type: "trigger.cron",    label: "Cron",     hint: "Fires on a timer", glyph: "g-trigger", icon: "clock" },
    { id: "trigger.manual",           type: "trigger.manual",  label: "Manual",   hint: "Kick off from UI / CLI", glyph: "g-trigger", icon: "play" },
    { id: "trigger.form",             type: "trigger.form",    label: "Form",     hint: "Human fills a form to start", glyph: "g-trigger", icon: "plus" },
  ]},
  { section: "Compute", items: [
    { id: "node.agent",     type: "agent",     label: "Agent",     hint: "Run an agent with a templated prompt", glyph: "g-state", icon: "box" },
    { id: "node.transform", type: "transform", label: "Transform", hint: "Derive a bundle from upstream outputs", glyph: "g-state", icon: "variable" },
  ]},
  { section: "People & composition", items: [
    { id: "node.userTask",   type: "userTask",   label: "User task",    hint: "Assign a form to an actor / role; pauses the run", glyph: "g-state", icon: "box" },
    { id: "node.subProcess", type: "subProcess", label: "Sub-process",  hint: "Call another workflow; parent resumes on child end", glyph: "g-state", icon: "box" },
    { id: "node.signal.emit", type: "signal.emit", label: "Emit signal", hint: "Post an event to other workflows", glyph: "g-action", icon: "msg" },
    { id: "node.signal.wait", type: "signal.wait", label: "Wait for signal", hint: "Pause until a matching signal arrives", glyph: "g-branch", icon: "flag" },
    { id: "node.timer.boundary", type: "timer.boundary", label: "Timer", hint: "Pause then fire after a duration (PT1H, P1D…)", glyph: "g-branch", icon: "clock" },
  ]},
  { section: "Flow control", items: [
    { id: "node.branch",     type: "branch",     label: "Branch",     hint: "Route based on a condition", glyph: "g-branch", icon: "branch" },
    { id: "node.gateway.parallel", type: "gateway.parallel", label: "Parallel gateway", hint: "Fan out / join branches (mode: fanOut | join)", glyph: "g-branch", icon: "branch" },
    { id: "node.rule",       type: "rule",       label: "Decision table", hint: "DMN-style N-input rules; first match wins", glyph: "g-branch", icon: "branch" },
    { id: "node.checkpoint", type: "checkpoint", label: "Checkpoint", hint: "Persist state, pause for event", glyph: "g-branch", icon: "flag" },
    { id: "node.end",        type: "end",        label: "End",        hint: "Run completes here", glyph: "g-end", icon: "stop" },
  ]},
  { section: "Actions", items: [
    { id: "action.send",        type: "action.send",        label: "Send message", hint: "Post a message to any channel", glyph: "g-action", icon: "msg" },
    { id: "action.createIssue", type: "action.createIssue", label: "Create issue", hint: "Open a new GitLab issue", glyph: "g-action", icon: "plus" },
    { id: "action.setLabel",    type: "action.setLabel",    label: "Set Label",    hint: "Add or remove labels", glyph: "g-action", icon: "tag" },
    { id: "action.callHTTP",    type: "action.callHTTP",    label: "HTTP Request", hint: "Call an external service", glyph: "g-action", icon: "globe" },
    { id: "action.run",         type: "action.run",         label: "Registered action", hint: "Invoke a shell/http action from the registry", glyph: "g-action", icon: "lightning" },
    { id: "action.logTime",     type: "action.logTime",     label: "Log Time",     hint: "Record time spent in a state", glyph: "g-action", icon: "clock" },
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
