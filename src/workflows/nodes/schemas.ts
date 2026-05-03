import type { NodeType } from "../types"

// --- Node output schemas (single source of truth) ---
//
// Each node handler writes its output to `run.context[node.id]`. Downstream
// handlers and `action.*` templates read from it via `{{<nodeId>.<path>}}`.
// This module declares what those bundles look like, per node type, so:
//
//   1. The visual editor can show a Context panel listing every available
//      template path on upstream nodes (end of "how am I supposed to know
//      these?").
//   2. A future schema-driven Inspector renderer can validate configs and
//      surface hints without bespoke React per node type.
//   3. Documentation and lints stay in lockstep with handler behaviour —
//      any handler that changes its output shape should update the schema
//      in the same commit (there's a test guarding a few of the critical
//      ones: see test/workflows.test.ts).
//
// Schemas are plain data — no imports from handlers.ts — so the editor's
// IIFE bundle stays small and handler-specific logic (execa, fs, ...) never
// leaks to the browser.

export type OutputFieldType = "string" | "number" | "bool" | "object" | "array" | "any"

export interface OutputField {
  /** Dotted path relative to the node's output bundle. Empty string = the
   *  node produces a scalar directly (`{{nodeId}}`), but we usually key into
   *  at least one level. */
  path: string
  type: OutputFieldType
  description: string
  /** Optional example value shown in the Context panel when no run data is
   *  available. Kept short — the panel is meant to inform, not replace a
   *  debugger. */
  example?: string
  /** When present, the field only appears for this subset of config. Used by
   *  `trigger.channel` where the output shape depends on `source`. */
  sourceFilter?: string[]
}

export interface NodeOutputSchema {
  /** Short prose shown at the top of the Context card. */
  summary: string
  /** Fields the node writes, in useful-first order (what authors usually
   *  template against: `text`, `reply`, `chatId`, ...). */
  fields: OutputField[]
}

// --- Per-type schemas ---
//
// trigger.channel: the hook layer (hooks.ts::buildChannelTriggerPayload for
// channel sources, and the gitlab/pipeline blocks for those) chooses the
// shape. We model the common superset + source-specific fields.

