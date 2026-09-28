import { describe, expect, it } from "vitest"
import { BANNED_WORDS } from "../src/procedures/mine/banned"
import { buildExtractionPrompt, lintBlackBox, type MinedProcedure } from "../src/procedures/mine"

const clean: MinedProcedure = {
  cluster: "c1",
  id: "monthly-report",
  title: "Monthly report",
  trigger: "When the month ends",
  inputs: ["<month>"],
  expected: "Report sent",
  kpis: [],
  tags: [],
  steps: ["Prepare the report", "Send the report"],
  notes: "",
}

describe("procedure miner banned words (#230)", () => {
  it("lists every word the lint rejects in the extraction prompt", () => {
    const prompt = buildExtractionPrompt([])
    for (const word of BANNED_WORDS) expect(prompt).toContain(`"${word}"`)
  })

  it("names the inputs and expected fields in the forbidden-word rule", () => {
    const rule = buildExtractionPrompt([]).split("\n").find((l) => l.startsWith("2. FORBIDDEN"))
    expect(rule).toContain("inputs")
    expect(rule).toContain("expected")
  })

  it("rejects each listed word, in inputs and expected too", () => {
    expect(lintBlackBox(clean)).toEqual([])
    for (const word of BANNED_WORDS) {
      expect(lintBlackBox({ ...clean, inputs: [`<${word.toUpperCase()} key>`] })).toEqual([`inputs[0]: "${word.toUpperCase()}"`])
      expect(lintBlackBox({ ...clean, expected: `the ${word} is done` })).toEqual([`expected: "${word}"`])
    }
  })

  it("keeps AI banned, as a whole word only", () => {
    expect(BANNED_WORDS).toContain("ai")
    expect(lintBlackBox({ ...clean, steps: ["Ask the AI for a summary", "Send it"] })).toEqual([`steps[0]: "AI"`])
    expect(lintBlackBox({ ...clean, steps: ["Check the email she said was sent", "Reply by mail"] })).toEqual([])
  })
})
