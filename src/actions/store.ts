import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { actionSchema, type Action } from "./types"

// --- Action registry filesystem store ---
//
// One JSON file per action under .agentx/actions/<id>.json. Schema-
// validated on read; malformed files are skipped (the operator will
// notice via `agentx actions list`).

export interface ActionStoreOptions {
  baseDir?: string
}

export class ActionStore {
  readonly dir: string

  constructor(opts: ActionStoreOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx")
    this.dir = resolve(root, "actions")
    mkdirSync(this.dir, { recursive: true })
  }

  private pathFor(id: string): string {
    return resolve(this.dir, `${id}.json`)
  }

  list(): Action[] {
    if (!existsSync(this.dir)) return []
    const out: Action[] = []
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.dir, entry.name), "utf-8"))
        const parsed = actionSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): Action | null {
    const file = this.pathFor(id)
    if (!existsSync(file)) return null
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"))
      const parsed = actionSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch { return null }
  }

  save(action: Action): Action {
    const parsed = actionSchema.parse({
      ...action,
      createdAt: action.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    writeFileSync(this.pathFor(parsed.id), JSON.stringify(parsed, null, 2))
    return parsed
  }

  delete(id: string): boolean {
    const file = this.pathFor(id)
    if (!existsSync(file)) return false
    unlinkSync(file)
    return true
  }
}
