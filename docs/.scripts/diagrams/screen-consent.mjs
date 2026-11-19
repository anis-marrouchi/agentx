// How an agent reads your open apps for one request, only
// after your yes: the picture at the top of docs/jobs/screen-for-a-request.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How an agent reads your screen for one request",
  desc:
    "Your agent needs to see what is open on your computer for the request it works on. It asks you with one card that says what it wants to read, why, and for how long. " +
    "The card opens as a popup on your Mac, the only place a yes counts. After your yes, the agent reads your open apps, each read is logged, and the yes ends by itself. " +
    "A no, or no answer, and nothing is read.",
})

d.header("How an agent reads your screen", "Off until you switch it on. Each request needs your yes, and the yes ends by itself.", [
  [C.accent, "You"],
  [C.ink, "Your agent"],
])

let y = 148
d.band(104, 2 * ROW + GAP + 64, "THE AGENT ASKS")
const askRow = d.row(
  [
    { title: ["Your agent needs it"], note: ["for the request", "it works on"], who: "ink" },
    { title: ["It asks you"], note: ["one card: what, why,", "for how many minutes"], who: "ink" },
    { title: ["A popup on your Mac"], note: ["the only place", "a yes counts"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(askRow.at(-1), d.x0 + 26, y)
const yes = d.row([{ title: ["You say yes"], note: ["in the popup"], who: "accent" }], y, { to: d.x0 + COL })
const refusalY = y + (ROW - 68) / 2

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "WHILE THE YES LASTS", { tint: C.tintGrey, dx: 48 })
d.wrap(yes.at(-1), d.x0 + 26, y, { label: "Yes" })
d.row(
  [
    { title: ["It reads"], note: ["your open apps,", "a few times at most"], who: "ink" },
    { title: ["Each read is logged"], note: ["when, which agent,", "which request"], who: "ink" },
    { title: ["The yes ends"], note: ["after the minutes", "on the card"], who: "ink" },
  ],
  y,
)

const end = d.now
d.callout(d.x0 + COL + 20, refusalY, COL, {
  title: "No, or no answer",
  note: "Nothing is read.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["The ask is refused", "Turn on the approvals popup."],
    ["A read says off", "Switch the source on."],
    ["A read says no consent", "No yes yet, or it ended."],
    ["Tabs are not loaded", "Expected: no separate reader yet."],
  ],
  delay: end + 1.2,
})

export default d.svg()
