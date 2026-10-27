// How an AgentX TV episode is made and watched: the picture at the top of
// docs/dashboard/tv.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high.
const ROW = 136

const d = createDiagram({
  height: 720,
  title: "How an AgentX TV episode is made and watched",
  desc:
    "Six steps in two parts. Making an episode: on your computer, agentx tv make reads the day's public work on GitHub and writes the script; " +
    "with --render-on it sends the script to the render server; the render server makes the voice-over and the video and sends the video back. " +
    "Watching: you press TV on the Wall, the TV page lists the day's episodes, and Play shows them full screen, one after another. " +
    "With no render server, the page reads the script aloud in the browser instead.",
})

d.header("How an episode is made and watched", "Your computer writes the script. The render server makes the video.", [
  [C.accent, "You"],
  [C.ink, "The machines"],
])

let y = 148
d.band(104, ROW + 64, "MAKING AN EPISODE")
const make = d.row(
  [
    { title: ["agentx tv make"], note: ["reads the day's public pull", "requests and issues on GitHub"], who: "accent" },
    { title: ["Your computer", "sends the script"], note: ["to the render server,", "over SSH (--render-on)"], who: "ink" },
    { title: ["The render server", "makes the video"], note: ["voice-over, then video,", "then sends it back"], who: "ink" },
  ],
  y,
)

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "WATCHING IT", { tint: C.tintGrey, dx: 48 })
d.wrap(make.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Press TV on", "the Wall"], note: ["on a computer, phone", "or a TV's browser"], who: "accent" },
    { title: ["The day's line-up"], note: ["every episode made that day,", "oldest first"], who: "ink" },
    { title: ["Play, full screen"], note: ["no video yet? the page", "reads the script aloud"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“is not public”", "The Build only covers public repositories."],
    ["“never run on a Mac”", "Add --render-on with your render server."],
    ["“Nothing on air yet”", "Run agentx tv make for that day."],
    ["No sound", "Press Play: browsers need one press first."],
  ],
  delay: end + 0.6,
})

export default d.svg()
