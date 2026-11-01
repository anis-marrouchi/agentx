import { spawnSync } from "child_process"

// --- OS keyring: where `auth: "keyring"` integrations keep their tokens ---
//
// Lives in src/native/ with the other OS-specific code (#1062);
// src/integrations/keyring.ts re-exports it.
//
// macOS: the login Keychain through `security`. Linux: the Secret Service
// through `secret-tool` (libsecret). Other systems have no keyring here:
// `connect` then stores the token in .env instead.
//
// Values are stored base64-encoded so they never need shell or `security -i`
// quoting, and they are passed on stdin, never on a command line that `ps`
// would show.

export interface KeyringStore {
  /** Whether a keyring can be used on this machine. */
  available(): boolean
  get(account: string): string | null
  set(account: string, value: string): void
  delete(account: string): boolean
}

export const KEYRING_SERVICE = "agentx"

/** The keyring account name for one integration. Never secret. */
export function integrationAccount(agentId: string, kind: string, label: string): string {
  return `integration:${agentId}:${kind}:${label}`
}

export interface RunResult { status: number | null; stdout: string }
export type Runner = (cmd: string, args: string[], input?: string) => RunResult

const defaultRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "ignore"] })
  if (r.error) return { status: null, stdout: "" }
  return { status: r.status, stdout: r.stdout ?? "" }
}

const enc = (v: string) => Buffer.from(v, "utf-8").toString("base64")
const dec = (v: string) => Buffer.from(v.trim(), "base64").toString("utf-8")

/** A `security -i` argument: only base64 and our own account names pass here. */
const quote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`

export function systemKeyring(platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner): KeyringStore {
  if (platform === "darwin") {
    return {
      available: () => run("security", ["help"]).status !== null,
      get(account) {
        const r = run("security", ["find-generic-password", "-s", KEYRING_SERVICE, "-a", account, "-w"])
        return r.status === 0 && r.stdout.trim() ? dec(r.stdout) : null
      },
      set(account, value) {
        const line = `add-generic-password -U -s ${quote(KEYRING_SERVICE)} -a ${quote(account)} -w ${quote(enc(value))}\n`
        const r = run("security", ["-i"], line)
        if (r.status !== 0) throw new Error("the macOS Keychain refused the token (security add-generic-password failed)")
      },
      delete(account) {
        return run("security", ["delete-generic-password", "-s", KEYRING_SERVICE, "-a", account]).status === 0
      },
    }
  }
  if (platform === "linux") {
    return {
      available: () => run("secret-tool", ["--version"]).status === 0,
      get(account) {
        const r = run("secret-tool", ["lookup", "service", KEYRING_SERVICE, "account", account])
        return r.status === 0 && r.stdout.trim() ? dec(r.stdout) : null
      },
      set(account, value) {
        const r = run("secret-tool", ["store", `--label=AgentX ${account}`, "service", KEYRING_SERVICE, "account", account], enc(value))
        if (r.status !== 0) throw new Error("the Secret Service refused the token (secret-tool store failed; is a keyring unlocked?)")
      },
      delete(account) {
        return run("secret-tool", ["clear", "service", KEYRING_SERVICE, "account", account]).status === 0
      },
    }
  }
  return { available: () => false, get: () => null, set: () => { throw new Error(`no OS keyring on ${platform}`) }, delete: () => false }
}

/** In-memory keyring for tests and dry runs. */
export function memoryKeyring(initial: Record<string, string> = {}): KeyringStore & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial))
  return {
    entries,
    available: () => true,
    get: (a) => entries.get(a) ?? null,
    set: (a, v) => { entries.set(a, v) },
    delete: (a) => entries.delete(a),
  }
}
