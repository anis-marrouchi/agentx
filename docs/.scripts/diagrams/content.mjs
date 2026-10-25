// How the content team turns your past posts into approved posts:
// the picture at the top of docs/jobs/content.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136

const d = createDiagram({
  height: 660,
  title: "How the content agent drafts posts and waits for your yes",
  desc:
    "Six steps in two parts. Each week: you keep a few past posts in a folder, on Friday the agent plans next week's posts in the calendar, and on Monday it drafts each one in your voice, naming the past posts it followed. " +
    "Then the draft waits in your Approvals inbox: you say yes, after editing if you like, and it is posted through your LinkedIn or X connector, or saved as a file ready to paste when no connector is set. A no publishes nothing.",
})

d.header("Posts in your voice", "The agent drafts. Only your yes publishes.", [
  [C.accent, "You"],
  [C.ink, "Content agent"],
])

let y = 148
d.band(104, ROW + 64, "EVERY WEEK")
const week = d.row(
  [
    { title: ["Your past posts"], note: ["one per file in voice/"], who: "accent" },
    { title: ["Friday: plan"], note: ["next week's rows", "in calendar.md"], who: "ink" },
    { title: ["Monday: draft"], note: ["each post names the", "past posts it followed"], who: "ink" },
  ],
  y,
)

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "NOTHING GOES OUT WITHOUT YOU", { tint: C.tintGrey, dx: 48 })
d.wrap(week.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Approvals inbox"], note: ["you read the whole", "post, edit if you like"], who: "accent" },
    { title: ["You say yes"], note: ["a no publishes nothing"], who: "accent" },
    { title: ["Posted, or ready"], note: ["through your connector,", "or a file to paste"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“samples is empty”", "Put a few past posts in voice/."],
    ["Saved to paste, not posted", "No connector or no token: see Connect."],
  ],
  delay: end + 1.2,
})

export default d.svg()
