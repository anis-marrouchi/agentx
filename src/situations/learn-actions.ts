import { z } from "zod"
import type { BuiltinAction } from "@/actions/builtin/types"
import { LEARN_WORKFLOW, learnDraftStep, learnReviewStep, type LearnDeps } from "./learn"

// --- The steps of the `situation-learn` workflow (#1892 phase 8) ---
//
//   situation.learn.draft    drafts templates from ended talks, once a
//                            week, within the cost caps (learn.ts)
//   situation.learn.review   asks the approver about each new draft, once
//
// Neither takes an input: what is drafted, who approves and the verdict
// never come from the workflow file or from a caller. Built-ins can also
// be called over /api/actions/builtin by an agent on this machine; that
// is refused, and so is a step of any other workflow (onlyIn). A workflow
// edited to call them more changes nothing: the week's one drafting call is booked before
// it runs, and each draft is put to the approver once.

let deps: LearnDeps | null = null

/** Attach the stores and the two calls (daemon start). Null detaches. */
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
  spentUsd: z.number(),
})
type DraftOutput = z.infer<typeof draftOutput>

export const situationLearnDraft: BuiltinAction<NoInput, DraftOutput> = {
  name: "situation.learn.draft",
  description: "The weekly learned-templates run's first step: draft templates from ended talks (redacted), within situations.learned.maxRunUsd and improve.dailyUsd. Once a week.",
  inputSchema: noInput,
  outputSchema: draftOutput,
  timeoutMs: 240_000,
  onlyIn: [LEARN_WORKFLOW],
  handler: async () => {
    if (!deps) return { ran: false, why: "learned templates are not available on this node", drafted: [], skipped: [], spentUsd: 0 }
    return learnDraftStep(deps)
  },
}

const reviewOutput = z.object({
  reviewed: z.array(z.object({ id: z.string(), verdict: z.enum(["approve", "reject", "none"]), why: z.string() })),
  stopped: z.string().optional(),
  notice: z.string().optional(),
  spentUsd: z.number(),
})
type ReviewOutput = z.infer<typeof reviewOutput>

export const situationLearnReview: BuiltinAction<NoInput, ReviewOutput> = {
  name: "situation.learn.review",
  description: "The weekly learned-templates run's second step: the approver the owner named (agentx situation learned approver) says yes or no to each new draft, once, in a call the daemon makes with fixed rules.",
  inputSchema: noInput,
  outputSchema: reviewOutput,
  // One isolated review run per draft, at most situations.learned.maxDrafts.
  timeoutMs: 45 * 60_000,
  onlyIn: [LEARN_WORKFLOW],
  handler: async () => {
    if (!deps) return { reviewed: [], stopped: "learned templates are not available on this node", spentUsd: 0 }
    return learnReviewStep(deps)
  },
}
