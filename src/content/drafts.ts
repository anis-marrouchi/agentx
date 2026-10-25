import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { setCalendarStatus } from "./calendar"
import { missingSamples } from "./voice"

// --- Content drafts waiting for the owner ---
//
// The agent never publishes. Its post is saved here and listed in the
// Approvals inbox as `content:<id>`. Only the owner's yes (CLI or
// dashboard, see approvals/inbox.ts) publishes it: through the agent's
// LinkedIn or X connector when one is set, else as a ready-to-paste file
// (publish.ts).
//
// Every draft names the voice samples it followed (voice.ts): a draft that
// names none, or a file that is not in voice/, is refused.
//
// One JSON file per draft under .agentx/content/drafts/, because the CLI,
// the dashboard and the daemon are separate processes. Deciding first
// renames the file away, so two clicks on "yes" publish once.

export const CONTENT_PLATFORMS = ["linkedin", "x"] as const
export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number]

export const PLATFORM_LABEL: Record<ContentPlatform, string> = { linkedin: "LinkedIn", x: "X" }

/** Longest post each platform takes. */
export const PLATFORM_MAX: Record<ContentPlatform, number> = { linkedin: 3000, x: 280 }

export const MAX_SAMPLES_NAMED = 10

export type ContentDraftStatus = "pending" | "posted" | "ready" | "rejected" | "failed"

export interface ContentDraft {
  id: string
  status: ContentDraftStatus
  created_at: string
  agent: string
  platform: ContentPlatform
  text: string
  /** Files in voice/ the draft follows. */
  samples: string[]
  topic?: string
  /** The calendar date it is planned for (YYYY-MM-DD). */
  date?: string
  /** The agent's workspace: where its samples, calendar and ready files live. */
  workspace: string
  decided_by?: string
  decided_at?: string
  /** Posted: the post's address, when the platform gave one. */
  url?: string
  /** Ready, or failed: the ready-to-paste file. */
  file?: string
  error?: string
}

export type PublishResult =
  | { ok: true; posted: true; url?: string }
  | { ok: true; posted: false; file: string }
  | { ok: false; error: string; file?: string }

export type PublishContent = (draft: ContentDraft) => Promise<PublishResult>

export function contentDraftsDir(root: string): string {
  return resolve(root, ".agentx", "content", "drafts")
}

export const isValidContentDraftId = (id: string): boolean => /^[a-z0-9-]{8,64}$/.test(id)
const fileFor = (root: string, id: string): string => resolve(contentDraftsDir(root), `${id}.json`)

