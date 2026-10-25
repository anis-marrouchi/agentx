// The sales week: the picture at the top of docs/jobs/sales.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136

const d = createDiagram({
  height: 660,
  title: "How the sales agent works with you",
  desc:
    "Six steps in two parts. You set it up once: you describe the customers you look for, list the competitor pages to watch, and tell the agent about your leads. " +
    "Then every morning the agent checks the competitor pages, sends you a brief with a source link on every line, and on Mondays drafts the follow-ups, which you send yourself. Nothing reaches a lead without you.",
})

d.header("Sales", "You set it up once. Every line it sends you has a source. You send every message.", [
  [C.accent, "You"],
  [C.ink, "The sales agent"],
])

// Part 1: once.
let y = 148
d.band(104, ROW + 64, "YOU SET IT UP ONCE")
const setup = d.row(
  [
    { title: ["Describe your", "customers"], note: ["in targets.md"], who: "accent" },
    { title: ["List competitor", "pages"], note: ["in competitors.md"], who: "accent" },
    { title: ["Tell it about", "your leads"], note: ["in Telegram"], who: "accent" },
  ],
  y,
)

// Part 2: every weekday morning.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "EVERY MORNING", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Check the pages"], note: ["keeps only what", "changed"], who: "ink" },
    { title: ["Send the brief"], note: ["new leads, quiet leads,", "changes, each with a link"], who: "ink" },
    { title: ["You send the", "follow-ups"], note: ["drafted on Mondays"], who: "accent" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“1 line above has no source”", "Do not rely on that line."],
    ["“No competitor changes.” every day", "Check the links in competitors.md."],
  ],
  delay: end + 1.2,
})

export default d.svg()
