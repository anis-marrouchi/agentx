// How a place reminder reaches you: the picture at the top of docs/dashboard/mobile-places.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high; rows inside one band sit GAP apart.
const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3
const twoColumns = 44 + 2 * COL + 20

const d = createDiagram({
  height: 1080,
  title: "How a place reminder reaches you",
  desc:
    "Seven steps in two parts. You set it up once: install the AgentX Android app and pair it, turn on place reminders and allow location all the time, then save a place and a reminder. " +
    "Then your phone and computer do the rest: Android watches the place with the app closed, the phone tells the computer only which place and whether you arrived or left, the computer picks the reminders for it, or asks an agent, and pushes the notification to your phone. " +
    "A crossing the phone can only report more than 30 minutes later is dropped.",
})

d.header("How a place reminder reaches you", "You set it up once. Your phone tells the computer only which place, never where you are.", [
  [C.accent, "You"],
  [C.ink, "Your phone and computer"],
])

// Part 1: the owner sets it up.
let y = 148
d.band(104, ROW + 64, "YOU SET IT UP ONCE")
const setup = d.row(
  [
    { title: ["Install the Android", "app and pair it"], note: ["the same pairing code as", "the phone app"] },
    { title: ["Turn on place", "reminders"], note: ["allow location", "all the time"] },
    { title: ["Save a place and", "a reminder"], note: ["in the phone app or on", "the computer's Places page"] },
  ],
  y,
  { who: "accent" },
)

// Part 2: phone and computer.
let band = y + ROW + 36
y = band + 44
d.band(band, 2 * ROW + GAP + 64, "THEN, WITH THE APP CLOSED", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
const watch = d.row(
  [
    { title: ["Android watches", "the place"], note: ["even with the screen off"], who: "ink" },
    { title: ["The phone reports", "the crossing"], note: ["which place, arrived or left,", "and when: nothing else"], who: "ink" },
    { title: ["The computer picks", "the reminders"], note: ["or asks an agent", "and waits for its answer"], who: "ink" },
  ],
  y,
)
const lateY = y + ROW + GAP + (ROW - 68) / 2
y += ROW + GAP
d.wrap(watch.at(-1), d.x0 + 26, y)
d.row([{ title: ["It pushes the", "notification"], note: ["to the phone that crossed"], who: "ink" }], y, { to: d.x0 + COL })

const end = d.now
d.callout(d.x0 + COL + 20, lateY, COL, {
  title: "No signal for 30 minutes",
  note: "The late crossing is dropped.",
  delay: end + 0.4,
})
d.window(twoColumns + 20, y - 12, COL, 160, {
  title: "Notification",
  rows: [
    ["Arrived at School", "Pick up the parcel", C.accent],
  ],
  delay: end + 0.2,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["Nothing arrives", "Location must be allowed all the time."],
    ["Fires late or not at all", "Make the place bigger: 150 m or more."],
    ["“Reminders are not sent”", "Turn on notifications for the phone app."],
    ["Address bar at the top", "Add the app's fingerprint to agentx.json."],
  ],
  delay: end + 1.6,
})

export default d.svg()
