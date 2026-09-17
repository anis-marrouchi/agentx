// Pull a JSON value out of text a model wrote.
//
// Consolidated from four byte-identical copies (src/graph/classifier.ts,
// src/agents/context-planner.ts, src/commands/graph.ts, and
// src/daemon/board-dashboard.ts). Callers that return prose keep their own
// bespoke variants — this is for call sites whose whole reply is supposed
// to be a structured value.
//
// One behavioural difference from the copies it replaces: the balanced-brace
// scan is string-aware. The old version counted every `{` and `}` including
// ones inside string literals, so a perfectly valid `{"glob": "src/**/{a,b}"}`
// truncated at the wrong byte and returned null.

/** Parse `text` as JSON, tolerating code fences and surrounding prose.
 *  Returns `null` when nothing parseable is found — never throws. */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null

  const direct = tryParse<T>(text)
  if (direct !== undefined) return direct

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    const parsed = tryParse<T>(fenced[1])
    if (parsed !== undefined) return parsed
  }

  // Last-ditch: the first balanced object or array in the text. Whichever
  // bracket appears first wins, so `here: [{"a":1}]` yields the array and
  // not the object nested inside it.
  const pairs = ([["{", "}"], ["[", "]"]] as const)
    .map(([open, close]) => ({ open, close, at: text.indexOf(open) }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at)

  for (const { open, close } of pairs) {
    const slice = balancedSlice(text, open, close)
    if (slice !== null) {
      const parsed = tryParse<T>(slice)
      if (parsed !== undefined) return parsed
    }
  }

  return null
}

function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.trim()) as T
  } catch {
    return undefined
  }
}

function balancedSlice(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}
