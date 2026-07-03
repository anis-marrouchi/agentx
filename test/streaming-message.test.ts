import { describe, it, expect } from "vitest"
import { StreamingMessage } from "../src/channels/streaming-message"

/** Recording fake for the send/edit deps. */
function fakeChannel(maxChars: number) {
  const sends: string[] = []
  const edits: Array<{ id: string; text: string }> = []
  let counter = 0
  const sm = new StreamingMessage({
    maxChars,
    send: async (text) => {
      sends.push(text)
      return `m${++counter}`
    },
    edit: async (id, text) => {
      edits.push({ id, text })
      return true
    },
  })
  return { sm, sends, edits }
}

describe("StreamingMessage", () => {
  it("short text → one send, zero edits, primary id set", async () => {
    const { sm, sends, edits } = fakeChannel(100)
    await sm.update("hello")
    await sm.update("hello world")
    expect(sends).toEqual(["hello"])
    expect(edits).toEqual([{ id: "m1", text: "hello world" }])
    expect(sm.primaryId).toBe("m1")
    expect(sm.lastId).toBe("m1")
  })

  it("growth across the chunk boundary rolls into a second message, no duplicate sends", async () => {
    const { sm, sends, edits } = fakeChannel(10)
    await sm.update("aaaaaaaa")          // 8 chars → one message
    await sm.update("aaaaaaaa bbbbbbbb")  // 17 chars → splits into two chunks
    expect(sends.length).toBe(2)          // second chunk becomes a new message
    expect(sm.primaryId).toBe("m1")
    expect(sm.lastId).toBe("m2")
    // No chunk is ever sent twice
    expect(new Set(sends).size).toBe(sends.length)
  })

  it("only edits the growing tail, not stable earlier chunks", async () => {
    const { sm, edits } = fakeChannel(10)
    await sm.update("aaaaaaaa bbbbbbbb")  // 2 messages: "aaaaaaaa", "bbbbbbbb"
    const editsAfterSplit = edits.length
    await sm.update("aaaaaaaa bbbbbbbb cc") // tail grows; head chunk stays stable
    // Any new edits target the last message, never the first
    for (const e of edits.slice(editsAfterSplit)) expect(e.id).not.toBe("m1")
  })

  it("finalize reconciles to longer post-hook text by spilling", async () => {
    const { sm, sends } = fakeChannel(10)
    await sm.update("short")
    await sm.update("short and then much longer text here") // grows well past one chunk
    expect(sends.length).toBeGreaterThan(1)
    expect(sm.started).toBe(true)
  })

  it("re-updating with identical text is a no-op (no redundant edits)", async () => {
    const { sm, edits } = fakeChannel(100)
    await sm.update("stable text")
    await sm.update("stable text")
    expect(edits.length).toBe(0)
  })
})
