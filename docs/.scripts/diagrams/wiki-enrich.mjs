// How a scheduled run brings one wiki page up to date: the picture at the top of docs/jobs/wiki-enrich.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How the scheduled run keeps a wiki page up to date",
  desc:
    "Six steps in two parts. You pick the agent that runs it, the kinds of pages, where it may read, and a cap on pages and spending per run. " +
    "On schedule, the run finds the pages whose sources changed since last time. For each one the agent reads the page, the messages that mention it and the contact records. " +
    "It writes the story in full, typed facts that each cite a source, and a History that links to event pages. Analysis of how you work with someone goes on a private page. " +
    "Old text is kept as a past version.",
})

d.header("How the scheduled run keeps a wiki page up to date", "One page at a time, only when its sources changed, never over your cap.", [
  [C.accent, "You, the owner"],
  [C.ink, "The enrichment agent"],
])

// Part 1: setup and selection.
let y = 148
d.band(104, ROW + 64, "SET UP ONCE, THEN IT RUNS ON SCHEDULE")
const pick = d.row(
  [
    { title: ["Pick the agent", "and the caps"], note: ["page kinds, sources,", "pages and dollars per run"], who: "accent" },
    { title: ["The run finds pages", "that changed"], note: ["new messages, new links,", "or never done before"], who: "ink" },
    { title: ["The agent reads", "one page"], note: ["its text, the messages", "and contact records"], who: "ink" },
  ],
  y,
)

// Part 2: what it writes.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 262, "WHAT IT WRITES, EACH WITH A SOURCE", { tint: C.tintGrey, dx: 48 })
d.wrap(pick.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The story", "in full"], note: ["who they are to us, how", "it started, where it stands"], who: "ink" },
    { title: ["Typed facts"], note: ["role at, client of,", "contact for, with a source"], who: "ink" },
    { title: ["History linked", "to events"], note: ["each item opens", "its own event page"], who: "ink" },
  ],
  y,
)

const end = d.now
d.window(d.x0 + COL + 20, y + ROW + 24, 2 * COL + 20, 172, {
  title: "agentx wiki enrich status",
  rows: [
    ["Sample Person", "refreshed: 2 facts", C.accent],
    ["Example Org", "nothing new", C.warn],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 246, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["Enrichment is off", "Turn it on and set the agent."],
    ["Nothing is refreshed", "No page changed; use --page."],
    ["It stops early", "The page or spending cap was hit."],
    ["Facts are left out", "They had no source the run could check."],
  ],
  delay: end + 1.4,
})

export default d.svg()
