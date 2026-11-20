// Every line the daemon writes to stdout or stderr starts with an ISO-8601
// UTC time (#2006). launchd sends both streams straight to
// ~/.agentx/logs/daemon-{stdout,stderr}.log, so this is the one place a time
// can be added for console.log, console.error, the Logger and child output
// the daemon passes through alike.

import { StringDecoder } from "string_decoder"

const INSTALLED = Symbol.for("agentx.logTimestamps")

/** Returns a function that puts `now()` at the start of every line of the
 *  text it is given. It remembers whether the last text ended mid-line, so a
 *  line written in several pieces gets one time, at its start. */
export function createLineStamper(now: () => string = () => new Date().toISOString()): (text: string) => string {
  let atLineStart = true
  return (text: string): string => {
    if (!text) return text
    const time = now()
    const parts = text.split("\n")
    let out = ""
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      if (isLast && parts[i] === "") break // the text ended with a newline
      out += (atLineStart ? `${time} ` : "") + parts[i]
      if (isLast) {
        atLineStart = false
      } else {
        out += "\n"
        atLineStart = true
      }
    }
    return out
  }
}

/** Wraps `stream.write` so every line gets a time. Safe to call twice. */
export function installLogTimestamps(stream: NodeJS.WriteStream, now?: () => string): void {
  const marked = stream as NodeJS.WriteStream & { [INSTALLED]?: boolean }
  if (marked[INSTALLED]) return
  marked[INSTALLED] = true
  const stamp = createLineStamper(now)
  const decoder = new StringDecoder("utf8")
  const original = stream.write.bind(stream) as (chunk: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => boolean
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
    if (typeof encoding === "function") {
      cb = encoding
      encoding = undefined
    }
    const text = typeof chunk === "string"
      ? (encoding && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(chunk, encoding).toString("utf8") : chunk)
      : decoder.write(Buffer.from(chunk))
    return original(stamp(text), "utf8", cb)
  }) as typeof stream.write
}