function save(root: string, draft: ContentDraft): void {
  mkdirSync(contentDraftsDir(root), { recursive: true })
  const path = fileFor(root, draft.id)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(draft, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

export interface ContentDraftInput {
  agent: string
  workspace: string
  platform: unknown
  text: unknown
  samples: unknown
  topic?: unknown
  date?: unknown
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/** A short fingerprint of a post's text. The Approvals page sends back the
 *  one it showed, so a yes never publishes text the owner did not see. */
export function contentTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Check and save a new draft. Every refusal says what to fix. */
export function createContentDraft(
  root: string,
  input: ContentDraftInput,
  now = Date.now(),
): { ok: true; draft: ContentDraft } | { ok: false; error: string } {
  const platform = str(input.platform).toLowerCase() as ContentPlatform
  if (!CONTENT_PLATFORMS.includes(platform)) return { ok: false, error: `platform must be one of: ${CONTENT_PLATFORMS.join(", ")}` }
  const text = str(input.text)
  if (!text) return { ok: false, error: "text is empty: give the whole post" }
  if (text.length > PLATFORM_MAX[platform]) {
    return { ok: false, error: `the post is ${text.length} characters; ${PLATFORM_LABEL[platform]} takes ${PLATFORM_MAX[platform]} at most` }
  }
  const samples = Array.isArray(input.samples)
    ? Array.from(new Set(input.samples.map(str).filter(Boolean)))
    : str(input.samples).split(",").map((s) => s.trim()).filter(Boolean)
  if (samples.length === 0) {
    return { ok: false, error: "samples is empty: name the files in voice/ this draft follows (add the owner's past posts there first)" }
  }
  if (samples.length > MAX_SAMPLES_NAMED) return { ok: false, error: `name ${MAX_SAMPLES_NAMED} samples at most` }
  const missing = missingSamples(input.workspace, samples)
  if (missing.length) return { ok: false, error: `not in voice/: ${missing.join(", ")}` }
  const date = str(input.date)
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "date must look like 2026-11-02" }
  const topic = str(input.topic).slice(0, 200)

  const draft: ContentDraft = {
    id: `${now.toString(36)}-${randomBytes(4).toString("hex")}`,
    status: "pending",
    created_at: new Date(now).toISOString(),
    agent: input.agent,
    platform,
    text,
    samples,
    ...(topic ? { topic } : {}),
    ...(date ? { date } : {}),
    workspace: input.workspace,
  }
  save(root, draft)
  if (date) setCalendarStatus(input.workspace, date, platform, "drafted")
  return { ok: true, draft }
}

export function readContentDraft(root: string, id: string): ContentDraft | null {
  if (!isValidContentDraftId(id)) return null
  try { return JSON.parse(readFileSync(fileFor(root, id), "utf-8")) as ContentDraft } catch { return null }
}

export function listContentDrafts(root: string, status?: ContentDraftStatus): ContentDraft[] {
  const dir = contentDraftsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readContentDraft(root, f.slice(0, -5)))
    .filter((d): d is ContentDraft => !!d && (!status || d.status === status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * The owner's answer. Yes publishes the draft (as edited with `text`, when
 * given), no drops it. With `seen` (the contentTextHash of the text the
 * owner was shown), a yes is refused when the draft changed since.
 * Operator surfaces only: never reachable by an agent.
 */
export async function decideContentDraft(
  root: string,
  id: string,
  verdict: "yes" | "no",
  opts: { by?: string; now?: number; text?: string; seen?: string; publish: PublishContent },
): Promise<{ ok: true; draft: ContentDraft } | { ok: false; error: string }> {
  const draft = readContentDraft(root, id)
  if (!draft || draft.status !== "pending") return { ok: false, error: `no content draft "${id}" is waiting` }
  if (verdict === "yes" && opts.seen !== undefined && opts.seen !== contentTextHash(draft.text)) {
    return { ok: false, error: `content draft "${id}" changed since it was shown: reload and read it again before saying yes` }
  }
  const edited = opts.text?.trim()
  if (verdict === "yes" && edited !== undefined) {
    if (!edited) return { ok: false, error: "the edited post is empty" }
    if (edited.length > PLATFORM_MAX[draft.platform]) {
      return { ok: false, error: `the edited post is ${edited.length} characters; ${PLATFORM_LABEL[draft.platform]} takes ${PLATFORM_MAX[draft.platform]} at most` }
    }
  }
  // Claim it: only one caller's rename succeeds.
  const claim = `${fileFor(root, id)}.${process.pid}.${randomBytes(3).toString("hex")}.claim`
  try { renameSync(fileFor(root, id), claim) } catch {
    return { ok: false, error: `content draft "${id}" is already being decided` }
  }
  const decided: ContentDraft = {
    ...draft,
    ...(verdict === "yes" && edited ? { text: edited } : {}),
    decided_by: opts.by ?? "operator",
    decided_at: new Date(opts.now ?? Date.now()).toISOString(),
  }
  if (verdict === "no") {
    decided.status = "rejected"
  } else {
    const r = await opts.publish(decided).catch((e: any): PublishResult => ({ ok: false, error: String(e?.message ?? e) }))
    if (r.ok && r.posted) { decided.status = "posted"; if (r.url) decided.url = r.url }
    else if (r.ok) { decided.status = "ready"; decided.file = r.file }
    else { decided.status = "failed"; decided.error = r.error; if (r.file) decided.file = r.file }
  }
  save(root, decided)
  try { unlinkSync(claim) } catch { /* already gone */ }
  if (decided.date) {
    const status = decided.status === "posted" ? "posted" : decided.status === "rejected" ? "skipped" : "ready"
    setCalendarStatus(decided.workspace, decided.date, decided.platform, status)
  }
  return decided.status === "failed" ? { ok: false, error: decided.error ?? "publish failed" } : { ok: true, draft: decided }
}
