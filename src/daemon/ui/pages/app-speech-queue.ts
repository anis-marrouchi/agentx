// --- Phone app: the speaking queue (#265) ---
//
// With the speaker on, answers are read out one at a time in the order
// they finished: the one on screen and the ones from conversations in the
// background alike, so two voices never overlap. These two pure functions
// hold the rules; app.ts ships them to the page with injectFns, and
// app-voice.client.ts keeps the queue and plays it.

export interface SpeechItem {
  /** conversation id + answer time: the same answer is never queued twice. */
  key: string
  conversationId: string
  text: string
  /** "<agent name>" said first, for an answer from the background. */
  announce?: string
}

/** Answers waiting at most; beyond it the oldest waiting one is dropped. */
export const SPEECH_QUEUE_MAX = 5

/** Adds an answer at the end (finishing order). Returns the new queue and
 *  what was dropped to keep it within `cap`, oldest first. */
export function queueSpeech(queue: SpeechItem[], item: SpeechItem, cap: number = 5): { queue: SpeechItem[]; dropped: SpeechItem[] } {
  if (queue.some((q) => q.key === item.key)) return { queue: queue.slice(), dropped: [] }
  const next = queue.concat([item])
  const over = Math.max(0, next.length - Math.max(1, cap))
  return { queue: next.slice(over), dropped: next.slice(0, over) }
}

/** The next answer to say, only when nothing is being said or recorded. */
export function nextSpeech(queue: SpeechItem[], busy: boolean): { item: SpeechItem | null; queue: SpeechItem[] } {
  if (busy || !queue.length) return { item: null, queue: queue.slice() }
  return { item: queue[0], queue: queue.slice(1) }
}
