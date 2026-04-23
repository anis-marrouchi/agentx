import type { UserTaskRecord, TaskStore } from "../../workflows/task-store"
import type { ActorStore } from "../../actors/store"

// --- WhatsApp user-task renderer ---
//
// Mirrors the Telegram renderer with Text only: WhatsApp's Baileys-based
// adapter doesn't expose native interactive buttons, so v1 just delivers
// a formatted text message with the task title, description, field
// summary, and a link to the web inbox.
//
// Approve/reject one-click URLs (the /t/:taskId/:action endpoint) are
// included inline when the form is approve/reject-shaped — the user taps
// the link, the browser opens, submission happens server-side.

interface SendingAdapter {
  send: (msg: { channel: string; chatId: string; text: string; parseMode?: "markdown" | "html" | "plain" }) => Promise<string | void>
}

export interface WhatsappRendererOptions {
  actors: ActorStore
  tasks: TaskStore
  adapter: SendingAdapter
  inboxBaseUrl?: string
  log?: (msg: string) => void
}

export function createWhatsappTaskRenderer(opts: WhatsappRendererOptions) {
  const log = opts.log ?? (() => {})
  return async function render(task: UserTaskRecord): Promise<void> {
    const baseUrl = opts.inboxBaseUrl ?? ""
    const oneClick = canOneClickSubmit(task)
    for (const actorId of task.assignedTo) {
      const handle = opts.actors.channelFor(actorId, "whatsapp")
      if (!handle) continue
      const text = buildText(task, actorId, baseUrl, oneClick)
      try {
        const messageId = await opts.adapter.send({
          channel: "whatsapp",
          chatId: handle,
          text,
          parseMode: "plain",
        })
        const delivered = [
          ...(task.delivered ?? []),
          {
            channel: "whatsapp",
            handle,
            messageId: typeof messageId === "string" ? messageId : undefined,
            at: new Date().toISOString(),
          },
        ]
        opts.tasks.save({ ...task, delivered })
      } catch (e: any) {
        log(`[task:${task.id}] whatsapp delivery to ${actorId}@${handle} failed: ${e?.message ?? e}`)
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
  lines.push(`📋 ${task.title}`)
  if (task.description) { lines.push(""); lines.push(task.description) }
  if (task.form.fields?.length && !oneClick) {
    lines.push("", "Fields:")
    for (const f of task.form.fields) {
      lines.push(`• ${f.label}${f.required ? " (required)" : ""}`)
    }
  }
  if (task.dueAt) lines.push("", `⏰ Due: ${new Date(task.dueAt).toLocaleString()}`)
  if (oneClick) {
    lines.push(
      "",
      `✓ ${task.form.submitLabel || "Approve"}: ${baseUrl}/t/${encodeURIComponent(task.id)}/primary?actor=${encodeURIComponent(actorId)}`,
    )
    if (task.form.secondaryAction) {
      lines.push(
        `✗ ${task.form.secondaryAction.label}: ${baseUrl}/t/${encodeURIComponent(task.id)}/secondary?actor=${encodeURIComponent(actorId)}`,
      )
    }
  } else {
    lines.push("", `Open form: ${baseUrl}/inbox?actor=${encodeURIComponent(actorId)}`)
  }
  return lines.join("\n")
}
