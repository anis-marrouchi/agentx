// How a task watcher works: the picture at the top of docs/jobs/task-watchers.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 780,
  title: "How a task watcher works",
  desc:
    "Six steps in two parts, and one exception. An agent hands work on with a due time; the daemon decides whether the task needs watching; one watcher is attached and recorded on the task. " +
    "If the run doing the work ends with no result, or the due time passes, the agent that handed the work on is told first, and you are told 30 minutes later if it is still not done. " +
    "When the work finishes in time, nothing is sent.",
})

d.header("How a task watcher works", "Work that has a due time is never dropped in silence.", [
  [C.accent, "You, the owner"],
  [C.ink, "The agents and the daemon"],
])

// Part 1: the task starts.
let y = 148
d.band(104, ROW + 64, "THE TASK STARTS")
const start = d.row(
  [
    { title: ["An agent hands", "work on"], note: ["with a due time"] },
    { title: ["The daemon decides"], note: ["a due time, a promise", "or a hand-off?"] },
    { title: ["A watcher is attached"], note: ["one per task,", "recorded on it"] },
  ],
  y,
  { who: "ink" },
)

// Part 2: the watcher waits.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 304, "THE WATCHER WAITS", { tint: C.tintGrey, dx: 48 })
d.wrap(start.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The run ends with", "no result"], note: ["or the due time passes"], who: "ink" },
    { title: ["The agent that", "handed it on is told"], note: ["finish it or re-assign it"], who: "ink" },
    { title: ["You are told"], note: ["30 minutes later,", "if it is still not done"], who: "accent" },
  ],
  y,
)
const end = d.now
d.callout(d.x0, y + ROW + 32, 2 * COL, {
  title: "The work finishes in time",
  note: "The watcher closes. Nothing is sent.",
  colour: C.done,
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 128, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No watcher is attached", "Turn watchers on; check the sources."],
    ["You hear too soon", "Raise the escalation time."],
    ["You get no alert", "Check your notification channel."],
    ["Too many watchers", "Set the task-watch seat to active."],
  ],
  delay: end + 1.6,
})

export default d.svg()
