#!/usr/bin/env node
// Speaks enough of `claude -p --input-format stream-json` for talk-model
// tests: each user message is answered word by word; an interrupt control
// request ends the turn at once, as an error result.
import { createInterface } from "readline"
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
let timer = null
const finish = (err) => { clearInterval(timer); timer = null; out({ type: "result", is_error: err, subtype: err ? "error_during_execution" : "success" }) }
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  if (m.type === "control_request") { out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } }); if (timer) finish(true); return }
  const words = `You said ${m.message.content}. That is all.`.split(" ")
  let i = 0
  timer = setInterval(() => {
    if (i >= words.length) return finish(false)
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: (i ? " " : "") + words[i++] } } })
  }, 15)
})
