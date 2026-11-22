// How one message travels through AgentX: the picture at the top of docs/architecture/overview.md.
// Every card names the src/ folder that does that step, so a new contributor knows where to read.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 1010,
  title: "How one message travels through AgentX",
  desc:
    "Nine steps in three parts. A person sends a Telegram message; the Telegram channel (src/channels/telegram.ts) receives it and the channel router (src/channels/router.ts) takes it; " +
    "the router checks the chat's situation (src/situations/), picks the agent and writes the choice in the intent ledger (src/intent/). " +
    "The run waits for a free slot in the admission queue (src/admission/), the agent's engine runs (src/agents/runtime.ts), and the agent calls AgentX tools such as agentx_request over MCP (src/mcp/). " +
    "The reply goes back through the router to Telegram; requests, plans and promises are tracked in src/requests/; events and history feed the dashboard (src/events/, src/daemon/ui/). " +
    "If the agent lives on another machine, the mesh (src/a2a/) sends the message there. Around the path: schedules and jobs, workflows, the wiki and memory, AgentX Voice.",
})

d.header("How one message travels", "Each card names the src/ folder that does that step.", [
  [C.accent, "The person writing"],
  [C.ink, "AgentX"],
])

// Part 1: the message arrives and is routed.
let y = 148
d.band(104, ROW + 64, "THE MESSAGE ARRIVES")
const arrive = d.row(
  [
    { title: ["Someone writes", "on Telegram"], note: ["channels/telegram.ts", "receives the update"], who: "accent" },
    { title: ["The router takes it"], note: ["channels/router.ts:", "one path for every channel"] },
    { title: ["Situation, agent,", "ledger"], note: ["situations/ · intent/", "who answers, and why"] },
  ],
  y,
  { who: "ink" },
)

// Part 2: the agent runs.
let band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THE AGENT RUNS", { tint: C.tintGrey, dx: 48 })
d.wrap(arrive.at(-1), d.x0 + 26, y)
const run = d.row(
  [
    { title: ["It waits for a slot"], note: ["admission/: a queue when", "the machine is busy"] },
    { title: ["The engine runs"], note: ["agents/runtime.ts: Claude", "Code, Codex, OpenCode, SDK"] },
    { title: ["It calls AgentX tools"], note: ["mcp/: agentx_request,", "agentx_send and the rest"] },
  ],
  y,
  { who: "ink" },
)

// Part 3: the reply goes back and the work is kept.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THE REPLY GOES BACK", { dx: 48 })
d.wrap(run.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["The reply arrives", "on Telegram"], note: ["router → channel adapter"], who: "accent" },
    { title: ["Open work is tracked"], note: ["requests/: requests,", "plans, promises"] },
    { title: ["History and events"], note: ["events/ · storage/, shown", "by the dashboard (daemon/ui/)"] },
  ],
  y,
  { who: "ink" },
)

const end = d.now
d.callout(d.x0, y + ROW + 32, 2 * COL + 20, {
  title: "The agent is on another machine",
  note: "The router hands the message to that mesh peer: src/a2a/.",
  colour: C.accent,
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 148, {
  title: "AROUND THE PATH",
  columns: 2,
  colour: C.accent,
  items: [
    ["Schedules and jobs", "crons/ · jobs/: work that starts by itself"],
    ["Workflows", "workflows/: saved steps, engine and runs"],
    ["Wiki and memory", "wiki/ · memory/: what agents know"],
    ["AgentX Voice", "apps/mac-voice/ · voice/: speak, hear"],
  ],
  delay: end + 1.2,
})

export default d.svg()
