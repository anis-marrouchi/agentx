import { describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { saveCard, type DecisionCard } from "../src/approvals/cards"
import { decide } from "../src/approvals/inbox"
import { readAnswered, recordAnswered } from "../src/approvals/answered"

// #1440: every yes or no through decide() lands on the answered list the
// Wall's Answered tab reads. "Later" and a refused answer do not.

const card = (id: string, extra: Partial<DecisionCard> = {}): DecisionCard => ({
  id, title: `Card ${id}`, ask: "Go?", recommend: "Tuesday", if_silent: "keep",
  expires: new Date(Date.now() + 3600e3).toISOString(), raised_by: "quill", created_at: new Date().toISOString(), status: "pending", ...extra,
})

describe("answered list (#1440)", () => {
  it("keeps yes and no with the title and the pick, newest first; not later or a refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentx-answered-"))
    saveCard(root, card("a", { choices: ["Now", "Tuesday"] }))
    saveCard(root, card("b"))
    saveCard(root, card("c"))
    expect((await decide({ root }, "card:a", "yes", { choice: 2, by: "operator (dashboard)" })).ok).toBe(true)
    expect((await decide({ root }, "card:b", "later")).ok).toBe(true)
    expect((await decide({ root }, "card:c", "no")).ok).toBe(true)
    expect((await decide({ root }, "card:missing", "yes")).ok).toBe(false)
    const list = readAnswered(root)
    expect(list.map((i) => [i.key, i.answer])).toEqual([["card:c", "no"], ["card:a", "yes"]])
    expect(list[1]).toMatchObject({ title: "Card a", kind: "card", raised_by: "quill", choice: "Tuesday", by: "operator (dashboard)" })
  })

  it("is bounded and reads past a torn line", () => {
    const root = mkdtempSync(join(tmpdir(), "agentx-answered-"))
    for (let n = 0; n < 700; n++) recordAnswered(root, { key: `card:${n}`, kind: "card", title: "t", raised_by: "x", answer: "yes", by: "o", at: new Date(n).toISOString() })
    expect(readAnswered(root, 1000).length).toBeLessThanOrEqual(600)
    expect(readAnswered(root, 1)[0].key).toBe("card:699")
  })
})
