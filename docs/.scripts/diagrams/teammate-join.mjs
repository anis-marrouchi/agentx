// How a teammate joins: the picture at the top of docs/jobs/members.md.
import { C, createDiagram } from "./kit.mjs"

const d = createDiagram({
  height: 836,
  title: "How a teammate joins AgentX",
  desc:
    "Thirteen steps in three rows. The owner prepares: add the person, publish only the member page, limit shared users to port 443, create the invite, share the computer in Tailscale, send the address and the code. " +
    "The teammate installs Tailscale, opens the address, enters a machine name and the code, and waits. The owner says yes on a decision card. " +
    "The page becomes My work and can be installed as an app. A no, or three days without an answer, ends the key.",
})

d.header("How a teammate joins", "You prepare once. They pair in a minute. Nothing opens until you say yes.", [
  [C.accent, "You, the owner"],
  [C.ink, "The teammate"],
])

d.band(104, 196, "YOU PREPARE")
const prepare = d.row(
  [
    { title: ["Add them to", "People"], note: ["with the account they", "write from"] },
    { title: ["Publish only the", "member page"], note: ["nothing else of yours", "is reachable"] },
    { title: ["Limit shared users", "to port 443"], note: ["in the Tailscale", "access rules"] },
    { title: ["Create the invite"], note: ["agentx people invite", "prints address + code"] },
    { title: ["Share this computer", "in Tailscale"], note: ["admin console:", "Machines › Share"] },
    { title: ["Send the address", "and the code"], note: ["the code works once,", "for 10 minutes"] },
  ],
  148,
  { who: "accent" },
)

d.band(316, 196, "THE TEAMMATE PAIRS, YOU APPROVE", { tint: C.tintGrey, dx: 48 })
d.wrap(prepare.at(-1), d.x0 + 26, 360)
const pair = d.row(
  [
    { title: ["Install Tailscale,", "accept the share"], note: ["on their own machine"], who: "ink" },
    { title: ["Open the address"], note: ["in Edge or Chrome"], who: "ink" },
    { title: ["Enter a machine name", "and the code"], note: ["then press Pair"], who: "ink" },
    { title: ["Waiting for the owner"], note: ["the page waits by itself"], who: "ink" },
    { title: ["Say yes on the card"], note: ["“New machine for …” in", "your Approvals inbox"], who: "accent" },
  ],
  360,
)

d.band(528, 288, "CONNECTED", { dx: 48 })
d.wrap(pair.at(-1), d.x0 + 26, 572, { label: "Yes" })
d.row(
  [
    { title: ["The page becomes", "My work"], note: ["only their own requests.", "The key lasts 90 days"], who: "ink" },
    { title: ["Install it as an app"], note: ["browser menu › Apps ›", "Install this site as an app"], who: "ink" },
  ],
  572,
  { to: d.x0 + 432 },
)

const end = d.now
d.callout(d.x0, 724, 432, {
  title: "No, or no answer within 3 days",
  note: "The key ends at once. Nothing of yours is shared.",
  delay: end + 0.4,
})
d.window(500, 572, 300, 220, {
  title: "My work",
  rows: [
    ["Invoice export for March", "In progress", C.accent],
    ["Fix the login redirect", "Waiting on owner", C.warn],
    ["Weekly stock report", "Done", C.done],
  ],
  delay: end + 0.2,
})
d.list(824, 590, {
  title: "IF IT DOES NOT WORK",
  items: [
    ["“That code didn’t work”", "Invite again: a code lasts 10 minutes, one use."],
    ["“Someone else is connecting”", "Their Tailscale login differs from People."],
    ["Waiting does not end", "Your card is still unanswered."],
    ["My work is empty", "Turn on request tracking, add their identity."],
  ],
  delay: end + 1.6,
})

export default d.svg()
