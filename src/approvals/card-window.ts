import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CHOICE_LIMITS } from "./choices"
import { renderCardPage, type CardPageOptions } from "./card-page"
import { CARD_PAD } from "./card-page-style"
import type { DecisionCard } from "./cards"
import { DISMISS_REASONS, type PopupAnswer, type Run } from "./popup"

// --- The Mac card window ---
//
// A small floating panel with a WKWebView in it, opened by osascript's
// JavaScript (JXA) bridge to AppKit. No app to build or install: the script
// below ships with the package, like the osascript dialogs it replaces.
//
// The page (card-page.ts) is written to a private temp file and loaded from
// disk; it can't reach the network. The panel is see-through: the page
// draws the card, its round corners and its shadow, so the panel is wider
// and taller than the card by CARD_PAD. It has no buttons of its own. The
// card sits at the top right of the main screen, floats over other windows,
// fits its height to the page, can be dragged by its top edge, and closes
// on an answer or after `seconds`. It stays up when another app is clicked
// (a panel hides then, unless told not to), and it takes a click made while
// another app is in front, so Send never needs a second click.
//
// The script prints the page's answer, or why there was none. Nothing here
// decides: popup-runner.ts records the answer, and only after parseAnswer
// has checked it against the card once more.

export const CARD_WIDTH = 440

export const WINDOW_JXA = `
ObjC.import("Cocoa"); ObjC.import("WebKit")
function run(argv) {
  var path = argv[0], side = ${CARD_PAD.side}, w = Number(argv[1]) + 2 * side, h = 420, secs = Number(argv[2]), capture = argv[3] || ""
  var app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  ObjC.registerSubclass({ name: "AgentXCardView", superclass: "WKWebView", methods: {
    "acceptsFirstMouse:": { types: ["bool", ["id"]], implementation: function () { return true } },
  } })
  var vis = $.NSScreen.mainScreen.visibleFrame
  var top = vis.origin.y + vis.size.height - 4, right = vis.origin.x + vis.size.width - 14 + side
  var mask = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskFullSizeContentView
  var win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(right - w, top - h, w, h), mask, $.NSBackingStoreBuffered, false)
  win.titlebarAppearsTransparent = true
  win.titleVisibility = $.NSWindowTitleHidden
  win.movableByWindowBackground = true
  win.level = $.NSFloatingWindowLevel
  win.releasedWhenClosed = false
  win.hidesOnDeactivate = false
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces
  win.opaque = false
  win.backgroundColor = $.NSColor.clearColor
  win.hasShadow = false
  ;[$.NSWindowCloseButton, $.NSWindowMiniaturizeButton, $.NSWindowZoomButton].forEach(function (b) { win.standardWindowButton(b).hidden = true })
  var cfg = $.WKWebViewConfiguration.alloc.init
  cfg.mediaTypesRequiringUserActionForPlayback = 0
  var web = $.AgentXCardView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, w, h), cfg)
  web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable
  web.setValueForKey(false, "drawsBackground")
  win.contentView = web
  var url = $.NSURL.fileURLWithPath(path)
  web.loadFileURLAllowingReadAccessToURL(url, url.URLByDeletingLastPathComponent)
  win.makeKeyAndOrderFront(null)
  app.activateIgnoringOtherApps(true)
  var end = Date.now() + secs * 1000, sized = 0, shot = false, seen = "", asked = false, answer = null
  while (Date.now() < end) {
    var ev = app.nextEventMatchingMaskUntilDateInModeDequeue($.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(0.05), $.NSDefaultRunLoopMode, true)
    if (ev && !ev.isNil()) app.sendEvent(ev)
    if (answer !== null) { win.close; return answer }
    if (!win.isVisible) return gone("closed")
    var t = web.title.js || ""
    if (t === "agentx:answer" && !asked) {
      asked = true
      web.evaluateJavaScriptCompletionHandler("window.agentxAnswer", function (r) { answer = String(ObjC.unwrap(r) || "") })
    }
    if (t !== seen && t.indexOf("agentx:size:") === 0) {
      seen = t
      var want = Math.min(Number(t.slice(12)), vis.size.height - 8)
      if (want > 80) { win.setFrameDisplayAnimate($.NSMakeRect(right - w, top - want, w, want), true, true); sized = Date.now() }
    }
    if (capture && !shot && sized && Date.now() - sized > 900) {
      shot = true
      var sa = Application.currentApplication(); sa.includeStandardAdditions = true
      sa.doShellScript("/usr/sbin/screencapture -x -o -l " + win.windowNumber + " " + quoted(capture))
      end = Math.min(end, Date.now() + 300)
    }
  }
  win.close
  return gone("timed out")
}
function gone(why) { return JSON.stringify({ action: "dismiss", why: why }) }
function quoted(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'" }
`

export interface CardWindowSettings extends CardPageOptions {
  timeoutSeconds: number
  /** Tests and docs: save a PNG of the window once it has opened. */
  capture?: string
}

/** The page's answer, checked against the card. Anything odd is a dismiss. */
export function parseAnswer(stdout: string, card: DecisionCard): PopupAnswer {
  const line = stdout.trim().split("\n").pop() ?? ""
  let raw: any
  try { raw = JSON.parse(line) } catch { return { action: "dismiss" } }
  if (raw?.action === "no") return { action: "no" }
  if (raw?.action === "dismiss" && DISMISS_REASONS.includes(raw.why)) return { action: "dismiss", why: raw.why }
  if (raw?.action !== "yes") return { action: "dismiss" }
  const choices = card.choices ?? []
  let choice: string | undefined
  if (choices.length) {
    if (typeof raw.choice !== "string" || !choices.includes(raw.choice)) return { action: "dismiss" }
    choice = raw.choice
  }
  let text: string | undefined
  if (card.draft) {
    text = typeof raw.text === "string" ? raw.text.replace(/\r\n?/g, "\n").trim() : ""
    // An emptied box is not an approval of nothing.
    if (!text || text.length > CHOICE_LIMITS.text) return { action: "dismiss" }
  }
  return { action: "yes", ...(choice ? { choice } : {}), ...(text ? { text } : {}) }
}

/**
 * Show the card in the window. Returns null when the window couldn't open,
 * so the caller can fall back to the plain dialogs.
 */
export async function showCardWindow(card: DecisionCard, settings: CardWindowSettings, exec: Run): Promise<PopupAnswer | null> {
  const seconds = Math.max(10, Math.round(settings.timeoutSeconds))
  const dir = mkdtempSync(join(tmpdir(), "agentx-card-"))
  try {
    const page = join(dir, "card.html")
    writeFileSync(page, renderCardPage(card, { ...settings, still: !!settings.capture }), { mode: 0o600 })
    const args = ["-l", "JavaScript", "-e", WINDOW_JXA, page, String(CARD_WIDTH), String(seconds), ...(settings.capture ? [settings.capture] : [])]
    const r = await exec("/usr/bin/osascript", args, (seconds + 10) * 1000)
    if (!r.ok) return null
    return parseAnswer(r.stdout, card)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
