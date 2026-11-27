// The global talk key: ⌥Space (Alt+Space) held while another app is in
// front. Hold-and-release needs key-up, which Electron's globalShortcut does
// not give, so it uses the native hook uiohook-napi (optional dependency).
// When the hook cannot run (not installed, refused by the system, Wayland),
// the key falls back to globalShortcut: press once to start, again to send,
// and the tray says why (design note v3, Hakim Q1).
//
// C10: every key event goes straight into keyMatcher (talk-key.ts), which
// reads only the key code and Alt; nothing here stores, logs or sends a key.

import { dialog, globalShortcut, systemPreferences } from "electron"
import { DEFAULT_TALK_KEY, keyMatcher, talkKeyLabel, talkMode, type KeyEventLike, type TalkEdge, type TalkModeResult } from "./talk-key.js"

interface Hook {
  on(event: "keydown" | "keyup", cb: (e: KeyEventLike) => void): void
  removeAllListeners(event?: string): void
  start(): void
  stop(): void
}

export const KEY_LABEL = talkKeyLabel(process.platform)

let hook: Hook | null = null
let shortcut = false
let current: TalkModeResult = { mode: "off", reason: null }

function loadHook(): Hook {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, loaded only when the key is on
  return (require("uiohook-napi") as { uIOhook: Hook }).uIOhook
}

/** macOS: the hook needs the Accessibility permission (libuiohook checks AXIsProcessTrusted). */
function macAllowed(): boolean {
  return process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false)
}

function startHook(onEdge: (edge: TalkEdge) => void): { ok: true } | { ok: false; reason: string } {
  if (!macAllowed()) return { ok: false, reason: "macOS permission not given" }
  try {
    const h = loadHook()
    const m = keyMatcher(DEFAULT_TALK_KEY)
    h.on("keydown", (e) => {
      const edge = m.down(e)
      if (edge) onEdge(edge)
    })
    h.on("keyup", (e) => {
      const edge = m.up(e)
      if (edge) onEdge(edge)
    })
    h.start()
    hook = h
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `key hook not available: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function startShortcut(onEdge: (edge: TalkEdge) => void): boolean {
  let talking = false
  shortcut = globalShortcut.register(DEFAULT_TALK_KEY.accelerator, () => {
    talking = !talking
    onEdge(talking ? "start" : "stop")
  })
  return shortcut
}

export function stopGlobalKey(): void {
  if (hook) {
    hook.removeAllListeners("keydown")
    hook.removeAllListeners("keyup")
    hook.stop()
    hook = null
  }
  if (shortcut) globalShortcut.unregister(DEFAULT_TALK_KEY.accelerator)
  shortcut = false
  current = { mode: "off", reason: null }
}

/** Starts (or stops) the key as the setting says; returns the mode for the tray. */
export function applyGlobalKey(enabled: boolean, wayland: boolean, onEdge: (edge: TalkEdge) => void, log: (m: string, err?: unknown) => void): TalkModeResult {
  stopGlobalKey()
  if (!enabled) return current
  const hookResult = wayland ? ({ ok: false, reason: "Wayland" } as const) : startHook(onEdge)
  current = talkMode({ enabled, wayland, hook: hookResult })
  if (current.mode === "press-twice" && !startShortcut(onEdge)) {
    log(`${DEFAULT_TALK_KEY.accelerator} is taken by another app`)
    current = { mode: "off", reason: `${KEY_LABEL} is taken by another app` }
  }
  log(`talk key: ${current.mode}${current.reason ? ` (${current.reason})` : ""}`)
  return current
}

export function globalKeyMode(): TalkModeResult {
  return current
}

/**
 * Asked once, when the person turns the key on: on macOS the hook needs a
 * permission, and the system asks for it after this plain reason. False when
 * the person said not now.
 */
export async function askForGlobalKey(): Promise<boolean> {
  if (process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false)) return true
  const r = await dialog.showMessageBox({
    type: "info",
    buttons: ["Continue", "Not now"],
    defaultId: 0,
    cancelId: 1,
    message: `Talk with ${KEY_LABEL} from any app`,
    detail:
      `To see ${KEY_LABEL} held down while another app is in front, macOS asks you to allow AgentX under Privacy & Security > Accessibility. ` +
      `AgentX looks at that one key only; it does not keep or send any other key. Until you allow it, ${KEY_LABEL} works as press to start, press again to send, and holding the orb always works.`,
  })
  if (r.response !== 0) return false
  systemPreferences.isTrustedAccessibilityClient(true) // shows the system's own prompt
  return true
}
