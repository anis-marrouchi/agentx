// How the merge policy sorts a pull request into core and edge: the picture
// at the top of docs/jobs/merge-policy.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 1000,
  title: "How the merge policy sorts a pull request",
  desc:
    "Seven steps in three parts. You prepare: list your core folders, turn the policy on, and make agentx/merge-policy a required check. " +
    "A pull request arrives: an agent opens it or pushes to it, and AgentX reads the changed files. An edge-only pull request gets success at once and merges on green CI. " +
    "A pull request that touches a core path gets the core-change label and stays pending until a person approves its latest commit; then it turns green and merges on green CI. A new push asks for a new approval.",
})

d.header("Core needs a person, edge merges itself", "AgentX sorts each pull request by the files it changes.", [
  [C.accent, "You, the owner"],
  [C.ink, "AgentX and the agents"],
])

// Part 1: you prepare.
let y = 148
d.band(104, ROW + 64, "YOU PREPARE")
const prepare = d.row(
  [
    { title: ["List your core folders"], note: ["quality.mergePolicy.corePaths", "in agentx.json"] },
    { title: ["Turn the policy on"], note: ["quality.mergePolicy.enabled", "then restart the daemon"] },
    { title: ["Require the check"], note: ["agentx/merge-policy in the", "branch rules on GitHub"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: a pull request arrives.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "A PULL REQUEST ARRIVES", { tint: C.tintGrey, dx: 48 })
d.wrap(prepare.at(-1), d.x0 + 26, y)
const arrive = d.row(
  [
    { title: ["An agent opens or", "pushes to a pull request"], note: ["GitHub tells AgentX"], who: "ink" },
    { title: ["AgentX reads the", "changed files"], note: ["each one is core or edge"], who: "ink" },
    { title: ["Edge only: success"], note: ["merges on green CI,", "as before"], who: "ink" },
  ],
  y,
)

// Part 3: a core change waits for you.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "A CORE CHANGE WAITS FOR YOU", { dx: 48 })
d.wrap(arrive.at(-1), d.x0 + 26, y, { label: "Touches core" })
d.row(
  [
    { title: ["Labeled core-change,", "status pending"], note: ["auto-merge waits"], who: "ink" },
    { title: ["You approve the", "latest commit"], note: ["a review on GitHub"], who: "accent" },
    { title: ["Status turns green"], note: ["merges on green CI;", "a new push asks again"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No agentx/merge-policy status", "Check enabled, and the webhook events."],
    ["Approved but still pending", "Approve the latest commit, not an older one."],
    ["A core PR merged anyway", "Make the check required on GitHub."],
    ["“check failed: …”", "GitHub did not answer; edit the PR to retry."],
  ],
  delay: end + 1.2,
})

export default d.svg()
