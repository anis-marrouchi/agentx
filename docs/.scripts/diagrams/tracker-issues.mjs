// How a Linear or Jira issue reaches an agent and comes back as a reviewed
// pull request: the picture at the top of docs/jobs/linear-jira.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 1170,
  title: "How a Linear or Jira issue becomes a reviewed pull request",
  desc:
    "Ten steps in three parts. You prepare: set the API key and webhook secret, route a Linear team or Jira project to an agent, and point Linear or Jira's webhook at AgentX. " +
    "An issue is labelled: someone adds the agentx label, the signed webhook reaches AgentX, and the route's agent works on the issue in a worktree of its own. " +
    "The agent opens a pull request that says Fixes and the issue key, and its reply is posted on the issue as a comment. " +
    "You read the review gate's verdict, which checks the pull request against the issue's acceptance criteria, before you merge. An unsigned webhook is refused.",
})

d.header("How a Linear or Jira issue gets done", "Label the issue; an agent does the work; the review gate checks it.", [
  [C.accent, "You, the owner"],
  [C.ink, "AgentX and the agent"],
])

// Part 1: you prepare.
let y = 148
d.band(104, ROW + 64, "YOU PREPARE")
const prepare = d.row(
  [
    { title: ["Set the key and secret"], note: ["environment variables,", "never in agentx.json"] },
    { title: ["Route a team or project"], note: ["trackers.linear.routes or", "trackers.jira.routes → an agent"] },
    { title: ["Point the webhook", "at AgentX"], note: ["/webhook/linear or", "/webhook/jira, with the secret"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: an issue is labelled.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "AN ISSUE IS LABELLED", { tint: C.tintGrey, dx: 48 })
d.wrap(prepare.at(-1), d.x0 + 26, y)
const arriveA = d.row(
  [
    { title: ["Someone adds the", "agentx label"], note: ["in Linear or Jira"], who: "ink" },
    { title: ["AgentX checks the", "signature and the route"], note: ["the issue's team or project", "names the agent"], who: "ink" },
    { title: ["The agent works on it"], note: ["in a worktree of its own,", "on the branch agentx/<key>"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(arriveA.at(-1), d.x0 + 26, y)
const arriveB = d.row(
  [
    { title: ["It opens a pull request"], note: ["the description says", "“Fixes ENG-12”"], who: "ink" },
    { title: ["Its reply lands on", "the issue"], note: ["as a comment"], who: "ink" },
  ],
  y,
  { to: twoColumns },
)
const failY = y + (ROW - 68) / 2

// Part 3: you merge.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 296, "YOU MERGE", { dx: 48 })
d.wrap(arriveB.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The review gate checks", "it against the issue"], note: ["the issue's acceptance", "criteria, the diff and CI"], who: "ink" },
    { title: ["Read agentx/review", "before you merge"], note: ["on the pull request's", "checks list"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, failY, COL, {
  title: "Not signed",
  note: "Refused: the secret is the only gate.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Pull request #43",
  rows: [
    ["ci", "Passed", C.done],
    ["agentx/review", "approved against ENG-12", C.done],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["Nothing happens", "Check the label and the route's key."],
    ["“no webhook secret”", "Set the secret's variable and restart."],
    ["“no route for …”", "Add the team or project to routes."],
    ["No comment on the issue", "Check the API key; the log says why."],
  ],
  delay: end + 1.6,
})

export default d.svg()
