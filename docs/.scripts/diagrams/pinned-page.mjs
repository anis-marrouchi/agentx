// How a pinned page opens: the picture at the top of docs/dashboard/mobile-pins.md.
import { C, createDiagram } from "./kit.mjs"

// Three steps to a row. Each row is ROW high.
const ROW = 136
const COL = (920 - 88 - 40) / 3

const d = createDiagram({
  height: 720,
  title: "How a pinned page opens",
  desc:
    "Six steps in two parts. You set it up once: serve the page over https, pin it with a name and its address in the phone app or in agentx.json, and the button appears at the top of Chat. " +
    "Then, each time: you tap the button, your phone opens the page inside the AgentX app, and the page asks for the microphone if it needs it. " +
    "Your computer only keeps the list of buttons; it never opens the page.",
})

d.header("How a pinned page opens", "Your computer keeps the buttons; the page comes from its own server.", [
  [C.accent, "You"],
  [C.ink, "Your phone"],
])

let y = 148
d.band(104, ROW + 64, "YOU SET IT UP ONCE")
const setup = d.row(
  [
    { title: ["Serve the page", "over https"], note: ["for example on your", "tailnet"] },
    { title: ["Pin it with a", "name and address"], note: ["in the app, agentx app pin,", "or agentx.json"] },
    { title: ["The button shows", "at the top of Chat"], note: ["on every phone paired", "with this computer"] },
  ],
  y,
  { who: "accent" },
)

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "THEN, EACH TIME", { tint: C.tintGrey, dx: 48 })
d.wrap(setup.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Tap the button"], note: ["one tap, no link to find"], who: "accent" },
    { title: ["The page opens", "inside the app"], note: ["close it to come back", "to AgentX"], who: "ink" },
    { title: ["It asks for the", "microphone"], note: ["only if the page needs it:", "tap Allow once"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“must start with https://”", "Serve the page over https."],
    ["The page does not load", "Turn Tailscale on on the phone."],
    ["No microphone prompt", "Allow the microphone for Chrome."],
    ["No button", "Open Chat: buttons show there."],
  ],
  delay: end + 0.6,
})

export default d.svg()
