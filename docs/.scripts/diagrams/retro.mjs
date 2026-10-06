// How a run that struggled becomes a fix: the picture at the top of
// docs/jobs/retro.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 950,
  title: "How a run that struggled becomes a fix",
  desc:
    "Six steps in two parts. A run struggles: it fails, is cut off by a restart, takes far longer than usual, or the session monitor notes friction. " +
    "You run agentx retro with its task id. A reviewer reads the run and proposes up to four fixes, each tied to a step of the run. " +
    "One decision card lists them, with None of these last. You pick one on the dashboard, the phone app, the Mac card or the terminal, and may edit the spec. " +
    "The agent that ran the task builds the fix as a pull request or a guard rule in warn mode, and you review it again. A card nobody answers is discarded.",
})

d.header("How a run that struggled becomes a fix", "A retro only proposes. Nothing changes until you pick.", [
  [C.accent, "You, the operator"],
  [C.ink, "AgentX and the agent"],
])

// Part 1: the retro reads the run.
let y = 148
d.band(104, 2 * ROW + GAP + 64, "THE RETRO PROPOSES", { tint: C.tintGrey })
const readA = d.row(
  [
    { title: ["A run struggles"], note: ["an error, a restart, far slower", "than usual, or friction"], who: "ink" },
    { title: ["Run agentx retro", "with its task id"], note: ["the id is in agentx trace list"], who: "accent" },
    { title: ["A reviewer proposes", "up to four fixes"], note: ["each one tied to a step"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(readA.at(-1), d.x0 + 26, y)
const card = d.row(
  [{ title: ["One card in Approvals"], note: ["the fixes, then None of these;", "the most severe is picked"], who: "ink" }],
  y,
  { to: d.x0 + COL },
)
const silentY = y + (ROW - 68) / 2

// Part 2: you pick, the agent builds.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 250, "YOU PICK, THE AGENT BUILDS", { dx: 48 })
d.wrap(card.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Pick a fix"], note: ["dashboard, phone, Mac card", "or terminal; edit the spec"], who: "accent" },
    { title: ["The agent builds it"], note: ["a pull request, or a guard", "rule in warn mode"], who: "ink" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(d.x0 + COL + 20, silentY, COL, {
  title: "Nobody answers",
  note: "Discarded; nothing changes.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Approvals",
  rows: [
    ["Deploy script", "Recommended", C.accent],
    ["Watchdog", "Choice 2", C.done],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“shows no sign of struggling”", "Pick a run that failed, or add --force."],
    ["“no candidate fix points…”", "The reviewer found nothing tied to the run."],
    ["“already asks about this failure”", "Answer the open card first."],
    ["Yes does nothing", "Pick one of the choices first."],
  ],
  delay: end + 1.6,
})

export default d.svg()
