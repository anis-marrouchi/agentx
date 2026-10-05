// How a client gets their page: the picture at the top of docs/jobs/clients.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 1256,
  title: "How a client gets their page",
  desc:
    "Thirteen steps in three parts. You prepare: add the person with the client role, publish only the member page, limit shared users to port 443, create the invite, share the computer in Tailscale, send the address and the code. " +
    "The client installs Tailscale, opens the address, enters a machine name and the code, and waits. You say yes on a decision card. " +
    "The page becomes Your project and can be installed as an app. A no, or three days without an answer, ends the key.",
})

d.header("How a client gets their page", "You prepare once. They pair in a minute. Nothing opens until you say yes.", [
  [C.accent, "You, the owner"],
  [C.ink, "The client"],
])

// Part 1: the owner prepares.
let y = 148
d.band(104, 2 * ROW + GAP + 64, "YOU PREPARE")
const prepareA = d.row(
  [
    { title: ["Add them to People", "as a client"], note: ["agentx people add … --role client"] },
    { title: ["Publish only the", "member page"], note: ["nothing else of yours is reachable"] },
    { title: ["Limit shared users", "to port 443"], note: ["in the Tailscale access rules"] },
  ],
  y,
  { who: "accent" },
)
y += ROW + GAP
d.wrap(prepareA.at(-1), d.x0 + 26, y)
const prepareB = d.row(
  [
    { title: ["Create the invite"], note: ["agentx people invite prints", "the address and a code"] },
    { title: ["Share this computer", "in Tailscale"], note: ["admin console: Machines › Share"] },
    { title: ["Send the address", "and the code"], note: ["the code works once, for 10 minutes"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: the client pairs, the owner approves.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "THE CLIENT PAIRS, YOU APPROVE", { tint: C.tintGrey, dx: 48 })
d.wrap(prepareB.at(-1), d.x0 + 26, y)
const pairA = d.row(
  [
    { title: ["Install Tailscale,", "accept the share"], note: ["on their own machine"], who: "ink" },
    { title: ["Open the address"], note: ["in Edge or Chrome"], who: "ink" },
    { title: ["Enter a machine name", "and the code"], note: ["then press Pair"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(pairA.at(-1), d.x0 + 26, y)
const pairB = d.row(
  [
    { title: ["Waiting for the owner"], note: ["the page waits by itself"], who: "ink" },
    { title: ["Say yes on the card"], note: ["“New machine for …” in your", "Approvals inbox"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)
const refusalY = y + (ROW - 68) / 2

// Part 3: connected.
band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "CONNECTED", { dx: 48 })
d.wrap(pairB.at(-1), d.x0 + 26, y, { label: "Yes" })
d.row(
  [
    { title: ["The page becomes", "Your project"], note: ["only what they asked you for.", "The key lasts 90 days"], who: "ink" },
    { title: ["Install it as an app"], note: ["browser menu › Apps ›", "Install this site as an app"], who: "ink" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, refusalY, COL, {
  title: "No, or 3 days pass",
  note: "The key ends. Nothing is shared.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y, COL, 160, {
  title: "Your project",
  rows: [
    ["Quote for the spring catalogue", "Being worked on", C.accent],
    ["Invoice export for March", "Waiting on us", C.warn],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“That code didn’t work”", "Invite again: one use, 10 minutes."],
    ["“Someone else is connecting”", "Their Tailscale login differs from People."],
    ["Waiting does not end", "Your card is still unanswered."],
    ["Your project is empty", "Turn on request tracking, add their identity."],
  ],
  delay: end + 1.6,
})

export default d.svg()
