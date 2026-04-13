import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs"
import { resolve, join } from "path"
import type { BusinessConfig, BusinessWorkSource } from "./config"
import type { DaemonConfig } from "@/daemon/config"

// --- Work pool: pluggable source of tasks for the business layer ---

export interface WorkItem {
  id: string                      // stable id for claim/report (e.g. "backlog:line-12", "gitlab:proj:issue:42")
  title: string
  description?: string
  assignee?: string               // agentId
  estimatedSeconds?: number
  url?: string
  priority?: number               // lower = higher priority
  /** Board stage derived from labels (kanban column id). */
  stage?: "triage" | "todo" | "doing" | "onhold" | "review" | "done"
  /** Raw labels from the source (GitLab). Empty array if source doesn't support labels. */
  labels?: string[]
  /** ISO timestamp of last update on the source. */
  updatedAt?: string
}

export interface WorkReport {
  status: "in-progress" | "done" | "blocked"
  note?: string
  timeSeconds?: number
  blocker?: string
}

/** What a WorkSource can do beyond the minimal listOpen/claim/report triple. */
export interface WorkSourceCapabilities {
  /** Enumerate items beyond assignee filter — required for a board view. */
  listAll: boolean
  /** Create new items (e.g. POST GitLab issue). */
  create: boolean
  /** Arbitrary column transitions (label add/remove pair). */
  transition: boolean
  /** Surfaces labels[] on returned items. */
  labels: boolean
  /** Server-side text search. */
  search: boolean
}

export interface WorkCreateInput {
  title: string
  description?: string
  /** agentId */
  assignee?: string
  labels?: string[]
  /** For sources that span multiple projects (gitlab): "group/project". */
  projectHint?: string
}

export interface ListAllOpts {
  sinceDays?: number
  labels?: string[]
  search?: string
  assignee?: string
}

export interface WorkSource {
  type: string
  capabilities: WorkSourceCapabilities
  listOpen(agentId: string): Promise<WorkItem[]>
  claim(agentId: string, itemId: string): Promise<void>
  report(itemId: string, update: WorkReport): Promise<void>
  /** Optional — gated by capabilities.listAll. */
  listAll?(opts: ListAllOpts): Promise<WorkItem[]>
  /** Optional — gated by capabilities.create. */
  create?(input: WorkCreateInput): Promise<WorkItem>
  /**
   * Optional — gated by capabilities.transition. Add `toLabel` and remove
   * `fromLabel` (if provided) from the item. Used by the kanban board on drag.
   */
  transition?(itemId: string, toLabel: string, fromLabel?: string): Promise<void>
}

// ---------- BacklogWorkSource: GFM checklist file ----------
// Format in .agentx/backlog.md (or configured path):
//
//   - [ ] @alice Implement login form [time: 2h]
//   - [x] @alice Write unit tests (done)
//   - [ ] @bob Design pricing page [time: 1h30m]
//
// Line number is the stable id.

const CHECK_RE = /^(\s*)-\s*\[( |x|X)\]\s*(.*)$/
const MENTION_RE = /@([a-z0-9_-]+)/i
const TIME_RE = /\[time:\s*([0-9hm\s]+)\]/i

function parseDuration(s: string): number {
  // "2h30m" -> 9000 s. "1h" -> 3600. "45m" -> 2700.
  const hMatch = s.match(/(\d+)\s*h/i)
  const mMatch = s.match(/(\d+)\s*m/i)
  return (hMatch ? parseInt(hMatch[1], 10) * 3600 : 0) + (mMatch ? parseInt(mMatch[1], 10) * 60 : 0)
}

export class BacklogWorkSource implements WorkSource {
  type = "backlog"
  capabilities: WorkSourceCapabilities = {
    listAll: false, create: false, transition: false, labels: false, search: false,
  }
  constructor(private path: string) {}

  private read(): string[] {
    const full = resolve(process.cwd(), this.path)
    if (!existsSync(full)) return []
    return readFileSync(full, "utf-8").split("\n")
  }

  private write(lines: string[]): void {
    const full = resolve(process.cwd(), this.path)
    writeFileSync(full, lines.join("\n"))
  }

