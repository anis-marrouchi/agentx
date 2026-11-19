// How AgentX learns a situation template once a week, and why nothing
// learned is used before your yes on the weekly card: the picture at the
// top of docs/jobs/learned-templates.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How AgentX learns a template from ended talks",
  desc:
    "Once a week AgentX reads counts about the talks that ended, with no messages or names, and a model drafts up to two templates: a few sentences for a kind of talk. " +
    "You get one card with that week's drafts and answer yes or no to each. A template with your yes is used only on a talk where you name it. " +
    "A no, or no answer by the next week, and the draft is not used.",
})

d.header("How AgentX learns a template", "Off until you switch it on. At most $2 a week, inside your daily self-improvement budget.", [
  [C.accent, "You"],
  [C.ink, "AgentX"],
])

let y = 148
d.band(104, 2 * ROW + GAP + 64, "ONCE A WEEK")
const draftRow = d.row(
  [
    { title: ["Talks end"], note: ["AgentX keeps counts,", "no messages or names"], who: "ink" },
    { title: ["A model drafts"], note: ["at most two, a few", "sentences each"], who: "ink" },
    { title: ["One card for you"], note: ["only when something", "is new"], who: "accent" },
  ],
  y,
)
y += ROW + GAP
d.wrap(draftRow.at(-1), d.x0 + 26, y)
const yes = d.row([{ title: ["You say yes"], note: ["in the popup, or with", "the operator key"], who: "accent" }], y, { to: d.x0 + COL })
const refusalY = y + (ROW - 68) / 2

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "AFTER A YES", { tint: C.tintGrey, dx: 48 })
d.wrap(yes.at(-1), d.x0 + 26, y, { label: "Yes" })
d.row(
  [
    { title: ["You name it on a talk"], note: ["its sentences reach", "the agent, in quotes"], who: "accent" },
    { title: ["Unused for 8 weeks"], note: ["retired by itself,", "named on the next card"], who: "ink" },
    { title: ["You can take it back"], note: ["agentx situation", "learned retire"], who: "accent" },
  ],
  y,
)

const end = d.now
d.callout(d.x0 + COL + 20, refusalY, COL, {
  title: "No, or no answer",
  note: "Not used. Two cards unanswered: learning pauses.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No card this week", "Nothing new, or paused."],
    ["Learning paused", "agentx situation learned resume"],
    ["Not in use after a yes", "Turn templates on."],
    ["A row says no valid seal", "Not made by AgentX: never used."],
  ],
  delay: end + 1.2,
})

export default d.svg()
