import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve } from "path"

// --- .env mutator ---
//
// Line-preserving read/write for .env files. Comments, blank lines, and
// original key order are kept intact. Used by `agentx connect <channel>`
// (and anything else that needs to persist secrets) so we never hand the
// user a file-editor instruction.

export type DotEnvLine =
  | { kind: "kv"; key: string; value: string; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank"; raw: string }

const KV_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

function parseValue(raw: string): string {
  // Strip matching surrounding quotes — write path re-adds them as needed.
  const s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function quoteIfNeeded(value: string): string {
  if (/[\s#"'\\]/.test(value) || value === "") return JSON.stringify(value)
  return value
}

export function readDotEnv(path: string = ".env"): DotEnvLine[] {
  const abs = resolve(path)
  if (!existsSync(abs)) return []
  const content = readFileSync(abs, "utf-8")
  const lines: DotEnvLine[] = []
  for (const raw of content.split(/\r?\n/)) {
    if (raw.trim() === "") {
      lines.push({ kind: "blank", raw })
      continue
    }
    if (raw.trim().startsWith("#")) {
      lines.push({ kind: "comment", raw })
      continue
    }
    const m = raw.match(KV_RE)
    if (m) {
      lines.push({ kind: "kv", key: m[1], value: parseValue(m[2]), raw })
    } else {
      // Unparseable line — preserve verbatim as "comment" so we don't trample it
      lines.push({ kind: "comment", raw })
    }
  }
  // Strip a single trailing blank line (every file ends with \n → one empty split)
  if (lines.length && lines[lines.length - 1].kind === "blank") lines.pop()
  return lines
}

export function serializeDotEnv(lines: DotEnvLine[]): string {
  return lines.map((l) => {
    if (l.kind === "kv") return `${l.key}=${quoteIfNeeded(l.value)}`
    return l.raw
  }).join("\n") + "\n"
}

/**
 * Set a key to a value, preserving ordering & comments.
 *  - If the key exists, the line is rewritten in place.
 *  - If it doesn't, the key is appended (with a blank separator if the file
 *    doesn't already end in one).
 */
export function setDotEnv(key: string, value: string, path: string = ".env"): void {
  const abs = resolve(path)
  const lines = readDotEnv(abs)

  const idx = lines.findIndex((l) => l.kind === "kv" && l.key === key)
  if (idx >= 0) {
    lines[idx] = { kind: "kv", key, value, raw: `${key}=${quoteIfNeeded(value)}` }
  } else {
    if (lines.length && lines[lines.length - 1].kind !== "blank") {
      lines.push({ kind: "blank", raw: "" })
    }
    lines.push({ kind: "kv", key, value, raw: `${key}=${quoteIfNeeded(value)}` })
  }

  writeFileSync(abs, serializeDotEnv(lines))
}

/**
 * Append a key only if it isn't already present. Use this when you don't want
 * to clobber an existing value (e.g. a MESH_TOKEN the user already rotated).
 */
export function appendDotEnv(key: string, value: string, path: string = ".env"): boolean {
  const lines = readDotEnv(path)
  if (lines.some((l) => l.kind === "kv" && l.key === key)) return false
  setDotEnv(key, value, path)
  return true
}

export function getDotEnv(key: string, path: string = ".env"): string | undefined {
  const lines = readDotEnv(path)
  const hit = lines.find((l): l is Extract<DotEnvLine, { kind: "kv" }> => l.kind === "kv" && l.key === key)
  return hit?.value
}

export function unsetDotEnv(key: string, path: string = ".env"): boolean {
  const abs = resolve(path)
  const lines = readDotEnv(abs)
  const idx = lines.findIndex((l) => l.kind === "kv" && l.key === key)
  if (idx < 0) return false
  lines.splice(idx, 1)
  // Collapse double-blank that may result
  if (idx > 0 && idx < lines.length && lines[idx - 1].kind === "blank" && lines[idx].kind === "blank") {
    lines.splice(idx, 1)
  }
  writeFileSync(abs, serializeDotEnv(lines))
  return true
}
