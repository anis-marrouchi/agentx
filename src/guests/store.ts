import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { randomBytes } from "crypto"
import type { AutonomyLevel } from "@/guard/autonomy"

// --- Guest meshes: another organisation's mesh, let in part-way (#380) ---
//
// A grant is what the host opened for one guest: which agent of the host
// acts for it, which folders, skills and commands that agent may touch
// for it, how much freedom it has (the routine autonomy levels from #80)
// and until when. Nothing is shared until the host adds it; a grant ends
// on its date and does not renew by itself.
//
// The guest holds one key, scope `guest:<grant>`, that reaches the guest
// routes and nothing else. Every join, approval, refusal, task, pause and
// end is appended to a log, one line per event, per grant.

export type GrantState = "pending" | "active" | "paused" | "ended"

export interface GuestGrant {
  id: string
  /** What the host calls it: "Support session for company X". */
  name: string
  /** The guest's name, as the host wrote it on the invite. */
  guest: string
  /** What the guest's node said about itself when it joined. */
  guestNode?: { id?: string; name?: string; address?: string }
  /** The host agent that works for the guest. */
  agentId: string
  folders: string[]
  skills: string[]
  commands: string[]
  level: AutonomyLevel
  state: GrantState
  /** The key record's id (token-store.ts). */
  tokenId: string
  /** The decision card the host answers before the grant works. */
  cardId?: string
  createdAt: string
  expiresAt: string
  approvedAt?: string
  pausedAt?: string
  endedAt?: string
  endedReason?: string
  usage: { turns: number; tokens: number; lastAt?: string }
}

export type GuestEventKind =
  | "invited" | "joined" | "approved" | "refused" | "task" | "paused" | "resumed" | "widened" | "narrowed" | "ended" | "expired"

export interface GuestEvent {
  at: string
  grant: string
  event: GuestEventKind
  detail?: string
  address?: string
}

const GRANTS_FILE = ".agentx/guests.json"
const LOG_FILE = ".agentx/guests-log.jsonl"

export class GuestStore {
  private file: string
  private logFile: string

  constructor(baseDir: string = process.cwd(), private now: () => number = Date.now) {
    this.file = resolve(baseDir, GRANTS_FILE)
    this.logFile = resolve(baseDir, LOG_FILE)
  }

  grants(): GuestGrant[] {
    return this.load().grants
  }

  get(id: string): GuestGrant | null {
    return this.load().grants.find((g) => g.id === id) ?? null
  }

  byToken(tokenId: string): GuestGrant | null {
    return this.load().grants.find((g) => g.tokenId === tokenId) ?? null
  }

  add(grant: GuestGrant): void {
    const data = this.load()
    data.grants = data.grants.filter((g) => g.id !== grant.id)
    data.grants.push(grant)
    this.save(data)
  }

  update(id: string, patch: Partial<GuestGrant>): GuestGrant | null {
    const data = this.load()
    const grant = data.grants.find((g) => g.id === id)
    if (!grant) return null
    Object.assign(grant, patch)
    this.save(data)
    return grant
  }

  /** Counts one turn for the grant. */
  used(id: string, tokens: number): void {
    const data = this.load()
    const grant = data.grants.find((g) => g.id === id)
    if (!grant) return
    grant.usage = {
      turns: (grant.usage?.turns ?? 0) + 1,
      tokens: (grant.usage?.tokens ?? 0) + Math.max(0, Math.floor(tokens || 0)),
      lastAt: new Date(this.now()).toISOString(),
    }
    this.save(data)
  }

  log(event: Omit<GuestEvent, "at">): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      appendFileSync(this.logFile, JSON.stringify({ at: new Date(this.now()).toISOString(), ...event }) + "\n", { mode: 0o600 })
    } catch { /* the grant record is the source of truth; the log is a trail */ }
  }

  events(grantId?: string, limit = 50): GuestEvent[] {
    if (!existsSync(this.logFile)) return []
    const lines = readFileSync(this.logFile, "utf-8").split("\n").filter(Boolean)
    const out: GuestEvent[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const ev = JSON.parse(lines[i]) as GuestEvent
        if (!grantId || ev.grant === grantId) out.push(ev)
      } catch { /* a torn line */ }
    }
    return out
  }

  private load(): { grants: GuestGrant[] } {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
        if (parsed && Array.isArray(parsed.grants)) return parsed
      } catch { /* rewritten on the next save */ }
    }
    return { grants: [] }
  }

  private save(data: { grants: GuestGrant[] }): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
