import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { WacliSettings } from "./config"
import type { TriageClass } from "./store"
import { sendText } from "./wacli"

// --- Draft WhatsApp replies waiting for the owner ---
//
// The agent never sends to a watched contact. Its draft is saved here and
// listed in the Approvals inbox as `whatsapp:<id>`. Only the owner's yes
// (CLI or dashboard, see approvals/inbox.ts) sends it through wacli.
//
// One JSON file per draft under .agentx/whatsapp-triage/drafts/, because
// the CLI, the dashboard and the daemon are separate processes. Deciding
// first renames the file away, so two clicks on "yes" send once.

export type DraftStatus = "pending" | "sent" | "rejected" | "failed"

export interface ReplyDraft {
  id: string
  status: DraftStatus
  created_at: string
  agent: string
  rule_id: string
  /** The chat the reply goes to. */
  to: string
  chat_name?: string
  text: string
  triage: TriageClass
  summary: string
  wacli: WacliSettings
  decided_by?: string
  decided_at?: string
  error?: string
}

export type SendReply = (draft: ReplyDraft) => Promise<{ ok: true } | { ok: false; error: string }>

export const DRAFT_MAX = 2000

export const sendWithWacli: SendReply = (d) => sendText(d.wacli, d.to, d.text)

export function draftsDir(root: string): string {
  return resolve(root, ".agentx", "whatsapp-triage", "drafts")
}

const validId = (id: string): boolean => /^[a-z0-9-]{8,64}$/.test(id)
const fileFor = (root: string, id: string): string => resolve(draftsDir(root), `${id}.json`)

function save(root: string, draft: ReplyDraft): void {
  mkdirSync(draftsDir(root), { recursive: true })
  const path = fileFor(root, draft.id)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(draft, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

export function createDraft(
  root: string,
  input: Omit<ReplyDraft, "id" | "status" | "created_at">,
  now = Date.now(),
): ReplyDraft {
  const text = input.text.trim().slice(0, DRAFT_MAX)
  if (!text) throw new Error("empty draft")
  const draft: ReplyDraft = {
    ...input,
    text,
    id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
    status: "pending",
    created_at: new Date(now).toISOString(),
  }
  save(root, draft)
  return draft
}

export function readDraft(root: string, id: string): ReplyDraft | null {
  if (!validId(id)) return null
  try { return JSON.parse(readFileSync(fileFor(root, id), "utf-8")) as ReplyDraft } catch { return null }
}

export function listDrafts(root: string, status?: DraftStatus): ReplyDraft[] {
  const dir = draftsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readDraft(root, f.slice(0, -5)))
    .filter((d): d is ReplyDraft => !!d && (!status || d.status === status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * The owner's answer. Yes sends the draft through wacli, no drops it.
 * Operator surfaces only: never reachable by an agent.
 */
export async function decideDraft(
  root: string,
  id: string,
  verdict: "yes" | "no",
  opts: { by?: string; now?: number; send?: SendReply } = {},
): Promise<{ ok: true; draft: ReplyDraft } | { ok: false; error: string }> {
  const draft = readDraft(root, id)
  if (!draft || draft.status !== "pending") return { ok: false, error: `no reply draft "${id}" is waiting` }
  // Claim it: only one caller's rename succeeds.
  const claim = `${fileFor(root, id)}.${process.pid}.${randomBytes(3).toString("hex")}.claim`
  try { renameSync(fileFor(root, id), claim) } catch {
    return { ok: false, error: `reply draft "${id}" is already being decided` }
  }
  const decided: ReplyDraft = {
    ...draft,
    decided_by: opts.by ?? "operator",
    decided_at: new Date(opts.now ?? Date.now()).toISOString(),
  }
  if (verdict === "no") {
    decided.status = "rejected"
  } else {
    const r = await (opts.send ?? sendWithWacli)(draft).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }))
    if (r.ok) decided.status = "sent"
    else { decided.status = "failed"; decided.error = r.error }
  }
  save(root, decided)
  try { unlinkSync(claim) } catch { /* already gone */ }
  return decided.status === "failed" ? { ok: false, error: decided.error ?? "send failed" } : { ok: true, draft: decided }
}
