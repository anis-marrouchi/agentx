// The global talk key, as plain rules (no Electron, no native hook), so they
// can be tested with plain Node (test/talk-key.test.mjs).
//
// Hakim C10 (#2265): the native hook sees every key on the machine. The
// matcher below reads only `keycode` and `altKey` of each event, compares them
// with the one chosen key, and keeps a single boolean (is the key held). It
// returns nothing for any other key; no other key is stored, logged or sent.

/** The two fields the matcher reads; any other field of the event is never read. */
export interface KeyEventLike {
  readonly keycode: number
  readonly altKey: boolean
}

export interface TalkKey {
  /** uiohook key code of the main key. */
  keycode: number
  /** Alt (Option on a Mac) must be held with it. */
  alt: boolean
  /** Electron accelerator for the press-twice fallback (globalShortcut). */
  accelerator: string
}

// uiohook-napi's UiohookKey: Space 0x0039, Alt 0x0038 (left), AltRight 0x0E38.
const SPACE = 0x0039
const ALT_CODES: readonly number[] = [0x0038, 0x0e38]

/** ⌥Space, as the Swift widget's Hotkey.swift. */
export const DEFAULT_TALK_KEY: TalkKey = Object.freeze({ keycode: SPACE, alt: true, accelerator: "Alt+Space" })

export function talkKeyLabel(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "⌥Space" : "Alt+Space"
}

export type TalkEdge = "start" | "stop"

export interface KeyMatcher {
  /** A key went down: "start" for the chosen key, else null. */
  down(e: KeyEventLike): TalkEdge | null
  /** A key went up: "stop" when the held chosen key (or its Alt) is let go, else null. */
  up(e: KeyEventLike): TalkEdge | null
}

export function keyMatcher(key: TalkKey = DEFAULT_TALK_KEY): KeyMatcher {
  let held = false // the only state: never a key code, never a history
  return Object.freeze({
    down(e: KeyEventLike): TalkEdge | null {
      if (held || e.keycode !== key.keycode) return null // auto-repeat, or another key
      if (key.alt && !e.altKey) return null
      held = true
      return "start"
    },
    up(e: KeyEventLike): TalkEdge | null {
      if (!held) return null
      const code = e.keycode
      if (code !== key.keycode && !(key.alt && ALT_CODES.includes(code))) return null
      held = false
      return "stop"
    },
  })
}

// --- Which way the key works, and what the tray says about it (v3 Q1) ---

/** hold: hold to talk, release to send. press-twice: press to start, again to send. */
export type TalkMode = "off" | "hold" | "press-twice"

export interface TalkModeInput {
  /** The person turned the global key on (tray). */
  enabled: boolean
  /** The session is Wayland: no app sees global key-up there. */
  wayland: boolean
  /** The native hook loaded and started; else why not. */
  hook: { ok: true } | { ok: false; reason: string }
}

export interface TalkModeResult {
  mode: TalkMode
  /** Why hold is not available, in plain words; null when it is, or the key is off. */
  reason: string | null
}

export function talkMode(i: TalkModeInput): TalkModeResult {
  if (!i.enabled) return { mode: "off", reason: null }
  if (i.wayland) return { mode: "press-twice", reason: "Wayland does not let apps see a key held down" }
  if (!i.hook.ok) return { mode: "press-twice", reason: i.hook.reason }
  return { mode: "hold", reason: null }
}

/** The tray line for the talk key. */
export function talkModeLine(r: TalkModeResult, keyLabel: string): string {
  if (r.mode === "off") return "Talk: hold the orb (global key off)"
  if (r.mode === "hold") return `Talk: hold ${keyLabel}, release to send`
  return `Talk: press ${keyLabel}, press again to send${r.reason ? ` (${r.reason})` : ""}`
}

/** Linux under Wayland (Ubuntu's default since 22.04). */
export function isWayland(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
  if (platform !== "linux") return false
  return env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY
}
