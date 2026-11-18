// --- Is this message courtesy only? (#1892) ---
//
// Plain code, no model: a short message made only of closers ("thanks",
// "bye", "merci, bonne journée", "شكرا جزيلا، مع السلامة") and a few
// filler words around them. Three answers:
//
//   courtesy  only closers (and fillers, thanks-emoji): the gate may drop it
//   unsure    short, but not clearly courtesy ("ok", "👍", "thanks John"):
//             it passes, and it never reopens an ended talk
//   real      a question, media, a longer text, or new content: it passes,
//             and it reopens an ended talk
//
// "ok", "yes", "sure" and 👍 are never courtesy: they can be an answer to a
// question the agent asked, and dropping an approval is the one mistake the
// gate must not make. Unsure always means "let it through".

export type CourtesyClass = "courtesy" | "unsure" | "real"

const CORE = [
  // English
  "thanks", "thank you", "thank u", "thanks a lot", "many thanks", "thx", "ty", "tysm", "cheers",
  "bye", "bye bye", "goodbye", "good bye", "see you", "see ya", "see you soon", "see you later",
  "talk soon", "talk later", "take care", "have a nice day", "have a good day", "have a great day",
  "have a nice evening", "have a good evening", "have a good one", "have a nice weekend",
  "have a great weekend", "good night", "goodnight", "you're welcome", "you are welcome",
  "no problem", "no worries", "my pleasure", "anytime", "glad to help", "glad i could help",
  "happy to help", "all the best", "best regards", "kind regards", "regards", "appreciate it",
  "much appreciated", "appreciated", "farewell",
  // French
  "merci", "merci beaucoup", "mille mercis", "merci bien", "au revoir", "bonne journée",
  "bonne soirée", "bonne nuit", "bonne fin de journée", "bon week-end", "bon weekend", "à bientôt",
  "à plus", "à plus tard", "à la prochaine", "à demain", "de rien", "je vous en prie",
  "je t'en prie", "avec plaisir", "pas de quoi", "il n'y a pas de quoi", "bonne continuation",
  "cordialement", "prenez soin de vous", "prends soin de toi", "ciao", "tchao",
  // Arabic (MSA and Tunisian)
  "شكرا", "شكراً", "شكرا جزيلا", "ألف شكر", "مشكور", "مشكورة", "يعطيك العافية", "مع السلامة",
  "في أمان الله", "إلى اللقاء", "وداعا", "بالتوفيق", "عفوا", "العفو", "لا شكر على واجب",
  "تصبح على خير", "تصبحون على خير", "يومك سعيد", "نهارك سعيد", "بارك الله فيك",
  "جزاك الله خيرا", "الله يسلمك", "يعيشك", "بالسلامة", "بسلامة", "مرسي", "ميرسي", "تحياتي",
]

const FILLER = [
  // English
  "so", "very", "much", "a", "lot", "again", "too", "you", "u", "all", "and", "for", "everything",
  "the", "help", "your", "it", "really", "both", "guys", "everyone", "everybody", "folks", "team",
  "friend", "dear", "sir", "madam", "great", "perfect", "awesome", "nice", "cool", "good",
  "wonderful", "excellent", "super", "indeed", "oh", "ah", "well", "once", "more", "as", "always",
  "to", "of", "with", "me", "us", "from", "lovely", "amazing", "brilliant", "then",
  // French
  "beaucoup", "encore", "parfait", "top", "génial", "vous", "toi", "à", "tous", "tout", "pour", "et",
  "bien", "très", "aussi", "également", "votre", "ton", "aide", "cher", "chère", "madame",
  "monsieur", "les", "infiniment", "vraiment", "nickel", "de", "la", "le", "l", "excellente",
  "journée", "soirée",
  // Arabic
  "جزيلا", "كثيرا", "لك", "لكم", "ليك", "و", "برشا", "يا", "أخي", "اختي", "أختي", "صديقي", "حبيبي",
  "على", "المساعدة", "مساعدتك", "كل", "شي", "شيء", "جدا", "عزيزي", "أستاذ", "الله",
]

/** Emoji that say thanks or goodbye. Ack emoji (👍 👌 ✅) are not here. */
const THANKS_EMOJI = /[🙏❤😊🤝👋🌹💐🙂☺🥰💙💚🌸✨😀😄😁🤗💯]/u
const ACK_EMOJI = /[👍👌✅]/u

/** Lower case, accents and Arabic marks off, punctuation to spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ـ/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const tokenize = (s: string): string[] => normalizeText(s).split(" ").filter(Boolean)

interface Phrase { words: string[]; core: boolean }

const PHRASES: Phrase[] = [
  ...CORE.map((p) => ({ words: tokenize(p), core: true })),
  ...FILLER.map((p) => ({ words: tokenize(p), core: false })),
]
  .filter((p) => p.words.length > 0)
  // Longest first, so "thank you" wins over "thank" + "you".
  .sort((a, b) => b.words.length - a.words.length)

const VOCAB = new Set(PHRASES.flatMap((p) => p.words))

/** Arabic joins "و" (and) to the next word: "وشكرا". Split it off when the
 *  rest is a word the lists know. */
function splitArabicAnd(words: string[]): string[] {
  return words.flatMap((w) => (w.length > 2 && w.startsWith("و") && VOCAB.has(w.slice(1)) && !VOCAB.has(w) ? ["و", w.slice(1)] : [w]))
}

/** Classify one inbound message. `hasMedia`: a photo, file or voice note
 *  is never courtesy only. */
export function classifyCourtesy(text: string, opts: { hasMedia?: boolean } = {}): CourtesyClass {
  if (opts.hasMedia) return "real"
  // An @-handle ("thanks @helper_bot") only says who is thanked.
  const raw = (text ?? "").replace(/(^|\s)@\S+/g, " ")
  if (/[?؟]/.test(raw)) return "real"
  const words = splitArabicAnd(tokenize(raw))
  if (words.length > 15) return "real"
  if (words.length === 0) return THANKS_EMOJI.test(raw) && !ACK_EMOJI.test(raw) ? "courtesy" : "unsure"

  let core = false
  const rest: string[] = []
  for (let i = 0; i < words.length;) {
    const hit = PHRASES.find((p) => p.words.every((w, j) => words[i + j] === w))
    if (hit) {
      if (hit.core) core = true
      i += hit.words.length
    } else {
      rest.push(words[i])
      i++
    }
  }
  if (core && rest.length === 0 && !ACK_EMOJI.test(raw)) return "courtesy"
  // With a closer, a few other words ("thanks John") are unsure. Without
  // one, only a very short text ("ok", "yes please") is.
  return (core ? rest.length <= 3 : words.length <= 2) ? "unsure" : "real"
}
