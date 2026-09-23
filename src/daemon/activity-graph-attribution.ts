// --- Which project is a dispatch about? ---
//
// Most mesh-routed events arrive with `project = null`: the GitLab/GitHub
// channel forwards the forge path inside the chat id
// ("noqta/minbar:issue:152", "owner/repo:pull:16") and peers that relay a
// webhook as bare A2A only mention it in the message text
// ("[GitLab noqta/minbar MR !51 update]: …"). Without reading those, every
// dispatch lands on "unmapped". Kept separate from the snapshot builder so
// the fleet merger can re-attribute rows from peers running older code.

const FORGE_PATH = String.raw`[\w.-]+(?:/[\w.-]+)+`
const CHAT_ID_RE = new RegExp(`^(?:chat:)?(${FORGE_PATH}):(?:issue|issues|merge_request|mr|pull|pr)s?:\\d+`)
const PREVIEW_RE = new RegExp(`^\\[(?:GitLab|GitHub) (${FORGE_PATH}) `)

/** Forge project path from a chat id or subject, e.g.
 *  "chat:noqta/minbar:merge_request:51" → "noqta/minbar". */
export function projectFromChatId(chatId: string | null | undefined): string | null {
  if (!chatId) return null
  const m = chatId.match(CHAT_ID_RE)
  return m ? m[1] : null
}

/** Forge project path from a relayed webhook summary line. */
export function projectFromPreview(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.trimStart().match(PREVIEW_RE)
  return m ? m[1] : null
}

/** Best project guess for an event whose ledger row has no project:
 *  explicit forwarded context, then the chat id, then the message text. */
export function inferProject(raw: any, subject: string | null, preview: string): string | null {
  const ctx = raw && typeof raw === "object" ? raw.context : null
  if (ctx && typeof ctx.project === "string" && ctx.project.trim()) return ctx.project.trim()
  return (
    projectFromChatId(typeof ctx?.chatId === "string" ? ctx.chatId : null) ??
    projectFromChatId(subject) ??
    projectFromPreview(preview)
  )
}
