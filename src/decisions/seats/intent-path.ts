import { choice } from "../questions"
import { askSeat, getSeatMode } from "../seat"
import type { SeatMode } from "../store"
import type { ChoiceAnswer, StateValue } from "../types"
import type { GraphNode } from "@/graph/types"

// Which intent-graph path a message belongs to.
//
// The intent graph is a closed set: seven categories, a few hundred verbs,
// and in the last few thousand classifications the LLM classifier never
// proposed a node that did not already exist. Picking one label out of a
// known list is what a decision seat does in under a second for a fraction
// of a cent; asking a chat model to write the label out cost a fresh CLI
// process per task, twenty seconds of wall time on average.
//
// Two stages because Jev caps a Choice at 255 options and the largest
// category holds about a hundred verbs: first the category, then the verb
// within it. Each stage carries the LLM's answer as the incumbent while the
// seat runs in shadow, so `agentx decisions stats` reports agreement before
// the seat is allowed to decide.
//
// Fail-open, as every seat: a missing or unconfident answer means "no
// proposal", and the classifier falls back to the LLM it uses today. The
// seat can only ever reuse existing nodes; growing the taxonomy stays the
// LLM's job.

export const INTENT_PATH_SEAT = "intent-path"

/** Below these the seat's answer is not acted on. A Choice always returns
 *  an argmax, so the probability mass behind it is the only signal that
 *  the pick is a match rather than the least bad option. */
export const INTENT_PATH_MIN_CATEGORY_P = 0.5
export const INTENT_PATH_MIN_VERB_P = 0.3

export interface IntentPathInput {
  message: string
  channel?: string
  sender?: string
  agent?: string
}

export interface IntentPathProposal {
  /** `[category]` or `[category, verb]`, existing node ids only. */
  path: string[]
  /** min over the stages' argmax probability. */
  confidence: number
  /** Both stages cleared their thresholds; the caller may act on `path`. */
  confident: boolean
  mode: SeatMode
}

export function intentPathState(input: IntentPathInput): StateValue {
  return {
    message: clip(input.message, 2000),
    channel: input.channel ?? null,
    sender: input.sender ?? null,
    agent: input.agent ?? null,
  }
}

/** One Choice over the given nodes. The option text is the node's own
 *  description when it has one, so the seat reads what a reviewer reads. */
export function nodeChoice(nodes: GraphNode[], instructions: string) {
  const criteria: Record<string, string | null> = {}
  for (const n of nodes) criteria[n.id] = describe(n)
  return choice(criteria, instructions)
}

export function categoryQuestions(categories: GraphNode[]) {
  return {
    category: nodeChoice(
      categories,
      "Which category of work does this message ask for or report on? Pick the one a reviewer would file it under.",
    ),
  }
}

export function verbQuestions(verbs: GraphNode[]) {
  return {
    verb: nodeChoice(
      verbs,
      "Within that category, which specific action does the message ask for or report on? Prefer the most specific verb that fits; a casual or ambiguous message belongs to the most general one.",
    ),
  }
}

export interface ProposeViaSeatOptions {
  /** The LLM's path for the same message, recorded as the incumbent so the
   *  shadow report can measure agreement. */
  incumbent?: string[]
}

/**
 * Two-stage classification through the seat. Returns null when the seat is
 * off, unreachable or the taxonomy is too small to ask; otherwise a proposal
 * whose `confident` flag says whether the thresholds were met.
 */
export async function proposePathViaSeat(
  input: IntentPathInput,
  nodes: GraphNode[],
  opts: ProposeViaSeatOptions = {},
): Promise<IntentPathProposal | null> {
  if (getSeatMode(INTENT_PATH_SEAT) === "off") return null
  const categories = nodes.filter((n) => n.parentId === null)
  if (categories.length < 2) return null

  const state = intentPathState(input)
  const features = { agent: input.agent ?? "unknown", channel: input.channel ?? "unknown" }
  const links = input.agent ? [{ kind: "agent", id: input.agent }] : undefined

  const stage1 = await askSeat(INTENT_PATH_SEAT, state, categoryQuestions(categories), {
    incumbent: opts.incumbent?.[0] ? { category: opts.incumbent[0] } : undefined,
    features: { ...features, stage: "category" },
    links,
  })
  if (!stage1) return null
  const cat = stage1.answers.category as ChoiceAnswer
  let confidence = cat.pMax
  let confident = cat.pMax >= INTENT_PATH_MIN_CATEGORY_P
  const path = [cat.choice]

  const verbs = nodes.filter((n) => n.parentId === cat.choice)
  if (verbs.length >= 2) {
    const sameCategory = opts.incumbent?.[0] === cat.choice
    const stage2 = await askSeat(INTENT_PATH_SEAT, { ...(state as Record<string, StateValue>), category: cat.choice }, verbQuestions(verbs), {
      // The LLM's verb is only a fair incumbent when it lives in the same
      // category; otherwise it is not among the options at all.
      incumbent: sameCategory && opts.incumbent?.[1] ? { verb: opts.incumbent[1] } : undefined,
      features: { ...features, stage: "verb", category: cat.choice },
      links,
    })
    if (!stage2) return null
    const verb = stage2.answers.verb as ChoiceAnswer
    confidence = Math.min(confidence, verb.pMax)
    confident = confident && verb.pMax >= INTENT_PATH_MIN_VERB_P
    path.push(verb.choice)
  } else if (verbs.length === 1) {
    path.push(verbs[0].id)
  }

  return { path, confidence, confident, mode: stage1.mode }
}

function describe(n: GraphNode): string | null {
  const d = n.axes?.description?.trim() || undefined
  const rawName = n.axes?.name?.trim()
  // A name that merely repeats the id adds nothing the label does not say.
  const name = rawName && rawName !== n.id ? rawName : undefined
  if (d && name) return `${name}: ${d}`
  return d ?? name ?? null
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
