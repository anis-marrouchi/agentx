// How a workflow follows a request: the picture at the top of docs/jobs/follow-up-workflows.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 1130,
  title: "How a workflow follows a request",
  desc:
    "Nine steps in three parts. You ask an agent for something with several steps; the agent starts a workflow, a saved one or one built from your words; you are told which one it chose. " +
    "Then the workflow follows each step on its own: agent steps run one after the other, a slow step gets a reminder, and you approve the message to the client once, on a decision card. The client gets the message, and their reply moves the run on. " +
    "At the end you get one summary with the proof of every step. A step that cannot go on without you is marked blocked and you are told once.",
})

d.header("How a workflow follows a request", "You ask once. AgentX starts each step, reminds whoever is slow, and tells you once.", [
  [C.accent, "You, the owner"],
  [C.ink, "Agents and the client"],
])

// Part 1: the request.
let y = 148
d.band(104, ROW + 64, "YOU ASK")
const ask = d.row(
  [
    { title: ["Ask an agent"], note: ["a request with", "several steps"], who: "accent" },
    { title: ["It starts a workflow"], note: ["a saved one, or one built", "from your words"], who: "ink" },
    { title: ["You see which one"], note: ["unless the workflow is", "marked to start on its own"], who: "accent" },
  ],
  y,
)

// Part 2: the engine follows each step.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "IT FOLLOWS EACH STEP", { tint: C.tintGrey, dx: 48 })
d.wrap(ask.at(-1), d.x0 + 26, y)
const steps = d.row(
  [
    { title: ["Agent steps run"], note: ["each one starts when", "the one before is done"], who: "ink" },
    { title: ["A slow step gets", "a reminder"], note: ["after 30 minutes", "without progress"], who: "ink" },
    { title: ["Approve the message"], note: ["once, on a decision card;", "edit it if you like"], who: "accent" },
  ],
  y,
)
const blockedY = y + ROW + GAP + (ROW - 68) / 2
y += ROW + GAP
d.wrap(steps.at(-1), d.x0 + 26, y)
const client = d.row(
  [
    { title: ["The client gets it"], note: ["a reminder goes out", "if no answer comes"], who: "ink" },
    { title: ["The client replies"], note: ["the reply moves", "the run on"], who: "ink" },
  ],
  y,
  { to: d.x0 + 2 * COL + 20 },
)

// Part 3: one summary.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "YOU HEAR ONCE", { dx: 48 })
d.wrap(client.at(-1), d.x0 + 26, y)
d.row([{ title: ["You get one summary"], note: ["every step with its proof,", "or why it stopped"], who: "accent" }], y, { to: d.x0 + COL })

const end = d.now
d.callout(d.x0 + 2 * COL + 40, blockedY, COL - 20, {
  title: "A step is blocked",
  note: "You are told once.",
  delay: end + 0.4,
})
d.window(d.x0 + COL + 20, y - 12, 2 * COL + 20, 160, {
  title: "Follow-ups · client:example-co",
  rows: [
    ["Release 2.4", "Waiting on your approval", C.accent],
    ["March invoice", "Waiting on a reply", C.warn],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The agent did the steps by hand", "Check the follow-up settings are on."],
    ["Nothing moves after you answer", "Answers are picked up each minute."],
    ["The client never got it", "The channel must be connected here."],
    ["A step stays blocked", "Sort it, or stop the run."],
  ],
  delay: end + 1.6,
})

export default d.svg()
