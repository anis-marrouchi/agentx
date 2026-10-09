// How a running task is paused with a resume plan and picked up later: the
// picture at the top of docs/jobs/pause-and-resume.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How a task is paused and resumed",
  desc:
    "Six steps in two parts. You, or the agent that handed out the task, ask a running agent to stop. " +
    "AgentX stops the task; it is marked stopped, not failed. The agent gets a short turn to write a resume plan: what is done, what is left, the next action, and anything half-finished. " +
    "If it does not answer in time, AgentX writes a plan from the record of the run. Later you, an agent or a workflow step asks to resume. " +
    "The task runs again in the same chat with its plan placed before the original request.",
})

d.header("How a task is paused and resumed", "Nothing is lost: the plan says where the work got to.", [
  [C.accent, "You, or the agent that asked"],
  [C.ink, "AgentX and the stopped agent"],
])

// Part 1: stop.
let y = 148
d.band(104, ROW + GAP + ROW + 64, "STOP", { tint: C.tintGrey })
const stop = d.row(
  [
    { title: ["Ask it to stop"], note: ["Pause on the Live page,", "agentx signal stop, or a tool"], who: "accent" },
    { title: ["The task stops"], note: ["marked stopped,", "not failed"], who: "ink" },
    { title: ["The agent writes", "a resume plan"], note: ["done, left, next action,", "half-finished"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(stop.at(-1), d.x0 + 26, y)
const saved = d.row(
  [{ title: ["The plan is saved"], note: ["shown under Stopped tasks", "on the Live page"], who: "ink" }],
  y,
  { to: d.x0 + COL },
)
const lateY = y + (ROW - 68) / 2

// Part 2: resume.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 230, "RESUME", { dx: 48 })
d.wrap(saved.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Ask it to resume"], note: ["Resume on the Live page,", "the CLI, a tool or a workflow"], who: "accent" },
    { title: ["It runs again"], note: ["same chat, plan first,", "then the request"], who: "ink" },
  ],
  y,
  { to: d.x0 + 2 * COL + 20 },
)

const end = d.now
d.callout(d.x0 + COL + 20, lateY, COL, {
  title: "No plan in time",
  note: "AgentX writes one from the run.",
  colour: C.warn,
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“is not in signals.allowAgents”", "Only you and the agent that asked may stop it."],
    ["“no running task matches”", "The task already finished."],
    ["“still writing its resume plan”", "Wait a moment, then resume."],
    ["“carried 6 signals today”", "The loop brake: raise signals.maxPerRoot."],
  ],
  delay: end + 1.6,
})

export default d.svg()
