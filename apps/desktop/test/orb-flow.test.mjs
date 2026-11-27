// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import flow from "../dist/orb-flow.js"

const { livePass, caption, opening, pageTokenOf, pickAgent, answerOf, LIVE_WORDS_CAP_MS, LIVE_WORDS_EVERY_MS } = flow

test("C11: one rolling pass at a time, not too often, none past the 30 s cap", () => {
  assert.equal(LIVE_WORDS_CAP_MS, 30_000)
  assert.equal(livePass({ busy: false, recordedMs: 5_000, sinceLastMs: LIVE_WORDS_EVERY_MS }), "pass")
  assert.equal(livePass({ busy: true, recordedMs: 5_000, sinceLastMs: 10_000 }), "skip", "the last pass still runs")
  assert.equal(livePass({ busy: false, recordedMs: 5_000, sinceLastMs: 1_000 }), "skip", "too soon")
  assert.equal(livePass({ busy: false, recordedMs: 30_001, sinceLastMs: 10_000 }), "meter", "past the cap: the meter only")
})

test("C11: the orb page uses the same numbers as the rules", async () => {
  const { readFile } = await import("node:fs/promises")
  const page = await readFile(new URL("../resources/orb/orb.js", import.meta.url), "utf8")
  assert.match(page, new RegExp(`CAP_MS = ${LIVE_WORDS_CAP_MS}\\b`))
  assert.match(page, new RegExp(`EVERY_MS = ${LIVE_WORDS_EVERY_MS}\\b`))
})

test("the live caption keeps the newest words, whole", () => {
  assert.equal(caption("  hello   there "), "hello there")
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")
  const c = caption(long, 40)
  assert.ok(c.startsWith("…"))
  assert.ok(c.endsWith("word59"))
  assert.ok(!/^…\S*\d\S* /.test(c) || c.slice(1).split(" ").every((w) => /^word\d+$/.test(w)), "no cut word")
  assert.ok(c.length <= 41)
})

test("the spoken answer shows its first words, whole", () => {
  assert.equal(opening("Done."), "Done.")
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")
  const o = opening(long, 40)
  assert.ok(o.startsWith("word0 ") && o.endsWith("…"))
  assert.ok(o.slice(0, -1).split(" ").every((w) => /^word\d+$/.test(w)), "no cut word")
})

test("the page token is read from window.AX_LOCAL_TOKEN, nothing else", () => {
  assert.equal(pageTokenOf('<script>window.AX_LOCAL_TOKEN = "abc\\"d";</script>'), 'abc"d')
  assert.equal(pageTokenOf("<html>no token</html>"), "")
  assert.equal(pageTokenOf("window.AX_LOCAL_TOKEN = 42"), "")
})

test("the orb talks to the chosen agent, or the node's first when it is gone", () => {
  const list = [{ id: "secretary", name: "Secretary" }, { id: "coder", name: "Coder" }, { name: "only-name" }, {}]
  assert.deepEqual(pickAgent(list, "coder"), { id: "coder", name: "Coder" })
  assert.deepEqual(pickAgent(list, "gone"), { id: "secretary", name: "Secretary" })
  assert.deepEqual(pickAgent(list, ""), { id: "secretary", name: "Secretary" })
  assert.deepEqual(pickAgent(list, "", "coder"), { id: "coder", name: "Coder" }, "the node's default agent")
  assert.deepEqual(pickAgent(list, "only-name"), { id: "only-name", name: "only-name" })
  assert.equal(pickAgent([], ""), null)
})

test("the answer is read only after the orb's own message", () => {
  const old = [{ role: "user", content: "hi" }, { role: "assistant", status: "done", content: "old answer" }]
  // The orb sent its message as the third one.
  assert.deepEqual(answerOf([...old, { role: "user", content: "now" }], 3), { kind: "working", partial: "" })
  assert.deepEqual(answerOf([...old, { role: "user" }, { role: "assistant", status: "pending", content: "Look" }], 3), { kind: "working", partial: "Look" })
  assert.deepEqual(answerOf([...old, { role: "user" }, { role: "assistant", status: "done", content: "New" }], 3), { kind: "done", text: "New" })
  assert.equal(answerOf([...old, { role: "user" }, { role: "assistant", status: "error", content: "boom" }], 3).kind, "failed")
  assert.equal(answerOf([...old, { role: "user" }, { role: "assistant", status: "done", content: "" }], 3).kind, "failed")
})

test("C11/S2: one speech-to-text pass at a time; a rolling one is dropped, the final one waits", async () => {
  const { oneAtATime } = flow
  const stt = oneAtATime()
  let release
  const order = []
  const rolling = stt.tryRun(() => new Promise((r) => (release = r)).then(() => order.push("rolling")))
  assert.ok(rolling)
  assert.equal(stt.busy(), true)
  assert.equal(stt.tryRun(async () => order.push("dropped")), undefined, "a second rolling pass is dropped")
  const final = stt.run(async () => order.push("final"))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, [], "the final pass waits for the rolling one")
  release()
  await final
  assert.deepEqual(order, ["rolling", "final"])
  assert.equal(stt.busy(), false)
  await assert.rejects(stt.run(async () => { throw new Error("boom") }))
  assert.equal(stt.busy(), false, "a failed pass frees the gate")
  assert.ok(stt.tryRun(async () => 1))
})
