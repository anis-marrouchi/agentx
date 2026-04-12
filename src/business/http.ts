import type { IncomingMessage, ServerResponse } from "http"
import type { WorkSource } from "./work-pool"
import type { Organization } from "./organization"
import type { Schedule } from "./schedule"
import type { Reporter } from "./reporter"
import type { KPI } from "./kpi"

// --- Business HTTP endpoints ---
// Agents running in their Claude Code workspaces reach the daemon over HTTP
// (localhost:18800 by default). These endpoints expose the work pool,
// reporter, and KPI snapshot so an agent's lifecycle prompts can call them.

export interface BusinessHttpDeps {
  workSource: WorkSource
  org: Organization
  schedule: Schedule
  reporter: Reporter
  kpi: KPI
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
}

/**
 * Try to handle a business HTTP request. Returns true if handled.
 * Call from the daemon's handleHttp() before the default case.
 */
export async function handleBusinessHttp(
  route: string,                // "METHOD PATH"
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessHttpDeps,
): Promise<boolean> {
  // GET /business/status — full snapshot
  if (route === "GET /business/status") {
    const now = new Date()
    const onClock = deps.schedule.clockedInAgents(now)
    json(res, 200, {
      time: now.toISOString(),
      onClock,
      employees: deps.org.all().map((e) => ({
        agentId: e.agentId,
        role: e.role.title,
        reportsTo: e.reportsTo,
        onClock: onClock.includes(e.agentId),
      })),
      kpi: deps.kpi.snapshot(),
    })
    return true
  }

  // GET /business/work?agent=<id>
  if (route.startsWith("GET /business/work")) {
    const url = new URL(req.url || "/", "http://x")
    const agentId = url.searchParams.get("agent")
    if (!agentId) { json(res, 400, { error: "?agent= required" }); return true }
    try {
      const items = await deps.workSource.listOpen(agentId)
      json(res, 200, { items })
    } catch (e: any) {
      json(res, 500, { error: e.message })
    }
    return true
  }

  // POST /business/claim  { agent, itemId }
  if (route === "POST /business/claim") {
    const body = await readJson(req)
    const { agent, itemId } = body as { agent?: string; itemId?: string }
    if (!agent || !itemId) { json(res, 400, { error: "agent and itemId required" }); return true }
    try {
      await deps.workSource.claim(agent, itemId)
      json(res, 200, { ok: true })
    } catch (e: any) {
      json(res, 500, { error: e.message })
    }
    return true
  }

  // POST /business/report  { itemId, status, note?, timeSeconds?, blocker? }
  if (route === "POST /business/report") {
    const body = await readJson(req) as {
      itemId?: string; status?: string; note?: string; timeSeconds?: number; blocker?: string
    }
    if (!body.itemId || !body.status) { json(res, 400, { error: "itemId and status required" }); return true }
    if (!["in-progress", "done", "blocked"].includes(body.status)) {
      json(res, 400, { error: "status must be in-progress | done | blocked" }); return true
    }
    try {
      await deps.workSource.report(body.itemId, {
        status: body.status as any,
        note: body.note,
        timeSeconds: body.timeSeconds,
        blocker: body.blocker,
      })
      json(res, 200, { ok: true })
    } catch (e: any) {
      json(res, 500, { error: e.message })
    }
    return true
  }

  // POST /business/escalate  { agent, subject, detail }
  if (route === "POST /business/escalate") {
    const body = await readJson(req) as { agent?: string; subject?: string; detail?: string }
    if (!body.agent || !body.subject) { json(res, 400, { error: "agent and subject required" }); return true }
    await deps.reporter.escalate(body.agent, body.subject, body.detail || "")
    deps.kpi.recordBlocker(body.agent)
    json(res, 200, { ok: true })
    return true
  }

  // POST /business/post  { agent, text }
  if (route === "POST /business/post") {
    const body = await readJson(req) as { agent?: string; text?: string }
    if (!body.text) { json(res, 400, { error: "text required" }); return true }
    await deps.reporter.postToMain(body.text, body.agent)
    json(res, 200, { ok: true })
    return true
  }

  return false
}

/**
 * Human-readable tool documentation, injected into agent workspace CLAUDE.md
 * when the business layer is enabled. Agents use `curl` to call these.
 */
export function businessToolsDoc(daemonBase: string): string {
  return `## Business Layer Tools

During business hours you'll receive lifecycle prompts ([STANDUP], [WORK], [WRAP]).
Use these HTTP endpoints on the local daemon to act on them.

- **List your work:**
  \`curl -s ${daemonBase}/business/work?agent=<your-id>\`
- **Claim an item** (optional — some sources no-op):
  \`curl -s -X POST ${daemonBase}/business/claim -d '{"agent":"<your-id>","itemId":"<id>"}'\`
- **Report progress or completion:**
  \`curl -s -X POST ${daemonBase}/business/report \\
     -d '{"itemId":"<id>","status":"done","timeSeconds":1800,"note":"shipped"}'\`
  status: \`in-progress\` | \`done\` | \`blocked\`
- **Escalate a blocker** up the org chart:
  \`curl -s -X POST ${daemonBase}/business/escalate \\
     -d '{"agent":"<your-id>","subject":"short","detail":"why it's stuck"}'\`
- **Post to the main channel** (daily plans, reports):
  \`curl -s -X POST ${daemonBase}/business/post \\
     -d '{"agent":"<your-id>","text":"your update"}'\`

Your org chart, role, and schedule are fixed in agentx.json under \`business.orgChart\`.
`
}
