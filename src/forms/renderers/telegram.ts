import type { UserTaskRecord, TaskStore } from "../../workflows/task-store"
import type { ActorStore } from "../../actors/store"
import type { FormSchema } from "../types"

// --- Telegram user-task renderer ---
//
// Delivers a user-task notification to the assignee's Telegram chat.
//
// Two delivery shapes:
//   1. Approve/reject (form has a secondaryAction AND no required fields
//      that lack defaults) — inline-keyboard with two URL buttons that
//      one-tap-submit via `GET /t/:taskId/:action`. No web visit required.
//   2. Full-form (any form with required fields) — plain message with a
//      deep link to the web inbox where the user fills in values.
//
// The one-click URL pattern uses URL buttons (not callback_data) so we
// don't need to wire callback_query handling into the adapter polling
// loop for Phase 3 MVP.

interface SendingAdapter {
  sendMessage: (msg: { chatId: string; text: string; parseMode?: string; accountId?: string }) => Promise<string | undefined | void>
  sendWithInlineButtons?: (args: {
    chatId: string
    text: string
    buttons: Array<{ label: string; url: string }>
    parseMode?: "markdown" | "html" | "plain"
    accountId?: string
  }) => Promise<string | undefined | void>
}

export interface TelegramRendererOptions {
  actors: ActorStore
  tasks: TaskStore
  inboxBaseUrl?: string
  adapter: SendingAdapter
  log?: (msg: string) => void
}

export function createTelegramTaskRenderer(opts: TelegramRendererOptions) {
  const log = opts.log ?? (() => {})
  return async function render(task: UserTaskRecord): Promise<void> {
    const baseUrl = opts.inboxBaseUrl ?? ""
    const oneClick = canOneClickSubmit(task.form)

    for (const actorId of task.assignedTo) {
      const handle = opts.actors.channelFor(actorId, "telegram")
      if (!handle) continue
      const text = buildTaskText(task, actorId, baseUrl, oneClick)

      try {
        let messageId: string | undefined
        if (oneClick && opts.adapter.sendWithInlineButtons) {
          const buttons = [
            { label: task.form.submitLabel || "Approve", url: `${baseUrl}/t/${encodeURIComponent(task.id)}/primary?actor=${encodeURIComponent(actorId)}` },
            ...(task.form.secondaryAction ? [{
              label: task.form.secondaryAction.label,
              url: `${baseUrl}/t/${encodeURIComponent(task.id)}/secondary?actor=${encodeURIComponent(actorId)}`,
            }] : []),
          ]
          const r = await opts.adapter.sendWithInlineButtons({
            chatId: handle, text, parseMode: "markdown", buttons,
          })
          messageId = typeof r === "string" ? r : undefined
        } else {
          const r = await opts.adapter.sendMessage({ chatId: handle, text, parseMode: "markdown" })
          messageId = typeof r === "string" ? r : undefined
        }
        const delivered = [
          ...(task.delivered ?? []),
          { channel: "telegram", handle, messageId, at: new Date().toISOString() },
        ]
        opts.tasks.save({ ...task, delivered })
      } catch (e: any) {
        log(`[task:${task.id}] telegram delivery to ${actorId}@${handle} failed: ${e?.message ?? e}`)
      }
    }
  }
}

/** A form is one-click-submittable when it has a primary + secondary
 *  action AND no required field without a defaultValue. Pure approve/
 *  reject forms (no fields at all, or all fields optional with defaults)
 *  fit this shape. */
function canOneClickSubmit(form: FormSchema): boolean {
  if (!form.secondaryAction) return false
  for (const f of form.fields ?? []) {
    if (f.required && f.defaultValue === undefined) return false
  }
  return true
}

function buildTaskText(task: UserTaskRecord, actorId: string, baseUrl: string, oneClick: boolean): string {
  const inboxUrl = `${baseUrl}/inbox?actor=${encodeURIComponent(actorId)}`
  const lines: string[] = []
  lines.push(`📋 **${task.title}**`)
  if (task.description) lines.push("", task.description)
  if (!oneClick && task.form.fields?.length) {
    lines.push("", "_Fields_:")
    for (const f of task.form.fields) {
      const required = f.required ? " *(required)*" : ""
      lines.push(`• ${f.label}${required}`)
    }
  }
  if (task.dueAt) lines.push("", `⏰ Due: ${new Date(task.dueAt).toLocaleString()}`)
  if (!oneClick) lines.push("", `[Open form →](${inboxUrl})`)
  return lines.join("\n")
}
