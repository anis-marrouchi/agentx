#!/usr/bin/env node
// All names, reviews and clocks below are fictional publication fixtures.
// Tasks go through the real daemon; reviews use the real SQLite table because
// the review API intentionally accepts transcripts, not precomputed findings.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
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
// Open requests on, for the tracked plan seeded below (#788).
cfg.requests = { enabled: true }
// Monthly caps for the Wall's Cost page (#1423): one agent and the fleet.
cfg.agents.cx.budget = { monthlyUsd: 5 }
cfg.budget = { monthlyUsd: 20 }
// The intent graph's files, for the Wall's review queue (#1182). The graph
// stays off, so nothing classifies; the queue only reads these files.
cfg.graph = { enabled: false, baseDir: ".agentx/graph" }
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")

// Two places with reminders for the /places shot (place reminders, #676).
// Nothing watches them: no phone is paired with the demo.
mkdirSync(resolve(root, ".agentx"), { recursive: true })
const placesAt = new Date(Date.now() - 86400000).toISOString()
writeFileSync(resolve(root, ".agentx/places.json"), JSON.stringify({
  places: [
    { id: "pl_demo00school", name: "School", lat: 48.8584, lng: 2.2945, radius: 200, createdAt: placesAt },
    { id: "pl_demo0library", name: "Library", lat: 48.8606, lng: 2.3376, radius: 150, createdAt: placesAt },
  ],
  rules: [
    { id: "pr_demo00000001", placeId: "pl_demo00school", on: "enter", text: "Pick up the parcel at the front desk", repeat: false, enabled: true, createdAt: placesAt },
    { id: "pr_demo00000002", placeId: "pl_demo00school", on: "exit", text: "What is left on today's list?", agent: "cx", repeat: true, enabled: true, createdAt: placesAt },
  ],
  seen: [],
}, null, 2) + "\n")

