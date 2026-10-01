import type { DecisionCard } from "./cards"

// --- A sample card, to see the Mac card without raising one ---
//
// `agentx approvals popup --sample` shows it; nothing is recorded. It is
// the case the card was designed on: someone asks for a new meeting date,
// the agent offers three free slots, says which one it would take, and
// drafts the reply.

export function sampleCard(now: number = Date.now()): DecisionCard {
  return {
    id: "sample",
    title: "New meeting date for Sam",
    context: "He wrote: “No problem, pick the time that suits you and tell me.”",
    ask: "Which date should I offer him?",
    recommend: "Thursday 14:00: your calendar is free and it is before his weekend",
    choices: ["Thursday 14:00", "Sunday 11:00", "Monday 16:00"],
    draft: "Thanks Sam. Could we meet on {choice}? If that doesn't suit you, tell me what does.",
    say: "Sam is waiting for a new meeting date. Pick one.",
    if_silent: "keep",
    expires: new Date(now + 2 * 86_400_000).toISOString(),
    raised_by: "assistant",
    created_at: new Date(now - 12 * 60_000).toISOString(),
    status: "pending",
    origin: { kind: "reminder", id: "sample", title: "Reply to Sam about the meeting" },
  }
}