const TRIGGER_CHANNEL_COMMON: OutputField[] = [
  { path: "channel", type: "string", description: "Channel name that received the event.", example: `"whatsapp"`, sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "chatId", type: "string", description: "Stable chat id — conversation partner JID (WhatsApp) or chat integer (Telegram). Use as `action.send` chatId to reply on the same thread.", example: `"21624309128@s.whatsapp.net"`, sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "accountId", type: "string", description: "Which bot account received the message. Telegram routes this per-account; inherit into `action.send` to reply through the same bot.", example: `"default"`, sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "text", type: "string", description: "Message body (caption for media), lower-cased for routing but the raw text here is verbatim.", example: `"hello"`, sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "fromJid", type: "string", description: "Raw sender JID/id straight from the platform. Use `sender.id` for the normalized form.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "sender.id", type: "string", description: "Normalized sender id.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "sender.name", type: "string", description: "Display name, e.g. WhatsApp pushName or Telegram first_name.", example: `"Anis"`, sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "sender.username", type: "string", description: "Platform-specific handle when available (Telegram @username, ...).", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "group.id", type: "string", description: "Group chat id when the message came from a group; undefined for DMs.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "group.name", type: "string", description: "Group display name when available.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "replyTo", type: "string", description: "ID of the message this one quoted, when any.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "replyToText", type: "string", description: "Text of the quoted message when available.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "media.path", type: "string", description: "Filesystem path of the attached media after download.", sourceFilter: ["whatsapp-message", "telegram-message"] },
  { path: "media.type", type: "string", description: "MIME type of the media (`image/jpeg`, `audio/ogg`, ...).", sourceFilter: ["whatsapp-message", "telegram-message"] },
  { path: "event.id", type: "string", description: "Platform message id. Use as `action.send` replyTo to thread replies.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },
  { path: "event.timestamp", type: "string", description: "ISO-8601 timestamp of the source message.", sourceFilter: ["whatsapp-message", "telegram-message", "discord-message", "slack-message"] },

  // GitLab issue source
  { path: "issue.iid", type: "number", description: "GitLab internal issue id (per project).", example: "42", sourceFilter: ["gitlab-issue"] },
  { path: "issue.title", type: "string", description: "Issue title.", sourceFilter: ["gitlab-issue"] },
  { path: "issue.description", type: "string", description: "Issue description body.", sourceFilter: ["gitlab-issue"] },
  { path: "issue.url", type: "string", description: "Web URL of the issue.", sourceFilter: ["gitlab-issue"] },
  { path: "issue.action", type: "string", description: "Action that triggered the event (`open`, `update`, `close`, ...).", sourceFilter: ["gitlab-issue"] },
  { path: "issue.labels", type: "array", description: "Current labels on the issue.", sourceFilter: ["gitlab-issue"] },
  { path: "issue.assignees", type: "array", description: "Assignees on the issue.", sourceFilter: ["gitlab-issue"] },
  { path: "project", type: "string", description: "GitLab project path.", example: `"noqta/web"`, sourceFilter: ["gitlab-issue", "gitlab-pipeline"] },
  { path: "chatId", type: "string", description: `Stable entity id for GitLab: "<project>:issue:<iid>" (issue) or "<project>:merge_request:<iid>" (pipeline).`, sourceFilter: ["gitlab-issue", "gitlab-pipeline"] },
  { path: "channel", type: "string", description: "Always `\"gitlab\"` for GitLab sources.", sourceFilter: ["gitlab-issue", "gitlab-pipeline"] },

  // GitLab pipeline source
  { path: "pipeline.id", type: "number", description: "Pipeline id.", sourceFilter: ["gitlab-pipeline"] },
  { path: "pipeline.status", type: "string", description: "Pipeline status (`success`, `failed`, `canceled`, ...).", sourceFilter: ["gitlab-pipeline"] },
  { path: "pipeline.ref", type: "string", description: "Git ref the pipeline ran on.", sourceFilter: ["gitlab-pipeline"] },
]

const AGENT_OUTPUT: OutputField[] = [
  { path: "reply", type: "string", description: "Full agent response text. Most common template target (e.g. echoing it back via `action.send`).", example: `"Got it — routing to..."` },
  { path: "result", type: "string", description: "Parsed `RESULT: <token>` marker from the agent's reply (lowercased), or `approved`/`rejected`/`done`/`failed` from a `[BRACKET]`. Used by `branch` nodes to route on agent classification.", example: `"approved"` },
  { path: "json", type: "any", description: "When `resultParser` is `json`, the parsed first fenced ```json ... ``` block. Useful for structured agent outputs." },
  { path: "taskId", type: "string", description: "Opaque workflow-scoped task id — mostly for diagnostics.", example: `"wf-<runId>-<suffix>"` },
  { path: "durationMs", type: "number", description: "Wall-clock duration of the agent call.", example: "14520" },
]

const ACTION_SEND_OUTPUT: OutputField[] = [
  { path: "messageId", type: "string", description: "Platform message id of the sent message. `null` when the adapter couldn't capture it (e.g. mesh-forwarded sends may return null)." },
  { path: "viaMesh", type: "bool", description: "`true` when the send was forwarded over the mesh to a peer that hosts the channel (workflow on one node, channel adapter on another). Absent for local sends." },
]

const ACTION_CREATE_ISSUE_OUTPUT: OutputField[] = [
  { path: "issue.iid", type: "number", description: "Newly-created issue iid.", example: "123" },
  { path: "issue.url", type: "string", description: "Web URL of the new issue." },
  { path: "issue.webUrl", type: "string", description: "Alias of `issue.url`." },
]

const ACTION_SET_LABEL_OUTPUT: OutputField[] = [
  { path: "labels", type: "array", description: "Label list after the change." },
  { path: "add", type: "array", description: "Labels that were added in this call." },
  { path: "remove", type: "array", description: "Labels that were removed in this call." },
]

const ACTION_READ_LABEL_OUTPUT: OutputField[] = [
  { path: "labels", type: "array", description: "Current label list on the entity. Use with a `branch` node to route on label state." },
]

const ACTION_REACT_OUTPUT: OutputField[] = [
  { path: "emoji", type: "string", description: "The emoji reaction that was applied (echoes the input for debugging)." },
]

const ACTION_EDIT_MESSAGE_OUTPUT: OutputField[] = [
  { path: "edited", type: "bool", description: "`true` when the platform accepted the edit. Treat `false` as a soft miss — text may have been unchanged or the message was too old." },
]

const ACTION_LOG_TIME_OUTPUT: OutputField[] = [
  { path: "durationMs", type: "number", description: "Duration logged, in milliseconds (echoed for downstream use)." },
]

const ACTION_CALL_HTTP_OUTPUT: OutputField[] = [
  { path: "ok", type: "bool", description: "Response.ok — `true` for 2xx." },
  { path: "status", type: "number", description: "HTTP status code.", example: "200" },
  { path: "body", type: "any", description: "Parsed JSON body when the response was JSON; otherwise the raw text string." },
]

const ACTION_RUN_OUTPUT: OutputField[] = [
  { path: "ok", type: "bool", description: "`true` when the action exited 0 (shell) or returned 2xx (http)." },
  { path: "status", type: "number", description: "Exit code (shell) or HTTP status (http)." },
  { path: "output", type: "string", description: "stdout (shell) or response body text (http). Capped at 32KB." },
  { path: "errors", type: "string", description: "stderr (shell) or transport error (http). Empty when none." },
  { path: "durationMs", type: "number", description: "Wall time of the invocation, in milliseconds." },
]

const BRANCH_OUTPUT: OutputField[] = [
  { path: "port", type: "string", description: "Which outgoing port matched. Downstream edges with `fromPort` matching this value will fire." },
]

const TRANSFORM_OUTPUT: OutputField[] = [
  { path: "value", type: "any", description: "When config uses `path`, this carries the value picked from context. In `template` mode, keys from the rendered template land at the top level of this node's output (no `.value` prefix)." },
]

const CHECKPOINT_OUTPUT: OutputField[] = [
  { path: "event", type: "any", description: "Payload of the event that resumed this checkpoint. Fields mirror whichever trigger source delivered the resume event." },
]

const SIGNAL_WAIT_OUTPUT: OutputField[] = [
  { path: "name", type: "string", description: "Name of the signal that resumed the wait." },
  { path: "payload", type: "any", description: "Payload the emitter attached to the signal." },
  { path: "receivedAt", type: "string", description: "ISO-8601 time the signal was observed." },
]

const SIGNAL_EMIT_OUTPUT: OutputField[] = [
  { path: "emittedAt", type: "string", description: "ISO-8601 time the signal was published." },
]

const TIMER_BOUNDARY_OUTPUT: OutputField[] = [
  { path: "firedAt", type: "string", description: "ISO-8601 time the timer elapsed (when resumed)." },
  { path: "scheduledFor", type: "string", description: "ISO-8601 time the timer was originally scheduled for." },
]

const USER_TASK_OUTPUT: OutputField[] = [
  { path: "submission", type: "object", description: "Form values submitted by the assignee, keyed by field id. Shape depends on this userTask's form schema." },
  { path: "submittedBy", type: "string", description: "Actor id of the user who completed the task." },
  { path: "submittedAt", type: "string", description: "ISO-8601 submission timestamp." },
]

const SUB_PROCESS_OUTPUT: OutputField[] = [
  { path: "childRunId", type: "string", description: "Run id of the spawned child workflow." },
  { path: "result", type: "any", description: "Output bundle of the child's terminal `end` node (if any)." },
]

// --- The table ---

export const NODE_OUTPUTS: Record<NodeType, NodeOutputSchema> = {
  "trigger.channel": {
    summary: "Raw event payload from the source channel. Shape varies by `source` — the Context panel filters accordingly.",
    fields: TRIGGER_CHANNEL_COMMON,
  },
  "trigger.manual": {
    summary: "Arbitrary payload posted by `agentx workflow run <id>` / POST /workflows/:id/run.",
    fields: [
      { path: "", type: "any", description: "Whatever JSON the caller supplied." },
    ],
  },
  "trigger.cron": {
    summary: "Scheduled tick — no data bundle beyond the firing metadata.",
    fields: [
      { path: "firedAt", type: "string", description: "ISO-8601 time the tick fired." },
      { path: "cronSpec", type: "string", description: "The `spec` from the node's config (echoed for debug)." },
    ],
  },
  "trigger.hook": {
    summary: "Fires when a custom hook event bubbles through the registry. Payload is whatever the hook subscriber chose to emit.",
    fields: [
      { path: "", type: "any", description: "Hook-specific payload." },
    ],
  },
  "trigger.form": {
    summary: "Starts when a published form receives a submission.",
    fields: [
      { path: "formId", type: "string", description: "Form id that received the submission." },
      { path: "submission", type: "object", description: "Submitted values keyed by field id." },
      { path: "submittedBy", type: "string", description: "Actor id of the submitter." },
    ],
  },
  "agent":              { summary: "Agent response after executing the prompt template.", fields: AGENT_OUTPUT },
  "transform":          { summary: "Value picked from upstream context (path mode) or rendered template bundle (template mode).", fields: TRANSFORM_OUTPUT },
  "branch":             { summary: "Which outgoing port fired. Downstream edges match via `fromPort`.", fields: BRANCH_OUTPUT },
  "gateway.parallel":   { summary: "All incoming branches joined here. No output.", fields: [] },
  "rule":               { summary: "Evaluates a declarative rule against context; may short-circuit the walk.", fields: [] },
  "action.send":        { summary: "Dispatched an outbound message through the chosen channel.", fields: ACTION_SEND_OUTPUT },
  "action.createIssue": { summary: "Created an issue on GitLab/GitHub.", fields: ACTION_CREATE_ISSUE_OUTPUT },
  "action.setLabel":    { summary: "Added/removed labels on a GitLab issue or MR.", fields: ACTION_SET_LABEL_OUTPUT },
  "action.readLabel":   { summary: "Fetched the current label list — useful before a `branch`.", fields: ACTION_READ_LABEL_OUTPUT },
  "action.react":       { summary: "Emoji reaction on a message (Telegram/WhatsApp).", fields: ACTION_REACT_OUTPUT },
  "action.editMessage": { summary: "Edited an existing message in place.", fields: ACTION_EDIT_MESSAGE_OUTPUT },
  "action.logTime":     { summary: "Logged time spent on a GitLab issue/MR.", fields: ACTION_LOG_TIME_OUTPUT },
  "action.callHTTP":    { summary: "Made an outbound HTTP request with templated params.", fields: ACTION_CALL_HTTP_OUTPUT },
  "action.run":         { summary: "Invoked a registered action from the action registry. Output is the full ActionRunResult.", fields: ACTION_RUN_OUTPUT },
  "userTask":           { summary: "Paused for a human to submit a form. Resumes with the submission in this node's output.", fields: USER_TASK_OUTPUT },
  "subProcess":         { summary: "Spawned a child workflow and waited for its completion.", fields: SUB_PROCESS_OUTPUT },
  "signal.emit":        { summary: "Published a signal to the bus. Runs elsewhere can resume on it via `signal.wait`.", fields: SIGNAL_EMIT_OUTPUT },
  "signal.wait":        { summary: "Paused until a matching signal arrives. Resumes with that signal in this node's output.", fields: SIGNAL_WAIT_OUTPUT },
  "timer.boundary":     { summary: "Paused until a timer elapses. Resumes with timing metadata.", fields: TIMER_BOUNDARY_OUTPUT },
  "checkpoint":         { summary: "Paused until a matching resume event arrives on this entity.", fields: CHECKPOINT_OUTPUT },
  "end":                { summary: "Terminal node — closes the run with the configured status. No output downstream.", fields: [] },
}

/** Filter a node's fields by its current config (used for source-conditional
 *  fields on `trigger.channel`). Safe to call with any config shape — missing
 *  keys just keep source-independent fields. */
export function outputFieldsFor(
  type: NodeType,
  config: Record<string, unknown> = {},
): OutputField[] {
  const schema = NODE_OUTPUTS[type]
  if (!schema) return []
  const source = typeof config.source === "string" ? config.source : undefined
  if (!source) {
    // No source set yet → show only source-agnostic fields. Better than a
    // flood of every-possible-source when the author hasn't committed yet.
    return schema.fields.filter((f) => !f.sourceFilter)
  }
  return schema.fields.filter((f) => !f.sourceFilter || f.sourceFilter.includes(source))
}