// A slow scripted step, so the Live shot can catch a task while it runs.
const scriptPath = resolve(root, "demo-script.json")
const script = JSON.parse(readFileSync(scriptPath, "utf8"))
// Not when the request is quoted in a pause's plan-writing turn: that turn
// gets the scripted plan, at once, instead of this minute-long review.
const backlog = "(?<!The request you were working on:\\n)Go through the demo backlog"
script.steps = script.steps.filter(s => !String(s.match).endsWith("Go through the demo backlog"))
script.steps.push({
  match: backlog,
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
// A workflow whose one agent step takes a minute (the scripted backlog
// review), so the Live page can show it paused by a stop signal (#870).
{
  const file = resolve(root, "demo-backlog.json")
  const nodes = fixture.nodes.map((n) => n.type === "agent" ? { ...n, config: { ...n.config, prompt: "Go through the demo backlog and tell me what is ready." } } : n)
  writeFileSync(file, JSON.stringify({ ...fixture, id: "demo-backlog", title: "Review the demo backlog", state: "active", nodes }, null, 2))
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
  // A retro card (#743): fixes to choose from, and a spec the operator may edit.
  {
    title: "Demo service left stopped after a deploy", ask: "What should change so this can't happen again?",
    recommend: "Deploy script: restart and check health: the most severe (high)", if_silent: "discard", expires: "3d",
    context: "The deploy stopped the demo service (step 4) and never started it again; the health check was refused (step 6).",
    // At most three choices, as the Mac card shows them.
    choices: ["Deploy script: restart and check health", "Watchdog: alert when the service is down", "None of these"],
    draft: "Build: {choice}\n\n1. Deploy script [script, high]\n   One script; CI runs it dry.\n2. Watchdog [watchdog, medium]",
    source: "agentx trace show demo-task-1",
  },
]) await post("/approvals", { ...card, raised_by: "cx" })

// A post drafted in the owner's voice (#1291), through the real agent
// endpoint: two past posts in the agent's voice/ folder, then the draft.
{
  const voice = resolve(root, cfg.agents.cx.workspace, "voice")
  mkdirSync(voice, { recursive: true })
  writeFileSync(resolve(voice, "2026-03-first-month.md"), "One month of the demo shop. Three things surprised us: people book on Sunday evenings, they read every word of the price list, and they always ask about parking.\n")
  writeFileSync(resolve(voice, "2026-06-new-hours.md"), "We open an hour earlier from Monday. You asked for it, so here it is. See you at 8.\n")
  await post("/content/drafts", {
    agent: "cx", platform: "linkedin", topic: "What 100 bookings taught us", date: "2026-11-02",
    samples: ["2026-03-first-month.md", "2026-06-new-hours.md"],
    text: "100 bookings at the demo shop. Three things we learned:\n\n1. Most people book on Sunday evening, so we answer then too.\n2. A short price list gets more bookings than a long one.\n3. Parking is still the first question. It now has its own line on the page.\n\nThank you for the first hundred.",
  })
}

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

// Daily token use for the Cost pages (#1423): three agents over 100 days,
// one on a local model with no price. Fictional; the same every seed.
db.transaction(() => {
  const put = db.prepare(`INSERT OR REPLACE INTO usage_daily
    (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tasks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const day = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10)
  for (let back = 0; back < 100; back++) {
    const wave = 1 + 0.5 * Math.sin(back / 3)
    put.run("cx", "claude-sonnet-4", day(back), Math.round(60000 * wave), Math.round(9000 * wave), Math.round(400000 * wave), 20000, 3 + (back % 3))
    if (back % 2 === 0) put.run("reviewer", "claude-haiku-4", day(back), Math.round(250000 * wave), 30000, 120000, 8000, 2)
    if (back % 4 === 0) put.run("notes", "llama-3-8b", day(back), 40000, 6000, 0, 0, 3)
  }
})()

// One open request with a tracked plan (#788), for the Approvals shot. The
// daemon made the tables at start. Step 2 was handed over just now, so the
// plan check neither nudges it nor sends the message before the shot.
const ago = (minutes) => Date.now() - minutes * 60000
db.transaction(() => {
  db.prepare("DELETE FROM requests WHERE id = 'req-docs-plan'").run()
  // Its headline and need line (#1126), as the agent gives them.
  db.prepare(`INSERT INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at, headline, need, headline_by)
    VALUES ('req-docs-plan', 'in_progress', 'dashboard', 'demo', 'Demo operator', 'cx', ?, ?, ?, ?, ?, 'agent')`)
    .run("so the checkout button on the demo shop is broken again, can you fix it, ship it, and then let the shop know once it is live",
      ago(95), ago(2), "Fix and ship the demo shop checkout button", "Nothing, just so you know.")
  db.prepare("INSERT INTO request_plans (request_id, created_by, created_at, state) VALUES ('req-docs-plan', 'cx', ?, 'active')").run(ago(94))
  const step = db.prepare(`INSERT INTO request_plan_steps (request_id, idx, name, kind, agent_id, done_when, state, needs_approval, approval,
    message, to_channel, to_chat, evidence, dispatched_at, updated_at) VALUES ('req-docs-plan', ?, ?, ?, 'cx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  step.run(1, "Build the fix", "task", "pull request merged", "done", 0, "none", null, null, null, "https://example.com/demo/shop/pull/48", ago(94), ago(40))
  step.run(2, "Deploy and check it is live", "deploy", "the shop shows version 2.4.1", "active", 0, "none", null, null, null, null, ago(2), ago(2))
  step.run(3, "Tell the shop", "message", "sent to telegram chat demo-shop", "pending", 1, "approved", "The checkout fix is live. Thank you for your patience.", "telegram", "demo-shop", null, null, ago(94))
  // QA sign-off (#1188): one request awaiting a verdict, one with a block.
  db.prepare("DELETE FROM requests WHERE id IN ('req-docs-qa-wait', 'req-docs-qa-block')").run()
  const qa = db.prepare(`INSERT INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at, headline, need, headline_by,
    work, qa_requested_at, qa_verdict, qa_by, qa_at, qa_note) VALUES (?, 'in_progress', 'dashboard', 'demo', 'Demo operator', 'cx', ?, ?, ?, ?, ?, 'agent', 'code', ?, ?, ?, ?, ?)`)
  qa.run("req-docs-qa-wait", "add a search box to the demo shop", ago(60), ago(10), "Add a search box to the demo shop", "Nothing, just so you know.",
    ago(10), null, null, null, null)
  qa.run("req-docs-qa-block", "let customers export their orders as a spreadsheet", ago(80), ago(30), "Export orders as a spreadsheet", "Nothing, just so you know.",
    ago(40), "block", "qa-check", ago(20), "The export fails when a customer has no orders.")
  db.prepare("INSERT INTO request_verdicts (request_id, verdict, by_agent, at, note) VALUES ('req-docs-qa-block', 'block', 'qa-check', ?, ?)")
    .run(ago(20), "The export fails when a customer has no orders.")
})()

// The Wall (#1180): a few more fictional requests, so the home page shows a
// hand-off with its thread, a question for the owner (with a concurrent run
// on its chat, #1187) and a closed task.
db.transaction(() => {
  const ids = ["req-docs-wall-handoff", "req-docs-wall-question", "req-docs-wall-done"]
  for (const id of ids) db.prepare("DELETE FROM requests WHERE id = ?").run(id)
  db.prepare("DELETE FROM task_traces WHERE task_id LIKE 'docs-wall-%'").run()
  const req = db.prepare(`INSERT INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at, state_changed_at,
    headline, need, headline_by, question, closed_at, evidence, home_kind, home_link, estimate_minutes)
    VALUES (?, ?, ?, ?, 'Demo operator', 'cx', ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`)
  req.run(ids[0], "waiting_other", "gitlab", "demo/shop:issue:47", "Update the demo shop FAQ with the new delivery times, and ask @reviewer to check it.",
    ago(70), ago(6), ago(30), "Update the demo shop FAQ with the new delivery times", "Nothing, just so you know.", null, null, null,
    "issue", "https://example.com/demo/shop/issues/47", 30)
  req.run(ids[1], "waiting_owner", "telegram", "demo-office", "Send the October newsletter to the demo office list.",
    ago(180), ago(50), ago(50), "Send the October newsletter to the demo office", "Answer: which day should it go out?", "Which day should it go out: Monday or Tuesday?", null, null,
    null, null, 15)
  req.run(ids[2], "done", "dashboard", "demo", "Check the demo office FAQ links.",
    ago(300), ago(20), ago(20), "Check the demo office FAQ links", "Nothing, just so you know.", null, ago(20), "https://example.com/demo/office/pull/12",
    null, null, 20)
  const trace = db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at, duration_ms, message_preview, final_response, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const link = db.prepare("INSERT OR REPLACE INTO request_links (request_id, kind, ref, at) VALUES (?, ?, ?, ?)")
  trace.run("docs-wall-1", "cx", "gitlab", "demo/shop:issue:47", "ok", ago(69), ago(60), 9 * 60000, "Update the FAQ", "Updated the FAQ in MR !48 (commit 4f2a9c1b). Asked @reviewer to check the wording.", null)
  trace.run("docs-wall-2", "reviewer", "a2a", "a2a:cx:reviewer:dlg-docs-1", "ok", ago(35), ago(31), 4 * 60000, "Check the FAQ wording", "Two wording fixes suggested on MR !48.", null)
  trace.run("docs-wall-3", "cx", "telegram", "demo-office", "error", ago(170), ago(169), 60000, "Send the newsletter", null, "mail provider answered 503")
  trace.run("docs-wall-4", "cx", "telegram", "demo-office", "ok", ago(51), ago(50), 70000, "Send the newsletter", "The draft is ready. Which day should it go out?", null)
  trace.run("docs-wall-5", "cx", "dashboard", "demo", "ok", ago(40), ago(21), 19 * 60000, "Check the links", "All **14 links** work. Fixed two in [pull request 12](https://example.com/demo/office/pull/12):\n\n- `/delivery` pointed to the old page\n- `/returns` had a typo", null)
  // #1187: the newsletter ask also reached the reviewer, on the same chat at the same time.
  trace.run("docs-wall-6", "reviewer", "telegram", "demo-office", "ok", ago(51) + 20000, ago(50) + 20000, 60000, "Send the newsletter", "I can send it today.", null)
  link.run(ids[0], "run", "docs-wall-1", ago(69))
  link.run(ids[0], "issue", "https://example.com/demo/shop/issues/47", ago(68))
  link.run(ids[0], "delegation", "dlg-docs-1", ago(36))
  link.run(ids[1], "run", "docs-wall-3", ago(170))
  link.run(ids[1], "run", "docs-wall-4", ago(51))
  link.run(ids[2], "run", "docs-wall-5", ago(40))
  // The newsletter question as a pending decision card on its post (#1185).
  link.run(ids[1], "card", "docs-wall-newsletter-day", ago(50))
})()
// Goals (#1168): two goals over the requests above, with the cost of their runs.
db.transaction(() => {
  const goal = db.prepare("UPDATE requests SET goal_id = ?, goal_title = ? WHERE id = ?")
  for (const id of ["req-docs-plan", "req-docs-qa-wait", "req-docs-qa-block"]) goal.run("shop-relaunch", "Relaunch the demo shop", id)
  for (const id of ["req-docs-wall-question", "req-docs-wall-done"]) goal.run("office-newsletter", "Monthly newsletter for the demo office", id)
  const cost = db.prepare("UPDATE task_traces SET cost_usd = ? WHERE task_id = ?")
  cost.run(0.42, "docs-wall-4")
  cost.run(0.18, "docs-wall-5")
  db.prepare("DELETE FROM task_traces WHERE task_id LIKE 'docs-goal-%'").run()
  const trace = db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at, duration_ms, message_preview, final_response, cost_usd)
    VALUES (?, 'cx', 'dashboard', 'demo', 'ok', ?, ?, ?, ?, ?, ?)`)
  const link = db.prepare("INSERT OR REPLACE INTO request_links (request_id, kind, ref, at) VALUES (?, 'run', ?, ?)")
  for (const [id, req, minutes, usd] of [["docs-goal-1", "req-docs-plan", 90, 1.37], ["docs-goal-2", "req-docs-qa-wait", 55, 0.64], ["docs-goal-3", "req-docs-qa-block", 75, 0.91]]) {
    trace.run(id, ago(minutes), ago(minutes - 8), 8 * 60000, "Demo shop work", "Done.", usd)
    link.run(req, id, ago(minutes))
  }
})()
{
  const iso = (ms) => new Date(ms).toISOString()
  mkdirSync(resolve(root, ".agentx/approvals"), { recursive: true })
  writeFileSync(resolve(root, ".agentx/approvals/docs-wall-newsletter-day.json"), JSON.stringify({
    id: "docs-wall-newsletter-day", title: "Newsletter day for the demo office",
    ask: "Send the October newsletter to the demo office list on Monday?",
    recommend: "Yes: Monday mornings get the most opens on this list",
    if_silent: "pause", expires: iso(Date.now() + 18 * 3_600_000), raised_by: "cx",
    created_at: iso(Date.now() - 50 * 60_000), status: "pending",
  }, null, 2) + "\n")
}
db.close()

// The portfolio (#1194) opens only with a key. This one exists only in the
// throwaway demo folder, for the screenshots; capture.mjs types the same.
{
  const demoKey = "agx_live_" + "demo".repeat(16)
  const file = resolve(root, ".agentx/tokens.json")
  const tokens = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).filter(t => t.id !== "tok_demo1194") : []
  tokens.push({
    id: "tok_demo1194", name: "Demo director", prefix: demoKey.slice(0, 13),
    hash: "sha256:" + createHash("sha256").update(demoKey).digest("hex"),
    scopes: ["wall:portfolio"], createdAt: new Date().toISOString(),
  })
  writeFileSync(file, JSON.stringify(tokens, null, 2) + "\n")
}

// The Wall's review queue (#1182): one pending classification, one the
// review agent approved (adding one node) and one it rejected. Fictional.
{
  const dir = resolve(root, ".agentx/graph")
  mkdirSync(dir, { recursive: true })
  const at = (min) => new Date(Date.now() - min * 60000).toISOString()
  writeFileSync(resolve(dir, "nodes.json"), JSON.stringify({ version: 1, nodes: [
    { id: "work", level: "category", parentId: null, axes: { name: "Work" }, createdAt: at(2880) },
    { id: "work.invoice", level: "verb", parentId: "work", axes: { name: "Invoice", kind: "task" }, createdAt: at(178), createdBy: "reviewer" },
  ] }, null, 2) + "\n")
  const base = { agentId: "cx", channel: "telegram", leaf: {}, source: "llm" }
  const rows = [
    { ...base, ts: at(180), msgHash: "docs-review-invoice", path: ["work", "work.invoice"], proposedAxes: { "work.invoice": { name: "Invoice", kind: "task" } }, confidence: 0.62, status: "pending", preview: "Send the October invoice to the demo shop" },
    { ...base, ts: at(178), msgHash: "docs-review-invoice", path: ["work", "work.invoice"], proposedAxes: { "work.invoice": { name: "Invoice", kind: "task" } }, confidence: 0.62, status: "approved", preview: "Send the October invoice to the demo shop · reviewer=reviewer · The wiki has an invoicing page for the demo shop." },
    { ...base, ts: at(120), msgHash: "docs-review-lunch", path: ["work", "work.lunch"], proposedAxes: { "work.lunch": { name: "Lunch" } }, confidence: 0.3, status: "pending", preview: "What is for lunch today?" },
    { ...base, ts: at(118), msgHash: "docs-review-lunch", path: ["work", "work.lunch"], proposedAxes: { "work.lunch": { name: "Lunch" } }, confidence: 0.3, status: "rejected", preview: "What is for lunch today? · reviewer=reviewer · Small talk, not a work request." },
    { ...base, ts: at(30), msgHash: "docs-review-refund", path: ["work", "work.refund"], proposedAxes: { "work.refund": { name: "Refund", kind: "task" } }, confidence: 0.41, status: "pending", preview: "Refund order 12 for the demo office" },
  ]
  writeFileSync(resolve(dir, "classifications.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
}

// Two fictional handovers, for Settings › Agents › cx › Handovers (#1428):
// one chat passed from cx to builder, one passed to cx from scout.
{
  const dir = resolve(root, ".agentx")
  mkdirSync(dir, { recursive: true })
  const at = new Date().toISOString()
  const ho = (channel, chatId, fromAgent, toAgent, extra = {}) => [`${channel}::${chatId}::-`, { channel, chatId, fromAgent, toAgent, createdAt: at, createdBy: "admin-ui", ...extra }]
  writeFileSync(resolve(dir, "handover.json"), JSON.stringify({ version: 1, overrides: Object.fromEntries([
    ho("telegram", "demo-office", "cx", "builder", { summary: "They asked for a quote on the new shelves." }),
    ho("whatsapp", "+10000000000", "scout", "cx", { expiresAt: "2030-01-01T00:00:00Z" }),
  ]) }, null, 2) + "\n")
}

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
console.log("Seeded three workflows, three disabled schedules with one scheduled run, one schedule request, three decision cards, two clients, six fictional reviews, an open request with a plan, three Wall posts (one with a decision card), a webhook, a board, an action, two places, two handovers, and two real scripted task runs.")
