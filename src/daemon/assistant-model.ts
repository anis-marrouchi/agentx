// --- The Hub composer's model picker (#2101 P7) ---
//
// The owner may run one message on another model than the agent's own.
// Only the engines whose CLI takes a short model name get choices; every
// other agent runs on its own model and the picker shows that model alone.
// The choice goes on the task as `model` (AgentTask.model), which the
// registry already honours: a named model that differs from the session's
// starts a new session on it (#2001, session-model.ts namedModelRotates).

/** The choices per engine, as the CLI names them. Empty: no choice. */
export const MODEL_CHOICES: Record<string, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
}

/** The choices for an agent on `tier`, in the order the picker shows them. */
export function modelChoices(tier: string | undefined): string[] {
  return MODEL_CHOICES[String(tier || "")] || []
}

/**
 * Checks the model a message asks for. No model, or an empty one: the
 * agent's own model. A model the engine does not offer is refused, so a
 * typo never reaches the CLI as a flag value.
 */
export function assistantModel(tier: string | undefined, asked: unknown): { model?: string; error?: string } {
  if (asked == null || asked === "") return {}
  if (typeof asked !== "string") return { error: "model must be a string" }
  const name = asked.trim().toLowerCase()
  if (!name) return {}
  const choices = modelChoices(tier)
  if (!choices.includes(name)) {
    return { error: choices.length
      ? `model "${asked}" is not offered for this agent (choose ${choices.join(", ")})`
      : "this agent runs on its own model only" }
  }
  return { model: name }
}
