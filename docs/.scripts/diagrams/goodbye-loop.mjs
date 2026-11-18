// How the courtesy-close gate ends a goodbye loop: the picture at the top
// of docs/jobs/stop-goodbye-loops.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 820,
  title: "How AgentX ends a goodbye loop",
  desc:
    "Two parties in one chat: your agent and the other side, which may be another company's agent. " +
    "While they talk, every message goes to your agent. The other side says thanks and goodbye; the talk is ending, and your agent answers once. " +
    "That one goodbye ends the talk. Further thanks are not passed to your agent; a person gets a small reaction instead. A real message opens the talk again.",
})

d.header("How AgentX ends a goodbye loop", "One goodbye from your agent, then quiet. A real message opens the talk again.", [
  [C.accent, "Your agent"],
  [C.ink, "The other side"],
])

let y = 148
d.band(104, 2 * ROW + GAP + 64, "THE TALK")
const talk = d.row(
  [
    { title: ["They write"], note: ["a question, a request"], who: "ink" },
    { title: ["Your agent answers"], note: ["as always"], who: "accent" },
    { title: ["They say thanks", "and goodbye"], note: ["the talk is ending"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(talk.at(-1), d.x0 + 26, y)
const bye = d.row(
  [{ title: ["Your agent says", "goodbye, once"], note: ["that reply ends the talk"], who: "accent" }],
  y,
  { to: d.x0 + COL },
)

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "AFTER THE END", { tint: C.tintGrey, dx: 48 })
d.wrap(bye.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["More thanks arrive"], note: ["not passed to your agent;", "kept in the gate log"], who: "ink" },
    { title: ["A person thanks you"], note: ["gets a thanks reaction,", "no text, no run"], who: "ink" },
    { title: ["A real message"], note: ["opens the talk again"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["A message was held by mistake", "agentx situation release <row>"],
    ["Nothing is ever held", "Mode is shadow: it only logs."],
  ],
  delay: end + 0.6,
})

export default d.svg()
