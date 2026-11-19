import { z } from "zod"
import type { BuiltinAction } from "@/actions/builtin/types"
import { LEARN_WORKFLOW, learnCardStep, learnDraftStep, type LearnDeps } from "./learn"

// --- The steps of the `situation-learn` workflow (#1892 phase 8, #1990) ---
//
//   situation.learn.draft    starts the week (closes last week's card,
//                            drops its unanswered drafts, retires unused
//                            templates, pauses after two unanswered
//                            cards), then drafts templates from ended
//                            talks within the cost caps (learn.ts)
//   situation.learn.card     one owner-only card with the week's drafts,
//                            or a notice when there is no card to say
//                            something on
//
// Neither takes an input: what is drafted, what the card holds and the
// owner's answer never come from the workflow file or from a caller.
// Built-ins can also be called over /api/actions/builtin by an agent on
// this machine; that is refused, and so is a step of any other workflow
// (onlyIn). A workflow edited to call them more changes nothing: a week
// starts once in 6.5 days and there is one card a week.

let deps: LearnDeps | null = null

/** Attach the stores, the drafting call and the card files (daemon start). Null detaches. */
export function setSituationLearnDeps(d: LearnDeps | null): void {
  deps = d
}

const noInput = z.object({}).passthrough()
type NoInput = z.infer<typeof noInput>

const draftOutput = z.object({
  ran: z.boolean(),
  why: z.string().optional(),
  drafted: z.array(z.string()),
  skipped: z.array(z.string()),
  dropped: z.array(z.string()),
  retired: z.array(z.string()),
  spentUsd: z.number(),
})
type DraftOutput = z.infer<typeof draftOutput>

export const situationLearnDraft: BuiltinAction<NoInput, DraftOutput> = {
  name: "situation.learn.draft",
  description: "The weekly learned-templates run's first step: close last week's card (unanswered drafts are dropped), retire templates unused for 8 weeks, pause after two unanswered cards, then draft templates from ended talks (redacted), within situations.learned.maxRunUsd and improve.dailyUsd. Once a week.",
  inputSchema: noInput,
  outputSchema: draftOutput,
  timeoutMs: 240_000,
  onlyIn: [LEARN_WORKFLOW],
  handler: async () => {
    if (!deps) return { ran: false, why: "learned templates are not available on this node", drafted: [], skipped: [], dropped: [], retired: [], spentUsd: 0 }
    return learnDraftStep(deps)
  },
}

const cardOutput = z.object({
  card: z.string().optional(),
  drafts: z.array(z.string()),
  stopped: z.string().optional(),
  notice: z.string().optional(),
})
type CardOutput = z.infer<typeof cardOutput>

export const situationLearnCard: BuiltinAction<NoInput, CardOutput> = {
  name: "situation.learn.card",
  description: "The weekly learned-templates run's second step: one owner-only decision card with this week's drafts (none when nothing is new). Only the owner's answer, in the popup or with agentx situation learned answer, approves a draft.",
  inputSchema: noInput,
  outputSchema: cardOutput,
  timeoutMs: 60_000,
  onlyIn: [LEARN_WORKFLOW],
  handler: async () => {
    if (!deps) return { drafts: [], stopped: "learned templates are not available on this node" }
    return learnCardStep(deps)
  },
}
