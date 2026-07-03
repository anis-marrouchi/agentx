// agentx chat — a distinct visual identity (not a Claude Code clone).
// One cyan-forward accent, a violet "working" state, green for the agent,
// and a consistent brand mark. Centralised so every surface stays cohesive.

export const theme = {
  /** Primary brand accent — user prompt, borders, highlights. */
  accent: "cyan" as const,
  /** The agent's voice. */
  agent: "green" as const,
  /** Active/working state (spinner, busy border). */
  working: "magenta" as const,
  /** Errors. */
  error: "red" as const,
  /** Secondary text. */
  muted: "gray" as const,
}

/** Brand mark shown in the header / welcome. */
export const BRAND = "◇ agentx"

/** Left gutter glyphs for message framing. */
export const GUTTER = "▌"
