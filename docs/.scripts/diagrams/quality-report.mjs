// How the weekly quality report reaches the epic issue, and how the gate
// verdict follows: the picture at the top of docs/jobs/quality-report.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 950,
  title: "How the weekly quality report reaches the epic issue",
  desc:
    "Six steps in two parts. Every Monday the daemon runs the quality report for the week that just ended. " +
    "It checks the text holds no cost amounts and no names, then posts one comment on the epic issue, or edits that week's comment if it is already there. " +
    "A failure is written to the daemon log and tried again every hour. " +
    "After week 3 with the gates on, the comment says the verdict is due. You run agentx quality verdict with keep, tune or switch-off for each gate, and it posts one verdict comment that cites the latest numbers.",
})

d.header("The weekly quality report", "One comment a week. The verdict is yours.", [
  [C.accent, "You, the owner"],
  [C.ink, "The AgentX daemon"],
])

// Part 1: the weekly comment.
let y = 148
d.band(104, 2 * ROW + GAP + 64, "EVERY MONDAY", { tint: C.tintGrey })
const weekly = d.row(
  [
    { title: ["Run last week's report"], note: ["Monday at the set time,", "or later that week"], who: "ink" },
    { title: ["Check it is public-safe"], note: ["no cost amounts,", "no names"], who: "ink" },
    { title: ["Comment on the epic"], note: ["the same week again", "edits that comment"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(weekly.at(-1), d.x0 + 26, y)
const flag = d.row(
  [{ title: ["After week 3:", "verdict due"], note: ["the comment says so"], who: "ink" }],
  y,
  { to: d.x0 + COL },
)
const failY = y + (ROW - 68) / 2

// Part 2: the owner's verdict.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 250, "AFTER WEEK 3", { dx: 48 })
d.wrap(flag.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Decide each gate"], note: ["keep, tune or", "switch-off"], who: "accent" },
    { title: ["Post the verdict"], note: ["one comment with", "the latest numbers"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(d.x0 + COL + 20, failY, COL, {
  title: "It fails",
  note: "Logged, tried again hourly.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Epic issue",
  rows: [
    ["Report 2026-W42", "Posted", C.accent],
    ["Verdict", "Due", C.done],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“FAILED … cost amount”", "The report printed an amount. Fix the report."],
    ["“no GitHub token”", "Set channels.github.token."],
    ["“No report was posted for …”", "Run agentx quality weekly --week."],
    ["“no verdict for: …”", "Give every gate a --gate."],
  ],
  delay: end + 1.6,
})

export default d.svg()
