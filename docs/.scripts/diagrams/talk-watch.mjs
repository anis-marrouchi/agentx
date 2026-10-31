// How a call with an agent on your watch works: the picture at the top of docs/dashboard/mobile-talk.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 880,
  title: "How you talk to an agent on your watch",
  desc:
    "Seven steps in two parts. You start it on the phone: pair the watch with the phone as a headset, choose the agent once, then tap Talk to AgentX. " +
    "Then the watch, the phone and the computer take turns: the watch rings and you answer on it, you speak after the beep, the phone sends the recording to your computer, which writes it down and asks the agent, " +
    "and the answer is spoken on the watch. It goes on until you hang up on the watch. Hanging up while the agent works does not stop it: the answer is kept in the phone app's Chat.",
})

d.header("How you talk to an agent on your watch", "The phone rings the watch, like a call. No phone number, no call cost.", [
  [C.accent, "You"],
  [C.ink, "Your phone and computer"],
])

// Part 1: the owner starts it.
let y = 148
d.band(104, ROW + 64, "YOU START IT ON THE PHONE")
const start = d.row(
  [
    { title: ["Pair the watch", "with the phone"], note: ["as a headset, as for", "phone calls"] },
    { title: ["Choose the agent"], note: ["once; the phone", "remembers it"] },
    { title: ["Tap Talk to", "AgentX"], note: ["its icon, or long-press", "the AgentX icon"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: each turn of the call.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "THEN, ON THE WATCH, UNTIL YOU HANG UP", { tint: C.tintGrey, dx: 48 })
d.wrap(start.at(-1), d.x0 + 26, y)
const turn = d.row(
  [
    { title: ["The watch rings;", "you answer on it"], note: ["the call screen of", "the watch"], who: "accent" },
    { title: ["You speak after", "the beep"], note: ["a pause ends", "what you say"], who: "accent" },
    { title: ["The computer writes", "it down, asks the agent"], note: ["the same chat as in", "the phone app"], who: "ink" },
  ],
  y,
)
const hangY = y + ROW + GAP + (ROW - 68) / 2
y += ROW + GAP
d.wrap(turn.at(-1), d.x0 + 26, y)
d.row([{ title: ["The answer is spoken", "on the watch"], note: ["then a beep: your turn", "again"], who: "ink" }], y, { to: d.x0 + COL })

const end = d.now
d.callout(d.x0 + COL + 20, hangY, COL, {
  title: "You hang up mid-answer",
  note: "The answer is kept in Chat.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y - 12, COL, 160, {
  title: "Phone",
  rows: [
    ["Talk to AgentX", "Listening…", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The watch doesn't ring", "Pair it as a headset; turn on calls."],
    ["The sound is on the phone", "Allow Nearby devices for AgentX."],
    ["“I didn't hear anything”", "Speak right after the beep."],
    ["“Could not reach your computer”", "Turn on Tailscale on the phone."],
  ],
  delay: end + 1.6,
})

export default d.svg()
