import { describe, expect, it } from "vitest"
import { platformOf, recordsFromEntries } from "../../src/wiki/facts"

const entry = (source: string, meta: Record<string, unknown>) => ({ source, meta })

describe("platformOf", () => {
  it("strips the mesh node suffix", () => {
    expect(platformOf("whatsapp@peer-server")).toBe("whatsapp")
    expect(platformOf("gitlab")).toBe("gitlab")
    expect(platformOf("webhook:hubspot")).toBe("webhook")
  })

  it("is empty for a missing source rather than throwing", () => {
    expect(platformOf(undefined)).toBe("")
  })
})

describe("recordsFromEntries", () => {
  it("reads a contact value straight off a WhatsApp JID", () => {
    // The point of the whole change: no directory lookup, no name
    // resolution, nothing to mismatch.
    const r = recordsFromEntries([
      entry("whatsapp@peer-server", { sender: "Alex Rivera", senderId: "10000000000@s.whatsapp.net" }),
    ])
    expect(r).toHaveLength(1)
    expect(r[0].fields.phone).toBe("+10000000000")
    expect(r[0].fields.whatsapp).toBe("10000000000@s.whatsapp.net")
    expect(r[0].fields.country).toBe("US/Canada")
    expect(r[0].source).toBe("entries")
  })

  it("accepts a bare number on a whatsapp entry", () => {
    const r = recordsFromEntries([entry("whatsapp", { sender: "Alex Rivera", senderId: "10000000000" })])
    expect(r[0].fields.phone).toBe("+10000000000")
    expect(r[0].fields.whatsapp).toBe("10000000000@s.whatsapp.net")
  })

  it("files a handle under the platform it belongs to", () => {
    const g = recordsFromEntries([entry("gitlab", { sender: "Alex Rivera", senderUsername: "alex" })])
    expect(g[0].fields.gitlab).toBe("@alex")
    const t = recordsFromEntries([entry("telegram", { sender: "Alex Rivera", senderUsername: "@alex" })])
    expect(t[0].fields.telegram).toBe("@alex")
  })

  it("never presents a numeric account id as a way to reach someone", () => {
    // A Telegram user id identifies an account and cannot be dialled or
    // messaged by a human. Writing it into a contact line would satisfy
    // the grader and help nobody.
    const r = recordsFromEntries([entry("telegram", { sender: "Alex Rivera", senderId: "818540323" })])
    expect(r[0].fields.phone).toBeUndefined()
    expect(r[0].fields.whatsapp).toBeUndefined()
    expect(r[0].fields.telegramId).toBe("818540323")
  })

  it("unions identifiers for a person seen across several entries", () => {
    const r = recordsFromEntries([
      entry("whatsapp", { sender: "Alex Rivera", senderId: "10000000000@s.whatsapp.net" }),
      entry("gitlab", { sender: "Alex Rivera", senderUsername: "alex" }),
    ])
    expect(r).toHaveLength(1)
    expect(r[0].fields.phone).toBe("+10000000000")
    expect(r[0].fields.gitlab).toBe("@alex")
  })

  it("ignores entries with no stamped sender, which is every old one", () => {
    expect(recordsFromEntries([entry("whatsapp", { intentPath: ["a"] }), entry("gitlab", {})])).toEqual([])
    expect(recordsFromEntries([{ source: "whatsapp" }])).toEqual([])
  })

  it("emits nothing for a sender with no identifier at all", () => {
    expect(recordsFromEntries([entry("telegram", { sender: "Alex Rivera" })])).toEqual([])
  })
})
