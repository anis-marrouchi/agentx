import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { resolve, relative } from "path"
import { procedureMetaSchema, type Procedure, type ProcedureMeta } from "./types"

// --- ProcedureStore ---
// Plain-file persistence (same convention as .agentx/wiki/ and .agentx/graph/).
// One markdown file per procedure. Frontmatter = yaml-ish name:value lines
// (arrays are JSON). This intentionally avoids pulling in a yaml lib — the
// surface is small and the wiki store already uses the same hand-parser.

export interface ProcedureStoreOptions {
  baseDir?: string
}

function parseFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, any> = {}
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let val = kv[2].trim()
    if (val.startsWith("[") && val.endsWith("]")) {
      try { meta[key] = JSON.parse(val); continue } catch { /* fallthrough */ }
      meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
      continue
    }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    meta[key] = val
  }
  return { meta, body: m[2] }
}

function serializeFrontmatter(meta: ProcedureMeta): string {
  const lines: string[] = ["---"]
  lines.push(`id: ${meta.id}`)
  lines.push(`title: "${meta.title.replace(/"/g, '\\"')}"`)
  lines.push(`trigger: "${meta.trigger.replace(/"/g, '\\"')}"`)
  if (meta.inputs?.length) lines.push(`inputs: ${JSON.stringify(meta.inputs)}`)
  if (meta.expected) lines.push(`expected: "${meta.expected.replace(/"/g, '\\"')}"`)
  if (meta.kpis?.length) lines.push(`kpis: ${JSON.stringify(meta.kpis)}`)
  if (meta.owner) lines.push(`owner: ${meta.owner}`)
  if (meta.tags?.length) lines.push(`tags: ${JSON.stringify(meta.tags)}`)
  if (meta.related?.length) lines.push(`related: ${JSON.stringify(meta.related)}`)
  if (meta.created) lines.push(`created: ${meta.created}`)
  if (meta.updated) lines.push(`updated: ${meta.updated}`)
  lines.push("---")
  return lines.join("\n")
}

export class ProcedureStore {
  readonly baseDir: string

  constructor(opts: ProcedureStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/procedures")
    mkdirSync(this.baseDir, { recursive: true })
  }

  private pathFor(id: string): string {
    return resolve(this.baseDir, `${id}.md`)
  }

  list(): Procedure[] {
    if (!existsSync(this.baseDir)) return []
    const out: Procedure[] = []
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_")) continue
      const full = resolve(this.baseDir, entry.name)
      const raw = readFileSync(full, "utf-8")
      const { meta, body } = parseFrontmatter(raw)
      const parsed = procedureMetaSchema.safeParse({
        ...meta,
        inputs: meta.inputs || [],
        kpis: meta.kpis || [],
        tags: meta.tags || [],
        related: meta.related || [],
      })
      if (!parsed.success) continue
      out.push({ meta: parsed.data, body: body.trim(), path: relative(this.baseDir, full) })
    }
    return out.sort((a, b) => a.meta.id.localeCompare(b.meta.id))
  }

  get(id: string): Procedure | null {
    const p = this.pathFor(id)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, "utf-8")
    const { meta, body } = parseFrontmatter(raw)
    const parsed = procedureMetaSchema.safeParse({
      ...meta,
      inputs: meta.inputs || [],
      kpis: meta.kpis || [],
      tags: meta.tags || [],
      related: meta.related || [],
    })
    if (!parsed.success) return null
    return { meta: parsed.data, body: body.trim(), path: relative(this.baseDir, p) }
  }

  add(meta: ProcedureMeta, body: string): Procedure {
    const parsed = procedureMetaSchema.parse({
      ...meta,
      created: meta.created || new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
    })
    const p = this.pathFor(parsed.id)
    if (existsSync(p)) throw new Error(`Procedure already exists: ${parsed.id}`)
    writeFileSync(p, serializeFrontmatter(parsed) + "\n\n" + body.trim() + "\n")
    return { meta: parsed, body: body.trim(), path: relative(this.baseDir, p) }
  }

  update(id: string, patch: Partial<ProcedureMeta>, newBody?: string): Procedure {
    const existing = this.get(id)
    if (!existing) throw new Error(`Procedure not found: ${id}`)
    const merged = procedureMetaSchema.parse({
      ...existing.meta,
      ...patch,
      id: existing.meta.id,  // immutable
      updated: new Date().toISOString().slice(0, 10),
    })
    const body = newBody !== undefined ? newBody : existing.body
    writeFileSync(this.pathFor(id), serializeFrontmatter(merged) + "\n\n" + body.trim() + "\n")
    return { meta: merged, body: body.trim(), path: existing.path }
  }
}
