// How a code editor uses AgentX's tools: the picture at the top of
// docs/jobs/connect-an-editor.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 900,
  title: "How a code editor uses AgentX's tools",
  desc:
    "Six steps in two parts. You set it up once: add agentx serve --stdio to the editor's list of tool servers, choose the read or full tool set, and restart the editor. " +
    "Then, while you work: the editor starts the tool server, which finds the AgentX node and its token; the editor's assistant calls a tool; the tool server asks the node with the token and passes the answer back. " +
    "When the node refuses, the tool answers with the reason, usually a missing or wrong token.",
})

d.header("How a code editor uses AgentX's tools", "You add it once. The editor starts it each time.", [
  [C.accent, "You"],
  [C.ink, "The editor and AgentX"],
])

// Part 1: you set it up.
let y = 148
d.band(104, ROW + 64, "YOU SET IT UP ONCE")
const setup = d.row(
  [
    { title: ["Add agentx to the", "editor's tool servers"], note: ["command: agentx", "args: serve --stdio"] },
    { title: ["Choose a tool set"], note: ["--tools read: looks only", "--tools full: everything"] },
    { title: ["Restart the editor"], note: ["it reads the list", "when it starts"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: while you work.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "WHILE YOU WORK", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The editor starts", "the tool server"], note: ["it finds the node's address", "and its token"], who: "ink" },
    { title: ["The assistant calls", "a tool"], note: ["for example agentx_health"], who: "ink" },
    { title: ["The node answers"], note: ["the call carries", "Authorization: Bearer"], who: "ink" },
  ],
  y,
)
const failY = y + ROW + 40

const end = d.now
d.callout(twoColumns + 20, failY, COL, {
  title: "The node refuses",
  note: "Often the token is missing.",
  delay: end + 0.4,
})
d.window(d.x0, failY, 2 * COL, 160, {
  title: "Editor: tool servers",
  rows: [
    ["agentx", "connected", C.done],
    ["10 tools (read set)", "or 29 (full set)", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, failY + 200, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The server is not listed", "Restart the editor after saving."],
    ["“fetch failed”", "Start the node, or set AGENTX_DAEMON_URL."],
    ["“Unauthorized”", "Set AGENTX_TOKEN to the node's token."],
    ["“not in the read tool set”", "Use --tools full for that tool."],
  ],
  delay: end + 1.6,
})

export default d.svg()
