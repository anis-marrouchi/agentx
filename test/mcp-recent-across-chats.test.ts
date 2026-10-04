import { describe, expect, it } from "vitest"
import { renderTurnsByChat } from "../src/mcp/index"

// agentx_recent without a chatId (#615): the calling agent's other chats of
// today, the cross-chat context a lean session fetches instead of being
// handed.

const turn = (chatId: string, ts: string, role: "user" | "agent", content: string, channel = "telegram") =>
  ({ ts, role, senderName: role === "user" ? "Alex" : "", content, channel, chatId })

describe("renderTurnsByChat", () => {
  it("groups by chat, oldest first inside each, and says who spoke", () => {
    const out = renderTurnsByChat([
      turn("200", "2026-10-04T09:30:00.000Z", "agent", "Done, deployed."),
      turn("100", "2026-10-04T09:00:00.000Z", "user", "Please deploy"),
      turn("200", "2026-10-04T09:20:00.000Z", "user", "Status?"),
    ], false)
    expect(out.indexOf("From telegram/200:")).toBeLessThan(out.indexOf("From telegram/100:"))
    const block = out.slice(out.indexOf("From telegram/200:"), out.indexOf("From telegram/100:"))
    expect(block.indexOf("[09:20] Alex: Status?")).toBeLessThan(block.indexOf("[09:30] you: Done, deployed."))
    expect(out).not.toContain("older turns exist")
  })

  it("cuts long messages and points at the rest when there is more", () => {
    const out = renderTurnsByChat([turn("x", "2026-10-04T09:00:00.000Z", "user", "a".repeat(500), "github")], true)
    expect(out).toContain("From github/x:")
    expect(out).not.toContain("a".repeat(301))
    expect(out).toContain("older turns exist")
  })
})
