#!/usr/bin/env node
// All names, reviews and clocks below are fictional publication fixtures.
// Tasks go through the real daemon; reviews use the real SQLite table because
// the review API intentionally accepts transcripts, not precomputed findings.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = resolve(repo, ".agentx-demo/node-a")
const cfgPath = resolve(root, "agentx.json")
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
if (cfg.node?.id !== "demo-laptop" || cfg.node.bind !== "127.0.0.1:18921" || cfg.agents?.cx?.provider !== "demo") {
  throw new Error("Refusing to seed anything except the isolated default demo.")
}
if (!existsSync(resolve(root, "demo-script.json"))) throw new Error("Demo script is missing.")
const api = "http://127.0.0.1:18921"
async function post(path, body = {}) {
  const r = await fetch(api + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

cfg.workflows = { enabled: true }
cfg.business = {
  enabled: false,
  mainChannel: { channel: "telegram", chatId: "demo-shop" },
  workSource: { type: "backlog" },
  projects: [{ id: "demo/shop", pm: "cx", client: "shop" }, { id: "demo/office", client: "office" }],
  clients: {
    shop: { name: "Demo Shop", kind: "client", respondWithin: "1h" },
    office: { name: "Demo Office", kind: "client", respondWithin: "4h" },
  },
  contactMap: [{ channel: "telegram", chatId: "demo-office", client: "office", project: "demo/office" }],
}
cfg.channels = { telegram: { enabled: false, accounts: { demo: { token: "123456:demo-bot-token", agentBinding: "cx" } } }, whatsapp: { enabled: false } }
cfg.crons = Object.fromEntries([
  ["morning-report", "0 9 * * *", "Prepare the demo shop report."],
  ["weekly-review", "0 9 * * 1", "Review the demo shop week."],
  ["afternoon-check", "0 15 * * 1-5", "Check the demo office queue."],
].map(([id, schedule, prompt]) => [id, { enabled: false, schedule, timezone: "UTC", agent: "cx", prompt }]))
// A schedule an agent asked for and nobody has approved yet: it shows up in
// the Approvals inbox next to the decision cards seeded below.
cfg.crons["friday-summary"] = {
  enabled: false, schedule: "0 16 * * 5", timezone: "UTC", agent: "cx",
  prompt: "Summarise the demo shop week for the team.", createdBy: "cx",
  approval: { action: "create", requestedBy: "cx", requestedAt: new Date(Date.now() - 2 * 3600000).toISOString() },
}
// One webhook with a routing trigger, and one board with two custom columns,
// for the Settings › Webhooks and Settings › Boards shots. Nothing calls them.
cfg.webhooks = [{
  id: "example-github", source: "github", agentId: "cx", secretEnv: "EXAMPLE_WEBHOOK_SECRET",
  description: "Pull requests on the demo shop", triggers: { "pull_request.opened": "demo-report" },
}]
cfg.boards = [{
  id: "demo-shop", name: "Demo Shop",
  source: { type: "gitlab", projects: ["demo/shop", "demo/office"] },
  timeRangeDays: 30, closedWindowDays: 30, primaryToolLabel: "Tool::Demo",
  columns: [
    { id: "doing", title: "Doing", kind: "scoped-label", scopedPrefix: "Status", scopedLabel: "Status::Doing" },
    { id: "review", title: "Review", kind: "scoped-label", scopedPrefix: "Status", scopedLabel: "Status::Review" },
  ],
}]
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")

// A slow scripted step, so the Live shot can catch a task while it runs.
const scriptPath = resolve(root, "demo-script.json")
const script = JSON.parse(readFileSync(scriptPath, "utf8"))
script.steps = script.steps.filter(s => s.match !== "Go through the demo backlog")
script.steps.push({
  match: "Go through the demo backlog",
  thinking: "Reading the demo backlog one issue at a time.",
  reply: "Backlog reviewed: three demo issues are ready and one waits for the customer. This is a scripted example.",
  delayMs: 60000,
})
writeFileSync(scriptPath, JSON.stringify(script, null, 2))

// A harmless shell action for Settings › Actions: it only prints a line.
execFileSync(process.execPath, [resolve(repo, "dist/cli.js"), "actions", "add", "shop-ping",
  "--title", "Ping the demo shop", "--kind", "shell", "--description", "Prints a scripted status line.",
  "--command", "echo \"Demo shop for {{who}}: all checks passed\"", "--inputs", "who:string"], { cwd: root, stdio: "pipe" })

const fixture = JSON.parse(readFileSync(resolve(repo, "docs/public/examples/demo-report.json"), "utf8"))
for (const [id, title] of [["demo-report", "Draft the demo shop report"], ["demo-handoff", "Prepare a customer handoff"]]) {
  const file = resolve(root, `${id}.json`)
  writeFileSync(file, JSON.stringify({ ...fixture, id, title }, null, 2))
  execFileSync(process.execPath, [resolve(repo, "dist/cli.js"), "workflow", "add", file, "--no-reload"], { cwd: root, stdio: "pipe" })
}
await post("/reload")
for (const [channel, chatId] of [["gitlab", "demo/shop:issue:47"], ["telegram", "demo-office"]]) {
  const result = await post("/task", { agent: "cx", message: "Prepare the demo shop report.", context: { channel, chatId, sender: "Demo operator" } })
  if (result.error) throw new Error(result.error)
}

// Decision cards go through the daemon's real agent-facing endpoint.
for (const card of [
  { title: "Send the demo shop newsletter", ask: "Send the October newsletter to the demo shop list on Monday?", recommend: "Yes: the draft is reviewed and the links are checked", if_silent: "discard", expires: "20h", source: "https://example.com/drafts/newsletter-october" },
  { title: "Merge the demo office FAQ update", ask: "Merge MR !12 with the new support hours?", recommend: "Yes: the hours match what the office confirmed", if_silent: "keep", expires: "3d" },
]) await post("/approvals", { ...card, raised_by: "cx" })

const db = new Database(resolve(root, ".agentx/db.sqlite"))
const insert = db.prepare(`INSERT OR REPLACE INTO session_reviews
  (id,session_id,agent,source,status,updated_at,model,input,result,error)
  VALUES (?,?,?,'docs-fixture','ready',?,'scripted-demo','',?,NULL)`)
const samples = [
  ["Approve the demo shop refund policy.", true, "shop", 90],
  ["Choose the delivery date for the demo shop launch.", true, "shop", 40],
  ["Confirm the demo office support hours.", true, "office", 25],
  ["Draft the customer update for demo/shop MR !47.", false, "shop", 55],
  ["Check the demo office FAQ links.", false, "office", 20],
  ["Prepare tomorrow's demo shop report.", false, "shop", 10],
]
db.transaction(() => {
  for (const [index, [text, needsHuman, client, minutesAgo]] of samples.entries()) {
    const session = client === "shop" ? "cx:gitlab:demo/shop:issue:47" : "cx:telegram:demo-office"
    const result = {
      summary: "Fictional documentation review: " + text,
      warnings: [],
      actions: [{ text, evidence: "Seeded demo fixture; no customer work was performed.", when: "now", minutes: 10, effort: "low", needsHuman }],
      decisions: [], friction: [], context: [], links: [], relatedTaskIds: [],
    }
    insert.run(`external:docs-${index}`, session, "cx", Date.now() - minutesAgo * 60000, JSON.stringify(result))
  }
})()
db.close()

// One real scheduled run, for the schedule drawer's Runs today: switch the
// morning report to every minute, wait for its first run, then put it back.
const runsToday = async () => (await (await fetch(api + "/crons/runs")).json()).runs || []
if (!(await runsToday()).some(r => r.jobId === "morning-report")) {
  const saved = { ...cfg.crons["morning-report"] }
  const setJob = async job => {
    cfg.crons["morning-report"] = job
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
    await post("/reload")
  }
  console.log("Waiting up to two minutes for one scheduled run…")
  await setJob({ ...saved, enabled: true, schedule: "* * * * *" })
  try {
    const deadline = Date.now() + 130000
    while (!(await runsToday()).some(r => r.jobId === "morning-report")) {
      if (Date.now() > deadline) throw new Error("The scheduled run did not happen.")
      await new Promise(r => setTimeout(r, 3000))
    }
  } finally {
    await setJob(saved)
  }
}
console.log("Seeded two workflows, three disabled schedules with one scheduled run, one schedule request, two decision cards, two clients, six fictional reviews, a webhook, a board, an action, and two real scripted task runs.")
