import { labelsOf } from "./questions"
import type { AnyQuestion, Questions, StateValue } from "./types"

// Turning a question set into something a chat model can answer.
//
// The schema below asks for `probabilities` and nothing else. No `choice`,
// no `score`, no `confidence`, no `legend` — those are derived in
// ./normalize.ts. Two reasons, and the second is the important one:
//
//   1. If a model reports both an argmax and a distribution they can
//      disagree, and there is no principled way to pick a winner.
//   2. A confidence a model writes out is a number it chose, not a
//      property of its own uncertainty. Asking for one reproduces exactly
//      the signal that `graph.autoApproveConfidence` already defaults to
//      1.0 to avoid trusting.

export const TOOL_NAME = "answer_questions"

export const SYSTEM_PROMPT = [
  "You answer questions about a piece of state by reporting a probability distribution for each one.",
  "",
  "Rules:",
  "- Answer every question. Never add a question that was not asked.",
  "- For a yes/no question, report `noul`: the probability the answer is yes, between 0 and 1.",
  "- For every other question, report `probabilities`: one number per listed option, summing to 1.",
  "- Use only the exact option names given. Never invent one.",
  "- Spread the distribution when the state genuinely does not settle the question. A flat",
  "  distribution is a useful answer; a confident wrong one is not.",
  "- Output the structure only. No prose, no explanation, no code fences.",
].join("\n")

/** JSON Schema for the forced tool's `input` — one object per question,
 *  keyed by question name, with `additionalProperties: false` throughout so
 *  a provider with strict structured output rejects drift server-side. */
export function toolInputSchema(questions: Questions): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(questions)) {
    properties[name] = answerObjectSchema(question)
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["answers"],
    properties: {
      answers: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(questions),
        properties,
      },
    },
  }
}

function answerObjectSchema(question: AnyQuestion): Record<string, unknown> {
  if (question.type === "noul") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["noul"],
      properties: {
        noul: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Probability the answer is yes.",
        },
      },
    }
  }

  const labels = labelsOf(question)
  const properties: Record<string, unknown> = {}
  for (const label of labels) {
    properties[label] = { type: "number", minimum: 0, maximum: 1 }
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["probabilities"],
    properties: {
      probabilities: {
        type: "object",
        additionalProperties: false,
        required: labels,
        properties,
        description: "One probability per option. Must sum to 1.",
      },
    },
  }
}

export interface RenderedState {
  text: string
  truncated: boolean
}

/** Serialize state and clip it to the backend's budget. Truncation is
 *  reported rather than hidden, because a calibration report has to be able
 *  to exclude rows where the model never saw the whole input. */
export function renderState(state: StateValue, maxChars: number): RenderedState {
  const text = typeof state === "string" ? state : JSON.stringify(state, null, 2) ?? "null"
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n…[truncated: ${text.length - maxChars} more characters]`,
    truncated: true,
  }
}

/** The human-readable question block. Providers without strict structured
 *  output only get this, so it has to carry the full contract on its own. */
export function renderQuestions(questions: Questions): string {
  const blocks: string[] = []
  for (const [name, question] of Object.entries(questions)) {
    const lines: string[] = [`### ${name}`]
    if (question.instructions) lines.push(question.instructions)

    if (question.type === "noul") {
      lines.push("Type: yes/no. Report `noul` — the probability the answer is yes.")
      if (question.criteria?.true) lines.push(`- yes means: ${question.criteria.true}`)
      if (question.criteria?.false) lines.push(`- no means: ${question.criteria.false}`)
    } else if (question.type === "choice") {
      lines.push("Type: choice. Report `probabilities` over exactly these options:")
      for (const [label, description] of Object.entries(question.criteria)) {
        lines.push(description ? `- ${label}: ${description}` : `- ${label}`)
      }
    } else {
      lines.push("Type: score. Report `probabilities` over exactly these levels:")
      question.criteria.forEach((description, i) => {
        lines.push(`- "${i}": ${description}`)
      })
    }
    blocks.push(lines.join("\n"))
  }
  return blocks.join("\n\n")
}

/** The user turn. Used verbatim in tool mode and in text mode; text mode
 *  appends the shape instructions, since it has no schema to lean on. */
export function renderUserPrompt(
  state: StateValue,
  questions: Questions,
  maxChars: number,
): { text: string; truncated: boolean } {
  const rendered = renderState(state, maxChars)
  const text = [
    "## State",
    rendered.text,
    "",
    "## Questions",
    renderQuestions(questions),
  ].join("\n")
  return { text, truncated: rendered.truncated }
}

/** Appended in text mode only, where nothing enforces the shape. */
export function renderShapeInstructions(questions: Questions): string {
  const example: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      example[name] = { noul: 0.5 }
      continue
    }
    const probabilities: Record<string, number> = {}
    const labels = labelsOf(question)
    for (const label of labels) probabilities[label] = Number((1 / labels.length).toFixed(4))
    example[name] = { probabilities }
  }
  return [
    "",
    "## Output",
    "Reply with this JSON object and nothing else:",
    JSON.stringify({ answers: example }, null, 2),
  ].join("\n")
}
