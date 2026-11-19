// How AgentX learns a situation template once a week, and why nothing
// learned is used before the approver's yes: the picture at the top of
// docs/jobs/learned-templates.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136
const GAP = 36
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 900,
  title: "How AgentX learns a template from ended talks",
  desc:
    "Once a week AgentX reads counts about the talks that ended, with no messages or names, and a model drafts up to three templates: a few sentences for a kind of talk. " +
    "The approver agent you named reads each draft once and says yes or no. You get one message. A template with a yes is used only on a talk where you name it. " +
    "A no, or no approver, and the draft is never used.",
})

d.header("How AgentX learns a template", "Off until you switch it on. At most $2 a week, inside your daily self-improvement budget.", [
  [C.accent, "You"],
  [C.ink, "AgentX, the approver"],
])

let y = 148
d.band(104, 2 * ROW + GAP + 64, "ONCE A WEEK")
const draftRow = d.row(
  [
    { title: ["Talks end"], note: ["AgentX keeps counts,", "no messages or names"], who: "ink" },
    { title: ["A model drafts"], note: ["a few sentences for", "a kind of talk"], who: "ink" },
    { title: ["The approver reads it"], note: ["once, in a run that", "can change nothing"], who: "ink" },
  ],
  y,
)
y += ROW + GAP
d.wrap(draftRow.at(-1), d.x0 + 26, y)
const yes = d.row([{ title: ["The approver says yes"], note: ["sealed by AgentX"], who: "ink" }], y, { to: d.x0 + COL })
const refusalY = y + (ROW - 68) / 2

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "AFTER A YES", { tint: C.tintGrey, dx: 48 })
d.wrap(yes.at(-1), d.x0 + 26, y, { label: "Yes" })
d.row(
  [
    { title: ["You get one message"], note: ["what was approved", "or turned down"], who: "accent" },
    { title: ["You name it on a talk"], note: ["its sentences reach", "the agent, in quotes"], who: "accent" },
    { title: ["You can take it back"], note: ["agentx situation", "learned retire"], who: "accent" },
  ],
  y,
)

const end = d.now
d.callout(d.x0 + COL + 20, refusalY, COL, {
  title: "No, or no approver",
  note: "The draft is never used.",
  delay: end + 0.4,
})
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["No draft this week", "Too few ended talks, or the budget."],
    ["Drafts wait", "Name an approver agent."],
    ["Not in use after a yes", "Turn templates on."],
    ["A row says no valid seal", "Not made by AgentX: never used."],
  ],
  delay: end + 1.2,
})

export default d.svg()
