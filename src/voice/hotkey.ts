// --- Keyboard shortcuts for AgentX Voice, as stored in agentx.json ---
//
// A shortcut is written as modifiers and one key joined by "+", for
// example "opt+space", "cmd+opt+period" or "ctrl+opt+1". The Mac app
// (apps/mac-voice Hotkey.swift) reads the same form. Stored in one
// normal order (ctrl, opt, shift, cmd, then the key) so two ways of
// writing a shortcut compare equal.

const MODIFIERS: Record<string, "ctrl" | "opt" | "shift" | "cmd"> = {
  ctrl: "ctrl", control: "ctrl",
  opt: "opt", option: "opt", alt: "opt",
  shift: "shift",
  cmd: "cmd", command: "cmd",
}
const ORDER = ["ctrl", "opt", "shift", "cmd"] as const

const NAMED_KEYS = [
  "space", "period", "comma", "slash", "semicolon", "quote", "minus", "equal",
  "leftbracket", "rightbracket", "backslash", "grave", "return", "tab",
]
const KEY_ALIASES: Record<string, string> = { ".": "period", ",": "comma", "/": "slash", ";": "semicolon", "'": "quote", "-": "minus", "=": "equal", "`": "grave", enter: "return" }

const isFKey = (k: string) => /^f([1-9]|1[0-9]|20)$/.test(k)
const isKey = (k: string) => /^[a-z0-9]$/.test(k) || NAMED_KEYS.includes(k) || isFKey(k)

export type HotkeyParse = { ok: true; value: string } | { ok: false; error: string }

/** A shortcut in its stored form, or why it cannot be one. */
export function parseHotkey(input: string): HotkeyParse {
  const raw = String(input ?? "").trim().toLowerCase()
  if (!raw) return { ok: false, error: "is empty" }
  // "+" itself is not a key we accept, so splitting on it is safe.
  const parts = raw.split("+").map((p) => p.trim())
  if (parts.some((p) => !p)) return { ok: false, error: `"${input}" has an empty part; write it like opt+space` }
  const key = KEY_ALIASES[parts[parts.length - 1]] ?? parts[parts.length - 1]
  const mods = new Set<string>()
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p]
    if (!m) return { ok: false, error: `"${p}" is not a modifier; use ctrl, opt, shift or cmd` }
    if (mods.has(m)) return { ok: false, error: `"${input}" names ${m} twice` }
    mods.add(m)
  }
  if (!isKey(key)) return { ok: false, error: `"${key}" is not a key AgentX Voice can use; use a letter, a digit, f1 to f20, or space, period, comma, slash, return, tab` }
  // Without ctrl, opt or cmd the shortcut would swallow ordinary typing.
  if (!isFKey(key) && !["ctrl", "opt", "cmd"].some((m) => mods.has(m))) {
    return { ok: false, error: `"${input}" needs ctrl, opt or cmd, or it would take that key away from your typing` }
  }
  return { ok: true, value: [...ORDER.filter((m) => mods.has(m)), key].join("+") }
}

/** Zod refinement message helper: undefined when fine. */
export function hotkeyError(input: string): string | undefined {
  const r = parseHotkey(input)
  return r.ok ? undefined : r.error
}

/** "⌃⌥1" for "ctrl+opt+1", as the Mac shows shortcuts. */
export function describeHotkey(value: string): string {
  const sym: Record<string, string> = { ctrl: "⌃", opt: "⌥", shift: "⇧", cmd: "⌘" }
  const names: Record<string, string> = { space: "Space", period: ".", comma: ",", slash: "/", semicolon: ";", quote: "'", minus: "-", equal: "=", leftbracket: "[", rightbracket: "]", backslash: "\\", grave: "`", return: "Return", tab: "Tab" }
  const parts = value.split("+")
  const key = parts.pop() ?? ""
  return parts.map((m) => sym[m] ?? m).join("") + (names[key] ?? key.toUpperCase())
}

export const DEFAULT_HOTKEYS = { talk: "opt+space", stop: "cmd+opt+period", paste: "cmd+opt+v" } as const
