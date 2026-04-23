import type { UserTaskRecord, TaskStore } from "../../workflows/task-store"
import type { ActorStore } from "../../actors/store"

// --- Slack user-task renderer ---
//
// Mirrors the Telegram/WhatsApp Phase 3 renderers. Delivers a plain-text
// message to the assignee's Slack member id, with one-click approve/
// reject URLs when the form is shaped that way, or a deep-link to the
// web inbox for forms with required fields.
//
// Block Kit interactive elements (rich buttons with callback handling)
// would need the adapter to surface Slack's interactive-message webhook.
// For parity with the other Phase 3 renderers we stick with text + URLs,
// which works everywhere Slack works and needs no extra plumbing.

interface SendingAdapter {
  send: (msg: { channel: string; chatId: string; text: string; parseMode?: "markdown" | "html" | "plain" }) => Promise<string | void>
}

export interface SlackRendererOptions {
  actors: ActorStore
  tasks: TaskStore
  adapter: SendingAdapter
  inboxBaseUrl?: string
  log?: (msg: string) => void
}

export function createSlackTaskRenderer(opts: SlackRendererOptions) {
  const log = opts.log ?? (() => {})
  return async function render(task: UserTaskRecord): Promise<void> {
    const baseUrl = opts.inboxBaseUrl ?? ""
    const oneClick = canOneClickSubmit(task)
    for (const actorId of task.assignedTo) {
      const handle = opts.actors.channelFor(actorId, "slack")
      if (!handle) continue
      const text = buildText(task, actorId, baseUrl, oneClick)
      try {
        const messageId = await opts.adapter.send({
          channel: "slack",
          chatId: handle,
          text,
          parseMode: "markdown",
        })
        const delivered = [
          ...(task.delivered ?? []),
          {
            channel: "slack",
            handle,
            messageId: typeof messageId === "string" ? messageId : undefined,
            at: new Date().toISOString(),
          },
        ]
        opts.tasks.save({ ...task, delivered })
      } catch (e: any) {
        log(`[task:${task.id}] slack delivery to ${actorId}@${handle} failed: ${e?.message ?? e}`)
      }
    }
  }
}

function canOneClickSubmit(task: UserTaskRecord): boolean {
  if (!task.form.secondaryAction) return false
  for (const f of task.form.fields ?? []) {
    if (f.required && f.defaultValue === undefined) return false
  }
  return true
}

function buildText(task: UserTaskRecord, actorId: string, baseUrl: string, oneClick: boolean): string {
  const lines: string[] = []
  lines.push(`*${task.title}*`)
  if (task.description) lines.push("", task.description)
  if (!oneClick && task.form.fields?.length) {
    lines.push("", "*Fields*:")
    for (const f of task.form.fields) lines.push(`• ${f.label}${f.required ? " (required)" : ""}`)
  }
  if (task.dueAt) lines.push("", `:clock3: Due: ${new Date(task.dueAt).toLocaleString()}`)
  if (oneClick) {
    lines.push(
      "",
      `:white_check_mark: <${baseUrl}/t/${encodeURIComponent(task.id)}/primary?actor=${encodeURIComponent(actorId)}|${task.form.submitLabel || "Approve"}>`,
    )
    if (task.form.secondaryAction) {
      lines.push(
        `:x: <${baseUrl}/t/${encodeURIComponent(task.id)}/secondary?actor=${encodeURIComponent(actorId)}|${task.form.secondaryAction.label}>`,
      )
    }
  } else {
    lines.push("", `<${baseUrl}/inbox?actor=${encodeURIComponent(actorId)}|Open form>`)
  }
  return lines.join("\n")
}
