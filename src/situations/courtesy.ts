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
// Approval words ("ok", "yes", "perfect", "parfait", "تمام") and 👍 are
// never courtesy, even next to a thanks: they can be an answer to a
// question the agent asked, and dropping an approval is the one mistake the
// gate must not make. A request after a thanks ("thanks, help me") is
// real. Unsure always means "let it through".

export type CourtesyClass = "courtesy" | "unsure" | "real"

const CORE = [
  // English
  "thanks", "thank you", "thank u", "thanks a lot", "many thanks", "thx", "ty", "tysm", "cheers",
  "bye", "bye bye", "goodbye", "good bye", "see you", "see ya", "see you soon", "see you later",
  "talk soon", "talk later", "take care", "have a nice day", "have a good day", "have a great day",
  "have a nice evening", "have a good evening", "have a good one", "have a nice weekend",
  "have a great weekend", "good night", "goodnight", "you're welcome", "you are welcome",
  "my pleasure", "glad to help", "glad i could help",
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
  // "يعيشك" is left out on purpose: in Tunisian it often means "please".
  "جزاك الله خيرا", "الله يسلمك", "بالسلامة", "بسلامة", "مرسي", "ميرسي", "تحياتي",
]

// Words around a closer that add nothing ("thank you SO MUCH for YOUR
// HELP"). Phrases, so "help" alone is not filler: "thanks, help me" is a
// request.
const FILLER = [
  // English
  "so", "very", "much", "a", "lot", "again", "too", "you", "u", "all", "and", "everything",
  "for everything", "for your help", "for the help", "for all your help", "for all the help",
  "for helping", "for your time", "for the info", "for that", "for this", "for it",
  "the", "your", "really", "both", "guys", "everyone", "everybody", "folks", "team",
  "friend", "dear", "sir", "madam", "indeed", "oh", "ah", "well", "once", "more", "as", "always",
  "from", "then",
  // French
  "beaucoup", "encore", "vous", "toi", "à", "tous", "tout", "et", "aussi", "également",
  "pour tout", "pour votre aide", "pour ton aide", "pour l aide", "pour votre temps", "pour ça",
  "cher", "chère", "madame", "monsieur", "les", "infiniment", "vraiment", "de", "la", "le", "l",
  "journée", "soirée",
  // Arabic
  "جزيلا", "كثيرا", "لك", "لكم", "ليك", "و", "برشا", "يا", "أخي", "اختي", "أختي", "صديقي", "حبيبي",
  "على المساعدة", "على مساعدتك", "على كل شي", "على كل شيء", "جدا", "عزيزي", "أستاذ", "الله",
]

// Approval: "perfect, thanks" or "parfait merci" can be the answer to a
// question the agent asked ("Shall I book it?"). Never courtesy; unsure
// at most, so it always passes.
const APPROVAL = [
  "ok", "okay", "great", "perfect", "awesome", "nice", "cool", "good", "fine", "wonderful",
  "excellent", "super", "lovely", "amazing", "brilliant", "sounds good", "no problem",
  "no worries", "anytime", "sure", "yes", "yep", "alright", "all right", "deal", "agreed",
  "parfait", "top", "génial", "nickel", "excellente", "très bien", "bien", "d'accord", "dac",
  "pas de problème", "pas de souci", "pas de soucis", "oui", "ça marche", "entendu", "volontiers",
  "تمام", "ممتاز", "باهي", "مزيان", "موافق", "نعم", "اي", "إي", "أوكي", "اوكي", "ماشي", "لا مشكل",
]

// Asking for something: after a thanks, any of these makes it real.
const REQUEST = new Set([
  "please", "pls", "plz", "can", "could", "would", "will", "need", "want", "send", "help", "check",
  "give", "tell", "show", "call", "share", "make", "fix", "book", "confirm", "let", "remind",
  "but", "however", "also", "wait",
  "svp", "stp", "peux", "pouvez", "pourriez", "pourrais", "envoyer", "envoie", "envoyez", "aide",
  "aidez", "besoin", "veux", "voudrais", "voulez", "mais", "confirmer", "attends", "attendez",
  "ممكن", "أرسل", "ارسل", "ابعث", "ابعثلي", "نحب", "نحتاج", "أحتاج", "احتاج", "عاوني", "ساعدني",
  "لكن", "اما", "أما", "فضلك", "يعيشك",
].map((w) => normalizeText(w)))

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

interface Phrase { words: string[]; kind: "core" | "filler" | "approval" }

const PHRASES: Phrase[] = [
  ...CORE.map((p) => ({ words: tokenize(p), kind: "core" as const })),
  ...FILLER.map((p) => ({ words: tokenize(p), kind: "filler" as const })),
  ...APPROVAL.map((p) => ({ words: tokenize(p), kind: "approval" as const })),
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
  let approval = false
  const rest: string[] = []
  for (let i = 0; i < words.length;) {
    const hit = PHRASES.find((p) => p.words.every((w, j) => words[i + j] === w))
    if (hit) {
      if (hit.kind === "core") core = true
      if (hit.kind === "approval") approval = true
      i += hit.words.length
    } else {
      rest.push(words[i])
      i++
    }
  }
  // Asking for something ("thanks, help me", "merci, envoyez…"): real.
  if (rest.some((w) => REQUEST.has(w))) return "real"
  if (core && !approval && rest.length === 0 && !ACK_EMOJI.test(raw)) return "courtesy"
  // An approval ("perfect, thanks"), or a closer with a few other words
  // ("thanks John"), is unsure. Without a closer, only a short text is.
  if (core || approval) return rest.length <= 3 ? "unsure" : "real"
  return words.length <= 2 ? "unsure" : "real"
}
