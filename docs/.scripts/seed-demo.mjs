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
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")

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
console.log("Seeded two workflows, three disabled schedules, one schedule request, two decision cards, two clients, six fictional reviews, and two real scripted task runs.")
