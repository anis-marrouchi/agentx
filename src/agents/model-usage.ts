// The Claude Code CLI's result carries `modelUsage`, keyed by model id, with
// one entry per model the run called. A multi-step run often has more than
// one: the CLI makes small side calls on a cheaper model (Haiku) next to the
// model the task asked for, and the side model can come first in the object.
// The billed model is the one the run spent the most on (#455).

/** The model in `modelUsage` with the highest `costUSD`, falling back to
 *  the most tokens when no cost is given. Undefined when there is none. */
export function primaryModelFromUsage(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined
  let best: string | undefined
  let bestCost = -1
  let bestTokens = -1
  for (const [model, raw] of Object.entries(modelUsage as Record<string, any>)) {
    const u = raw && typeof raw === "object" ? raw : {}
    const cost = typeof u.costUSD === "number" ? u.costUSD : 0
    const tokens = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
      + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0)
    if (cost > bestCost || (cost === bestCost && tokens > bestTokens)) {
      best = model
      bestCost = cost
      bestTokens = tokens
    }
  }
  return best
}
