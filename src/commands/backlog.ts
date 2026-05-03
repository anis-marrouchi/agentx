import { Command } from "commander"
import chalk from "chalk"
import prompts from "prompts"
import { loadDaemonConfig, type DaemonConfig } from "@/daemon/config"
import { BacklogStore, sourceBacklogId, type BacklogItem, type BacklogSource } from "@/business/backlog-store"
import { syncBacklogItemToSource, resolveAssigneesForSource } from "@/business/backlog-sync"

export const backlog = new Command()
  .name("backlog")
  .description("manage the local backlog used by business workSource=backlog")

// ---------- Helpers ----------

interface Daemon {
  config: DaemonConfig
  storePath: string
  store: BacklogStore
}

function loadCtx(configPath?: string): Daemon {
  const config = loadDaemonConfig(configPath)
  const ws = (config as any).business?.workSource
  const storePath = ws?.type === "backlog" ? ws.path : ".agentx/backlog.md"
  return { config, storePath, store: new BacklogStore(storePath) }
}

function fmtSource(s: BacklogItem["source"]): string {
  if (!s) return chalk.dim("manual")
  return chalk.cyan(`${s.type}:${s.project}#${s.iid}`)
}

function fmtStatus(status: BacklogItem["status"]): string {
  return ({
    todo: chalk.gray("todo"),
    doing: chalk.yellow("doing"),
    blocked: chalk.red("blocked"),
    done: chalk.green("done"),
  })[status]
}

// ---------- list ----------

backlog
  .command("list", { isDefault: true })
  .description("list backlog items")
  .option("--status <status>", "filter by status (todo|doing|blocked|done)")
  .option("--assignee <agent>", "filter by assignee")
  .option("--source <type>", "filter by source.type (gitlab|github|manual)")
  .option("-c, --config <path>", "config path")
  .action(async (opts: { status?: string; assignee?: string; source?: string; config?: string }) => {
    const { store } = loadCtx(opts.config)
    let items = store.list()
    if (opts.status) items = items.filter((i) => i.status === opts.status)
    if (opts.assignee) items = items.filter((i) => i.assignee === opts.assignee)
    if (opts.source) {
      items = items.filter((i) =>
        opts.source === "manual" ? !i.source : i.source?.type === opts.source,
      )
    }

    if (!items.length) {
      console.log(chalk.dim("  (no items)"))
      return
    }

    console.log()
    for (const it of items) {
      const assignee = it.assignee ? chalk.magenta(`@${it.assignee}`) : chalk.dim("unassigned")
      console.log(`  ${fmtStatus(it.status).padEnd(7)} ${fmtSource(it.source)} ${assignee}  ${it.title}`)
      if (it.source?.url) console.log(chalk.dim(`         ${it.source.url}`))
    }
    console.log()
    console.log(chalk.dim(`  ${items.length} item${items.length === 1 ? "" : "s"} — ${store.jsonPath()}`))
  })

// ---------- claim ----------

backlog
  .command("claim <id> <agent>")
  .description("assign an item to an agent and set status=doing")
  .option("-c, --config <path>", "config path")
  .action(async (id: string, agent: string, opts: { config?: string }) => {
    const ctx = loadCtx(opts.config)
    const item = ctx.store.findById(id)
    if (!item) {
      console.error(chalk.red(`  item ${id} not found`))
      process.exit(1)
    }
    const updated = ctx.store.update(id, { assignee: agent, status: "doing" })
    console.log(chalk.green(`  claimed: ${updated.title} -> ${agent}`))

    if (updated.source) {
      const usernames = resolveAssigneesForSource([agent], updated.source, ctx.config)
      const result = await syncBacklogItemToSource(updated, {
        assigneeUsernames: usernames,
        addLabels: ["Doing"],
        removeLabels: ["To Do"],
      }, ctx.config, (...a) => console.log(chalk.dim("  sync:"), ...a))
      console.log(result.ok
        ? chalk.dim(`  synced -> ${result.url ?? updated.source.type}`)
        : chalk.yellow(`  sync failed: ${result.error}`),
      )
    }
  })

// ---------- done ----------

backlog
  .command("done <id>")
  .description("mark an item as done; closes the upstream issue if linked")
  .option("--note <text>", "comment to post upstream")
  .option("--close", "also close the upstream issue (default: only labels change)", false)
  .option("-c, --config <path>", "config path")
  .action(async (id: string, opts: { note?: string; close?: boolean; config?: string }) => {
    const ctx = loadCtx(opts.config)
    const item = ctx.store.findById(id)
    if (!item) {
      console.error(chalk.red(`  item ${id} not found`))
      process.exit(1)
    }
    const updated = ctx.store.update(id, { status: "done" })
    console.log(chalk.green(`  done: ${updated.title}`))

    if (updated.source) {
      const result = await syncBacklogItemToSource(updated, {
        addLabels: ["Done"],
        removeLabels: ["Doing"],
        state: opts.close ? "closed" : undefined,
        note: opts.note,
      }, ctx.config, (...a) => console.log(chalk.dim("  sync:"), ...a))
      console.log(result.ok
        ? chalk.dim(`  synced -> ${result.url ?? updated.source.type}`)
        : chalk.yellow(`  sync failed: ${result.error}`),
      )
    }
  })

