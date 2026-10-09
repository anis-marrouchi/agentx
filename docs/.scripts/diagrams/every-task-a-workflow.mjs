// How a task runs when every task goes through a workflow: the picture at the top of docs/jobs/every-task-a-workflow.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 920,
  title: "How a task runs through a workflow",
  desc:
    "Seven steps in three parts. You turn the setting on, then ask an agent for something. " +
    "AgentX picks the workflow: a saved workflow that fits your request, else a plan the agent writes first, else a single step. " +
    "The agent works through the steps and reports each one; it may change the steps it has left, and the change is kept. " +
    "Every run is recorded step by step, with how long each took and where it failed, and the Live page shows the step each agent is on. " +
    "A plain question that changed nothing leaves no run.",
})

d.header("How a task runs through a workflow", "Every piece of work gets a plan, a follow-up and a record.", [
  [C.accent, "You, the owner"],
  [C.ink, "The agent and AgentX"],
])

// Part 1: the setting and the request.
let y = 148
d.band(104, ROW + 64, "YOU ASK")
const ask = d.row(
  [
    { title: ["Turn the setting on"], note: ["once, for every agent", "or for one"], who: "accent" },
    { title: ["Ask an agent"], note: ["in your own words,", "as usual"], who: "accent" },
    { title: ["AgentX picks one"], note: ["a saved workflow that fits,", "else a plan, else one step"], who: "ink" },
  ],
  y,
)

// Part 2: the work.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THE AGENT WORKS THROUGH IT", { tint: C.tintGrey, dx: 48 })
d.wrap(ask.at(-1), d.x0 + 26, y)
const work = d.row(
  [
    { title: ["It writes a plan"], note: ["the steps, before", "it starts"], who: "ink" },
    { title: ["It reports each step"], note: ["and may change the", "steps it has left"], who: "ink" },
    { title: ["You see the step"], note: ["on the Live page,", "per agent"], who: "accent" },
  ],
  y,
)

// Part 3: the record.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "IT LEAVES A RECORD", { dx: 48 })
d.wrap(work.at(-1), d.x0 + 26, y)
d.row([{ title: ["Every run is recorded"], note: ["steps, times, and", "where it failed"], who: "ink" }], y, { to: d.x0 + COL })

const end = d.now
d.window(d.x0 + COL + 20, y - 12, 2 * COL + 20, 160, {
  title: "Live · demo agent",
  rows: [
    ["workflow", "step Rename the report (2/3)", C.accent],
    ["plain question", "no run: nothing was changed", C.ink],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No run is recorded", "Check the engine and the setting are on."],
    ["The agent wrote no plan", "One-step tasks need none."],
    ["A question left a run", "It used a tool that changes things."],
    ["One agent should skip it", "Turn it off for that agent."],
  ],
  delay: end + 1.6,
})

export default d.svg()
