import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { randomBytes } from "crypto"

// --- The guest's side: the hosts this node has joined (#380) ---
//
// One entry per grant this node holds as a guest: the host's address and
// the key it gave. Kept out of agentx.json, readable by this user only,
// because the key is a secret. `agentx mesh join` writes it; the daemon's
// POST /mesh/task reads it to route `peer: <host>` to the host's guest
// route; `agentx mesh ask` and `agentx mesh hosts` read it too.

const HOSTS_FILE = ".agentx/guest-hosts.json"

export interface GuestHost {
  /** What this node calls the host. */
  name: string
  url: string
  token: string
  grant: string
  /** The host agent that works for this node. */
  agentId: string
  expiresAt: string
  joinedAt: string
}

export class GuestHostStore {
  private file: string
  constructor(baseDir: string = process.cwd()) { this.file = resolve(baseDir, HOSTS_FILE) }

  hosts(): GuestHost[] { return this.load() }

  get(name: string): GuestHost | null {
    return this.load().find((h) => h.name === name) ?? null
  }

  add(host: GuestHost): void {
    const hosts = this.load().filter((h) => h.name !== host.name)
    hosts.push(host)
    this.save(hosts)
  }

  remove(name: string): boolean {
    const hosts = this.load()
    const kept = hosts.filter((h) => h.name !== name)
    if (kept.length === hosts.length) return false
    this.save(kept)
    return true
  }

  private load(): GuestHost[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
      return Array.isArray(parsed?.hosts) ? parsed.hosts : []
    } catch { return [] }
  }

  private save(hosts: GuestHost[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify({ hosts }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/** The guest's call to the host: one turn of the host agent inside the grant. */
export async function askHost(host: GuestHost, message: string, opts: { timeoutMs?: number } = {}): Promise<{ content: string; error?: string }> {
  const url = `${host.url.replace(/\/+$/, "")}/mesh/guest/task`
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30 * 60_000),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    if (!r.ok) return { content: "", error: String(data.error ?? `host answered HTTP ${r.status}`) }
    return { content: String(data.content ?? "") }
  } catch (e: any) {
    return { content: "", error: `could not reach ${host.name}: ${e?.message ?? e}` }
  }
}

/** The grant as the host shows it to this guest, or the refusal. */
export async function hostStatus(host: GuestHost): Promise<{ ok: true; grant: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  try {
    const r = await fetch(`${host.url.replace(/\/+$/, "")}/mesh/guest/me`, {
      headers: { Authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(10_000),
    })
    const data = await r.json().catch(() => ({})) as Record<string, unknown>
    return r.ok ? { ok: true, grant: data } : { ok: false, status: r.status, error: String(data.error ?? `HTTP ${r.status}`) }
  } catch (e: any) {
    return { ok: false, status: 0, error: `could not reach ${host.name}: ${e?.message ?? e}` }
  }
}
