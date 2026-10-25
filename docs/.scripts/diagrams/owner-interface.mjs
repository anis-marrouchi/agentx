// The four parts of the owner interface: the picture at the top of docs/architecture/patterns.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high: taller than the kit's 136 so the
// two-line notes under two-line titles keep a margin above the card's edge.
const ROW = 152

const d = createDiagram({
  height: 736,
  title: "How work reaches you: Promise, Fact, Reach and Desk",
  desc:
    "Six steps in two parts. An agent makes a Promise: who owes what to whom, by when, and the proof that closes it. " +
    "Proof closes it: a link, a test, an output or a check. Closing writes a Fact: what is true, its source and when it was checked. " +
    "Each change is recorded on the request or its card. Reach picks the one channel where you were last seen, waits, and tries the next one if you did not see it. " +
    "You read one list, the Desk, on any surface. Two switches are off by default, and one fix (issue 1214) is merged but not yet proven live.",
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
  { who: "ink", h: ROW },
)

// Part 2: the controller and the view, wired by the event bus.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "REACH AND DESK: THE CONTROLLER AND THE VIEW", { tint: C.tintGrey, dx: 48 })
d.wrap(model.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The change is", "recorded"], note: ["on the request", "or its card"], who: "ink" },
    { title: ["Reach picks", "one channel"], note: ["where you were last seen;", "unseen, it tries the next"], who: "ink" },
    { title: ["You read one list"], note: ["the Desk, on the phone,", "the Mac or the dashboard"], who: "accent" },
  ],
  y,
  { h: ROW },
)

d.list(d.x0, y + ROW + 64, {
  title: "STATUS (EPIC #1138, CLOSED)",
  columns: 2,
  items: [
    ["Urgent ladder is off", "Your switch: notifications.reach.enabled."],
    ["Promise catch is off", "Your switch: requests.catchPromises.enabled."],
    ["Due work: fix not proven", "Fixed in #1218, not yet proven live."],
    ["Steps C, D and F shipped", "See the table below for each step."],
  ],
  delay: d.now + 1.4,
})

export default d.svg()
