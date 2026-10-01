// --- Written answer to spoken answer ---
//
// Shared by the daemon's voice replies (/ask, talk, voice history) and the
// phone app's spoken answers (voice-io-api.ts). Moved out of index.ts
// unchanged, with the length cap as a parameter.

import { detectLanguage, type Language } from "./language"

/** voice.spokenMaxChars' default: about three short sentences, half a
 *  minute of speech. */
export const SPOKEN_MAX_CHARS = 500

/** Said after an answer cut for speech, so the listener knows to read on. */
const MORE: Record<Language, string> = {
  en: "The rest is on screen.",
  fr: "La suite est à l'écran.",
  ar: "الباقي على الشاشة.",
}

/**
 * Convert text to TTS-friendly speech.
 * Strips markdown, expands technical terms, removes code, handles symbols.
 */
export function toSpeakable(text: string, max = SPOKEN_MAX_CHARS): string {
  let s = text

  // Remove code blocks entirely (don't read code aloud)
  s = s.replace(/```[\s\S]*?```/g, ". ")
  s = s.replace(/`[^`]*`/g, "") // inline code

  // Remove markdown syntax characters
  s = s.replace(/\*\*(.*?)\*\*/g, "$1")   // bold
  s = s.replace(/__(.*?)__/g, "$1")       // bold
  s = s.replace(/\*([^*]+)\*/g, "$1")     // italic
  s = s.replace(/_([^_]+)_/g, "$1")       // italic
  s = s.replace(/~~(.*?)~~/g, "$1")       // strikethrough

  // Links: keep text, drop URL
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // Images: describe
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "image$1 ")

  // Headers: remove # markers
  s = s.replace(/^#{1,6}\s+/gm, "")

  // List bullets: convert to pauses
  s = s.replace(/^[\s]*[-*+]\s+/gm, ". ")
  s = s.replace(/^[\s]*\d+\.\s+/gm, ". ")

  // Horizontal rules
  s = s.replace(/^[-=_]{3,}$/gm, "")

  // Blockquotes
  s = s.replace(/^>\s*/gm, "")

  // URLs in plain text: replace with "link"
  s = s.replace(/https?:\/\/\S+/g, "link")

  // File paths: keep readable
  s = s.replace(/\/\w+(\/\w+)+/g, (match) => match.split("/").filter(Boolean).join(" slash "))

  // Technical symbols → words
  s = s.replace(/&/g, " and ")
  s = s.replace(/@/g, " at ")
  s = s.replace(/=>/g, " returns ")
  s = s.replace(/->/g, " to ")
  s = s.replace(/\|/g, " or ")

  // Common abbreviations
  s = s.replace(/\be\.g\./gi, "for example")
  s = s.replace(/\bi\.e\./gi, "that is")
  s = s.replace(/\betc\./gi, "etcetera")
  s = s.replace(/\bvs\.?\b/gi, "versus")

  // Collapse whitespace
  s = s.replace(/\n{2,}/g, ". ")
  s = s.replace(/\n/g, " ")
  s = s.replace(/\s+/g, " ")
  s = s.replace(/\.\s*\./g, ".")
  s = s.replace(/\s+([.,!?])/g, "$1")

  // Strip leading/trailing whitespace and punctuation
  s = s.trim().replace(/^[.,:;]+\s*/, "")

  // Cap for voice UX. A long answer ends on its last whole sentence inside
  // the cap, then says there is more; the written answer is shown whole.
  // Only a sentence longer than half the cap is cut between words.
  if (s.length > max) {
    const head = s.slice(0, max)
    const end = ([...s.slice(0, max + 1).matchAll(/[.!?؟](?=\s)/g)].at(-1)?.index ?? -1) + 1
    s = (end >= max / 2 ? head.slice(0, end) : head.replace(/\s+\S*$/, "") + "...") + " " + MORE[detectLanguage(head) ?? "en"]
  }

  return s
}
