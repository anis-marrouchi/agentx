// How a teammate joins their work page, seen from their side: the picture at the top of docs/jobs/join-work-page.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 900,
  title: "How you join your work page",
  desc:
    "Eight steps in two parts. You pair: get a share link, an address and a code from the owner; accept the share and wait for Tailscale to say Connected; open the address; name this machine and type the code; " +
    "the page waits for the owner; the owner says yes on a card. Connected: the page becomes My work, and you can install it as an app. " +
    "If the owner says no, or three days pass, ask them for a new code.",
})

d.header("How you join your work page", "Six steps on your machine. The owner says yes once, then the page is yours.", [
  [C.accent, "You, the teammate"],
  [C.ink, "The owner"],
])

// Part 1: the teammate pairs.
let y = 148
d.band(104, 2 * ROW + GAP + 64, "YOU PAIR")
const pairA = d.row(
  [
    { title: ["Get three things", "from the owner"], note: ["a share link, an address", "and a pairing code"] },
    { title: ["Accept the share,", "wait for Connected"], note: ["in the Tailscale app", "on this machine"] },
    { title: ["Open the address"], note: ["in Edge or Chrome;", "it ends in /member"] },
  ],
  y,
  { who: "accent" },
)
y += ROW + GAP
d.wrap(pairA.at(-1), d.x0 + 26, y)
const pairB = d.row(
  [
    { title: ["Name this machine,", "type the code"], note: ["then press Pair this machine"], who: "accent" },
    { title: ["Waiting for the owner"], note: ["leave the page open;", "it moves on by itself"], who: "accent" },
    { title: ["The owner says yes"], note: ["on a card in their", "Approvals inbox"], who: "ink" },
  ],
  y,
)

// Part 2: connected.
const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 236, "CONNECTED", { dx: 48 })
d.wrap(pairB.at(-1), d.x0 + 26, y, { label: "Yes" })
d.row(
  [
    { title: ["The page becomes", "My work"], note: ["your agents, your requests;", "the key lasts 90 days"], who: "accent" },
    { title: ["Install it as an app"], note: ["browser menu › Apps ›", "Install this site as an app"], who: "accent" },
  ],
  y,
  { to: twoColumns },
)

const end = d.now
d.callout(twoColumns + 20, y + (ROW - 68) / 2, COL, {
  title: "No, or 3 days pass",
  note: "Ask the owner for a new code.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The address does not open", "Wait for Connected in Tailscale; restart the browser."],
    ["“That code didn’t work”", "Ask the owner for a new one: one use, 10 minutes."],
    ["Waiting does not end", "The owner has not answered their card yet."],
    ["My work is empty", "Tell the owner: nothing of yours is tracked yet."],
  ],
  delay: end + 1.2,
})

export default d.svg()
