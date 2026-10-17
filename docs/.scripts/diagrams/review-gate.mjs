// How the pre-merge review gate checks an agent's pull request: the picture
// at the top of docs/jobs/review-gate.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 1170,
  title: "How the review gate checks an agent's pull request",
  desc:
    "Ten steps in three parts. You prepare: pick a reviewer agent that is not the one writing the code, turn the gate on, and link every pull request to its issue. " +
    "A pull request arrives: an agent opens it or pushes to it, AgentX marks the commit pending, waits for CI, and gives a reviewer in a fresh session only the issue, its acceptance criteria, the diff and the CI result. " +
    "The reviewer's verdict becomes the agentx/review status on that commit: success, failure with a comment listing what is missing, or error. You read the status before you merge; a new push starts a new review. " +
    "A pull request with no linked issue fails at once.",
})

d.header("How the review gate checks a pull request", "A second agent reads the change against the issue, before you merge.", [
  [C.accent, "You, the owner"],
  [C.ink, "AgentX and the agents"],
])

// Part 1: you prepare.
let y = 148
d.band(104, ROW + 64, "YOU PREPARE")
const prepare = d.row(
  [
    { title: ["Pick a reviewer agent"], note: ["not the agent that writes", "the code; ideally another model"] },
    { title: ["Turn the gate on"], note: ["quality.reviewGate.enabled", "in agentx.json"] },
    { title: ["Link each PR to its issue"], note: ["“Closes #12” in the", "pull request description"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: a pull request arrives.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "A PULL REQUEST ARRIVES", { tint: C.tintGrey, dx: 48 })
d.wrap(prepare.at(-1), d.x0 + 26, y)
const arriveA = d.row(
  [
    { title: ["An agent opens or", "pushes to a pull request"], note: ["GitHub tells AgentX"], who: "ink" },
    { title: ["The commit shows", "agentx/review pending"], note: ["AgentX waits for CI", "to finish"], who: "ink" },
    { title: ["The reviewer starts", "in a fresh session"], note: ["it gets the issue, its criteria,", "the diff and CI: nothing else"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(arriveA.at(-1), d.x0 + 26, y)
const arriveB = d.row(
  [
    { title: ["The verdict becomes", "the commit's status"], note: ["success, failure or error,", "cost and time kept on the node"], who: "ink" },
    { title: ["A failure gets a comment"], note: ["unmet criteria, and defects", "by file and line"], who: "ink" },
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
    { title: ["Read agentx/review", "before you merge"], note: ["on the pull request's", "checks list"], who: "accent" },
    { title: ["A new push starts", "a new review"], note: ["an earlier approval never", "covers the new commit"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, failY, COL, {
  title: "No linked issue",
  note: "Fails with “no linked issue/ACs”.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Pull request #43",
  rows: [
    ["ci", "Passed", C.done],
    ["agentx/review", "approved against #42", C.done],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No agentx/review status", "Only agent PRs are reviewed; check the log."],
    ["“no reviewer agent set”", "Set quality.reviewGate.reviewer.agent."],
    ["“over budget”", "Raise maxMinutes or maxCostPerReview."],
    ["“reviewer … is the PR's author”", "Pick a different reviewer agent."],
  ],
  delay: end + 1.6,
})

export default d.svg()
