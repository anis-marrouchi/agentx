// --- In-band rich-message directive (`agentx:ui`) ---
//
// Agents emit rich messages (buttons, polls, media) by appending a fenced
// block to their reply:
//
//   ```agentx:ui
//   { "buttons": [{ "label": "Docs", "url": "https://…" }],
//     "poll": { "question": "Deploy now?", "options": ["Yes", "No"] } }
//   ```
//
// A render layer lifts the JSON into an OutgoingMessage's buttons/poll/media
// and strips the block from the visible text. Fail-safe by design: a missing
// or malformed block leaves the text untouched and yields no directive, so a
// half-written or invalid fence just renders as ordinary text.
//
// Phase 1 is non-interactive: buttons are URL-only. A `{ "action": … }` button
// (a tappable callback that re-invokes the agent) is parsed but skipped until
// the inbound callback_query plumbing lands (Phase 2).

export interface UiButton {
  label: string
  url: string
}

export interface UiPoll {
  question: string
  options: string[]
  multiple?: boolean
}

export interface UiMedia {
  type: "image" | "document" | "audio" | "video"
  url: string
  caption?: string
}

export interface UiDirective {
  buttons?: UiButton[]
  poll?: UiPoll
  media?: UiMedia
  /** Labels of `action` (callback) buttons dropped because Phase 2 isn't wired
   *  yet — surfaced so the caller can log them. */
  skippedActions?: string[]
}

/** The opening fence, matched case-insensitively at a line start. */
const FENCE_OPEN = /(^|\n)[ \t]*```[ \t]*agentx:ui[ \t]*\r?\n/i

/** A complete fenced block: ```agentx:ui\n<json>\n``` (capturing the JSON). */
const FENCE_FULL = /(^|\n)[ \t]*```[ \t]*agentx:ui[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\n|$)/gi

export interface ExtractResult {
  cleanText: string
  ui?: UiDirective
}

/**
 * Extract the LAST complete `agentx:ui` block from `text`, returning the text
 * with that block removed plus the parsed directive. Never throws: on no
 * block, invalid JSON, or an empty directive, returns the original text and no
 * `ui`.
 */
export function extractUiDirective(text: string): ExtractResult {
  if (!text || !text.includes("agentx:ui")) return { cleanText: text }

  // Find all complete blocks; the last one wins (agents sometimes narrate an
  // example fence earlier in the reply).
  const matches = [...text.matchAll(FENCE_FULL)]
  if (matches.length === 0) return { cleanText: text }
  const match = matches[matches.length - 1]
  const json = match[2]

  const ui = parseDirective(json)
  if (!ui) return { cleanText: text } // malformed → leave text intact

  // Remove exactly the matched block, preserving the leading newline group.
  const start = match.index ?? 0
  const leading = match[1] ?? ""
  const cleanText = (text.slice(0, start) + leading + text.slice(start + match[0].length)).trim()
  return { cleanText, ui }
}

/**
 * During streaming, hide a partial or complete directive so a half-written
 * fence never flashes as raw text. Cuts from the first `agentx:ui` opening
 * fence to the end of the string. Cheap and lossy-forward-only — the final
 * `extractUiDirective` does the authoritative parse.
 */
export function stripUiDirectiveForPreview(text: string): string {
  if (!text || !text.includes("agentx:ui")) return text
  const m = FENCE_OPEN.exec(text)
  if (!m) return text
  return text.slice(0, m.index).trimEnd()
}

/** Parse + validate the directive JSON. Returns null on any problem or when
 *  nothing renderable survives. */
function parseDirective(json: string): UiDirective | null {
  let raw: any
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null

  const ui: UiDirective = {}

  if (Array.isArray(raw.buttons)) {
    const buttons: UiButton[] = []
    const skippedActions: string[] = []
    for (const b of raw.buttons) {
      if (!b || typeof b.label !== "string") continue
      if (typeof b.url === "string" && /^https?:\/\//i.test(b.url)) {
        buttons.push({ label: b.label, url: b.url })
      } else if (b.action != null) {
        skippedActions.push(b.label) // Phase 2
      }
    }
    if (buttons.length) ui.buttons = buttons
    if (skippedActions.length) ui.skippedActions = skippedActions
  }

  if (raw.poll && typeof raw.poll === "object") {
    const q = raw.poll.question
    const opts = raw.poll.options
    if (typeof q === "string" && q.trim() && Array.isArray(opts) && opts.filter((o: unknown) => typeof o === "string").length >= 2) {
      ui.poll = {
        question: q,
        options: opts.filter((o: unknown) => typeof o === "string"),
        multiple: raw.poll.multiple === true,
      }
    }
  }

  if (raw.media && typeof raw.media === "object") {
    const { type, url, caption } = raw.media
    if (["image", "document", "audio", "video"].includes(type) && typeof url === "string" && url) {
      ui.media = { type, url, ...(typeof caption === "string" ? { caption } : {}) }
    }
  }

  // Nothing renderable (and no skipped actions worth reporting) → treat as
  // "no directive" so the block is left in the text rather than silently
  // vanishing.
  if (!ui.buttons && !ui.poll && !ui.media && !ui.skippedActions) return null
  return ui
}
