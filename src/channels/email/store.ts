import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { ThreadState } from "./mail"

// --- Email state on disk (#1287) ---
//
// Under .agentx/email/: per account, the thread of each customer and the
// IMAP cursor; and the reply drafts waiting for the owner. Files, not the
// daemon's memory, because the CLI and the dashboard decide drafts in their
// own processes. Same claim-by-rename as WhatsApp drafts: two clicks on
// "yes" send once.

export function emailDir(root: string): string {
  return resolve(root, ".agentx", "email")
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T } catch { return null }
}

// ── Threads: customer address → where the next reply goes ────────────

const threadsFile = (root: string) => resolve(emailDir(root), "threads.json")

export function readThreads(root: string): Record<string, ThreadState> {
  return readJson<Record<string, ThreadState>>(threadsFile(root)) ?? {}
}

export function readThread(root: string, address: string): ThreadState | undefined {
  return readThreads(root)[address.toLowerCase()]
}

export function saveThread(root: string, thread: ThreadState): void {
  const all = readThreads(root)
  all[thread.to.toLowerCase()] = thread
  writeJson(threadsFile(root), all)
}

// ── IMAP cursor: only mail that arrives after connecting is answered ──

export interface MailCursor { uidValidity: string; lastUid: number }

const cursorFile = (root: string, account: string) => resolve(emailDir(root), "cursors", `${account}.json`)

export function readCursor(root: string, account: string): MailCursor | null {
  return readJson<MailCursor>(cursorFile(root, account))
}

export function saveCursor(root: string, account: string, cursor: MailCursor): void {
  writeJson(cursorFile(root, account), cursor)
}

// ── Reply drafts waiting for the owner ────────────────────────────────

export type EmailDraftStatus = "pending" | "sent" | "rejected"

export interface EmailDraft {
  id: string
  status: EmailDraftStatus
  created_at: string
  agent: string
  account: string
  to: string
  to_name?: string
  subject: string
  in_reply_to?: string
  references?: string
  text: string
  decided_by?: string
  decided_at?: string
  /** The text as sent, when the owner edited it. */
  edited?: boolean
  /** Why the last send failed; the draft stays pending. */
  error?: string
}

export const DRAFT_MAX = 20_000

const draftsDir = (root: string) => resolve(emailDir(root), "drafts")
const validId = (id: string) => /^[a-z0-9-]{8,64}$/.test(id)
const draftFile = (root: string, id: string) => resolve(draftsDir(root), `${id}.json`)

export function createEmailDraft(root: string, input: Omit<EmailDraft, "id" | "status" | "created_at">, now = Date.now()): EmailDraft {
  const text = input.text.trim().slice(0, DRAFT_MAX)
  if (!text) throw new Error("empty reply")
  const draft: EmailDraft = {
    ...input,
    text,
    id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
    status: "pending",
    created_at: new Date(now).toISOString(),
  }
  writeJson(draftFile(root, draft.id), draft)
  return draft
}

export function readEmailDraft(root: string, id: string): EmailDraft | null {
  return validId(id) ? readJson<EmailDraft>(draftFile(root, id)) : null
}

export function listEmailDrafts(root: string, status?: EmailDraftStatus): EmailDraft[] {
  const dir = draftsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readEmailDraft(root, f.slice(0, -5)))
    .filter((d): d is EmailDraft => !!d && (!status || d.status === status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export type SendEmailDraft = (draft: EmailDraft) => Promise<{ ok: true } | { ok: false; error: string }>

/**
 * The owner's answer: yes sends the reply (as edited, if `text` is given),
 * no drops it. Operator surfaces only: an agent never reaches this.
 */
export async function decideEmailDraft(
  root: string,
  id: string,
  verdict: "yes" | "no",
  opts: { by?: string; now?: number; text?: string; send: SendEmailDraft },
): Promise<{ ok: true; draft: EmailDraft } | { ok: false; error: string }> {
  const draft = readEmailDraft(root, id)
  if (!draft || draft.status !== "pending") return { ok: false, error: `no email reply "${id}" is waiting` }
  const claim = `${draftFile(root, id)}.${process.pid}.${randomBytes(3).toString("hex")}.claim`
  try { renameSync(draftFile(root, id), claim) } catch {
    return { ok: false, error: `email reply "${id}" is already being decided` }
  }
  const edited = opts.text !== undefined && opts.text.trim() !== "" && opts.text.trim() !== draft.text
  const decided: EmailDraft = {
    ...draft,
    ...(edited ? { text: opts.text!.trim().slice(0, DRAFT_MAX), edited: true } : {}),
    decided_by: opts.by ?? "operator",
    decided_at: new Date(opts.now ?? Date.now()).toISOString(),
  }
  if (verdict === "no") {
    decided.status = "rejected"
  } else {
    const r = await opts.send(decided).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }))
    if (!r.ok) {
      // Not sent: it stays waiting, with the reason, so a later yes retries.
      writeJson(draftFile(root, id), { ...draft, error: r.error })
      try { unlinkSync(claim) } catch { /* already gone */ }
      return { ok: false, error: `not sent: ${r.error}` }
    }
    decided.status = "sent"
    delete decided.error
  }
  writeJson(draftFile(root, id), decided)
  try { unlinkSync(claim) } catch { /* already gone */ }
  return { ok: true, draft: decided }
}
