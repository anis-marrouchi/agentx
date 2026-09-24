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

// --- Which issues / MRs is a dispatch about? ---

export interface ForgeRef { kind: "issue" | "mr"; n: number }

/** Forge path of a project id, or null for synthetic ids ("mtgl/_mesh"). */
export function forgePath(projectId: string): string | null {
  const [head, ...rest] = projectId.split("/")
  if (!rest.length || head === "unmapped" || rest[0].startsWith("_")) return null
  return projectId
}

export function refKey(projectId: string, r: ForgeRef): string {
  return `${projectId}${r.kind === "mr" ? "!" : "#"}${r.n}`
}

const SUBJECT_REF_RE = /\b(issue|merge_request|pull|MR|Issue)s?[:\s]+[#!]?(\d+)/
const HEADER_REF_RE = /^\[(?:GitLab|GitHub) \S+ (issue|merge_request|pull|MR|Issue)s? [#!]?(\d+)/i
const kindOf = (word: string): ForgeRef["kind"] => (/^issue/i.test(word) ? "issue" : "mr")

/** The one issue / MR / PR a dispatch is about: the subject first
 *  ("issue:152", "MR #51", "pull:16"), then only the leading header of a
 *  relayed webhook ("[GitLab ns/repo MR !51 update]") — a body can mention
 *  any number of unrelated MRs. */
export function primaryRef(d: { subject: string; inputPreview: string }): ForgeRef | null {
  const m = d.subject.match(SUBJECT_REF_RE) ?? d.inputPreview.trimStart().match(HEADER_REF_RE)
  return m ? { kind: kindOf(m[1]), n: Number(m[2]) } : null
}

/** MRs a hand-off names in its text ("review !445–!448"). Only for
 *  dispatches without a primary ref — those are about one thing. */
export function mentionedMrs(text: string, limit = 8): ForgeRef[] {
  const out: ForgeRef[] = []
  const seen = new Set<number>()
  for (const m of text.matchAll(/(?:^|[\s(,])!(\d{1,6})\b/g)) {
    const n = Number(m[1])
    if (seen.has(n)) continue
    seen.add(n)
    out.push({ kind: "mr", n })
    if (out.length >= limit) break
  }
  return out
}

/** Every ref a dispatch is about, primary first. Empty when the project
 *  has no forge path — a bare "!445" could belong to any repo. */
export function refsOf(d: { subject: string; inputPreview: string; projectId: string }): ForgeRef[] {
  if (!forgePath(d.projectId)) return []
  const primary = primaryRef(d)
  return primary ? [primary] : mentionedMrs(d.inputPreview)
}
