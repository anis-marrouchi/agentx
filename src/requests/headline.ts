import { referenceOnlyTitle } from "@/approvals/screen-gate"
import type { RequestRecord, RequestStore } from "./store"

// --- What a request is, in a few words (#1126) ---
//
// A request's card used to be titled with the start of the owner's own
// words, most often a voice transcript. Read back on a phone, that says
// neither what the request is nor what it wants. Each request now carries
// a headline (a few words saying what it is) and a need (the one thing
// wanted from the owner, or nothing). The owner's words stay on the card,
// under "You said".
//
// The agent writes them with agentx_request. When it did not, the daemon
// writes the headline once with one small model call, through the
// provider the operator already set up. The need is not the model's to
// guess: it follows from where the request stands (cardWords in
// card-view.ts) unless the agent said it.

export const HEADLINE_MAX = 80
export const NEED_MAX = 160

const flat = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")

/** What an agent passed, checked: the fields it gave, or why they are refused. */
export function parseDescription(input: { headline?: unknown; need?: unknown }): { headline?: string; need?: string } | string {
  const out: { headline?: string; need?: string } = {}
  if (input.headline !== undefined && input.headline !== null && input.headline !== "") {
    const h = flat(input.headline)
    if (!h) return "headline must be text"
    if (h.length > HEADLINE_MAX) return `headline is longer than ${HEADLINE_MAX} characters: say what it is in a few words`
    const bare = referenceOnlyTitle(h)
    if (bare) return bare.replace(/^title/, "headline")
    out.headline = h
  }
  if (input.need !== undefined && input.need !== null && input.need !== "") {
    const n = flat(input.need)
    if (!n) return "need must be text"
    if (n.length > NEED_MAX) return `need is longer than ${NEED_MAX} characters: one thing, in one line`
    out.need = n
  }
  return out
}

/** The model's prompt. The request's words are data, fenced. */
export function headlinePrompt(r: Pick<RequestRecord, "text" | "agentId" | "state">): string {
  return [
    "Write a headline for a request a person gave an AI agent. It is the title of the card they see on their phone.",
    `- At most ${HEADLINE_MAX} characters, about 3 to 8 words. Say what the request is about, as a noun phrase or a short imperative.`,
    "- Use the request's own language. Plain words: no ids, links, issue numbers or quotes on their own.",
    "- Do not answer the request or add anything that is not in it.",
    "",
    "REQUEST:",
    "```",
    r.text.slice(0, 2000),
    "```",
    "",
    'Return ONE JSON object on one line, no prose, no fences: {"headline": string}',
  ].join("\n")
}

/** The headline in the model's answer, cut to fit, or null when it has none
 *  that may go on a screen. */
export function readHeadline(text: string): string | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch { return null }
  let h = flat(parsed?.headline).replace(/^["'“]+|["'”]+$/g, "")
  if (!h) return null
  if (h.length > HEADLINE_MAX) {
    const cut = h.slice(0, HEADLINE_MAX - 1)
    const space = cut.lastIndexOf(" ")
    h = `${(space > HEADLINE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  return referenceOnlyTitle(h) ? null : h
}

export interface HeadlineSettings {
  enabled: boolean
  timeoutSeconds: number
}

export const DEFAULT_HEADLINE_SETTINGS: HeadlineSettings = { enabled: true, timeoutSeconds: 30 }

export interface HeadlineWriterDeps {
  store: Pick<RequestStore, "get" | "setHeadline" | "withoutHeadline" | "markHeadlineTried">
  /** One model call: the prompt in, the model's text out. */
  generate: (prompt: string, signal: AbortSignal) => Promise<string>
  settings: () => HeadlineSettings
  log: (msg: string) => void
  now?: () => number
}

/** Writes the missing headlines, each request at most once: the attempt
 *  is kept on the request, so a model that cannot write one is not asked
 *  again every minute, nor after a restart. */
export class HeadlineWriter {
  private filling = false

  constructor(private deps: HeadlineWriterDeps) {}

  /** The request with a headline when one could be written; as it was otherwise. */
  async ensure(r: RequestRecord): Promise<RequestRecord> {
    const settings = this.deps.settings()
    if (r.headline || !settings.enabled || r.headlineTriedAt) return r
    // Marked first: a call that hangs or crashes the process is not repeated.
    this.deps.store.markHeadlineTried(r.id, (this.deps.now ?? Date.now)())
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), settings.timeoutSeconds * 1000)
    timer.unref?.()
    try {
      const headline = readHeadline(await this.deps.generate(headlinePrompt(r), ac.signal))
      if (!headline) {
        this.deps.log(`[requests] ${r.id}: the model wrote no usable headline`)
        return r
      }
      this.deps.store.setHeadline(r.id, { headline }, "model")
      return this.deps.store.get(r.id) ?? r
    } catch (e: any) {
      this.deps.log(`[requests] ${r.id}: headline not written: ${e?.message ?? e}`)
      return r
    } finally {
      clearTimeout(timer)
    }
  }

  /** Write up to `limit` missing headlines, newest request first. One
   *  pass at a time; returns how many were written. */
  async fill(limit = 5): Promise<number> {
    if (this.filling || !this.deps.settings().enabled) return 0
    this.filling = true
    let written = 0
    try {
      for (const r of this.deps.store.withoutHeadline(limit)) {
        if ((await this.ensure(r)).headline) written++
      }
    } finally {
      this.filling = false
    }
    return written
  }
}
