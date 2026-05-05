// Single source of truth for user-facing labels in the dashboard web UIs.
//
// AgentX keeps its JSON schema keys (tier, mention, workspace, mesh, heartbeat)
// because third-party configs depend on them. But the dashboard is for operators
// who don't care about the schema — they want plain English. This module maps
// the internal vocabulary to the labels shown on screen and to the glossary.
//
// Changes here are SAFE: they only affect what the browser renders. They do NOT
// change agentx.json, the CLI, or any external API surface.

export const UI_LABELS = {
  brand: "AgentX",
  subtitle: "Team AI ops",

  // Header summary
  nodes: "machines",
  agentsCount: "agents",
  activeNow: "handling now",
  errorsCount: "failed",

  // Per-agent card
  stats: {
    active: "Handling",
    total: "Today",
    errors: "Failed",
  },
  idle: "idle",
  runningNoPreview: "working · preparing reply",
  recentActivities: "Recent activities →",
  noAgentsOnNode: "No agents set up on this machine.",
  unreachable: "This machine is unreachable.",
  neverRan: "not used yet",

  // Friendly names per tier
  tierLabels: {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    "sdk": "SDK",
    "orchestrator": "Orchestrator",
  } as Record<string, string>,

  // Task history / modal
  taskModalTitle: "Task activity",
  taskModalConnecting: "connecting…",
  taskModalLive: "live",
  taskModalFinished: "finished",
  taskModalArchived: "archived",
  taskModalLoadFailed: "couldn't load",
  taskModalFinalResponse: "Final reply",
  historyPanelTitle: "Recent activities",
  historyEmpty: "No activity yet.",
  historyLoading: "loading…",
}

/**
 * Rename map used by a small tooltip helper in the UI. Lets us hover over any
 * badge/label and see both the friendly name and the original schema key so
 * operators who do know the config aren't confused.
 */
export const SCHEMA_ALIASES: Record<string, string> = {
  tier: "AI engine",
  model: "model",
  mention: "trigger word",
  mentions: "trigger words",
  workspace: "agent folder",
  mesh: "team network",
  heartbeat: "status check-in",
  channel: "channel",
  cron: "schedule",
  primaryToolLabel: "board filter label",
  scopedLabel: "status label",
}

/**
 * Friendly glossary shown at /glossary. Keep entries short, definition-style,
 * no jargon — written for a business operator, not an engineer.
 */
export const GLOSSARY: Array<{ term: string; alias?: string; definition: string }> = [
  {
    term: "Agent",
    definition: "An AI worker with its own role, instructions, and channels it responds on. Think of each agent as a job title — \"support\", \"devops\", \"sales\".",
  },
  {
    term: "Trigger word",
    alias: "mention",
    definition: "A word that activates an agent. When the trigger appears in a message (e.g. @support), AgentX routes the message to that agent.",
  },
  {
    term: "Channel",
    definition: "Where messages come from — Telegram, WhatsApp, Discord, GitLab comments, a scheduled cron, or an HTTP webhook.",
  },
  {
    term: "AI engine",
    alias: "tier",
    definition: "Which backend answers: Claude Code, Codex CLI, Anthropic Agent SDK, or AgentX's provider-agnostic orchestrator.",
  },
  {
    term: "Agent folder",
    alias: "workspace",
    definition: "The directory on disk where the agent lives. It holds the agent's personality (CLAUDE.md), its knowledge (wiki), and the tools it can use.",
  },
  {
    term: "Team network",
    alias: "mesh",
    definition: "When you run AgentX on more than one machine, the machines find each other and share work. Each machine is a \"node\"; together they are your team network.",
  },
  {
    term: "Status check-in",
    alias: "heartbeat",
    definition: "A lightweight ping between machines so each one knows the others are alive and responsive.",
  },
  {
    term: "Board",
    definition: "A Kanban view of tasks (issues, tickets) pulled from GitLab. Drag cards between columns to move work forward — the labels update upstream automatically.",
  },
  {
    term: "Task",
    definition: "A single conversation or job an agent handles, from trigger message to final reply. Every task is logged and replayable.",
  },
  {
    term: "Schedule",
    alias: "cron",
    definition: "A recurring job — e.g. \"every Monday at 9am\" — that nudges an agent without a human trigger.",
  },
  {
    term: "Status label",
    alias: "scopedLabel",
    definition: "A GitLab label that moves an issue between Kanban columns (e.g. Status::Doing). Labels are mutually exclusive by prefix.",
  },
]

export function tierFriendly(tier: string | undefined): string {
  if (!tier) return ""
  return UI_LABELS.tierLabels[tier] || tier
}