// ---------- remove ----------

backlog
  .command("remove <id>")
  .description("remove an item from the local backlog (does NOT touch upstream)")
  .option("-c, --config <path>", "config path")
  .action(async (id: string, opts: { config?: string }) => {
    const { store } = loadCtx(opts.config)
    const removed = store.remove(id)
    if (!removed) {
      console.error(chalk.red(`  item ${id} not found`))
      process.exit(1)
    }
    console.log(chalk.green(`  removed ${id}`))
  })

// ---------- import ----------

backlog
  .command("import")
  .description("import open issues from gitlab/github into the backlog (interactive)")
  .option("--source <type>", "source type (gitlab|github)")
  .option("--project <id>", "project id (group/repo for gitlab, owner/repo for github)")
  .option("--assignee <agent>", "assign all imported items to this agentId")
  .option("-c, --config <path>", "config path")
  .action(async (opts: { source?: string; project?: string; assignee?: string; config?: string }) => {
    const ctx = loadCtx(opts.config)

    // Resolve which sources are configured.
    const gitlabReady = !!ctx.config.channels.gitlab?.token
    const githubReady = !!ctx.config.channels.github?.token
    if (!gitlabReady && !githubReady) {
      console.error(chalk.red("  no source configured — set channels.gitlab.token or channels.github.token in agentx.json"))
      process.exit(1)
    }

    let source = opts.source
    if (!source) {
      const choices = [
        gitlabReady && { title: "GitLab", value: "gitlab" },
        githubReady && { title: "GitHub", value: "github" },
      ].filter(Boolean) as Array<{ title: string; value: string }>
      const ans = await prompts({ type: "select", name: "source", message: "Source", choices })
      source = ans.source
      if (!source) return
    }

    if (source === "gitlab" && !gitlabReady) {
      console.error(chalk.red("  channels.gitlab.token not configured"))
      process.exit(1)
    }
    if (source === "github" && !githubReady) {
      console.error(chalk.red("  channels.github.token not configured"))
      process.exit(1)
    }

    // Project.
    let project = opts.project
    if (!project) {
      const candidates = source === "gitlab"
        ? collectGitlabProjects(ctx.config)
        : collectGithubProjects(ctx.config)
      if (candidates.length) {
        const ans = await prompts({
          type: "autocomplete",
          name: "project",
          message: "Project (type to filter, or pick + then Enter for custom)",
          choices: [
            ...candidates.map((p) => ({ title: p, value: p })),
            { title: "(custom — type below)", value: "__CUSTOM__" },
          ],
        })
        project = ans.project
        if (project === "__CUSTOM__") {
          const c = await prompts({ type: "text", name: "p", message: source === "gitlab" ? "Group/path" : "owner/repo" })
          project = c.p
        }
      } else {
        const c = await prompts({
          type: "text",
          name: "p",
          message: source === "gitlab" ? "Group/path" : "owner/repo",
        })
        project = c.p
      }
    }
    if (!project) return

    // Optional search filter pre-fetch (server-side).
    const searchAns = await prompts({
      type: "text",
      name: "search",
      message: "Search filter (optional — leave empty for all open)",
    })
    const search = (searchAns.search || "").trim()

    console.log(chalk.dim(`  fetching open issues from ${source}:${project}${search ? ` (search: ${search})` : ""}…`))
    const issues = source === "gitlab"
      ? await fetchGitlabIssues(ctx.config, project, search)
      : await fetchGithubIssues(ctx.config, project, search)

    if (!issues.length) {
      console.log(chalk.yellow("  no open issues matched"))
      return
    }
    console.log(chalk.dim(`  ${issues.length} open issue${issues.length === 1 ? "" : "s"}`))

    const projectId = project
    // Mark already-imported items so the user can see them.
    const existing = new Set(ctx.store.list().map((i) => i.id))
    const choices = issues.map((iss) => {
      const id = sourceBacklogId({ type: source as any, project: projectId, iid: iss.iid, url: iss.url })
      const already = existing.has(id)
      const labels = iss.labels.length ? ` [${iss.labels.slice(0, 3).join(",")}]` : ""
      return {
        title: `#${iss.iid} ${iss.title}${labels}${already ? chalk.dim(" (already imported)") : ""}`,
        value: iss,
        disabled: already,
      }
    })

    const pick = await prompts({
      type: "autocompleteMultiselect",
      name: "selected",
      message: "Pick issues to import (space to toggle, Enter to confirm)",
      instructions: false,
      choices,
      min: 1,
    })

    const selected = (pick.selected || []) as ImportIssue[]
    if (!selected.length) {
      console.log(chalk.dim("  nothing selected"))
      return
    }

    const toAdd = selected.map((iss): Omit<BacklogItem, "createdAt" | "updatedAt"> => {
      const src: BacklogSource = {
        type: source as "gitlab" | "github",
        host: source === "gitlab" ? hostnameFromGitlab(ctx.config) : undefined,
        project: projectId,
        iid: iss.iid,
        url: iss.url,
      }
      return {
        id: sourceBacklogId(src),
        title: iss.title,
        description: iss.description,
        assignee: opts.assignee || iss.assignee,
        labels: iss.labels,
        milestone: iss.milestone,
        status: "todo",
        source: src,
        importedAt: new Date().toISOString(),
      }
    })

    const added = ctx.store.addMany(toAdd)
    console.log(chalk.green(`  imported ${added.length} item${added.length === 1 ? "" : "s"}`))
    for (const it of added) {
      console.log(chalk.dim(`    ${it.id} — ${it.title}`))
    }
  })

