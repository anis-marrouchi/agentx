// What deserves to become a raw wiki entry.
//
// Until now the only gate was `response.content.length > 50`. Every agent
// task was captured, with the task's own message as the "User:" half — so
// a cron's prompt became an entry, a role brief became an entry, and a
// "[MISSED RUN]" notice became an entry.
//
// Measured over the 10,703 entries that produced: 30% arrived on a
// machine-origin channel, 33% are prompt-shaped, and 47.5% are one or
// both. That is the bulk of a corpus that has yielded 257 articles and is
// read about three times a quarter.
//
// These rules are deterministic and free. They are deliberately
// conservative — each one describes a shape that cannot contain knowledge
// about the world, rather than guessing at value. Judging whether the
// REMAINDER is worth keeping is a different question, and belongs to the
// entry-triage seat, which costs money and can be wrong.

/** Channels where both sides of the exchange are machines. A cron's
 *  prompt is configuration, and its reply is a status report. */
const MACHINE_CHANNELS = new Set(["cron", "a2a", "workflow", "selftest"])

/** Shapes that are an instruction to an agent, not a record of anything.
 *  Anchored at the start of the captured content, which always begins
 *  "User: " followed by the task message. */
const PROMPT_SHAPES: Array<[RegExp, string]> = [
  [/^User:\s*You are\s/i, "role brief"],
  [/^User:\s*(Run|Execute)\s/i, "run instruction"],
  [/^User:\s*\[MISSED RUN/i, "missed cron run"],
  // The bracketed prefix varies: some arrive as "[Group, 09:43]: [Recent
  // group conversation]". Anchoring on the bare marker missed 367 entries
  // in the first purge, so allow one leading bracketed segment.
  [/^User:\s*(\[[^\]]{0,40}\]:?\s*)?\[Recent group conversation\]/i, "group chat dump"],
]

export interface CaptureDecision {
  capture: boolean
  /** Why it was rejected, for logging and for counting what the filter
   *  actually removes once it is live. */
  reason?: string
}

export function shouldCaptureEntry(input: {
  channel: string | undefined
  content: string
  responseLength: number
}): CaptureDecision {
  if (input.responseLength <= 50) return { capture: false, reason: "response too short" }

  const channel = (input.channel ?? "").toLowerCase()
  // Channels carry a node suffix: "telegram@clawd-server".
  const base = channel.split("@")[0]
  if (MACHINE_CHANNELS.has(base)) return { capture: false, reason: `machine channel: ${base}` }

  const head = input.content.slice(0, 400)
  for (const [shape, reason] of PROMPT_SHAPES) {
    if (shape.test(head)) return { capture: false, reason }
  }

  return { capture: true }
}
