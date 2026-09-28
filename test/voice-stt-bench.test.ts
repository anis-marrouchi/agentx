import { describe, expect, it } from "vitest"
// @ts-expect-error plain JavaScript benchmark helper, no type declarations
import { normalize, pooledWer, wer } from "../scripts/voice-stt-bench/wer.mjs"

describe("voice STT benchmark word error rate", () => {
  it("ignores case and punctuation but keeps apostrophes inside words", () => {
    expect(normalize("L'après-midi, c'est prêt ?")).toEqual(["l'après", "midi", "c'est", "prêt"])
    expect(wer("Open the report.", "open the report")).toBe(0)
  })

  it("folds Arabic short vowels and letter variants", () => {
    expect(wer("بدأ المطر قليلاً", "بدا المطر قليلا")).toBe(0)
    expect(wer("القاعة ليست جاهزة", "القاعه ليست جاهزه")).toBe(0)
  })

  it("counts substitutions, insertions and deletions against the reference length", () => {
    expect(wer("one two three four", "one too three four")).toBe(0.25)
    expect(wer("one two", "one two three")).toBe(0.5)
    expect(wer("one two", "")).toBe(1)
    expect(wer("one two", "four five six seven")).toBe(2)
  })

  it("pools clips by words, not by clip", () => {
    const pooled = pooledWer([
      { reference: "a b c d e f g h i j", hypothesis: "a b c d e f g h i j" },
      { reference: "k l", hypothesis: "x l" },
    ])
    expect(pooled).toBeCloseTo(1 / 12)
  })
})
