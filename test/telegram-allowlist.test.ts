import { describe, it, expect } from "vitest"
import { TelegramAdapter } from "../src/channels/telegram"

type AllowFrom = string[] | undefined

function allowed(global: AllowFrom, account: AllowFrom, from: number, chat: number, username?: string): boolean {
  const adapter = new TelegramAdapter(
    { support: { token: "x", agentBinding: "support-agent", allowFrom: account } },
    { policy: { allowFrom: global } },
    () => {},
  )
  return (adapter as any).isAllowed("support", from, chat, username)
}

describe("Telegram allowlist", () => {
  it("drops everything when no list is set", () => {
    expect(allowed(undefined, undefined, 1, 1)).toBe(false)
    expect(allowed([], undefined, 1, 1)).toBe(false)
  })

  it("matches a user id, a chat id or an @username", () => {
    expect(allowed(["100"], undefined, 100, 5)).toBe(true)
    expect(allowed(["-200"], undefined, 1, -200)).toBe(true)
    expect(allowed(["@Alice"], undefined, 1, 1, "alice")).toBe(true)
    expect(allowed(["@alice"], undefined, 1, 1, "bob")).toBe(false)
  })

  it('lets everyone in with "*"', () => {
    expect(allowed(["*"], undefined, 42, 42)).toBe(true)
    expect(allowed(undefined, ["*"], 42, 42, "stranger")).toBe(true)
  })

  it("lets a per-account list override a public global list", () => {
    expect(allowed(["*"], ["@owner"], 42, 42, "stranger")).toBe(false)
    expect(allowed(["*"], [], 42, 42)).toBe(false)
  })
})