// ---------- Source helpers ----------

interface ImportIssue {
  iid: number
  title: string
  description?: string
  labels: string[]
  milestone?: string
  assignee?: string
  url: string
}

function hostnameFromGitlab(daemon: DaemonConfig): string | undefined {
  const host = daemon.channels.gitlab?.host
  if (!host) return undefined
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function collectGitlabProjects(daemon: DaemonConfig): string[] {
  const set = new Set<string>()
  for (const r of daemon.channels.gitlab?.routes ?? []) if (r.project && r.project !== "*") set.add(r.project)
  const ws = (daemon as any).business?.workSource
  if (ws?.type === "gitlab") for (const p of ws.projects ?? []) set.add(p)
  for (const p of (daemon as any).business?.projects ?? []) {
    if (p?.id && p.id.includes("/")) set.add(p.id)
  }
  return [...set].sort()
}

function collectGithubProjects(daemon: DaemonConfig): string[] {
  const set = new Set<string>()
  for (const r of daemon.channels.github?.routes ?? []) if (r.repo && r.repo !== "*") set.add(r.repo)
  return [...set].sort()
}

async function fetchGitlabIssues(daemon: DaemonConfig, project: string, search: string): Promise<ImportIssue[]> {
  const gl = daemon.channels.gitlab!
  const params = new URLSearchParams({
    state: "opened",
    scope: "all",
    per_page: "100",
    order_by: "updated_at",
    sort: "desc",
  })
  if (search) params.set("search", search)

  const res = await fetch(
    `${gl.host}/api/v4/projects/${encodeURIComponent(project)}/issues?${params}`,
    { headers: { "PRIVATE-TOKEN": gl.token! } },
  )
  if (!res.ok) {
    throw new Error(`GitLab ${res.status}: ${await res.text().catch(() => "")}`)
  }
  const arr: any = await res.json()
  if (!Array.isArray(arr)) return []
  return arr.map((i: any): ImportIssue => ({
    iid: i.iid,
    title: i.title,
    description: i.description || undefined,
    labels: Array.isArray(i.labels) ? i.labels.map((l: any) => (typeof l === "string" ? l : l.name)) : [],
    milestone: i.milestone?.title || undefined,
    assignee: i.assignee?.username || i.assignees?.[0]?.username || undefined,
    url: i.web_url,
  }))
}

async function fetchGithubIssues(daemon: DaemonConfig, project: string, search: string): Promise<ImportIssue[]> {
  const gh = daemon.channels.github!
  const headers = {
    "Authorization": `Bearer ${gh.token!}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  // GitHub: separate `search` API for text filter (covers title+body); without
  // a query, list issues directly. Search API includes pull requests in `issues`,
  // so filter `is:issue` explicitly.
  let url: string
  if (search) {
    const q = `repo:${project} is:issue is:open ${search}`
    url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&sort=updated&order=desc`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text().catch(() => "")}`)
    const data: any = await res.json()
    const items: any[] = data.items ?? []
    return items.map(githubMap)
  }

  url = `https://api.github.com/repos/${project}/issues?state=open&per_page=100&sort=updated&direction=desc`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text().catch(() => "")}`)
  const arr: any = await res.json()
  if (!Array.isArray(arr)) return []
  // /issues returns PRs too; drop them.
  return arr.filter((i: any) => !i.pull_request).map(githubMap)
}

function githubMap(i: any): ImportIssue {
  return {
    iid: i.number,
    title: i.title,
    description: i.body || undefined,
    labels: Array.isArray(i.labels) ? i.labels.map((l: any) => (typeof l === "string" ? l : l.name)) : [],
    milestone: i.milestone?.title || undefined,
    assignee: i.assignee?.login || i.assignees?.[0]?.login || undefined,
    url: i.html_url,
  }
}
