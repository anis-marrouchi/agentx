// Settings › Machine and Diagnostics: the rows the panes draw, the one
// source search reads (panes.ts, condition 1).
import type { SettingsRowDef } from "../panes"

// System › Machine (#2101 ST3b): screen capture, recent frames, agentx.json.
export const MACHINE_ROWS = [
  { id: "screen", label: "Screen capture", help: "Each capture is cropped and scaled, and taken when something changes or settles. Same as agentx screen config.", words: "screen capture agentx screen config" },
  { id: "sc-pixels", label: "Pixel budget per frame", help: "Larger captures are scaled down to fit.", words: "screen capture max pixels" },
  { id: "sc-interval", label: "Look every", help: "Time between two looks while an agent waits for a change.", words: "screen capture interval ms" },
  { id: "sc-regions", label: "Named regions", help: "One per line: name=x,y,width,height, in screen points.", words: "screen capture region" },
  { id: "sc-threshold", label: "Change threshold", help: "How different two looks must be to count as a change. 0 to 1.", words: "screen capture advanced", open: "screen-advanced" },
  { id: "sc-stable", label: "Settled after", help: "How long the screen must stay still to count as settled.", words: "screen capture advanced stable ms", open: "screen-advanced" },
  { id: "sc-timeout", label: "Wait timeout", help: "Longest a capture waits for a change or for the screen to settle.", words: "screen capture advanced timeout ms", open: "screen-advanced" },
  { id: "frames", label: "Recent frames", help: "The last few seconds of a region, kept in memory only. Off unless you turn it on.", words: "buffer screen recent frames" },
  { id: "fb-on", label: "Keep recent frames", help: "An agent can then look back at what just happened.", words: "buffer recent frames screen" },
  { id: "fb-region", label: "Region", help: "A built-in region, a named one, or x,y,w,h.", words: "recent frames buffer region" },
  { id: "fb-seconds", label: "Seconds kept", help: "Up to 120.", words: "recent frames buffer" },
  { id: "fb-fps", label: "Frames per second", help: "Up to 10.", words: "recent frames buffer fps" },
  { id: "fb-pixels", label: "Pixel budget per frame, recent frames", help: "Smaller than a capture: these stay in memory.", words: "recent frames buffer max pixels" },
  { id: "cfg", label: "agentx.json", help: "Every other section writes to this file. Edit it for bulk changes or a setting with no form yet.", words: "advanced config raw edit file json" },
] as const satisfies readonly SettingsRowDef[]

// System › Diagnostics (#2101 ST3b). A tab is a fold of the shell, as in
// Jobs and Channels: `open` names the tab (dg-tab-*), so search turns to it.
export const DIAGNOSTICS_TABS = [
  ["overview", "Overview"], ["activity", "Activity"], ["errors", "Errors"], ["routing", "Routing"],
  ["rotations", "Rotations"], ["logs", "Logs"], ["doctor", "Doctor"],
] as const
export type DiagnosticsTab = (typeof DIAGNOSTICS_TABS)[number][0]

export const DIAGNOSTICS_ROWS = [
  { id: "dg-today", label: "Today", help: "Compared with yesterday at the same time.", words: "overview tasks errors response spend", open: "dg-tab-overview" },
  { id: "dg-tasks", label: "Tasks", words: "overview today count", open: "dg-tab-overview" },
  { id: "dg-errors-today", label: "Errors today", words: "overview error rate", open: "dg-tab-overview" },
  { id: "dg-response", label: "Average response", words: "overview duration p50 p95 time", open: "dg-tab-overview" },
  { id: "dg-spend", label: "Spend", words: "overview cost money today", open: "dg-tab-overview" },
  { id: "dg-failures", label: "Recent failures", help: "In the last 24 hours, newest first.", words: "errors failed", open: "dg-tab-overview" },
  { id: "dg-agents", label: "Per agent, today", words: "overview tasks agent table", open: "dg-tab-overview" },
  { id: "dg-channels", label: "Per channel, today", words: "overview tasks channel table", open: "dg-tab-overview" },
  { id: "dg-idle", label: "Idle agents", words: "overview no task last 24 hours", open: "dg-tab-overview" },
  { id: "dg-activity", label: "Last 24 hours, per hour", help: "The red part of each bar is errors.", words: "activity tasks per hour chart", open: "dg-tab-activity" },
  { id: "dg-days", label: "Last 7 days, per day", words: "activity tasks per day chart", open: "dg-tab-activity" },
  { id: "dg-agents-week", label: "Per agent, 7 days", words: "activity tasks agent table", open: "dg-tab-activity" },
  { id: "dg-errors", label: "Errors", help: "Task errors with what happened, in plain words.", words: "task errors failed", open: "dg-tab-errors" },
  { id: "dg-routing", label: "Routing", help: "Which stage picked which agent for a message: why an agent did or did not pick it up.", words: "which agent stage binding wake word", open: "dg-tab-routing" },
  { id: "dg-rotations", label: "Rotations", help: "Each time a session started fresh: stale (idle), tier-2 (input crossed the billing threshold) or max-turns.", words: "session fresh tier-2 stale max-turns", open: "dg-tab-rotations" },
  { id: "dg-logs", label: "Logs", help: "Live tail of the daemon's output", words: "live tail daemon output", open: "dg-tab-logs" },
  { id: "dg-doctor", label: "Doctor checks", help: "The same checks as agentx doctor", words: "preflight doctor health", open: "dg-tab-doctor" },
] as const satisfies readonly SettingsRowDef[]
