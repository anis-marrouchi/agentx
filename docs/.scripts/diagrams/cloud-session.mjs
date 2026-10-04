// How a GitHub task becomes a Claude cloud session: the picture at the top
// of docs/jobs/cloud-sessions.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 1170,
  title: "How a GitHub task becomes a Claude cloud session",
  desc:
    "Ten steps in three parts. You prepare: keep a clone of the repository on the computer, point the project file at it, turn the setting on for the agent and for the GitHub channel. " +
    "A task arrives: someone opens an issue, AgentX checks the rules and starts a cloud session with claude --cloud, then posts the session id and link on the issue. " +
    "The session works in a copy of the repository and opens a pull request; you review it. Comments on the issue reach the session while it is open. " +
    "When the launch fails, the task runs on the computer as before and the reason is logged.",
})

d.header("How a GitHub task becomes a cloud session", "You prepare once. The work happens away from your computer.", [
  [C.accent, "You, the owner"],
  [C.ink, "AgentX and the cloud session"],
])

// Part 1: you prepare.
let y = 148
d.band(104, ROW + 64, "YOU PREPARE")
const prepare = d.row(
  [
    { title: ["Keep a clone of the", "repository on the computer"], note: ["its origin is on github.com"] },
    { title: ["Point the project file", "at the clone"], note: [".agentx/projects/<owner>/<repo>.yaml", "runbook: the clone's path"] },
    { title: ["Turn the setting on"], note: ["agent: cloudSessions.enabled", "channel: github.cloudSessions"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: a task arrives.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "A TASK ARRIVES", { tint: C.tintGrey, dx: 48 })
d.wrap(prepare.at(-1), d.x0 + 26, y)
const arriveA = d.row(
  [
    { title: ["Someone opens an issue"], note: ["or comments on one, on GitHub"], who: "ink" },
    { title: ["AgentX checks the rules"], note: ["GitHub channel, agent on,", "clone found: go to the cloud"], who: "ink" },
    { title: ["claude --cloud starts", "a session"], note: ["on a copy of the repository,", "away from your computer"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(arriveA.at(-1), d.x0 + 26, y)
const arriveB = d.row(
  [
    { title: ["The issue gets a comment"], note: ["the session id and its link,", "also kept on the task trace"], who: "ink" },
    { title: ["The session opens", "a pull request"], note: ["it references the issue"], who: "ink" },
  ],
  y,
  { to: twoColumns },
)
const failY = y + (ROW - 68) / 2

// Part 3: you follow up.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 296, "YOU FOLLOW UP", { dx: 48 })
d.wrap(arriveB.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Review the pull request"], note: ["as you would any other"], who: "accent" },
    { title: ["Comment on the issue", "to steer the session"], note: ["forwarded while the session", "is open (24 hours by default)"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, failY, COL, {
  title: "The launch fails",
  note: "It runs on the computer; the log says why.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Issue #42",
  rows: [
    ["Started a cloud session", "session link", C.accent],
    ["Pull request #43 opened", "Ready for review", C.done],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["Everything still runs locally", "Both settings must be on; check the trace."],
    ["“no checkout of owner/repo”", "The clone's origin must be that repository."],
    ["“did not print a session”", "Run claude --cloud by hand in the clone."],
    ["A second run started", "The session's open time has passed."],
  ],
  delay: end + 1.6,
})

export default d.svg()
