// How a ready-made team is installed, and shared with a second machine:
// the picture at the top of docs/jobs/ready-made-teams.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row, each ROW high.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 660,
  title: "How a ready-made team is installed and shared",
  desc:
    "Six steps in two parts. On your machine: you pick a team from the list, one command adds its agents, skills and schedules, and you connect the channel it needs, which is the only step left by hand. " +
    "To share it: you export the team to one file, which holds no tokens, chat ids or contacts, you send the file, and the other machine imports it and connects its own channel.",
})

d.header("Ready-made teams", "One command adds a working team. One file shares it.", [
  [C.accent, "You"],
  [C.ink, "AgentX"],
])

// Part 1: install.
let y = 148
d.band(104, ROW + 64, "ON YOUR MACHINE")
const install = d.row(
  [
    { title: ["Pick a team"], note: ["agentx team list"], who: "accent" },
    { title: ["Add it"], note: ["agents, skills and", "schedules in one step"], who: "ink" },
    { title: ["Connect the channel"], note: ["the one step", "left to you"], who: "accent" },
  ],
  y,
)

// Part 2: share.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "SHARE IT WITH ANOTHER MACHINE", { tint: C.tintGrey, dx: 48 })
d.wrap(install.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Export it"], note: ["one file, with no tokens,", "chat ids or contacts"], who: "accent" },
    { title: ["Import it there"], note: ["same agents, skills", "and schedules"], who: "ink" },
    { title: ["Connect its channel"], note: ["with that machine's", "own token or phone"], who: "accent" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“Already in this install”", "An agent or schedule has that id: remove it."],
    ["“looks like a secret”", "Take the token out of the prompt or skill."],
  ],
  delay: end + 1.2,
})

export default d.svg()
