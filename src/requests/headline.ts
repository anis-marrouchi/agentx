import { extractJson } from "@/utils/extract-json"
import { HEADLINE_MAX, NEED_MAX, type RequestRecord, type RequestStore } from "./store"
import { plain } from "./card-view"

// --- A headline for a request its agent did not describe (#1126) ---
//
// Every request carries a headline (what it is) and a need line (what is
// needed from the owner). The agent sets them with agentx_request. When it
// did not, the daemon writes them once, with one small model call through
// the provider the intent classifier already uses: no new paid path. It
// runs beside the requests check, never inside it, a few requests a
// minute. Each request is tried once, whatever comes of it; a request with
// no headline keeps the start of the owner's words as its title.
// Off with requests.headlines.enabled = false.

/** The owner's words given to the model: enough to say what it is. */
export const PROMPT_TEXT_MAX = 1500
/** Requests described per pass: one pass a minute. */
export const HEADLINES_PER_PASS = 3

export const NEED_FYI = "Nothing, just so you know"

export interface Description { headline: string; need: string }

/** Turns the prompt into the model's answer, as text. */
export type HeadlineModel = (system: string, prompt: string) => Promise<string>

export const HEADLINE_SYSTEM =
  "You title requests for a busy person who reads them at a glance or hears them read aloud. " +
  "Respond with a single JSON object on one line: {\"headline\": \"...\", \"need\": \"...\"}. No prose, no code fences."

export function headlinePrompt(r: RequestRecord): string {
  const words = plain(r.text)
  const said = words.length > PROMPT_TEXT_MAX ? `${words.slice(0, PROMPT_TEXT_MAX)}…` : words
  return [
    `headline: what this request is, in 3 to 10 plain words, at most ${HEADLINE_MAX} characters. No ids, links or issue numbers.`,
    `need: what is needed from the owner now, in one short sentence, at most ${NEED_MAX} characters. ` +
      `If the agent can do it without them, write "${NEED_FYI}".`,
    "Write both in the language of the request.",
    "",
    `State: ${r.state.replace(/_/g, " ")}${r.question ? `. The agent asked: ${r.question}` : ""}${r.attentionReason ? `. ${r.attentionReason}` : ""}`,
    r.promise ? `The agent ${r.agentId} promised ${r.owedTo ?? "someone"}:` : `The owner asked ${r.agentId}:`,
    said,
  ].join("\n")
}

/** The model's answer as a description, or null when it is not one. */
export function parseModelDescription(raw: string): Description | null {
  const obj = extractJson(raw) as any
  if (!obj || typeof obj !== "object") return null
  const one = (v: unknown, max: number) => {
    if (typeof v !== "string") return ""
    const t = v.replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "")
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
  }
  const headline = one(obj.headline, HEADLINE_MAX)
  if (!headline) return null
  return { headline, need: one(obj.need, NEED_MAX) || NEED_FYI }
}

/** Describe up to `limit` open requests that have no headline. Returns
 *  how many got one. Never throws: a failed call leaves the title as it
 *  was, and the request is not tried again. */
export async function writeMissingHeadlines(
  store: Pick<RequestStore, "needingHeadline" | "markHeadlineTried" | "describe">,
  model: HeadlineModel,
  opts: { now?: number; limit?: number; log?: (msg: string) => void } = {},
): Promise<number> {
  const now = opts.now ?? Date.now()
  let written = 0
  for (const r of store.needingHeadline(opts.limit ?? HEADLINES_PER_PASS)) {
    // Marked first: a call that hangs or fails is not made twice.
    store.markHeadlineTried(r.id, now)
    try {
      const d = parseModelDescription(await model(HEADLINE_SYSTEM, headlinePrompt(r)))
      if (!d) { opts.log?.(`[requests] ${r.id}: no headline in the model's answer`); continue }
      if (store.describe(r.id, d, "daemon")) written++
    } catch (e: any) {
      opts.log?.(`[requests] ${r.id}: headline failed: ${e?.message ?? e}`)
    }
  }
  return written
}

/** The model the intent classifier uses, through the provider the
 *  operator already configured (createProvider's default: the stored
 *  login, Claude subscription or API key). 30 s at most: a headline is
 *  metadata, not work. */
export function providerHeadlineModel(model: string): HeadlineModel {
  let provider: import("@/agent/providers").AgentProvider | undefined
  return async (system, prompt) => {
    if (!provider) {
      const { createProvider } = await import("@/agent/providers")
      provider = createProvider("claude-code")
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30_000)
    try {
      const res = await provider.generate(
        [{ role: "system", content: system }, { role: "user", content: prompt }],
        { model, maxTokens: 200, abortSignal: ac.signal, bare: true },
      )
      return res.content || ""
    } finally {
      clearTimeout(timer)
    }
  }
}
