// How spec tests reach a pull request: the picture at the top of
// docs/jobs/spec-tests.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 870,
  title: "How spec tests reach a pull request",
  desc:
    "Seven steps in two parts. An issue that names a pilot path, such as src/daemon, arrives and goes to a Claude cloud session. " +
    "At the same time AgentX starts a separate test agent on a clean copy of the repository, with the issue text only. " +
    "The test agent writes a test file; AgentX commits it under the test agent's name and pushes it to the spec-tests branch. " +
    "The coding session merges that branch, runs the tests, and records in the pull request which failures were code defects and which were test misreads. " +
    "When the budget runs out, the test agent stops and a note is left on the issue.",
})

d.header("How spec tests reach a pull request", "Two agents, one issue. The test agent never sees the code.", [
  [C.accent, "The coding agent"],
  [C.ink, "The test agent and AgentX"],
])

// Part 1: an issue arrives.
let y = 148
d.band(104, ROW + 64, "AN ISSUE ARRIVES", { tint: C.tintGrey })
const arrive = d.row(
  [
    { title: ["An issue names", "a pilot path"], note: ["for example src/daemon"], who: "ink" },
    { title: ["A cloud session", "writes the code"], note: ["the coding agent, as before"], who: "accent" },
    { title: ["The test agent writes", "tests at the same time"], note: ["clean copy, issue text only,", "no shell, no network"], who: "ink" },
  ],
  y,
)

// Part 2: tests meet the code.
const band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "TESTS MEET THE CODE", { dx: 48 })
d.wrap(arrive.at(-1), d.x0 + 26, y)
const meetA = d.row(
  [
    { title: ["AgentX commits and pushes"], note: ["test: spec tests for #N", "to spec-tests/issue-N"], who: "ink" },
    { title: ["The session merges", "the branch"], note: ["the commit keeps the", "test agent as its author"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)
const stopY = y + (ROW - 68) / 2
y += ROW + GAP
d.wrap(meetA.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["A failing spec test", "is a finding"], note: ["fix the code, or show", "the test misreads the issue"], who: "accent" },
    { title: ["The pull request", "records the call"], note: ["written, failed, code defects,", "test misreads"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, stopY, COL, {
  title: "The budget runs out",
  note: "It stops and leaves a note.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No spec-tests branch appeared", "The log line [spec-tests] says why."],
    ["“names none of the pilot paths”", "The issue must name a path in paths."],
    ["“is the coding agent”", "Give the test agent another name."],
    ["A note says the budget ran out", "Raise maxCostPerIssue, or test by hand."],
  ],
  delay: end + 1.6,
})

export default d.svg()
