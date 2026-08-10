export { AttachRegistry, type OfferOutcome, type OfferInput } from "./registry"
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

import { AttachRegistry } from "./registry"

// Process-global registry. The daemon owns one; the CLI and MCP tools reach
// it over loopback HTTP rather than importing it, exactly like the guard.
let _registry: AttachRegistry | undefined

export function getAttachRegistry(): AttachRegistry {
  if (!_registry) _registry = new AttachRegistry()
  return _registry
}

/** Test-only: drop the global so each suite starts clean. */
export function resetAttachRegistry(): void {
  _registry = undefined
}
