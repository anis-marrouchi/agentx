import { describe, expect, it } from "vitest"
import { plainMarkerText } from "../src/daemon/ui/marker-text"
import { supervisedSuffix, nudgeText as workflowNudgeText } from "../src/workflows/nodes/follow-up"
import { sameHomeNote } from "../src/a2a/home"

// #1443: the Wall never shows an internal [agentx:…] marker. A text that
// was only a marker becomes one plain line; any other text loses its markers.

describe("plainMarkerText (#1443)", () => {
  it.each([
    ["[agentx:delegation-result task=dlg-1 from=dev-session status=done]", "Result from dev-session"],
    ["[agentx:delegation-result task=dlg-1 from=dev-session peer=node-b status=error]", "Result from dev-session"],
    ["[agentx:delegation-result task=dlg-1 from=dev-session status=waiting]", "Update from dev-session: still under way"],
    ["[agentx:delegation-result task=dlg-1 from=dev-session status=reply]", "Reply from dev-session"],
    ["[agentx:delegation-result]", "Result from another agent"],
    ["[agentx:plan-step id=req-1 step=2]", "Plan step 2"],
    ["[agentx:plan-nudge id=req-1 step=3]", "Reminder: plan step 3"],
    ["[agentx:workflow-step run=run-1 step=build]", "A workflow step"],
    ["[agentx:workflow-nudge run=run-1 step=build nudge=1/3]", "Reminder: a workflow step"],
    ["[agentx:request-pickup id=req-1]", "A request picked up again"],
    ["[agentx:watcher id=w-1 task=t-1]", "A watcher's alert"],
    ["[agentx:same-home]", "Another run works on the same thing"],
    ["[agentx:something-new x=1]", "A message from AgentX"],
  ])("says %s plainly", (marker, plain) => {
    expect(plainMarkerText(marker)).toBe(plain)
    expect(plainMarkerText(`  ${marker}  \n\n`)).toBe(plain)
  })

  it("reads a marker a preview clipped before its closing bracket", () => {
    expect(plainMarkerText("[agentx:delegation-result task=dlg-1 from=dev-session sta")).toBe("Result from dev-session")
    expect(plainMarkerText("[agentx:plan-step id=req-1 st")).toBe("A plan step")
  })

  it("drops the marker line and keeps the text under it", () => {
    const msg = "[agentx:plan-step id=req-1 step=2]\nYou own step 2 of 3 in the plan.\n\nDone when: it ships"
    expect(plainMarkerText(msg)).toBe("You own step 2 of 3 in the plan.\n\nDone when: it ships")
    expect(plainMarkerText("[agentx:delegation-result task=dlg-1 from=dev-session status=done]\nEarlier in this conversation you asked dev-session to help."))
      .toBe("Earlier in this conversation you asked dev-session to help.")
  })

  it("drops a marker in the middle of a prompt and keeps the Markdown around it as it was", () => {
    const prompt = "Build it.\n\n- one\n    - nested\n" + supervisedSuffix({ id: "run-1" }, "build")
    const out = plainMarkerText(prompt)
    expect(out).not.toContain("[agentx:")
    expect(out).toContain("- one\n    - nested")
    expect(out).toContain("This is one step of a workflow AgentX is following.")
  })

  it("leaves the text after an inline marker on its line", () => {
    const note = sameHomeNote([{ homes: ["repo-a"], channel: "telegram", chatId: "1", startedAt: new Date("2026-01-01T10:00:00Z") }], ["repo-a"], { channel: "wall" })!
    expect(plainMarkerText(note)).toMatch(/^Another run of yours is already working on repo-a/)
    expect(plainMarkerText(workflowNudgeText({ id: "run-1", meta: {} } as never, "build", 1, 3, 60_000))).toMatch(/^Reminder 1 of 3:/)
  })

  it("passes any other text through as it is", () => {
    expect(plainMarkerText("Answering a refund")).toBe("Answering a refund")
    expect(plainMarkerText("  keep  spacing  ")).toBe("  keep  spacing  ")
    expect(plainMarkerText(null)).toBe("")
    expect(plainMarkerText(undefined)).toBe("")
  })
})
