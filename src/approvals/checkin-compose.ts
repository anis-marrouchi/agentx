import type { Reminder } from "@/reminders/source"
import type { ReminderTrailer } from "@/reminders/trailer"
import type { CardInput } from "./cards"

// --- Asking the owning agent what a reminder's card should say ---
//
// At a check-in, each open reminder goes to the agent that owns it. The
// agent does the homework (free calendar slots, the thread it is about)
// and answers with one JSON object: the card, or that the reminder doesn't
// need the operator. The daemon validates it and raises the card on the
// agent's behalf (checkin.ts). The agent sends nothing at this stage.

/** A reminder card offers two to four options, or none (a plain yes/no). */
export const COMPOSE_MAX_CHOICES = 4

export type ComposeResult =
  | { kind: "card"; input: CardInput }
  | { kind: "skip"; why: string }
  | { kind: "error"; error: string }

export function composePrompt(r: Reminder, trailer: ReminderTrailer | null, nowText: string): string {
  const notes = trailer ? trailer.detail : (r.notes ?? "").trim()
  return [
    "[Check-in] The operator has an open reminder. Decide whether it needs them now. If it does, prepare a card they can answer in one click.",
    "",
    `Reminder: "${r.title}"`,
    r.listName ? `List: ${r.listName}` : "",
    `Due: ${r.dueDate ?? "no due date"} (now: ${nowText})`,
    notes ? `Notes: ${notes}` : "",
    trailer?.context ? `It came from: ${trailer.context}` : "",
    "",
    "Do the homework first: look at their calendar for free slots, read the thread it is about.",
    "Do not message anyone and do not act yet. Nothing goes out until they click.",
    "",
    "Reply with ONLY one JSON object, no other text. When it needs them:",
    '{"needs_operator": true, "title": "short, under 80 characters", "context": "what they need to know, a few lines",',
    ' "ask": "the question", "recommend": "your advice and why, one line",',
    ' "choices": ["2 to 4 short options, e.g. free slots or reply choices"],',
    ' "draft": "the message you would send; {choice} is replaced by their pick", "say": "one short spoken line",',
    ' "if_silent": "keep", "expires": "2d"}',
    "choices and draft are optional; leave choices out for a plain yes/no. Write the draft in the language of the person it goes to.",
    'When it does not need them (already done, not theirs, not time yet): {"needs_operator": false, "why": "one line"}',
    "",
    "When they answer you get their pick and the exact text. Then you do it, and tick the reminder off.",
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n")
}

/** The last {...} in the reply, fences and prose around it ignored. */
function lastObject(text: string): unknown {
  const end = text.lastIndexOf("}")
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* a nested brace; widen */ }
  }
  return undefined
}

export function parseCompose(reply: string | undefined): ComposeResult {
  const raw = reply ? lastObject(reply) : undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "error", error: "the reply has no JSON object" }
  const o = raw as Record<string, unknown>
  if (o.needs_operator === false) return { kind: "skip", why: typeof o.why === "string" ? o.why.slice(0, 200) : "" }
  if (o.needs_operator !== true) return { kind: "error", error: "needs_operator must be true or false" }
  if (Array.isArray(o.choices) && (o.choices.length === 1 || o.choices.length > COMPOSE_MAX_CHOICES)) {
    return { kind: "error", error: `a reminder card offers 2 to ${COMPOSE_MAX_CHOICES} choices, or none` }
  }
  return {
    kind: "card",
    input: {
      title: o.title, ask: o.ask, recommend: o.recommend, context: o.context,
      choices: o.choices, draft: o.draft, say: o.say,
      if_silent: o.if_silent ?? "keep", expires: o.expires,
    },
  }
}
