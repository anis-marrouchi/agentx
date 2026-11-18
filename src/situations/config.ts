import { z } from "zod"

// --- situations: settings (#1892, phase 1: the courtesy-close gate) ---
//
//   situations:
//     mode: shadow            # off | shadow | active
//     courtesy:
//       onPerson: react       # drop | react | reply
//       reaction: "🙏"
//     backstop: { count: 6, windowMinutes: 10 }
//     maxAge: { duringHours: 12, endingMinutes: 60 }
//
// `shadow` (the default) keeps the record of each chat and writes every
// message the gate WOULD drop to the gate log, but drops nothing and sends
// nothing. `active` drops. `off` does neither.

export const situationsConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "active"]).default("shadow"),
  courtesy: z.object({
    /** A person (not a bot, not one of our agents) sends only "thanks"
     *  after the talk ended: `react` puts a reaction on it where the channel
     *  has reactions (no text, no run); `drop` does nothing; `reply` lets it
     *  through to the agent as before. */
    onPerson: z.enum(["drop", "react", "reply"]).default("react"),
    /** The reaction for `onPerson: react`. */
    reaction: z.string().min(1).max(16).default("🙏"),
  }).default({}),
  /** Blunt brake under the word list: at most `count` messages from bots or
   *  our own agents start a run on one chat per `windowMinutes`. Past it the
   *  chat's talk is ended as a "courtesy loop" and further bot messages are
   *  dropped until the window clears. */
  backstop: z.object({
    count: z.number().int().min(1).max(1000).default(6),
    windowMinutes: z.number().min(1).max(1440).default(10),
  }).default({}),
  /** How long a phase lasts with no message before the talk counts as
   *  ended ("stale"). Checked when the next message arrives. */
  maxAge: z.object({
    duringHours: z.number().min(0.25).max(24 * 30).default(12),
    endingMinutes: z.number().min(1).max(24 * 60).default(60),
  }).default({}),
}).default({})

export type SituationsConfig = z.infer<typeof situationsConfigSchema>

export const DEFAULT_SITUATIONS_CONFIG: SituationsConfig = situationsConfigSchema.parse(undefined)
