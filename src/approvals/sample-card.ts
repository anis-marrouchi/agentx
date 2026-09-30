import type { DecisionCard } from "./cards"

// --- A sample card, to see the Mac card without raising one ---
//
// `agentx approvals popup --sample` shows it; nothing is recorded. It is
// the case the card was designed on: a client asks for a new meeting date,
// the agent offers three free slots and drafts the reply in his language.

export function sampleCard(now: number = Date.now()): DecisionCard {
  return {
    id: "sample",
    title: "New meeting date for Abdullah (Muqtana)",
    context: "He wrote on WhatsApp: “No problem, pick the time that suits you and tell me.” Fahd's note on the metal-only product and the notes field is with the team.",
    ask: "Which date should I offer him?",
    recommend: "Thursday: your calendar is free and it is before his weekend",
    choices: ["Thu 1 Oct · 12:00 Tunis / 14:00 Riyadh", "Sun 4 Oct · 11:00 Tunis / 13:00 Riyadh", "Mon 5 Oct · 14:00 Tunis / 16:00 Riyadh"],
    draft: "الله يسلمك أخي عبدالله ويجزاك خير. أقترح أن يكون الاجتماع يوم {choice}، إذا كان يناسبك. وبخصوص ملاحظة الأخ فهد عن منتج المعدن فقط وخانة الملاحظات، وصلتنا والفريق يعمل عليها إن شاء الله.",
    say: "Abdullah is waiting for a new meeting date. Pick one.",
    if_silent: "keep",
    expires: new Date(now + 2 * 86_400_000).toISOString(),
    raised_by: "secretary-agent",
    created_at: new Date(now - 12 * 60_000).toISOString(),
    status: "pending",
    origin: { kind: "reminder", id: "sample", title: "Reply to Abdullah about the meeting" },
  }
}
