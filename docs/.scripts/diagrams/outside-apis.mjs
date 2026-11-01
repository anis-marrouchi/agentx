// How an agent reads data from an outside service you signed in to:
// the picture at the top of docs/integrations.md.
import { C, createDiagram } from "./kit.mjs"

const ROW = 136

const d = createDiagram({
  height: 660,
  title: "How an agent reads data from a service you connected",
  desc:
    "Six steps in two parts. Once: you create an app with the service and put its id and secret in .env, you run agentx agent integrations connect and sign in in the browser, and the service's answer is kept in your computer's keyring or in .env. " +
    "Then, each time: the agent asks for a named read, AgentX checks it against the allowed list and adds the token, and the service's numbers come back to the agent. The agent never sees the token and can only read.",
})

d.header("Read data from a service you connected", "You sign in once. The agent only reads, and never sees the token.", [
  [C.accent, "You"],
  [C.ink, "AgentX and the agent"],
])

let y = 148
d.band(104, ROW + 64, "ONCE")
const once = d.row(
  [
    { title: ["Create an app"], note: ["with the service; put its", "id and secret in .env"], who: "accent" },
    { title: ["Connect"], note: ["sign in and approve", "in the browser"], who: "accent" },
    { title: ["Token kept safe"], note: ["in the keyring or .env,", "never in agentx.json"], who: "ink" },
  ],
  y,
)

const band = y + ROW + 36
y = band + 44
d.band(band, ROW + 64, "EACH TIME THE AGENT NEEDS NUMBERS", { tint: C.tintGrey, dx: 48 })
d.wrap(once.at(-1), d.x0 + 26, y)
d.row(
  [
    { title: ["Agent asks"], note: ["a named read, such as", "a monthly report"], who: "ink" },
    { title: ["AgentX checks it"], note: ["allowed read and values;", "adds a fresh token"], who: "ink" },
    { title: ["Numbers come back"], note: ["read only; nothing", "is posted or changed"], who: "ink" },
  ],
  y,
)

const end = d.now
d.list(d.x0, y + ROW + 56, {
  title: "IF IT DOES NOT WORK",
  columns: 2,
  items: [
    ["“not connected”", "Run connect again."],
    ["“not granted: …”", "Connect again and allow every permission."],
  ],
  delay: end + 1.2,
})

export default d.svg()
