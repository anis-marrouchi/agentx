// How the AgentX plugin reaches Claude Code: the picture at the top of
// docs/jobs/install-the-plugin.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 900,
  title: "How the AgentX plugin reaches Claude Code",
  desc:
    "Six steps in two parts. You install it once: one command adds the AgentX marketplace and installs the agentx plugin, you choose the read or full tool set, and you start a new Claude Code session. " +
    "Then, while you work: Claude Code loads the two skills and starts the agentx tool server; a skill tells the assistant which tool to call; the tool server asks your AgentX node and passes the answer back. " +
    "When the node refuses, the tool answers with the reason, usually a node that is not running or a missing token.",
})

d.header("How the AgentX plugin reaches Claude Code", "You install it once. Claude Code loads it each session.", [
  [C.accent, "You"],
  [C.ink, "Claude Code and AgentX"],
])

// Part 1: you install it.
let y = 148
d.band(104, ROW + 64, "YOU INSTALL IT ONCE")
const setup = d.row(
  [
    { title: ["Run one command"], note: ["claude plugin install agentx", "--marketplace …"] },
    { title: ["Choose a tool set"], note: ["read: looks only (default)", "full: everything"] },
    { title: ["Start a new session"], note: ["Claude Code reads", "plugins when it starts"] },
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
    { title: ["Claude Code loads it"], note: ["2 skills and", "the agentx tool server"], who: "ink" },
    { title: ["A skill picks", "the tool"], note: ["for example agentx_health"], who: "ink" },
    { title: ["Your node answers"], note: ["on this machine, or at", "the address you set"], who: "ink" },
  ],
  y,
)
const failY = y + ROW + 40

const end = d.now
d.callout(twoColumns + 20, failY, COL, {
  title: "The node refuses",
  note: "Often it is not running.",
  delay: end + 0.4,
})
d.window(d.x0, failY, 2 * COL, 160, {
  title: "Claude Code: /mcp",
  rows: [
    ["plugin:agentx:agentx", "connected", C.done],
    ["10 tools (read set)", "or 31 (full set)", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, failY + 200, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“Failed to connect”", "Install agentx, then start a new session."],
    ["“fetch failed”", "Start the node, or set its address."],
    ["“Unauthorized”", "Set the token option to the node's token."],
    ["“not in the read tool set”", "Set the tool set option to full."],
  ],
  delay: end + 1.6,
})

export default d.svg()
