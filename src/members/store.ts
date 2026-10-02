import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "fs"
import { dirname, resolve } from "path"
import { randomBytes } from "crypto"

// --- Members: a teammate's machines, and what happened with them (#385) ---
//
// A member is a person from the people list (people.ts) who reaches one
// page of this node, /member, from their own machine. Each machine is one
// token with the scope `member:<person>` in the token store; this file
// keeps what the token store does not: whose machine it is, what it is
// called, where it paired from, what the private network said about who
// was connecting, and whether the owner has said yes to it.
//
// Every sign-in, refusal and removal is appended to a log, one line per
// event, per person and per machine.

const DEVICES_FILE = ".agentx/members.json"
const LOG_FILE = ".agentx/members-log.jsonl"

export type DeviceState = "pending" | "active" | "removed"

export interface MemberDevice {
  /** The token record's id (token-store.ts). */
  tokenId: string
  personId: string
  /** What the person called the machine when pairing. */
  name: string
  state: DeviceState
  /** The decision card the owner answers before the machine works. */
  cardId?: string
  /** Where the pairing came from. */
  address?: string
  /** Who the private network said was connecting, when it said. */
  network?: string
  createdAt: string
  approvedAt?: string
  removedAt?: string
  /** Why it was removed: the owner said no, the owner removed it, the key expired. */
  removedReason?: string
  lastSeenAt?: string
  lastAddress?: string
}

export type MemberEventKind =
  | "invited" | "paired" | "approved" | "refused" | "signed-in" | "removed" | "expired"
  /** A message to an agent the person may not reach (people[].agents, #379);
   *  `detail` is the agent. */
  | "agent-refused"
  /** A tool or skill call the person's turn may not make (people[].deny,
   *  #379); `detail` is the tool, or "skill:<name>". */
  | "tool-refused"

export interface MemberEvent {
  at: string
  person: string
  device?: string
  event: MemberEventKind
  address?: string
  detail?: string
}

interface DevicesFile { devices: MemberDevice[] }

export class MemberStore {
  private file: string
  private logFile: string

  private prunedAt = 0

  constructor(
    baseDir: string = process.cwd(),
    private now: () => number = Date.now,
    /** Days a log line is kept (members.logRetentionDays). */
    private retentionDays = 90,
  ) {
    this.file = resolve(baseDir, DEVICES_FILE)
    this.logFile = resolve(baseDir, LOG_FILE)
  }

  devices(personId?: string): MemberDevice[] {
    const all = this.load().devices
    return personId ? all.filter((d) => d.personId === personId) : all
  }

  byToken(tokenId: string): MemberDevice | null {
    return this.load().devices.find((d) => d.tokenId === tokenId) ?? null
  }

  add(device: MemberDevice): void {
    const data = this.load()
    data.devices = data.devices.filter((d) => d.tokenId !== device.tokenId)
    data.devices.push(device)
    this.save(data)
  }

  update(tokenId: string, patch: Partial<MemberDevice>): MemberDevice | null {
    const data = this.load()
    const device = data.devices.find((d) => d.tokenId === tokenId)
    if (!device) return null
    Object.assign(device, patch)
    this.save(data)
    return device
  }

  /** Append one event. Never throws: the log must not break a sign-in. */
  log(event: Omit<MemberEvent, "at">): void {
    // On its own: a failed prune must not cost the new line.
    try { this.prune() } catch { /* next write tries again */ }
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      appendFileSync(this.logFile, JSON.stringify({ at: new Date(this.now()).toISOString(), ...event }) + "\n", { mode: 0o600 })
    } catch { /* the device record is the source of truth; the log is a trail */ }
  }

  /** Drops lines older than the retention, at most once an hour. The daemon,
   *  the dashboard and the CLI all append here with no lock: a line another
   *  process writes between the read and the rename is lost. */
  prune(force = false): number {
    const now = this.now()
    if (!force && now - this.prunedAt < 3_600_000) return 0
    this.prunedAt = now
    if (!existsSync(this.logFile)) return 0
    const cutoff = now - this.retentionDays * 86_400_000
    const lines = readFileSync(this.logFile, "utf-8").split("\n").filter(Boolean)
    const kept = lines.filter((line) => {
      try { return Date.parse(JSON.parse(line).at) >= cutoff } catch { return false }
    })
    if (kept.length === lines.length) return 0
    const tmp = `${this.logFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.logFile)
    return lines.length - kept.length
  }

  /** The latest events, newest first; `personId` narrows them to one person. */
  events(personId?: string, limit = 50): MemberEvent[] {
    if (!existsSync(this.logFile)) return []
    const lines = readFileSync(this.logFile, "utf-8").split("\n").filter(Boolean)
    const out: MemberEvent[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const ev = JSON.parse(lines[i]) as MemberEvent
        if (!personId || ev.person === personId) out.push(ev)
      } catch { /* a torn line */ }
    }
    return out
  }

  private load(): DevicesFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
        if (parsed && Array.isArray(parsed.devices)) return parsed
      } catch { /* rewritten on the next save */ }
    }
    return { devices: [] }
  }

  private save(data: DevicesFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
