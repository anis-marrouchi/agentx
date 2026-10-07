// How a tracked plan runs: the picture at the top of docs/jobs/tracked-plans.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 932,
  title: "How a tracked plan runs",
  desc:
    "Eight steps in three parts, and one exception. You ask for work that takes several steps; the agent writes a plan with a name, an owner and a done check for each step; you approve the client message once, on a card. " +
    "The agents work: the first step is built, the next step is handed to its agent, and the daemon checks the release is live. A step that goes quiet is nudged, then reported to you as blocked. " +
    "The daemon sends the approved message to the client without asking again, and you get one summary at the end.",
})

d.header("How a tracked plan runs", "You approve once. The daemon follows every step and tells you at the end.", [
  [C.accent, "You, the owner"],
  [C.ink, "The agents and the daemon"],
])

// Part 1: the request becomes a plan.
let y = 148
d.band(104, ROW + 64, "YOU ASK, ONCE")
const ask = d.row(
  [
    { title: ["Ask for the work"], note: ["build it, ship it,", "tell the client"], who: "accent" },
    { title: ["The agent writes", "the plan"], note: ["name, owner, done check"], who: "ink" },
    { title: ["Approve the client", "message"], note: ["one card, text editable"], who: "accent" },
  ],
  y,
)

// Part 2: the agents work, the daemon watches.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THE AGENTS WORK, THE DAEMON WATCHES", { tint: C.tintGrey, dx: 48 })
d.wrap(ask.at(-1), d.x0 + 26, y)
const work = d.row(
  [
    { title: ["Step 1 is built"], note: ["the agent reports it done,", "with the proof"] },
    { title: ["Step 2 is handed on"], note: ["the daemon starts a turn", "on its agent"] },
    { title: ["Live check passes"], note: ["the daemon reads the", "address it was given"] },
  ],
  y,
  { who: "ink" },
)

// Part 3: the end.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "THE PLAN FINISHES", { dx: 48 })
d.wrap(work.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Message sent", "to the client"], note: ["the approved text, once"], who: "ink" },
    { title: ["One summary for you"], note: ["every step and its proof;", "the request closes"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, y + (ROW - 68) / 2, COL, {
  title: "A step goes quiet",
  note: "Nudged, then reported as blocked.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No plan is made", "Turn requests on; plans need them."],
    ["A step is blocked", "Answer the agent, or retry the step."],
    ["The message did not go", "The card is unanswered, or expired."],
    ["Nudges come too soon", "Raise the stall time."],
  ],
  delay: end + 1.6,
})

export default d.svg()
