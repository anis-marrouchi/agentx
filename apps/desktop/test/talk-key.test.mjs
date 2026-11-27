// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import talk from "../dist/talk-key.js"

const { DEFAULT_TALK_KEY, keyMatcher, talkMode, talkModeLine, isWayland } = talk
const SPACE = 0x0039
const ALT = [0x0038, 0x0e38]

// An event that records which of its fields were read.
function spyEvent(fields, reads) {
  return new Proxy(fields, {
    get(t, k) {
      reads.add(String(k))
      return t[k]
    },
  })
}

test("C10: only the chosen key gives an edge; other keys give nothing and nothing is kept", () => {
  const m = keyMatcher(DEFAULT_TALK_KEY)
  const edges = []
  const reads = new Set()
  const feed = (kind, keycode, altKey) => {
    const edge = m[kind](spyEvent({ keycode, altKey, ctrlKey: false, metaKey: false, shiftKey: false, time: 1 }, reads))
    if (edge) edges.push(edge)
  }
  // Every other key code uiohook can send, with and without Alt, down and up: nothing.
  for (let code = 0; code <= 0xffff; code++) {
    if (code === SPACE) continue
    feed("down", code, false)
    feed("down", code, true)
    feed("up", code, false)
  }
  feed("down", SPACE, false) // Space without Alt is typing, not the talk key
  assert.deepEqual(edges, [])
  // Only key code and Alt were ever read; time, other modifiers, nothing else.
  assert.deepEqual([...reads].sort(), ["altKey", "keycode"])
  // The matcher holds no field a key could be kept in: two methods, frozen.
  assert.deepEqual(Object.keys(m).sort(), ["down", "up"])
  assert.ok(Object.isFrozen(m))

  // The chosen key: start once (auto-repeat ignored), other keys while held still give nothing, stop on release.
  feed("down", SPACE, true)
  feed("down", SPACE, true)
  feed("down", 30 /* A */, true)
  feed("up", 30, true)
  feed("up", SPACE, true)
  feed("up", SPACE, true)
  assert.deepEqual(edges, ["start", "stop"])
})

test("letting go of Alt first also stops", () => {
  for (const alt of ALT) {
    const m = keyMatcher()
    assert.equal(m.down({ keycode: SPACE, altKey: true }), "start")
    assert.equal(m.up({ keycode: alt, altKey: false }), "stop")
    assert.equal(m.up({ keycode: SPACE, altKey: false }), null)
  }
})

test("talk mode: off, hold, or press twice with the reason (v3 Q1)", () => {
  const ok = { ok: true }
  assert.deepEqual(talkMode({ enabled: false, wayland: false, hook: ok }), { mode: "off", reason: null })
  assert.deepEqual(talkMode({ enabled: true, wayland: false, hook: ok }), { mode: "hold", reason: null })
  assert.equal(talkMode({ enabled: true, wayland: true, hook: ok }).mode, "press-twice")
  const failed = talkMode({ enabled: true, wayland: false, hook: { ok: false, reason: "key hook not available" } })
  assert.deepEqual(failed, { mode: "press-twice", reason: "key hook not available" })
  assert.equal(talkModeLine(failed, "Alt+Space"), "Talk: press Alt+Space, press again to send (key hook not available)")
  assert.equal(talkModeLine({ mode: "hold", reason: null }, "⌥Space"), "Talk: hold ⌥Space, release to send")
  assert.equal(talkModeLine({ mode: "off", reason: null }, "⌥Space"), "Talk: hold the orb (global key off)")
})

test("Wayland is Linux with a Wayland session only", () => {
  assert.equal(isWayland("linux", { XDG_SESSION_TYPE: "wayland" }), true)
  assert.equal(isWayland("linux", { WAYLAND_DISPLAY: "wayland-0" }), true)
  assert.equal(isWayland("linux", { XDG_SESSION_TYPE: "x11" }), false)
  assert.equal(isWayland("darwin", { WAYLAND_DISPLAY: "wayland-0" }), false)
})
