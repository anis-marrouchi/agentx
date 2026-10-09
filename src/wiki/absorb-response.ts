// Parsing and model choice for `agentx wiki absorb`.
//
// The reply used to be cut out with a brace counter that also counted `{`
// and `}` inside JSON strings. An entry quoting `${` (a template literal)
// left the count unbalanced, the run printed "Unbalanced JSON", and those
// entries stayed queued for every later run. extractJson's scan skips
// string contents.

import { extractJson } from "@/utils/extract-json"

export interface AbsorbArticle {
  path: string
  title: string
  tags: string[]
  content: string
  sources: string[]
  type?: string
  related?: string[]
}

export type AbsorbResponse =
  /** `notes` is the model's raw answer to the wiki notes inbox (#831),
   *  read by parseNoteAnswers. */
  | { articles: AbsorbArticle[]; gaps: string[]; notes: unknown[] }
  | { error: string }

/** Read `{ articles, gaps }` (or a legacy bare array of articles) out of the
 *  model's reply. Returns `{error}` when nothing usable is found. */
export function parseAbsorbResponse(text: string): AbsorbResponse {
  const parsed = extractJson(text)
  if (parsed === null) {
    return { error: /[{[]/.test(text) ? "no parseable JSON in response" : "no JSON found in response" }
  }
  if (Array.isArray(parsed)) return { articles: parsed, gaps: [], notes: [] }
  if (typeof parsed !== "object") return { error: "response JSON is not an object or array" }
  return {
    articles: Array.isArray(parsed.articles) ? parsed.articles : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  }
}

/** The model absorb runs on: --model, else AGENTX_WIKI_ABSORB_MODEL, else
 *  sonnet. It goes into a shell command, so anything beyond a model name
 *  (letters, digits, `.`, `-`, `_`, `:`, `[`, `]`) is refused. */
export function absorbModel(model?: string): string {
  const chosen = model || process.env.AGENTX_WIKI_ABSORB_MODEL || "sonnet"
  if (!/^[\w.:\-[\]]+$/.test(chosen)) throw new Error(`not a model name: ${chosen}`)
  return chosen
}
