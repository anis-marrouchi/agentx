import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// Picking a UI control from an accessibility tree.
//
// Deliberately the same shape as wiki-rerank, because it is the same
// problem: a bounded candidate set, scored against one query, where the
// per-option probabilities ARE the ranking. That shape is the one this
// codebase has actually measured a decision model to be good at — the
// failures were on arithmetic and on questions with no stated boundary,
// neither of which this is.
//
// The companion Noul is what keeps it honest, and it is not optional. A
// Choice must return something: asked which of forty controls means "send
// the invoice" on a screen that has no such control, it will name one,
// with a confident-looking probability. `present` is the question that can
// say no, and the caller reads it FIRST.

export const UI_ELEMENT_SEAT = "ui-element"

/** Enough to identify a control, small enough that forty of them fit in
 *  one request. Position is deliberately excluded — a model should choose
 *  by meaning, and coordinates invite it to guess geometrically. */
export interface UICandidate {
  id: number
  role: string
  label: string
  value?: string | null
  enabled: boolean
}

export interface UIElementInput {
  /** What the user asked for, in their words. */
  request: string
  app: string
  window?: string | null
  candidates: UICandidate[]
}

export function uiElementState(input: UIElementInput): StateValue {
  return {
    request: input.request,
    app: input.app,
    window: input.window ?? null,
    controls: input.candidates.map((c) => ({
      id: String(c.id),
      role: humanRole(c.role),
      label: clip(c.label, 120),
      value: c.value ? clip(c.value, 80) : null,
      enabled: c.enabled,
    })),
  }
}

/** Built per call — the option set IS the candidate set. */
export function uiElementQuestions(candidates: UICandidate[]) {
  const criteria: Record<string, string> = {}
  for (const c of candidates) {
    const name = c.label || c.value || "(unlabelled)"
    criteria[String(c.id)] = `${humanRole(c.role)}: ${clip(name, 80)}`
  }
  return {
    target: choice(criteria, "Which control does the request refer to?"),
    present: noul(
      "The screen actually contains a control matching the request.",
      {
        true: "One of the listed controls is plainly the thing the request names, or is the obvious way to perform it.",
        false:
          "Nothing listed corresponds to the request — the right control is on another screen, behind a menu, not yet visible, or this application simply cannot do what was asked.",
      },
    ),
  }
}

export type UIElementAnswers = AnswersFor<ReturnType<typeof uiElementQuestions>>

export interface UISelection {
  id: number
  confidence: number
  /** P(the request corresponds to anything on screen at all). */
  present: number
  ranked: Array<{ id: number; score: number }>
}

export function toSelection(
  answers: UIElementAnswers,
  candidates: UICandidate[],
): UISelection {
  const target = answers.target as ChoiceAnswer
  const ranked = candidates
    .map((c) => ({ id: c.id, score: target.probabilities[String(c.id)] ?? 0 }))
    .sort((a, b) => b.score - a.score)
  return {
    id: Number(target.choice),
    confidence: target.confidence,
    present: (answers.present as NoulAnswer).noul,
    ranked,
  }
}

/** AXButton -> button. The raw role names are an implementation detail of
 *  the accessibility API and read as noise in a prompt. */
function humanRole(role: string): string {
  return role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) : flat
}