  async listOpen(agentId: string): Promise<WorkItem[]> {
    const lines = this.read()
    const items: WorkItem[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CHECK_RE)
      if (!m) continue
      const checked = m[2].toLowerCase() === "x"
      if (checked) continue
      const body = m[3]
      const mention = body.match(MENTION_RE)
      if (mention && mention[1].toLowerCase() !== agentId.toLowerCase()) continue
      const timeMatch = body.match(TIME_RE)
      const title = body.replace(MENTION_RE, "").replace(TIME_RE, "").trim()
      items.push({
        id: `backlog:${i}`,
        title: title || `Task at line ${i + 1}`,
        assignee: mention ? mention[1] : undefined,
        estimatedSeconds: timeMatch ? parseDuration(timeMatch[1]) : undefined,
        priority: i,
      })
    }
    return items
  }

  async claim(_agentId: string, _itemId: string): Promise<void> {
    // No-op: backlog file has no "claimed" state distinct from "assigned".
  }

  async report(itemId: string, update: WorkReport): Promise<void> {
    if (!itemId.startsWith("backlog:")) throw new Error(`not a backlog id: ${itemId}`)
    const lineNo = parseInt(itemId.slice("backlog:".length), 10)
    const lines = this.read()
    const line = lines[lineNo]
    if (!line) throw new Error(`backlog line ${lineNo} missing`)
    const m = line.match(CHECK_RE)
    if (!m) throw new Error(`backlog line ${lineNo} not a checkbox`)

    if (update.status === "done") {
      lines[lineNo] = line.replace(/- \[ \]/, "- [x]")
      const note = update.timeSeconds
        ? `    <!-- done by agent, ${Math.round(update.timeSeconds / 60)}m -->`
        : "    <!-- done by agent -->"
      lines.splice(lineNo + 1, 0, note)
    } else if (update.status === "blocked") {
      lines.splice(lineNo + 1, 0, `    <!-- BLOCKED: ${update.blocker || update.note || "?"} -->`)
    } else if (update.note) {
      lines.splice(lineNo + 1, 0, `    <!-- ${update.note.replace(/-->/g, "— >")} -->`)
    }
    this.write(lines)
  }
}

// ---------- WikiWorkSource: scan markdown files for @mention checkboxes ----------

export class WikiWorkSource implements WorkSource {
  type = "wiki"
  capabilities: WorkSourceCapabilities = {
    listAll: false, create: false, transition: false, labels: false, search: false,
  }
  constructor(private root: string, private glob: string) {}

  private walk(dir: string, out: string[]): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        this.walk(full, out)
      } else if (entry.endsWith(".md")) {
        out.push(full)
      }
    }
  }

  async listOpen(agentId: string): Promise<WorkItem[]> {
    const files: string[] = []
    this.walk(resolve(process.cwd(), this.root), files)
    const items: WorkItem[] = []
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(CHECK_RE)
        if (!m || m[2].toLowerCase() === "x") continue
        const mention = m[3].match(MENTION_RE)
        if (!mention || mention[1].toLowerCase() !== agentId.toLowerCase()) continue
        items.push({
          id: `wiki:${file}:${i}`,
          title: m[3].replace(MENTION_RE, "").trim(),
          assignee: mention[1],
          priority: i,
        })
      }
    }
    return items
  }

  async claim(): Promise<void> { /* no-op */ }

  async report(itemId: string, update: WorkReport): Promise<void> {
    // wiki:<file>:<line>
    const parts = itemId.split(":")
    const lineNo = parseInt(parts[parts.length - 1], 10)
    const file = parts.slice(1, -1).join(":")
    if (!existsSync(file)) return
    const lines = readFileSync(file, "utf-8").split("\n")
    if (update.status === "done" && lines[lineNo]) {
      lines[lineNo] = lines[lineNo].replace(/- \[ \]/, "- [x]")
      writeFileSync(file, lines.join("\n"))
    }
  }
}

// ---------- GitLabWorkSource: assignee-filtered issues via GitLab API ----------

export class GitLabWorkSource implements WorkSource {
  type = "gitlab"
  capabilities: WorkSourceCapabilities = {
    listAll: true, create: true, transition: true, labels: true, search: true,
  }

  constructor(
    private host: string,
    private token: string,
    private projects: string[],
    /** Map from agentId -> GitLab username(s) */
    private agentUsernames: Record<string, string[]>,
    private log: (...args: unknown[]) => void,
  ) {}

