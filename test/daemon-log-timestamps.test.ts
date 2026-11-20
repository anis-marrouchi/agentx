import { describe, expect, it } from "vitest"
import { Writable } from "stream"
import { createLineStamper, installLogTimestamps } from "../src/daemon/log-timestamps"
import { readLessons } from "../src/voice/lesson-log"

const T = "2026-11-20T02:00:00.000Z"

function fakeStream(): { stream: NodeJS.WriteStream; out: () => string } {
  let written = ""
  const w = new Writable({ write(chunk, _enc, cb) { written += chunk.toString("utf8"); cb() } })
  return { stream: w as unknown as NodeJS.WriteStream, out: () => written }
}

describe("createLineStamper", () => {
  it("puts the time at the start of every line, including each line of a multi-line error", () => {
    const stamp = createLineStamper(() => T)
    expect(stamp("Error: boom\n    at a (x.ts:1)\n    at b (y.ts:2)\n")).toBe(
      `${T} Error: boom\n${T}     at a (x.ts:1)\n${T}     at b (y.ts:2)\n`,
    )
  })

  it("gives a line written in pieces one time, at its start", () => {
    const stamp = createLineStamper(() => T)
    expect(stamp("[agentx] step ") + stamp("agent ") + stamp("done\nnext")).toBe(`${T} [agentx] step agent done\n${T} next`)
  })

  it("leaves empty text alone", () => {
    expect(createLineStamper(() => T)("")).toBe("")
  })
})

describe("installLogTimestamps", () => {
  it("stamps strings and buffers written to the stream, and installs once", () => {
    const { stream, out } = fakeStream()
    installLogTimestamps(stream, () => T)
    installLogTimestamps(stream, () => "twice")
    stream.write("child said hi\n")
    stream.write(Buffer.from("é".repeat(2)).subarray(0, 3)) // a character split across writes
    stream.write(Buffer.from("é".repeat(2)).subarray(3))
    stream.write("\n")
    expect(out()).toBe(`${T} child said hi\n${T} éé\n`)
  })

  it("keeps the callback forms of write working", async () => {
    const { stream, out } = fakeStream()
    installLogTimestamps(stream, () => T)
    await new Promise<void>((done) => stream.write("a\n", () => done()))
    await new Promise<void>((done) => stream.write("b\n", "utf8", () => done()))
    expect(out()).toBe(`${T} a\n${T} b\n`)
  })

  it("keeps `agentx voice lessons` able to read a stamped log", () => {
    const stamp = createLineStamper(() => T)
    const line = "[agentx] [teach] 2026-11-20T01:59:00.000Z coder-agent (teach): open the board\n"
    const log = stamp(line)
    expect(log.startsWith(`${T} [agentx] [teach]`)).toBe(true)
    const lessons = readLessons(log)
    expect(lessons).toHaveLength(1)
    expect(lessons).toEqual(readLessons(line))
    expect(lessons[0]).toMatchObject({ agentId: "coder-agent", mode: "teach", goal: "open the board" })
  })
})
