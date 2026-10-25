import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"

// --- Work held for an agent paused by its monthly budget (#1162) ---
//
// A chat message that reaches an agent past its budget is not lost: it
// waits here until the budget gate lets it run again (the cap was raised,
// or the month turned), then runs as a queued turn would, with its reply
// posted back to the chat. Each chat is told the reason once per pause,
// not once per message.
//
// With a file, every change is written to it and it is read back at
// start, so what waits survives a daemon restart (#1290). Bounded per
// agent; past the bound a message is refused instead.

export interface HeldMessage {
  text: string
  channel: string
  chatId: string
  context: Record<string, unknown> | undefined
  /** When it was first held, for the stale-state note when it runs (#282). */
  heldAt: number
}

export const MAX_HELD_PER_AGENT = 200

export type HoldResult =
  /** Held; the first message of its chat in this pause. Tell the chat why. */
  | "held-first"
  /** Held; the chat was already told. */
  | "held"
  /** Not held: the agent's line is full. */
  | "full"

export class BudgetHolds {
  private held = new Map<string, HeldMessage[]>()

  constructor(private readonly max: number = MAX_HELD_PER_AGENT, private readonly file?: string, private readonly log: (msg: string) => void = () => {}) {
    if (file) this.load(file)
  }

  hold(agentId: string, m: HeldMessage): HoldResult {
    const list = this.held.get(agentId) ?? []
    if (list.length >= this.max) return "full"
    const told = list.some((h) => h.channel === m.channel && h.chatId === m.chatId)
    list.push(m)
    this.held.set(agentId, list)
    this.save()
    return told ? "held" : "held-first"
  }

  /** Messages waiting for `agentId`. */
  count(agentId: string): number {
    return this.held.get(agentId)?.length ?? 0
  }

  agents(): string[] {
    return [...this.held.keys()]
  }

  /** Remove and return what waits for `agentId` and passes `ready`, oldest first. */
  take(agentId: string, ready: (m: HeldMessage) => boolean = () => true): HeldMessage[] {
    const list = this.held.get(agentId) ?? []
    const out = list.filter(ready)
    if (!out.length) return []
    const rest = list.filter((m) => !out.includes(m))
    if (rest.length) this.held.set(agentId, rest)
    else this.held.delete(agentId)
    this.save()
    return out
  }

  get size(): number {
    let n = 0
    for (const l of this.held.values()) n += l.length
    return n
  }

  private load(file: string): void {
    if (!existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, HeldMessage[]>
      for (const [agentId, list] of Object.entries(raw ?? {})) {
        const ok = (Array.isArray(list) ? list : [])
          .filter((m) => m && typeof m.text === "string" && typeof m.channel === "string" && typeof m.chatId === "string")
          .slice(0, this.max)
        if (ok.length) this.held.set(agentId, ok)
      }
    } catch (e: any) {
      this.log(`[budget] couldn't read held messages from ${file} (${e?.message ?? e}); starting empty`)
    }
  }

  /** Write the whole set: a temp file renamed over the old one. */
  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.held)))
      renameSync(tmp, this.file)
    } catch (e: any) {
      this.log(`[budget] couldn't save held messages to ${this.file} (${e?.message ?? e})`)
    }
  }
}
