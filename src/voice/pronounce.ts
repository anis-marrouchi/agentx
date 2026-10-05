// --- How a word is said, without changing how it is written (#433) ---
//
// voice.pronunciations pairs a written word with what the voice should
// say instead ("Marrouchi" → "Ma-roo-shee"), and a person in `people` can
// carry how their name is said. The swap is made only on text on its way
// to a voice: the speaking queue, /ask's spoken `text`, and the phone's
// answer audio. Cards, transcripts and messages keep the written form.

import { detectLanguage, type Language } from "./language"

export interface Pronunciation {
  /** The word or words as written; matched whole, without case. */
  written: string
  /** What the voice says instead. */
  spoken: string
  /** Only lines in these languages; empty or unset: every line. */
  languages?: string[]
}

interface Rule { spoken: string; languages: Language[] | null; caseSensitive: boolean }

/** Letters and digits of any script: what a whole word may not touch. */
const WORD = "\\p{L}\\p{N}"

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const norm = (s: string) => s.trim().replace(/\s+/g, " ")
const langs = (l?: string[]): Language[] | null => {
  const out = (l ?? []).map((x) => x.toLowerCase().split(/[-_]/)[0]).filter((x): x is Language => x === "en" || x === "fr" || x === "ar")
  return out.length ? out : null
}

/**
 * Every pair that applies, from the setting and from people. A person's
 * `say` covers their full name; when it has as many words as the name,
 * each name word is covered too, but only where it is written with its
 * capital, so a first name that is also a word ("Will") is left alone
 * in the middle of a sentence. An explicit pair wins over a person's.
 */
export function pronunciationRules(
  pairs: Pronunciation[] = [],
  people: Array<{ name: string; say?: string }> = [],
): Map<string, Rule> {
  const rules = new Map<string, Rule>()
  const add = (written: string, spoken: string, rule: Omit<Rule, "spoken">) => {
    const w = norm(written), s = norm(spoken)
    if (!w || !s) return
    const key = rule.caseSensitive ? w : w.toLowerCase()
    if (!rules.has(key)) rules.set(key, { spoken: s, ...rule })
  }
  for (const p of pairs) add(p.written, p.spoken, { languages: langs(p.languages), caseSensitive: false })
  for (const p of people) {
    if (!p.say) continue
    add(p.name, p.say, { languages: null, caseSensitive: false })
    const written = norm(p.name).split(" "), spoken = norm(p.say).split(" ")
    if (written.length > 1 && written.length === spoken.length) {
      written.forEach((w, i) => { if (/^\p{Lu}/u.test(w)) add(w, spoken[i], { languages: null, caseSensitive: true }) })
    }
  }
  return rules
}

/** `text` as the voice should say it. No pairs: the text unchanged. */
export function pronounce(text: string, rules: Map<string, Rule>): string {
  if (!rules.size || !text) return text
  const lang = detectLanguage(text)
  const live = [...rules.entries()].filter(([, r]) => !r.languages || (lang !== null && r.languages.includes(lang)))
  if (!live.length) return text
  // Longest first, so "Anis Marrouchi" is taken whole before "Anis".
  // One pass: a spoken form is never read again as a written one.
  live.sort(([a], [b]) => b.length - a.length)
  const alt = live.map(([w]) => escape(w).replace(/ /g, "\\s+")).join("|")
  const re = new RegExp(`(?<![${WORD}])(?:${alt})(?![${WORD}])`, "giu")
  return text.replace(re, (m) => {
    const flat = m.replace(/\s+/g, " ")
    const exact = rules.get(flat)
    if (exact?.caseSensitive) return exact.spoken
    const any = rules.get(flat.toLowerCase())
    return any && !any.caseSensitive ? any.spoken : m
  })
}

/** A pronouncer for a config, rebuilt only when its pairs or people change. */
export function pronouncer(
  get: () => { pairs?: Pronunciation[]; people?: Array<{ name: string; say?: string }> },
): (text: string) => string {
  let pairs: unknown, people: unknown, rules = new Map<string, Rule>()
  return (text) => {
    const now = get()
    if (now.pairs !== pairs || now.people !== people) {
      pairs = now.pairs; people = now.people
      rules = pronunciationRules(now.pairs, now.people)
    }
    return pronounce(text, rules)
  }
}
