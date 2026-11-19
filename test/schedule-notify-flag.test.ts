import { describe, it, expect } from "vitest"
import { isBrokenAppNotify, parseNotifyFlag } from "../src/crons/schedule-ops"

// #2005: `--notify` split on every ":", so an app chat id ("app:<id>")
// became chatId "app" with the id in accountId.
describe("parseNotifyFlag", () => {
  it("keeps the colon inside an app chat id", () => {
    expect(parseNotifyFlag("app:app:01ABC")).toEqual({ channel: "app", chatId: "app:01ABC" })
  })

  it("keeps a gitlab chat id whole", () => {
    expect(parseNotifyFlag("gitlab:org/repo:issue:1")).toEqual({ channel: "gitlab", chatId: "org/repo:issue:1" })
  })

  it("still reads telegram and whatsapp account suffixes", () => {
    expect(parseNotifyFlag("telegram:123")).toEqual({ channel: "telegram", chatId: "123" })
    expect(parseNotifyFlag("telegram:123:bot2")).toEqual({ channel: "telegram", chatId: "123", accountId: "bot2" })
    expect(parseNotifyFlag("whatsapp:216@s.whatsapp.net:main")).toEqual({ channel: "whatsapp", chatId: "216@s.whatsapp.net", accountId: "main" })
  })

  it("rejects values without a channel or chat id", () => {
    expect(parseNotifyFlag("telegram")).toBeNull()
    expect(parseNotifyFlag(":123")).toBeNull()
    expect(parseNotifyFlag("app:")).toBeNull()
  })
})

describe("isBrokenAppNotify", () => {
  it("flags the shape the old parser saved", () => {
    expect(isBrokenAppNotify({ channel: "app", chatId: "app" })).toBe(true)
    expect(isBrokenAppNotify({ channel: "app", chatId: "app:01ABC" })).toBe(false)
    expect(isBrokenAppNotify({ channel: "telegram", chatId: "123" })).toBe(false)
  })
})
