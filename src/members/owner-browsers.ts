import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { createHash, randomBytes, randomInt } from "crypto"

// --- The owner's browsers, confirmed on the home machine (#1478, Decision 8) ---
//
// The owner may sign in by an email link too, and then gets full owner
// rights: the dashboard's own ax_session cookie, the one /login gives for
// the token. Before that, each new browser must be confirmed on the home
// machine itself, with the dashboard opened there, never by a phone card.
//
//   the browser  gets an ax_owner_browser cookie on its first sign-in: 32
//                random bytes, only their sha256 kept here. It names the
//                browser, and gives no rights by itself.
//   pending      the sign-in waits; the browser shows a short check code,
//                and the home machine's "Sign-in requests" page shows the
//                same code with Confirm and Refuse. 15 minutes, then gone.
//   confirmed    the waiting sign-in collects ax_session once. A later link
//                sign-in from this browser goes straight in.
//   ended        End on that page: the next sign-in from it asks again.
//                Its ax_session stays valid until it expires (30 days) or
//                dashboard.token changes, as for a /login sign-in.

const FILE = ".agentx/owner-browsers.json"
export const OWNER_BROWSER_COOKIE = "ax_owner_browser"
/** A browser stays known a year; its sign-ins still need a link each time. */
export const OWNER_BROWSER_MAX_AGE_S = 365 * 24 * 3600
/** How long a sign-in waits for the confirm, and a confirmed one to be collected. */
export const CONFIRM_TTL_MS = 15 * 60 * 1000
/** At most this many sign-ins wait at once, so the page stays readable. */
export const MAX_WAITING = 5

export type OwnerBrowserState = "pending" | "confirmed" | "refused" | "ended"

export interface OwnerBrowser {
  id: string
  /** sha256 of the cookie value, hex. */
  hash: string
  personId: string
  /** The name typed in the browser: "Work laptop". */
  label: string
  /** The network address and login the first sign-in came from. */
  address: string
  login?: string
  /** Shown in the browser and on the home machine: "482 913". */
  check: string
  createdAt: string
  state: OwnerBrowserState
  decidedAt?: string
  /** A sign-in that may collect its ax_session, and since when. Cleared once collected. */
  waitingSince?: string
  lastSignInAt?: string
}

/** What the page and the API show: never the hash. */
export type ShownOwnerBrowser = Omit<OwnerBrowser, "hash"> & { expired?: true }

interface BrowsersFile { browsers: OwnerBrowser[] }

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex")

/** Six digits, in two groups, easy to compare across two screens. */
function checkCode(): string {
  const n = String(randomInt(0, 1_000_000)).padStart(6, "0")
  return `${n.slice(0, 3)} ${n.slice(3)}`
}

export class OwnerBrowserStore {
  private file: string

  constructor(baseDir: string = process.cwd(), private now: () => number = Date.now) {
    this.file = resolve(baseDir, FILE)
  }

  /** The browser a cookie value names, whatever its state. */
  find(value: string | null | undefined): OwnerBrowser | null {
    if (!value) return null
    const hash = sha256(value)
    return this.load().browsers.find((b) => b.hash === hash) ?? null
  }

  /** How many sign-ins wait for the owner now. */
  waiting(): number {
    return this.load().browsers.filter((b) => b.state === "pending" && !this.stale(b)).length
  }

  /** A new browser, waiting for the confirm. The value goes in the cookie, once. */
  begin(p: { personId: string; label: string; address: string; login?: string | null }): { browser: OwnerBrowser; value: string } | null {
    const data = this.load()
    if (data.browsers.filter((b) => b.state === "pending" && !this.stale(b)).length >= MAX_WAITING) return null
    const value = randomBytes(32).toString("base64url")
    const at = new Date(this.now()).toISOString()
    const browser: OwnerBrowser = {
      id: randomBytes(8).toString("hex"), hash: sha256(value), personId: p.personId, label: p.label,
      address: p.address, ...(p.login ? { login: p.login } : {}), check: checkCode(),
      createdAt: at, state: "pending", waitingSince: at, lastSignInAt: at,
    }
    // Waiting sign-ins nobody answered are dropped, so the file stays small.
    data.browsers = data.browsers.filter((b) => !(b.state === "pending" && this.stale(b)))
    data.browsers.push(browser)
    this.save(data)
    return { browser, value }
  }

  /** A confirmed browser signed in again: noted, nothing to confirm. */
  signedIn(id: string): void {
    const data = this.load()
    const b = data.browsers.find((x) => x.id === id)
    if (!b) return
    b.lastSignInAt = new Date(this.now()).toISOString()
    this.save(data)
  }

  /** The owner's answer on the home machine. Null when there is nothing waiting with this id. */
  decide(id: string, answer: "confirm" | "refuse"): OwnerBrowser | null {
    const data = this.load()
    const b = data.browsers.find((x) => x.id === id)
    if (!b || b.state !== "pending" || this.stale(b)) return null
    b.state = answer === "confirm" ? "confirmed" : "refused"
    b.decidedAt = new Date(this.now()).toISOString()
    // A confirm opens a new window to collect, from now: the owner may
    // have taken a while to walk to the home machine.
    if (answer === "confirm") b.waitingSince = b.decidedAt
    else delete b.waitingSince
    this.save(data)
    return b
  }

  /** End a confirmed browser: its next sign-in asks again. */
  end(id: string): OwnerBrowser | null {
    const data = this.load()
    const b = data.browsers.find((x) => x.id === id)
    if (!b || b.state !== "confirmed") return null
    b.state = "ended"
    b.decidedAt = new Date(this.now()).toISOString()
    delete b.waitingSince
    this.save(data)
    return b
  }

  /**
   * The browser asks where its sign-in stands. "collect" once, right after
   * the confirm (the caller then sets ax_session); "waiting" while the
   * owner has not answered; "gone" for a no, an ended browser, a sign-in
   * that waited too long, or one already collected.
   */
  collect(value: string | null | undefined): { state: "collect" | "waiting" | "gone"; browser: OwnerBrowser | null } {
    const found = this.find(value)
    if (!found) return { state: "gone", browser: null }
    if (found.state === "pending") return { state: this.stale(found) ? "gone" : "waiting", browser: found }
    if (found.state !== "confirmed" || !found.waitingSince || this.stale(found)) return { state: "gone", browser: found }
    const data = this.load()
    const b = data.browsers.find((x) => x.id === found.id)!
    delete b.waitingSince
    this.save(data)
    return { state: "collect", browser: b }
  }

  /** Every browser, newest first, for the home machine's page. */
  list(): ShownOwnerBrowser[] {
    return this.load().browsers
      .map(({ hash: _, ...b }) => (b.state === "pending" && this.stale({ ...b, hash: "" }) ? { ...b, expired: true as const } : b))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** A waiting sign-in, or a confirmed one not yet collected, past its window. */
  private stale(b: OwnerBrowser): boolean {
    const since = b.waitingSince ?? b.createdAt
    return this.now() >= Date.parse(since) + CONFIRM_TTL_MS
  }

  private load(): BrowsersFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
        if (parsed && Array.isArray(parsed.browsers)) return parsed
      } catch { /* rewritten on the next save */ }
    }
    return { browsers: [] }
  }

  private save(data: BrowsersFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
