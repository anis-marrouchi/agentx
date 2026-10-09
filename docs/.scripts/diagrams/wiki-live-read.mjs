// How a wiki question gets a live check: the picture at the top of docs/jobs/wiki-live-read.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How a wiki question gets a live check",
  desc:
    "Six steps in two parts. You write a one-line summary of every wiki page once, and list the places AgentX may read. " +
    "When an agent asks the wiki a question, AgentX picks pages from their summaries. " +
    "A small model names what to check, AgentX reads it from GitHub, GitLab or your machines, and the answer marks each fact that came from that check. " +
    "A check that fails is left out; the answer still comes from the pages.",
})

d.header("How a wiki question gets a live check", "Pages say what was true. The live read says what is true now.", [
  [C.accent, "You, the owner"],
  [C.ink, "AgentX"],
])

// Part 1: setup.
let y = 148
d.band(104, ROW + 64, "SET UP ONCE")
const setup = d.row(
  [
    { title: ["Summarise the pages"], note: ["one line per page,", "pages stay as they are"], who: "accent" },
    { title: ["List what may be read"], note: ["repositories, hosts,", "your machines"], who: "accent" },
    { title: ["Agent asks the wiki"], note: ["agentx wiki query,", "or the agent's wiki tool"], who: "ink" },
  ],
  y,
)

// Part 2: each question.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 262, "EVERY QUESTION", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Pick by summary"], note: ["up to 3 pages,", "or none"], who: "ink" },
    { title: ["Read the live state"], note: ["only what you listed,", "read-only"], who: "ink" },
    { title: ["Answer from both"], note: ["live facts marked", "[live 1], [live 2]"], who: "ink" },
  ],
  y,
)

const end = d.now
d.window(d.x0 + COL + 20, y + ROW + 24, 2 * COL + 20, 172, {
  title: "agentx wiki query \"Is the login fix out?\"",
  rows: [
    ["example/app#12", "closed 2026-10-08", C.accent],
    ["Newest release", "v2.1.0 2026-10-05", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 246, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No Live read lines", "List a source and its repositories."],
    ["Method shows catalog", "Run agentx wiki summarize."],
    ["A read is missing", "Check the token and the host."],
    ["Wrong pages picked", "Summarise again after big edits."],
  ],
  delay: end + 1.4,
})

export default d.svg()
