import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- VAPID keys for Web Push ---
//
// The key pair identifies this node to the phone's push service. It lives in
// its own file (channels.push.keysFile, default .agentx/push-keys.json next
// to the device tokens), never in agentx.json, so sharing or committing the
// config can't leak the private key. `agentx app push-keys` writes it once;
// replacing it cuts off every phone until each turns notifications on again.

export const DEFAULT_PUSH_KEYS_FILE = ".agentx/push-keys.json"

export interface PushKeys {
  publicKey: string
  privateKey: string
  createdAt: string
}

export function pushKeysPath(file: string = DEFAULT_PUSH_KEYS_FILE, baseDir: string = process.cwd()): string {
  return resolve(baseDir, file)
}

/** The saved key pair, or null when the file is missing or unreadable. */
export function readPushKeys(path: string): PushKeys | null {
  if (!existsSync(path)) return null
  try {
    const k = JSON.parse(readFileSync(path, "utf-8"))
    return typeof k?.publicKey === "string" && typeof k?.privateKey === "string" ? k : null
  } catch {
    return null
  }
}

/** Writes the key pair readable by the owner only. */
export function writePushKeys(path: string, keys: { publicKey: string; privateKey: string }): PushKeys {
  const out: PushKeys = { ...keys, createdAt: new Date().toISOString() }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
  chmodSync(path, 0o600)
  return out
}
