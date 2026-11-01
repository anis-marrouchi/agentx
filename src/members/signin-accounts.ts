import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// The account each person first signed in with, per provider (#1675).
// Kept only once the person is let in: straight in, or on the owner's yes
// on the first-sign-in card. A refused or discarded sign-in binds nothing.

const ACCOUNTS_FILE = ".agentx/signin-accounts.json"

/** A provider account: its issuer and its subject there. */
export interface SignInAccount { issuer: string; subject: string }

export class SignInAccountStore {
  private file: string
  constructor(baseDir: string = process.cwd()) { this.file = resolve(baseDir, ACCOUNTS_FILE) }

  /** The subject kept for this person at this issuer, if any. */
  get(personId: string, issuer: string): string | null {
    return this.read()[`${personId} ${issuer}`] ?? null
  }

  /** The person this account was bound to, if any. */
  personOf(issuer: string, subject: string): string | null {
    for (const [k, v] of Object.entries(this.read())) if (v === subject && k.endsWith(` ${issuer}`)) return k.slice(0, -issuer.length - 1)
    return null
  }

  /** Keep this account for the person, unless one is kept already. */
  keepFirst(personId: string, account: SignInAccount): void {
    if (!this.get(personId, account.issuer)) this.bind(personId, account.issuer, account.subject)
  }

  bind(personId: string, issuer: string, subject: string): void {
    const all = this.read()
    all[`${personId} ${issuer}`] = subject
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify({ accounts: all }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    try {
      const a = JSON.parse(readFileSync(this.file, "utf-8")).accounts
      return a && typeof a === "object" ? a : {}
    } catch { return {} }
  }
}
