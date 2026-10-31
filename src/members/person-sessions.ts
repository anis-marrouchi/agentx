import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { createHash, randomBytes } from "crypto"
import type { Person } from "@/people/people"

// --- Personal sessions on the Wall: the ax_person cookie (#1478, slice 1) ---
//
// A person who signs in (by an email link, slice 3) gets a session of their
// own, not the owner's ax_session. Its cookie is ax_person, and no owner
// gate in board-dashboard.ts reads it: wallOwnerOk, adminTokenOk (admin API
// and peer proxy), the general /api check, pageAllowed, isDashboardOwner
// and wallOwner all look at the dashboard token, its ax_session cookie or a
// dashboard:write key only. So a member's session can never pass as the
// owner, even if one gate is missed (notes/design/wall-sign-in.md, Decision 1).
//
// The cookie holds 32 random bytes. This file keeps only their sha256, with
// the person, when the session started and was last used, and a short label
// for the browser. A session ends after 30 days, on End access, or at the
// next request once the person is off the people list, or is a guest.

const SESSIONS_FILE = ".agentx/wall-sessions.json"
export const PERSON_COOKIE = "ax_person"
export const PERSON_SESSION_MAX_AGE_S = 30 * 24 * 3600
/** lastUsedAt is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60_000

export interface PersonSession {
  id: string
  /** sha256 of the cookie value, hex. */
  hash: string
  personId: string
  /** "Chrome on a Mac". */
  label: string
  startedAt: string
  lastUsedAt: string
  endedAt?: string
  /** Why it ended: "ended by the owner (dashboard)", "expired". */
  endedReason?: string
  /** The person's first sign-in waits for the owner's card (#1478, slice 3). */
  state?: "pending"
  cardId?: string
  /** When the owner let the person in, on this session's card or by the
   *  `auto` setting. A person with one approved session goes straight in. */
  approvedAt?: string
}

interface SessionsFile { sessions: PersonSession[] }

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex")

export class PersonSessionStore {
  private file: string

  constructor(baseDir: string = process.cwd(), private now: () => number = Date.now) {
    this.file = resolve(baseDir, SESSIONS_FILE)
  }

  /** A new session for `personId`. The value goes in the cookie, once; only its hash is kept. */
  create(personId: string, label: string, extra: Pick<PersonSession, "state" | "cardId" | "approvedAt"> = {}): { session: PersonSession; value: string } {
    const value = randomBytes(32).toString("base64url")
    const at = new Date(this.now()).toISOString()
    const session: PersonSession = { id: randomBytes(8).toString("hex"), hash: sha256(value), personId, label, startedAt: at, lastUsedAt: at, ...extra }
    const data = this.load()
    data.sessions.push(session)
    this.save(data)
    return { session, value }
  }

  /** Every session, newest first; `personId` narrows them to one person. */
  sessions(personId?: string): PersonSession[] {
    const all = this.load().sessions.map((s) => this.expired(s) ? { ...s, endedAt: s.endedAt ?? this.expiry(s), endedReason: s.endedReason ?? "expired" } : s)
    return (personId ? all.filter((s) => s.personId === personId) : all).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Whether the owner has let this person in before, by any session. */
  approved(personId: string): boolean {
    return this.load().sessions.some((s) => s.personId === personId && !!s.approvedAt)
  }

  /** The owner said yes on a waiting session's card. */
  approve(id: string): PersonSession | null {
    const data = this.load()
    const session = data.sessions.find((s) => s.id === id)
    if (!session || session.endedAt) return null
    delete session.state
    session.approvedAt = new Date(this.now()).toISOString()
    this.save(data)
    return session
  }

  /** The person a cookie value belongs to, when its session is live and the
   *  person is still on the list with a role that may sign in. A session
   *  still waiting for the owner is returned too: callers check `state`. */
  verify(value: string, people: Person[]): { session: PersonSession; person: Person } | null {
    if (!value) return null
    const hash = sha256(value)
    const data = this.load()
    const session = data.sessions.find((s) => s.hash === hash)
    if (!session || session.endedAt || this.expired(session)) return null
    const person = people.find((p) => p.id === session.personId)
    if (!person || person.role === "guest") return null
    const now = this.now()
    if (now - Date.parse(session.lastUsedAt) >= TOUCH_EVERY_MS) {
      session.lastUsedAt = new Date(now).toISOString()
      try { this.save(data) } catch { /* lastUsedAt is a hint; the sign-in still stands */ }
    }
    return { session, person }
  }

  /** End one session at once. Null when there is no live session with this id for this person. */
  end(personId: string, id: string, reason: string): PersonSession | null {
    const data = this.load()
    const session = data.sessions.find((s) => s.id === id && s.personId === personId)
    if (!session || session.endedAt || this.expired(session)) return null
    session.endedAt = new Date(this.now()).toISOString()
    session.endedReason = reason
    this.save(data)
    return session
  }

  private expiry(s: PersonSession): string {
    return new Date(Date.parse(s.startedAt) + PERSON_SESSION_MAX_AGE_S * 1000).toISOString()
  }

  private expired(s: PersonSession): boolean {
    return this.now() >= Date.parse(s.startedAt) + PERSON_SESSION_MAX_AGE_S * 1000
  }

  private load(): SessionsFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
        if (parsed && Array.isArray(parsed.sessions)) return parsed
      } catch { /* rewritten on the next save */ }
    }
    return { sessions: [] }
  }

  private save(data: SessionsFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