  /** Reverse lookup: GitLab username -> agentId. Used when resolving board items
   *  back to an agent (for the reconciler and card display). */
  private usernameToAgent(username: string): string | undefined {
    for (const [agentId, names] of Object.entries(this.agentUsernames)) {
      if (names.some((n) => n.toLowerCase() === username.toLowerCase())) return agentId
    }
    return undefined
  }

  private mapIssue(issue: any, project: string): WorkItem {
    const ns = issue.references?.full?.split("#")[0] || project
    const labels: string[] = Array.isArray(issue.labels) ? issue.labels : []
    const assigneeUsername = issue.assignee?.username || issue.assignees?.[0]?.username
    return {
      id: `gitlab:${ns}:issue:${issue.iid}`,
      title: issue.title,
      description: issue.description || undefined,
      assignee: assigneeUsername ? this.usernameToAgent(assigneeUsername) : undefined,
      url: issue.web_url,
      priority: issue.weight ?? 99,
      estimatedSeconds: issue.time_stats?.time_estimate || undefined,
      labels,
      updatedAt: issue.updated_at,
    }
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.host}/api/v4${path}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    })
    if (!res.ok) throw new Error(`GitLab ${res.status}: ${await res.text().catch(() => "")}`)
    return res.json()
  }

  async listOpen(agentId: string): Promise<WorkItem[]> {
    const usernames = this.agentUsernames[agentId] || []
    if (!usernames.length) return []

    const items: WorkItem[] = []
    const projectList = this.projects.length
      ? this.projects
      : ["__ALL__"]  // falls back to a global issues query

    for (const username of usernames) {
      for (const project of projectList) {
        try {
          const q = `assignee_username=${encodeURIComponent(username)}&state=opened&scope=all&per_page=20`
          const path = project === "__ALL__"
            ? `/issues?${q}`
            : `/projects/${encodeURIComponent(project)}/issues?${q}`
          const issues = await this.api(path)
          for (const issue of issues) {
            const item = this.mapIssue(issue, project)
            // Force assignee to the agent we queried for (listOpen is per-agent).
            item.assignee = agentId
            items.push(item)
          }
        } catch (e: any) {
          this.log(`[business] GitLab listOpen failed for ${username} on ${project}: ${e.message}`)
        }
      }
    }
    return items
  }

  async claim(agentId: string, itemId: string): Promise<void> {
    // itemId: "gitlab:<project>:issue:<iid>"
    const { project, iid, type } = this.parseId(itemId)
    // Transition labels: add "Doing", remove "To Do"
    const path = `/projects/${encodeURIComponent(project)}/${type === "issue" ? "issues" : "merge_requests"}/${iid}?add_labels=Doing&remove_labels=To Do`
    try {
      await this.api(path, { method: "PUT" })
    } catch (e: any) {
      this.log(`[business] claim label update failed: ${e.message}`)
    }
  }

  async report(itemId: string, update: WorkReport): Promise<void> {
    const { project, iid, type } = this.parseId(itemId)
    const seg = type === "issue" ? "issues" : "merge_requests"

    // Time tracking
    if (update.timeSeconds && update.timeSeconds > 0) {
      const mins = Math.max(1, Math.round(update.timeSeconds / 60))
      const dur = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins}m`
      try {
        await this.api(
          `/projects/${encodeURIComponent(project)}/${seg}/${iid}/add_spent_time?duration=${encodeURIComponent(dur)}`,
          { method: "POST" },
        )
      } catch (e: any) {
        this.log(`[business] add_spent_time failed: ${e.message}`)
      }
    }

    // Status → labels
    if (update.status === "done") {
      try {
        await this.api(
          `/projects/${encodeURIComponent(project)}/${seg}/${iid}?add_labels=Done&remove_labels=Doing`,
          { method: "PUT" },
        )
      } catch (e: any) {
        this.log(`[business] done label update failed: ${e.message}`)
      }
    } else if (update.status === "blocked") {
      try {
        await this.api(
          `/projects/${encodeURIComponent(project)}/${seg}/${iid}?add_labels=Blocked`,
          { method: "PUT" },
        )
      } catch (e: any) {
        this.log(`[business] blocked label update failed: ${e.message}`)
      }
    }

    // Note/comment
    if (update.note) {
      try {
        await this.api(
          `/projects/${encodeURIComponent(project)}/${seg}/${iid}/notes`,
          { method: "POST", body: JSON.stringify({ body: update.note }) },
        )
      } catch (e: any) {
        this.log(`[business] report note failed: ${e.message}`)
      }
    }
  }

  async listAll(opts: ListAllOpts = {}): Promise<WorkItem[]> {
    const sinceDays = opts.sinceDays ?? 30
    const updatedAfter = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString()

    const params = new URLSearchParams()
    params.set("state", "all")
    params.set("updated_after", updatedAfter)
    params.set("scope", "all")
    params.set("per_page", "100")
    if (opts.labels?.length) params.set("labels", opts.labels.join(","))
    if (opts.search) params.set("search", opts.search)

    const projectList = this.projects.length ? this.projects : ["__ALL__"]
    const items: WorkItem[] = []
    for (const project of projectList) {
      try {
        const path = project === "__ALL__"
          ? `/issues?${params.toString()}`
          : `/projects/${encodeURIComponent(project)}/issues?${params.toString()}`
        const issues = await this.api(path)
        for (const issue of issues) items.push(this.mapIssue(issue, project))
      } catch (e: any) {
        this.log(`[business] GitLab listAll failed on ${project}: ${e.message}`)
      }
    }
    return items
  }

  async create(input: WorkCreateInput): Promise<WorkItem> {
    const project = input.projectHint || this.projects[0]
    if (!project) throw new Error("GitLabWorkSource.create requires projectHint or configured projects")

    // Resolve assignee (agentId) → GitLab user id via cached /users?username=X
    let assignee_ids: number[] | undefined
    if (input.assignee) {
      const usernames = this.agentUsernames[input.assignee]
      if (usernames?.length) {
        try {
          const users = await this.api(`/users?username=${encodeURIComponent(usernames[0])}`)
          if (Array.isArray(users) && users[0]?.id) assignee_ids = [users[0].id]
        } catch (e: any) {
          this.log(`[business] GitLab user lookup failed for ${usernames[0]}: ${e.message}`)
        }
      }
    }

    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      labels: (input.labels || []).join(","),
    }
    if (assignee_ids) body.assignee_ids = assignee_ids

    const issue = await this.api(`/projects/${encodeURIComponent(project)}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    return this.mapIssue(issue, project)
  }

  async transition(itemId: string, toLabel: string, fromLabel?: string): Promise<void> {
    const { project, iid, type } = this.parseId(itemId)
    const seg = type === "issue" ? "issues" : "merge_requests"
    const params = new URLSearchParams()
    params.set("add_labels", toLabel)
    if (fromLabel && fromLabel !== toLabel) params.set("remove_labels", fromLabel)
    await this.api(
      `/projects/${encodeURIComponent(project)}/${seg}/${iid}?${params.toString()}`,
      { method: "PUT" },
    )
  }

  private parseId(itemId: string): { project: string; type: "issue" | "mr"; iid: string } {
    // "gitlab:<project>:issue:<iid>"  (project may contain a slash → it's joined)
    const body = itemId.replace(/^gitlab:/, "")
    const parts = body.split(":")
    const iid = parts.pop() as string
    const type = parts.pop() === "mr" ? "mr" : "issue"
    const project = parts.join(":")
    return { project, type, iid }
  }
}

// ---------- Factory ----------

export function createWorkSource(
  business: BusinessConfig,
  daemon: DaemonConfig,
  log: (...args: unknown[]) => void,
): WorkSource {
  const ws: BusinessWorkSource = business.workSource
  switch (ws.type) {
    case "backlog":
      return new BacklogWorkSource(ws.path)

    case "wiki":
      return new WikiWorkSource(ws.path, ws.glob)

    case "gitlab": {
      const gl = daemon.channels.gitlab
      if (!gl?.token) {
        throw new Error("business.workSource.type=gitlab requires channels.gitlab.token")
      }
      const agentUsernames: Record<string, string[]> = {}
      for (const mapping of gl.agentMappings) {
        if (mapping.gitlabUsernames.length) {
          agentUsernames[mapping.agentId] = mapping.gitlabUsernames
        }
      }
      const projects = ws.projects.length
        ? ws.projects
        : gl.routes.map((r) => r.project)
      return new GitLabWorkSource(gl.host, gl.token, projects, agentUsernames, log)
    }
  }
}
