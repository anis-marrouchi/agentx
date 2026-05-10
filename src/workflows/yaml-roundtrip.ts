import { Document, isMap, isSeq, isScalar, parseDocument, YAMLMap, YAMLSeq, type Node, type Pair } from "yaml"
import type { Workflow } from "./types"

// --- YAML round-trip save (Move D) ---
//
// Preserves comments and key-ordering when the editor writes back to a
// YAML-authored workflow file. Without this, every editor save would
// either (a) refuse to overwrite the YAML (the old behaviour) or (b)
// regenerate canonical YAML from JSON, dropping every `# ...` comment
// the operator wrote in the file.
//
// Strategy: parse the existing file as a yaml@2 Document (which retains
// per-key + per-item commentBefore/commentAfter metadata), then merge
// the new workflow object into it in-place:
//
//   * top-level keys: preserve order for keys present in both old and
//     new; append new keys; drop removed keys (e.g. `flow:` becomes
//     `edges:` after a structural edit)
//   * arrays-of-objects with an `id` field (nodes, agents, …): merge by
//     id, keeping the original Pair (and its commentBefore) when ids
//     match. Re-order to match the new array. Append entries for new
//     ids; drop entries whose id was removed.
//   * arrays-of-objects without `id` (edges): replace wholesale —
//     edges don't carry author comments in practice.
//   * scalars + other shapes: replace.
//
// Comments tied to deleted keys / removed nodes are lost (there's no
// honest place to relocate them). The document-level header comment
// (`doc.commentBefore`) is always kept.

export function renderWorkflowYamlPreservingComments(originalText: string, workflow: Workflow): string {
  const doc = parseDocument(originalText)
  if (!doc.contents || !isMap(doc.contents)) {
    // Source file isn't a mapping — fall back to a clean dump of the new
    // workflow. The header comment (if any) carries forward via
    // commentBefore on the new contents.
    const fresh = new Document(workflow as unknown)
    if (doc.commentBefore) fresh.commentBefore = doc.commentBefore
    return String(fresh)
  }
  mergeMapInPlace(doc, doc.contents, workflow as unknown as Record<string, unknown>)
  return String(doc)
}

function mergeMapInPlace(doc: Document, map: YAMLMap, next: Record<string, unknown>): void {
  const newKeys = Object.keys(next)
  const newKeySet = new Set(newKeys)
  const oldPairs = new Map<string, Pair>()
  for (const pair of map.items) {
    const k = scalarKey(pair)
    if (k !== null) oldPairs.set(k, pair)
  }

  const merged: Pair[] = []
  for (const key of newKeys) {
    const value = next[key]
    const existing = oldPairs.get(key)
    if (existing) {
      mergeValueInPlace(doc, existing, value)
      merged.push(existing)
    } else {
      merged.push(doc.createPair(key, value))
    }
  }
  // Keep dropped pairs out of the mapping. Their commentBefore is lost
  // by design — orphaned comments would render in the wrong place.
  void newKeySet
  map.items = merged
}

function mergeValueInPlace(doc: Document, pair: Pair, nextValue: unknown): void {
  const oldVal = pair.value as Node | null

  // null/undefined → blank scalar
  if (nextValue === null || nextValue === undefined) {
    pair.value = doc.createNode(null) as Node
    return
  }

  // primitive → scalar replacement (preserves the key's commentBefore
  // because we mutate `pair.value`, not the pair itself).
  if (typeof nextValue !== "object") {
    pair.value = doc.createNode(nextValue) as Node
    return
  }

  // array
  if (Array.isArray(nextValue)) {
    if (isSeq(oldVal)) {
      mergeSeqInPlace(doc, oldVal as YAMLSeq, nextValue)
    } else {
      pair.value = doc.createNode(nextValue) as Node
    }
    return
  }

  // object/mapping
  if (isMap(oldVal)) {
    mergeMapInPlace(doc, oldVal as YAMLMap, nextValue as Record<string, unknown>)
  } else {
    pair.value = doc.createNode(nextValue) as Node
  }
}

function mergeSeqInPlace(doc: Document, seq: YAMLSeq, nextItems: unknown[]): void {
  // If every item is an object with a stable string `id`, merge by id so
  // per-item commentBefore (e.g. the `# Capture start time …` block above
  // a workflow node) sticks with that node even if it moves.
  const allHaveId =
    nextItems.length > 0 &&
    nextItems.every((it) => it && typeof it === "object" && typeof (it as { id?: unknown }).id === "string")

  if (!allHaveId) {
    // Replace wholesale. Edge lists, envAllow strings, etc.
    const replacement = doc.createNode(nextItems) as YAMLSeq
    seq.items = replacement.items
    return
  }

  const oldById = new Map<string, Node>()
  for (const item of seq.items) {
    if (isMap(item)) {
      const idNode = item.get("id", true)
      if (isScalar(idNode) && typeof idNode.value === "string") {
        oldById.set(idNode.value, item)
      }
    }
  }

  const merged: Node[] = []
  for (const next of nextItems) {
    const id = (next as { id: string }).id
    const existing = oldById.get(id)
    if (existing && isMap(existing)) {
      mergeMapInPlace(doc, existing as YAMLMap, next as Record<string, unknown>)
      merged.push(existing)
    } else {
      merged.push(doc.createNode(next) as Node)
    }
  }
  seq.items = merged
}

function scalarKey(pair: Pair): string | null {
  const k = pair.key
  if (isScalar(k) && typeof k.value === "string") return k.value
  if (typeof k === "string") return k
  return null
}
