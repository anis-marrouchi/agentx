import { describe, it, expect } from "vitest"
import { pollParams, mediaSendSpec } from "../src/channels/telegram"
import { splitMessageText, TG_CHUNK_CHARS, TG_MAX_MESSAGE_CHARS } from "../src/channels/message-chunks"

describe("pollParams", () => {
  it("builds a single-answer poll with JSON-encoded options", () => {
    const p = pollParams("123", { name: "Ship?", values: ["Yes", "No"] })
    expect(p.chat_id).toBe("123")
    expect(p.question).toBe("Ship?")
    expect(p.options).toBe(JSON.stringify(["Yes", "No"]))
    expect(p.allows_multiple_answers).toBe(false)
  })

  it("enables multiple answers and caps options at 10", () => {
    const values = Array.from({ length: 15 }, (_, i) => `o${i}`)
    const p = pollParams("c", { name: "q", values, selectableCount: 3 })
    expect(p.allows_multiple_answers).toBe(true)
    expect(JSON.parse(p.options as string)).toHaveLength(10)
  })

  it("sets reply_to_message_id when replying", () => {
    const p = pollParams("c", { name: "q", values: ["a", "b"] }, "42")
    expect(p.reply_to_message_id).toBe(42)
  })
})

describe("mediaSendSpec", () => {
  it("maps each media type to method + field", () => {
    expect(mediaSendSpec("c", { type: "image", url: "u" }).method).toBe("sendPhoto")
    expect(mediaSendSpec("c", { type: "image", url: "u" }).params.photo).toBe("u")
    expect(mediaSendSpec("c", { type: "audio", url: "u" }).method).toBe("sendAudio")
    expect(mediaSendSpec("c", { type: "video", url: "u" }).method).toBe("sendVideo")
    const doc = mediaSendSpec("c", { type: "document", url: "u", caption: "cap" }, "7")
    expect(doc.method).toBe("sendDocument")
    expect(doc.params.document).toBe("u")
    expect(doc.params.caption).toBe("cap")
    expect(doc.params.reply_to_message_id).toBe(7)
  })
})

describe("message chunk constants", () => {
  it("chunk target sits under the hard ceiling", () => {
    expect(TG_CHUNK_CHARS).toBeLessThan(TG_MAX_MESSAGE_CHARS)
  })

  it("splitMessageText delivers every character across chunks (lossless)", () => {
    const text = "x".repeat(9000) + " end"
    const chunks = splitMessageText(text, TG_CHUNK_CHARS)
    expect(chunks.length).toBeGreaterThan(1)
    // no chunk exceeds the target, and nothing is dropped
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TG_CHUNK_CHARS)
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""))
  })
})
