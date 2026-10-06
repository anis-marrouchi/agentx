import { describe, it, expect } from "vitest"
import { isWhatsAppSenderAllowed } from "../src/channels/whatsapp"

// #736: the WhatsApp channel is closed by default, like Telegram.
describe("isWhatsAppSenderAllowed", () => {
  it("drops every chat when allowFrom is unset or empty", () => {
    expect(isWhatsAppSenderAllowed(undefined, "15550001111", "15550001111")).toBe(false)
    expect(isWhatsAppSenderAllowed([], "15550001111", "15550001111")).toBe(false)
  })

  it("accepts a sender or chat that matches an entry, with or without +", () => {
    expect(isWhatsAppSenderAllowed(["+15550001111"], "15550001111", "15550001111")).toBe(true)
    expect(isWhatsAppSenderAllowed(["15550001111"], "15550002222", "15550001111")).toBe(true)
    expect(isWhatsAppSenderAllowed(["+15550001111"], "15550002222", "15550002222")).toBe(false)
  })

  it("accepts a group or contact JID entry", () => {
    expect(isWhatsAppSenderAllowed(["120363000000000000@g.us"], "15550002222", "120363000000000000")).toBe(true)
    expect(isWhatsAppSenderAllowed(["15550001111@s.whatsapp.net"], "15550001111", "15550001111")).toBe(true)
  })

  it("never treats a blank entry as match-everything", () => {
    expect(isWhatsAppSenderAllowed(["", " ", "+"], "15550001111", "15550001111")).toBe(false)
  })

  it("answers every chat only when \"*\" is listed", () => {
    expect(isWhatsAppSenderAllowed(["*"], "15550001111", "15550001111")).toBe(true)
  })
})
