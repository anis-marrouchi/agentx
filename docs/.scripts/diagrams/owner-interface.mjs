// The four parts of the owner interface: the picture at the top of docs/architecture/patterns.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high.
const ROW = 136

const d = createDiagram({
  height: 704,
  title: "How work reaches you: Promise, Fact, Reach and Desk",
  desc:
    "Six steps in two parts. An agent makes a Promise: who owes what to whom, by when, and the proof that closes it. " +
    "Proof closes it: a link, a test, an output or a check. Closing writes a Fact: what is true, its source and when it was checked. " +
    "Each change goes on the event bus; the request and card events are added in step 1. Reach picks the one channel where you were last seen, waits, and tries the next one if you did not see it. " +
    "You read one list, the Desk, on any surface. Four links are still missing and are built in steps 1 to 4 of issue 1137.",
})

d.header("How work reaches you", "Promise and Fact are the model, Reach the controller, Desk the view.", [
  [C.accent, "You, the owner"],
  [C.ink, "Your agents"],
])

// Part 1: the model of work and the model of truth.
let y = 148
d.band(104, ROW + 64, "PROMISE AND FACT: THE MODEL")
const model = d.row(
  [
    { title: ["An agent makes", "a Promise"], note: ["owner, owed to, due,", "the proof that closes it"] },
    { title: ["Proof closes it"], note: ["a link, a test,", "an output or a check"] },
    { title: ["A Fact is written"], note: ["the claim, its source,", "when it was checked"] },
  ],
  y,
  { who: "ink" },
)

// Part 2: the controller and the view, wired by the event bus.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "REACH AND DESK: THE CONTROLLER AND THE VIEW", { tint: C.tintGrey, dx: 48 })
d.wrap(model.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The change goes", "on the event bus"], note: ["request and card events,", "added in step 1"], who: "ink" },
    { title: ["Reach picks", "one channel"], note: ["where you were last seen;", "unseen, it tries the next"], who: "ink" },
    { title: ["You read one list"], note: ["the Desk, on the phone,", "the Mac or the dashboard"], who: "accent" },
  ],
  y,
)

d.list(d.x0, y + ROW + 64, {
  title: "NOT WIRED YET (ISSUE #1137)",
  columns: 2,
  items: [
    ["Four surfaces, four queries", "Step 1: one owner queue."],
    ["Sent is not seen", "Step 2: presence, seen and dead channels."],
    ["Promises only when asked", "Step 3: read them from the reply."],
    ["Closing writes no Fact", "Step 4: one Promise, one Proof."],
  ],
  delay: d.now + 1.4,
})

export default d.svg()
