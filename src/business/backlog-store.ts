import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { randomUUID } from "crypto"
import { z } from "zod"

// --- Structured backlog store (Plan B + import) ---
//
// Replaces the legacy `.agentx/backlog.md` GFM checklist as the canonical
// store when `.agentx/backlog.json` is present. The markdown view is
// regenerated on every save so humans still get a readable diff.
//
// Why structured: importing issues from gitlab/github needs a stable
// linkage back to the source (project + iid + url) so mutations
// (assignee, labels, status, milestone) can be pushed upstream by the
// sync-back layer. Encoding that in markdown comments is brittle.

const sourceSchema = z.object({
  type: z.enum(["gitlab", "github"]),
  host: z.string().optional(),
  project: z.string(),
  iid: z.number().int().positive(),
  url: z.string(),
})

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).default([]),
  milestone: z.string().optional(),
  status: z.enum(["todo", "doing", "blocked", "done"]).default("todo"),
  priority: z.number().int().optional(),
  estimatedSeconds: z.number().int().optional(),
  source: sourceSchema.optional(),
  importedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  blocker: z.string().optional(),
  doneNote: z.string().optional(),
})

const fileSchema = z.object({
  version: z.literal(1),
  items: z.array(itemSchema).default([]),
})

export type BacklogSource = z.infer<typeof sourceSchema>
export type BacklogItem = z.infer<typeof itemSchema>
export type BacklogFile = z.infer<typeof fileSchema>

export class BacklogStore {
  constructor(private path: string) {}

  /** Absolute path of the JSON store. */
  jsonPath(): string {
    return resolve(process.cwd(), this.path).replace(/\.md$/i, ".json")
  }

  /** Absolute path of the markdown view (alongside the JSON store). */
  mdPath(): string {
    return resolve(process.cwd(), this.path).replace(/\.json$/i, ".md")
  }

  exists(): boolean {
    return existsSync(this.jsonPath())
  }

  load(): BacklogFile {
    const p = this.jsonPath()
    if (!existsSync(p)) return { version: 1, items: [] }
    const raw = readFileSync(p, "utf-8")
    try {
      return fileSchema.parse(JSON.parse(raw))
    } catch (e: any) {
      throw new Error(`Backlog file invalid (${p}): ${e.message}`)
    }
  }

  save(file: BacklogFile): void {
    const jsonP = this.jsonPath()
    mkdirSync(dirname(jsonP), { recursive: true })
    writeFileSync(jsonP, JSON.stringify(file, null, 2) + "\n")
    writeFileSync(this.mdPath(), this.toMarkdown(file))
  }

  list(): BacklogItem[] {
    return this.load().items
  }

  findById(id: string): BacklogItem | undefined {
    return this.list().find((i) => i.id === id)
  }

  /** Add an item; rejects duplicates by id. Returns the saved item. */
  add(input: Omit<BacklogItem, "createdAt" | "updatedAt"> & { createdAt?: string }): BacklogItem {
    const file = this.load()
    if (file.items.some((i) => i.id === input.id)) {
      throw new Error(`backlog item ${input.id} already exists`)
    }
    const now = new Date().toISOString()
    const item: BacklogItem = {
      ...input,
      labels: input.labels ?? [],
      status: input.status ?? "todo",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    }
    file.items.push(item)
    this.save(file)
    return item
  }

  /** Add many; skips items whose id already exists, returns the inserted set. */
  addMany(inputs: Array<Omit<BacklogItem, "createdAt" | "updatedAt"> & { createdAt?: string }>): BacklogItem[] {
    const file = this.load()
    const existing = new Set(file.items.map((i) => i.id))
    const now = new Date().toISOString()
    const added: BacklogItem[] = []
    for (const input of inputs) {
      if (existing.has(input.id)) continue
      const item: BacklogItem = {
        ...input,
        labels: input.labels ?? [],
        status: input.status ?? "todo",
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      }
      file.items.push(item)
      added.push(item)
      existing.add(item.id)
    }
    if (added.length) this.save(file)
    return added
  }

  update(id: string, patch: Partial<BacklogItem>): BacklogItem {
    const file = this.load()
    const idx = file.items.findIndex((i) => i.id === id)
    if (idx < 0) throw new Error(`backlog item ${id} not found`)
    const updated: BacklogItem = {
      ...file.items[idx],
      ...patch,
      id: file.items[idx].id,
      createdAt: file.items[idx].createdAt,
      updatedAt: new Date().toISOString(),
    }
    file.items[idx] = updated
    this.save(file)
    return updated
  }

  remove(id: string): boolean {
    const file = this.load()
    const before = file.items.length
    file.items = file.items.filter((i) => i.id !== id)
    if (file.items.length === before) return false
    this.save(file)
    return true
  }

  /** Render a human-readable markdown view (generated, not authoritative). */
  toMarkdown(file: BacklogFile): string {
    const lines: string[] = [
      "# Backlog",
      "",
      "_Generated from `backlog.json`. Do not edit by hand — use `agentx backlog` commands._",
      "",
    ]
    const buckets: Record<BacklogItem["status"], BacklogItem[]> = {
      doing: [], blocked: [], todo: [], done: [],
    }
    for (const item of file.items) buckets[item.status].push(item)
    const sections: Array<[BacklogItem["status"], string]> = [
      ["doing", "Doing"], ["blocked", "Blocked"], ["todo", "To Do"], ["done", "Done"],
    ]
    for (const [key, label] of sections) {
      if (!buckets[key].length) continue
      lines.push(`## ${label}`, "")
      for (const it of buckets[key]) {
        const check = key === "done" ? "x" : " "
        const mention = it.assignee ? `@${it.assignee} ` : ""
        const time = it.estimatedSeconds
          ? ` [time: ${Math.round(it.estimatedSeconds / 60)}m]`
          : ""
        const src = it.source ? ` (${it.source.type}: ${it.source.project}#${it.source.iid})` : ""
        lines.push(`- [${check}] ${mention}${it.title}${time}${src}`)
        if (it.source?.url) lines.push(`    - <${it.source.url}>`)
        if (it.labels.length) lines.push(`    - labels: ${it.labels.join(", ")}`)
        if (it.milestone) lines.push(`    - milestone: ${it.milestone}`)
        if (it.blocker) lines.push(`    - BLOCKED: ${it.blocker}`)
      }
      lines.push("")
    }
    return lines.join("\n")
  }
}

/** Generate a stable BacklogItem.id for a fresh manual item. */
export function manualBacklogId(): string {
  return `manual:${randomUUID()}`
}

/** Build the canonical id for an imported source issue. */
export function sourceBacklogId(source: BacklogSource): string {
  return `${source.type}:${source.project}:${source.iid}`
}
