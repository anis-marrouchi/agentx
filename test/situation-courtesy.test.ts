import { describe, expect, it } from "vitest"
import { classifyCourtesy, normalizeText } from "../src/situations/courtesy"

// #1892 proof (e): the courtesy word list, in English, French and Arabic.
// "courtesy" may be dropped after a talk ended; "unsure" always passes and
// never reopens; "real" passes and reopens. An answer to a question ("ok",
// "yes", 👍) must never be called courtesy.

describe("courtesy word list — English", () => {
  it.each([
    "Thank you, goodbye!",
    "Thanks!",
    "thanks a lot",
    "Thank you so much for your help",
    "Many thanks, have a nice day",
    "Bye bye",
    "You're welcome! Take care.",
    "no problem, all the best",
    "Great, thanks again!",
    "Cheers",
    "Goodbye 👋",
  ])("%s → courtesy", (t) => expect(classifyCourtesy(t)).toBe("courtesy"))

  it.each([
    ["ok", "unsure"],
    ["yes", "unsure"],
    ["sure thanks", "unsure"],
    ["👍", "unsure"],
    ["Thanks 👍", "unsure"],
    ["hi", "unsure"],
    ["thanks John", "unsure"],
  ])("%s → %s", (t, want) => expect(classifyCourtesy(t)).toBe(want))

  it.each([
    "Thanks! When is the start date?",
    "Thank you, one more thing: please send the contract to the new address today",
    "Can you resend the file",
    "thanks, but the invoice total is wrong and needs fixing before Friday",
  ])("%s → real", (t) => expect(classifyCourtesy(t)).toBe("real"))
})

describe("courtesy word list — French", () => {
  it.each([
    "Merci, au revoir !",
    "Merci beaucoup",
    "Merci beaucoup pour votre aide, bonne journée",
    "Mille mercis",
    "À bientôt",
    "De rien, bonne soirée !",
    "Je vous en prie",
    "Avec plaisir, bonne continuation",
    "Parfait, merci encore",
  ])("%s → courtesy", (t) => expect(classifyCourtesy(t)).toBe("courtesy"))

  it.each([
    ["d'accord", "unsure"],
    ["oui", "unsure"],
    ["Merci ! Quelle est la date de début ?", "real"],
    ["Merci, pouvez-vous envoyer le contrat signé à la comptabilité demain matin", "real"],
  ])("%s → %s", (t, want) => expect(classifyCourtesy(t)).toBe(want))
})

describe("courtesy word list — Arabic", () => {
  it.each([
    "شكرا",
    "شكراً جزيلاً",
    "شكرا جزيلا، مع السلامة",
    "مع السلامة",
    "في أمان الله",
    "عفوا",
    "لا شكر على واجب",
    "وشكرا",
    "يعيشك برشا",
    "بالسلامة",
    "جزاك الله خيرا",
  ])("%s → courtesy", (t) => expect(classifyCourtesy(t)).toBe("courtesy"))

  it.each([
    ["تمام", "unsure"],
    ["نعم", "unsure"],
    ["شكرا، متى يبدأ العمل؟", "real"],
    ["شكرا، أرسل لي العقد الجديد والفاتورة قبل يوم الجمعة من فضلك", "real"],
  ])("%s → %s", (t, want) => expect(classifyCourtesy(t)).toBe(want))
})

describe("courtesy word list — other inputs", () => {
  it("a thanks emoji alone is courtesy; an ack emoji alone is unsure", () => {
    expect(classifyCourtesy("🙏")).toBe("courtesy")
    expect(classifyCourtesy("❤️🙏")).toBe("courtesy")
    expect(classifyCourtesy("👌")).toBe("unsure")
  })

  it("an @-handle does not count as a word", () => {
    expect(classifyCourtesy("Thanks @helper_bot, goodbye!")).toBe("courtesy")
    expect(classifyCourtesy("@helper_bot please send the report")).toBe("real")
  })

  it("media is never courtesy", () => {
    expect(classifyCourtesy("thanks", { hasMedia: true })).toBe("real")
  })

  it("an empty text is unsure", () => {
    expect(classifyCourtesy("")).toBe("unsure")
  })

  it("normalizes accents, Arabic marks and punctuation alike on both sides", () => {
    expect(normalizeText("Bonne JOURNÉE !")).toBe("bonne journee")
    expect(normalizeText("شكراً")).toBe("شكرا")
    expect(normalizeText("مع السلامة")).toBe("مع السلامه")
  })
})
