// Settings › Business › Org chart: a move whose later step is refused puts
// the old line back, and says to reload when it cannot (#2443 review C2).
import { describe, expect, it } from "vitest"
import type { OrgChange } from "../src/daemon/ui/pages/org-setup"
import { OrgUndoFailed, applyOrgSteps } from "../src/hub/settings/OrgChart"

const step = (to: string) => ({ op: "add-relation", from: "agent:cx", type: "reports-to", to }) as unknown as OrgChange

function fakeServer(refuse: (c: OrgChange, n: number) => boolean) {
  const sent: OrgChange[] = []
  const send = async (c: OrgChange) => {
    sent.push(c)
    if (refuse(c, sent.length)) throw new Error("refused " + sent.length)
  }
  return { sent, send }
}

describe("applyOrgSteps", () => {
  it("sends every step when none is refused", async () => {
    const s = fakeServer(() => false)
    await applyOrgSteps([step("a"), step("b")], [step("undo")], s.send)
    expect(s.sent).toEqual([step("a"), step("b")])
  })

  it("puts the old line back when a later step is refused, and throws the first error", async () => {
    const s = fakeServer((_c, n) => n === 2)
    await expect(applyOrgSteps([step("a"), step("b")], [step("undo")], s.send)).rejects.toThrow("refused 2")
    expect(s.sent).toEqual([step("a"), step("b"), step("undo")])
  })

  it("sends no undo when the first step is refused", async () => {
    const s = fakeServer((_c, n) => n === 1)
    await expect(applyOrgSteps([step("a"), step("b")], [step("undo")], s.send)).rejects.toThrow("refused 1")
    expect(s.sent).toEqual([step("a")])
  })

  it("says to reload when the undo is refused too", async () => {
    const s = fakeServer((_c, n) => n >= 2)
    const err = await applyOrgSteps([step("a"), step("b")], [step("undo")], s.send).catch((e) => e)
    expect(err).toBeInstanceOf(OrgUndoFailed)
    expect(err.message).toBe("Not saved, and the old line could not be put back: reload. The server said: refused 2")
  })
})
