// What leaves your machine when an agent works: the picture at the top of docs/your-data.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 820,
  title: "What leaves your machine",
  desc:
    "Three steps, then three optional features. Every time an agent works: you send a message, AgentX on your machine adds the agent's instructions and the files it needs, and the model provider reads all of it and writes the reply. " +
    "Only for features you turn on: your voice goes to ElevenLabs when a key is set, screen and camera pictures go to the model or a vision service, and phone notifications pass through your phone browser's push service. " +
    "The demo is the exception: its replies are scripted and nothing leaves the computer.",
})

d.header("What leaves your machine", "AgentX runs on your machine. The model that writes the replies does not.", [
  [C.accent, "You"],
  [C.ink, "AgentX and services"],
])

// Part 1: every reply.
let y = 148
d.band(104, ROW + 64, "EVERY TIME AN AGENT WORKS")
const every = d.row(
  [
    { title: ["You send a message"], note: ["from a chat app, the dashboard", "or the phone app"], who: "accent" },
    { title: ["AgentX adds what", "the agent needs"], note: ["instructions, chat, files"], who: "ink" },
    { title: ["The model provider", "writes the reply"], note: ["it reads all of it, online"], who: "ink" },
  ],
  y,
)

// Part 2: optional features.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "ONLY FOR WHAT YOU TURN ON", { tint: C.tintGrey, dx: 48 })
d.wrap(every.at(-1), d.x0 + 26, y)
// Three separate cards, not a sequence: one row() each, so no arrows join them.
const optional = [
  { title: ["Your voice"], note: ["to ElevenLabs when a key is set;", "voice.stt: local keeps it here"], who: "ink" },
  { title: ["Screen and camera", "pictures"], note: ["to the model or a vision service"], who: "ink" },
  { title: ["Phone notifications"], note: ["through your phone", "browser's push service"], who: "ink" },
]
optional.forEach((item, i) => {
  const from = d.x0 + i * (COL + 20)
  d.row([item], y, { from, to: from + COL })
})

const end = d.now
const after = y + ROW + 36
d.callout(d.x0, after, twoColumns - d.x0 - 20, {
  title: "The demo sends nothing out",
  note: "Its replies are scripted: no model account, no provider.",
  colour: C.done,
  delay: end + 0.4,
})
d.list(d.x0, after + 124, {
  title: "TO KEEP SOMETHING ON YOUR MACHINE",
  columns: 2,
  items: [
    ["Secrets and private files", "Keep them out of the agent's workspace."],
    ["Your voice", "Set voice.stt to local."],
    ["Pictures", "Don't share the screen or camera."],
    ["The whole conversation", "Use a model that runs on your machine."],
  ],
  delay: end + 1.2,
})

export default d.svg()
