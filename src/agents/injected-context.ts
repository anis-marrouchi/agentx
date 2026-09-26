import type { InjectedContext } from "@/storage/traces"

// --- Injected lessons per task (#98) ---
//
// Which memory facts, procedures and wiki catalog actually reached the
// prompt. Candidates are not enough: the request-context selector can drop
// a whole layer, and the layer budgets in buildAgentContext can cut a layer
// short. So a lesson counts as injected only when its text is in the
// assembled context. Only ids are recorded, never content, and the lists
// are capped, so the trace row stays small.

export const MAX_INJECTED_IDS = 20
const MAX_ID_LENGTH = 80

export interface InjectionCandidates {
  memory?: Array<{ id: string; content: string }>
  procedures?: Array<{ id: string; title: string }>
  /** The wiki catalog block offered to the prompt, if any. */
  wikiContext?: string
}

/** The first line of the wiki catalog block; see buildWikiContext. */
const WIKI_MARKER = "[Institutional Wiki"

function capIds(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_INJECTED_IDS).map((id) => id.slice(0, MAX_ID_LENGTH))
}

export function injectedContextOf(assembled: string, candidates: InjectionCandidates): InjectedContext {
  const text = assembled ?? ""
  return {
    memory: capIds((candidates.memory ?? []).filter((m) => m.content && text.includes(m.content)).map((m) => m.id)),
    procedures: capIds(
      (candidates.procedures ?? []).filter((p) => text.includes(`[Known procedure: ${p.title}]`)).map((p) => p.id),
    ),
    wiki: Boolean(candidates.wikiContext) && text.includes(WIKI_MARKER),
  }
}

/** Clamp an InjectedContext from any source to the recorded bounds. */
export function boundInjectedContext(ctx: InjectedContext): InjectedContext {
  return { memory: capIds(ctx.memory), procedures: capIds(ctx.procedures), wiki: ctx.wiki === true }
}
