import { z } from "zod"
import type { AnyQuestion, Questions } from "./types"

// Runtime validation of raw model output, DERIVED from the questions.
//
// Derived, not hand-written, because a hand-written schema is free to drift
// from the Jev wire format and drift is the one failure this whole module
// exists to prevent. There is exactly one definition of what an answer looks
// like, and both the static type (AnswerFor, in ./types.ts) and this runtime
// check come from it.
//
// These validate SHAPE, not content. `probabilities` values are `unknown`
// on purpose: a model that writes "0.7" instead of 0.7 is coerced by
// normalizeDistribution and flagged `repaired`, which is cheaper and more
// informative than burning a correction round on a cosmetic slip. What we
// do insist on is that the container is there and is an object — that is
// the failure that means "the model ignored the schema and wrote prose",
// and that one is worth a retry.

const noulSchema = z.object({
  noul: z.number(),
})

const distributionSchema = z.object({
  probabilities: z.record(z.string(), z.unknown()),
})

export function rawAnswerSchema(question: AnyQuestion): z.ZodType<unknown> {
  return question.type === "noul" ? noulSchema : distributionSchema
}

/** Every question must be answered. A backend that drops one has not done
 *  the job, and silently returning a partial map would leave the caller
 *  reading `undefined.choice`. */
export function rawAnswersSchema(questions: Questions): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {}
  for (const [name, question] of Object.entries(questions)) {
    shape[name] = rawAnswerSchema(question)
  }
  return z.object(shape)
}

/** Flatten a ZodError into the one-line-per-problem form we feed back to a
 *  model on a correction round. Mirrors the correction-round shape already
 *  used by src/procedures/mine/distill.ts. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      return `- ${path}: ${issue.message}`
    })
    .join("\n")
}
