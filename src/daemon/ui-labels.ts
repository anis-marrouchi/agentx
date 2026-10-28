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
    "opencode": "OpenCode",
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

export function tierFriendly(tier: string | undefined): string {
  if (!tier) return ""
  return UI_LABELS.tierLabels[tier] || tier
}
