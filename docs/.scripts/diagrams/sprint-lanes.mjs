// How sprint lanes run: the picture at the top of docs/jobs/sprint-lanes.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 932,
  title: "How sprint lanes run",
  desc:
    "Eight steps in three parts, and one exception. A lead agent writes a sprint: lanes side by side, each with one agent and a list of issues, and hands it to AgentX. " +
    "AgentX gives each lane its first issue; when a lane's turn ends, AgentX gives that lane its next issue, passing over held ones. " +
    "A lane whose turn fails, or that sits idle with issues left, is told to you once. When every lane is done you get one summary.",
})

d.header("How sprint lanes run", "The queue lives in AgentX, not in an agent's memory.", [
  [C.accent, "You, the owner"],
  [C.ink, "The agents and the daemon"],
])

// Part 1: the plan becomes a sprint.
let y = 148
d.band(104, ROW + 64, "THE LEAD HANDS OVER THE SPRINT")
const start = d.row(
  [
    { title: ["Ask for a sprint"], note: ["a list of issues", "to work through"], who: "accent" },
    { title: ["The lead writes", "the lanes"], note: ["one agent, issues in order"], who: "ink" },
    { title: ["AgentX keeps", "the queue"], note: ["the lead may stop now"], who: "ink" },
  ],
  y,
)

// Part 2: the lanes work.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "EACH LANE WORKS ITS ISSUES IN ORDER", { tint: C.tintGrey, dx: 48 })
d.wrap(start.at(-1), d.x0 + 26, y)
const work = d.row(
  [
    { title: ["First issue", "handed out"], note: ["one turn per lane"] },
    { title: ["The turn ends"], note: ["the agent posts its", "result on the issue"] },
    { title: ["Next issue", "handed out"], note: ["held issues wait"] },
  ],
  y,
  { who: "ink" },
)

// Part 3: the end.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "THE SPRINT FINISHES", { dx: 48 })
d.wrap(work.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Every lane", "is done"], note: ["issues done or skipped"], who: "ink" },
    { title: ["One summary for you"], note: ["each lane and", "what it finished"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, y + (ROW - 68) / 2, COL, {
  title: "A lane stops",
  note: "Failed or idle: you are told once.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The sprint is refused", "An agent is not on this node."],
    ["A lane is blocked", "Retry or skip its issue."],
    ["A lane sits idle", "Release its held issues."],
    ["Nothing is handed out", "Turn requests on."],
  ],
  delay: end + 1.6,
})

export default d.svg()
