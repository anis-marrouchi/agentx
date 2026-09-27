export { AttachRegistry, type OfferOutcome, type OfferInput, type BindingStore, type SavedBinding } from "./registry"
export {
  DEFAULT_ATTACH_OPTIONS,
  DELIVERY_MODES,
  isDeliveryMode,
  type AttachOptions,
  type AttachSession,
  type DeliveryMode,
  type InboxItem,
  type ItemState,
  type StopDecision,
} from "./types"

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { AttachRegistry, type BindingStore, type SavedBinding } from "./registry"

/** #193 — bindings survive daemon restarts. Atomic write, owner-only. */
export function fileBindingStore(path: string): BindingStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, SavedBinding>) : {}),
    save: (all) => {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

function defaultBindingStore(): BindingStore | undefined {
  // Test runs never touch the real ~/.agentx.
  if (process.env.VITEST) return undefined
  return fileBindingStore(process.env.AGENTX_ATTACH_BINDINGS_FILE ?? join(homedir(), ".agentx", "attach-bindings.json"))
}

// Process-global registry. The daemon owns one; the CLI and MCP tools reach
// it over loopback HTTP rather than importing it, exactly like the guard.
let _registry: AttachRegistry | undefined

export function getAttachRegistry(): AttachRegistry {
  if (!_registry) _registry = new AttachRegistry({}, defaultBindingStore())
  return _registry
}

/** Test-only: drop the global so each suite starts clean. */
export function resetAttachRegistry(): void {
  _registry = undefined
}
