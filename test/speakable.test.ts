import { describe, it, expect } from "vitest"
import { toSpeakable, SPOKEN_MAX_CHARS } from "../src/voice/speakable"

// #357: a long answer was cut for speech in the middle of a sentence, with
// nothing to say there was more.

describe("toSpeakable's cap", () => {
  it("says a short answer whole", () => {
    expect(toSpeakable("All done. Nothing needs you.")).toBe("All done. Nothing needs you.")
  })

  it("ends a long answer on its last whole sentence and says there is more", () => {
    const said = toSpeakable("I opened the issue. It tracks every request. Nothing is built yet. If you meant something else, tell me.", 70)
    expect(said).toBe("I opened the issue. It tracks every request. Nothing is built yet. The rest is on screen.")
  })

  it("caps at voice.spokenMaxChars' default when no cap is given", () => {
    const said = toSpeakable("This is one sentence of the answer. ".repeat(40))
    expect(said.endsWith("answer. The rest is on screen.")).toBe(true)
    expect(said.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS + " The rest is on screen.".length)
  })

  it("cuts between words only when no sentence ends in the second half of the cap", () => {
    expect(toSpeakable("Yes. " + "word ".repeat(100), 60)).toMatch(/^Yes\. (word )+word\.\.\. The rest is on screen\.$/)
  })

  it("does not take a version number or a decimal for a sentence end", () => {
    const said = toSpeakable("Both machines are on release 0.45.1 and it took 2.5 hours to get there today. Then more follows here.", 60)
    expect(said).toBe("Both machines are on release 0.45.1 and it took 2.5 hours... The rest is on screen.")
  })

  it("says there is more in the answer's language", () => {
    expect(toSpeakable("Le rapport est prêt pour vous. Il est dans le dossier. Nous avons aussi une autre note.", 60))
      .toBe("Le rapport est prêt pour vous. Il est dans le dossier. La suite est à l'écran.")
    expect(toSpeakable("التقرير جاهز الآن. وهو في المجلد. ولدينا ملاحظة أخرى طويلة هنا.", 40)).toMatch(/الباقي على الشاشة\.$/)
  })
})
