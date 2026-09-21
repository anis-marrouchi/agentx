import { describe, expect, it } from "vitest"
import { buildEntryMeta } from "../../src/agents/registry"
import { extractHints } from "../../src/wiki/facts"

describe("buildEntryMeta — recording who spoke", () => {
  const ctx = { sender: "Alex Rivera", senderId: "10000000000@s.example.net", senderUsername: "@alex", group: "Team Chat" }

  it("stamps the sender and the platform identifier", () => {
    const m = buildEntryMeta(undefined, ctx)!
    expect(m.sender).toBe("Alex Rivera")
    // On WhatsApp the platform id IS the number, so capturing it means
    // the identifier arrives with the entry rather than being
    // reconstructed from a directory later.
    expect(m.senderId).toBe("10000000000@s.example.net")
    expect(m.senderUsername).toBe("@alex")
  })

  it("keeps the intent path it already carried", () => {
    const m = buildEntryMeta({ path: ["admin", "update"], pathLabel: "admin › update" }, ctx)!
    expect(m.intentPath).toEqual(["admin", "update"])
    expect(m.intentPathLabel).toBe("admin › update")
    expect(m.sender).toBe("Alex Rivera")
  })

  it("records the group only alongside a sender", () => {
    // Without a sender, sourceContext already holds the group; repeating
    // it buys nothing.
    expect(buildEntryMeta(undefined, { group: "Team Chat" })).toBeUndefined()
    expect(buildEntryMeta(undefined, ctx)!.group).toBe("Team Chat")
  })

  it("is undefined when there is nothing to record", () => {
    expect(buildEntryMeta(undefined, undefined)).toBeUndefined()
    expect(buildEntryMeta({ path: [] }, {})).toBeUndefined()
  })
})

describe("extractHints with a recorded sender", () => {
  it("finds the speaker in a group chat, which context alone never could", () => {
    // The regression this exists for: sourceContext holds the group, the
    // body is just the message, and the person was invisible.
    const h = extractHints([
      { context: "Team Chat", content: "can you check the invoice?", sender: "Alex Rivera" },
    ])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ name: "Alex Rivera", origin: "sender", type: "person" })
  })

  it("prefers the recorded sender over a context guess", () => {
    const h = extractHints([{ context: "Dana Okonkwo", content: "x", sender: "Alex Rivera" }])
    expect(h.find((x) => x.name === "Alex Rivera")?.origin).toBe("sender")
  })

  it("still falls back to context for entries captured before senders were stamped", () => {
    const h = extractHints([{ context: "Dana Okonkwo", content: "x" }])
    expect(h).toEqual([{ name: "Dana Okonkwo", origin: "context" }])
  })

  it("does not treat a bot or placeholder sender as a person", () => {
    const h = extractHints([{ context: "g", content: "x", sender: "system" }])
    expect(h).toEqual([])
  })

  it("dedupes a person who both spoke and is named in the body", () => {
    const h = extractHints(
      [{ context: "Team Chat", content: "Alex Rivera said so", sender: "Alex Rivera" }],
      { known: ["Alex Rivera"] },
    )
    expect(h).toHaveLength(1)
    expect(h[0].origin).toBe("sender")
  })
})
