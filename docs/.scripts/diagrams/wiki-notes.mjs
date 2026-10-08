// How an agent's note reaches the wiki run: the picture at the top of docs/jobs/wiki-notes.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How an agent's note reaches the wiki run",
  desc:
    "Six steps in two parts. You pick the inbox agent, the one that runs the wiki observe and sweep schedule, and the schedules that read its inbox. " +
    "Any agent leaves a note: what changed, the source and the date; its own machine passes it to the machine that holds the inbox. " +
    "When the schedule starts, the run reads its notes first, checks each one at its source, and records it as patched, rejected or deferred with a reason. A deferred note comes back next run. " +
    "Notes stay inside your machines.",
})

d.header("How an agent's note reaches the wiki run", "Agents tell the run what only they know. The run checks before it changes anything.", [
  [C.accent, "You, the owner"],
  [C.ink, "Your agents"],
])

// Part 1: setup and posting.
let y = 148
d.band(104, ROW + 64, "SET UP ONCE, THEN AGENTS WRITE")
const post = d.row(
  [
    { title: ["Pick the inbox agent"], note: ["the one that runs the wiki", "observe/sweep schedule"], who: "accent" },
    { title: ["An agent leaves", "a note"], note: ["what changed, the source", "and the date"], who: "ink" },
    { title: ["Its machine passes", "it on"], note: ["to the machine that", "holds the inbox"], who: "ink" },
  ],
  y,
)

// Part 2: the run.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 262, "THE NEXT RUN READS IT FIRST", { tint: C.tintGrey, dx: 48 })
d.wrap(post.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The run lists", "its notes"], note: ["ahead of its own", "instructions"], who: "ink" },
    { title: ["It checks each one"], note: ["at the source, not by", "copying the note"], who: "ink" },
    { title: ["It records what", "it did"], note: ["patched, rejected or", "deferred, with a reason"], who: "ink" },
  ],
  y,
)

const end = d.now
d.window(d.x0 + COL + 20, y + ROW + 24, 2 * COL + 20, 172, {
  title: "agentx wiki notes list --status all",
  rows: [
    ["Staging moved region", "patched", C.accent],
    ["Old billing contact", "deferred: source down", C.warn],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 246, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["wiki notes are off", "Turn them on and set the inbox."],
    ["The inbox node is unreachable", "Try again when it is back."],
    ["The run never mentions notes", "List its schedule under the inbox."],
    ["A note stays open", "The run did not record it; check its answer."],
  ],
  delay: end + 1.4,
})

export default d.svg()
