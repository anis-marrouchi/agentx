// How an agent answers customers on WhatsApp: the picture at the top of docs/jobs/answer-whatsapp.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 900,
  title: "How an agent answers customers on WhatsApp",
  desc:
    "Seven steps in two parts. You set it up once: get a separate WhatsApp number, pair it with AgentX by scanning a QR code, then fill the allow-list: a star for every customer, or a list of numbers. Until it is filled, no one is answered. " +
    "Then, for every message: a customer writes to that number, AgentX checks the list, the agent writes an answer, and the answer goes back at once, in the same chat, with no approval step. " +
    "A message from a number that is not on the list is ignored.",
})

d.header("How the agent answers on WhatsApp", "You set it up once. After that, the agent replies on its own.", [
  [C.accent, "You"],
  [C.ink, "The customer and AgentX"],
])

// Part 1: the owner sets it up.
let y = 148
d.band(104, ROW + 64, "YOU SET IT UP ONCE")
const setup = d.row(
  [
    { title: ["Get a spare number"], note: ["a second phone or SIM,", "not your personal number"] },
    { title: ["Pair it with AgentX"], note: ["agentx connect whatsapp,", "then scan the QR code"] },
    { title: ["List who may write"], note: ["the allow-list: \"*\" for every", "customer, or their numbers"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: every message.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "THEN, FOR EVERY MESSAGE", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
const message = d.row(
  [
    { title: ["A customer writes"], note: ["to the separate number"], who: "ink" },
    { title: ["AgentX checks the list"], note: ["numbers not on it", "are ignored"], who: "ink" },
    { title: ["The agent answers"], note: ["with its own instructions", "and tools"], who: "ink" },
  ],
  y,
)
const ignoredY = y + ROW + GAP + (ROW - 68) / 2
y += ROW + GAP
d.wrap(message.at(-1), d.x0 + 26, y)
d.row([{ title: ["The reply goes out"], note: ["at once, in the same chat,", "with no approval"], who: "ink" }], y, { to: d.x0 + COL })

const end = d.now
d.callout(d.x0 + COL + 20, ignoredY, COL, {
  title: "Not on the list",
  note: "Nothing is read or answered.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y - 12, COL, 160, {
  title: "WhatsApp",
  rows: [
    ["Open on Saturday?", "Customer", C.ink],
    ["Yes, 9:00 to 13:00.", "Helper", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No QR code appears", "Stop the daemon, then pair again."],
    ["No one gets an answer", "The allow-list is empty: fill it."],
    ["“not in allowlist” in the log", "Add the number, or use \"*\"."],
    ["“Logged out” in the log", "Delete the session folder, pair again."],
  ],
  delay: end + 1.6,
})

export default d.svg()
