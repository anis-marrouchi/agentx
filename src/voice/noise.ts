// --- Transcripts with no words ---
//
// Speech to text writes what it heard when nobody spoke: "[background
// noise]", "(mumbling)". /ask drops such a transcript before any agent is
// woken (#614: each one cost a full agent turn to answer "I didn't catch
// that").

/** voice.noiseFilter.markers' default: what the transcribers wrote on the
 *  Mac in three days of voice turns, plus Whisper's own. */
export const NOISE_MARKERS = [
  "background noise", "noise", "mumbling", "babbling", "unintelligible",
  "inaudible", "muffled speech", "pause", "silence", "music",
  "outro jingle", "blank audio",
]

/** What the caller hears instead of an agent's answer. */
export const NOISE_REPLY = "I didn't catch that."

const key = (s: string) => s.toLowerCase().replace(/[_\s]+/g, " ").trim()

/**
 * True when a transcript holds no words: empty after trimming, or nothing
 * but bracketed markers from the list ("[background noise]", "(Mumbling)
 * [pause]"). A marker beside real speech is speech, and so is a short
 * answer such as "Yes".
 */
export function isNoiseTranscript(text: string, markers: string[] = NOISE_MARKERS): boolean {
  const known = new Set(markers.map(key))
  const rest = text.replace(/\[([^\][]*)\]|\(([^()]*)\)/g, (group, square, round) =>
    known.has(key(square ?? round)) ? "" : group)
  return !/[\p{L}\p{N}]/u.test(rest)
}
