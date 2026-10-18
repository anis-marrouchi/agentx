// How a release soaks here before it reaches a second machine: the picture at
// the top of docs/jobs/canary-soak.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 860,
  title: "How a release soaks before it reaches a second machine",
  desc:
    "Six steps in two parts. On this machine: build the release, restart the daemon on it, and let it run for the soak time while AgentX counts restarts, crashes and failed tasks. " +
    "Then the deploy: agentx daemon deploy checks the soak, copies the same release to the second machine, and that machine restarts when idle. " +
    "A release that is still soaking or failed is refused, with the time left or the failed check.",
})

d.header("A release soaks before it travels", "It runs here first. Only a release that stayed healthy is copied on.", [
  [C.accent, "This machine (you)"],
  [C.ink, "The second machine"],
])

// Part 1: the soak on this machine.
let y = 148
d.band(104, ROW + 64, "IT RUNS HERE FIRST")
const soak = d.row(
  [
    { title: ["Build the release"], note: ["commit, then build;", "the commit is the release"] },
    { title: ["Restart this daemon", "on it"], note: ["agentx daemon restart", "--when-idle"] },
    { title: ["It soaks for 2 hours"], note: ["restarts, crashes and", "failed tasks are counted"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: the deploy.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THEN IT TRAVELS", { tint: C.tintGrey, dx: 48 })
d.wrap(soak.at(-1), d.x0 + 26, y, { label: "Passed" })
d.row(
  [
    { title: ["Run the deploy"], note: ["agentx daemon deploy", "checks the soak first"], who: "accent" },
    { title: ["The same release", "is copied"], note: ["nothing else changes", "on the way"], who: "accent" },
    { title: ["It restarts", "when idle"], note: ["no running task", "is cut off"], who: "ink" },
  ],
  y,
)

const end = d.now
d.callout(d.x0, y + ROW + 48, COL, {
  title: "Still soaking, or failed",
  note: "The deploy stops and says why.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 164, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“soaking: 75 min left”", "Wait, then run the deploy again."],
    ["“failed: crashes …”", "Fix it, commit, and soak the new release."],
    ["“has not run on this daemon”", "Restart this daemon on that commit."],
    ["“uncommitted changes”", "Commit first: a release is a commit."],
  ],
  delay: end + 1.2,
})

export default d.svg()
