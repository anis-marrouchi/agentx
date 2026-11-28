// The orb page itself (resources/orb/orb.js), run in a Node vm with a small
// stand-in for the DOM, the microphone and the app bridge (#2265 B1, S2, N6).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

const source = await readFile(new URL("../resources/orb/orb.js", import.meta.url), "utf8")

function el() {
  const e = {
    dataset: {},
    hidden: false,
    textContent: "",
    title: "",
    attrs: {},
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    addEventListener(k, fn) {
      this.listeners[k] = fn
    },
    classes: new Set(),
    classList: {
      add(k) {
        this.owner.classes.add(k)
      },
      remove(k) {
        this.owner.classes.delete(k)
      },
    },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  }
  e.classList.owner = e
  return e
}

/** Loads the page; the microphone answers only when the test says so. */
function page() {
  const els = {}
  const calls = []
  const on = {}
  const bridge = {}
  for (const k of ["resize", "dragStart", "dragMove", "dragEnd", "begin", "partial", "final", "cancel", "played"]) {
    bridge[k] = (...a) => calls.push([k, ...a])
  }
  for (const k of ["onState", "onTalk", "onPartial", "onPlay"]) bridge[k] = (cb) => (on[k] = cb)
  const mic = { requests: [], stopped: 0 }
  const frames = []
  const recorders = []
  let clock = 1_000_000
  class MediaRecorder {
    constructor(stream) {
      this.stream = stream
      this.mimeType = "audio/webm"
      recorders.push(this)
    }
    start() {}
    stop() {
      this.onstop?.()
    }
  }
  const ctx = {
    window: { agentxOrb: bridge },
    document: {
      getElementById: (id) => (els[id] ||= el()),
      documentElement: { style: { setProperty() {} } },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve, reject) => {
            const stream = { getTracks: () => [{ stop: () => mic.stopped++ }] }
            mic.requests.push({ grant: () => resolve(stream), deny: (name) => reject(Object.assign(new Error(name), { name })) })
          }),
      },
    },
    location: { search: "" },
    MediaRecorder,
    AudioContext: class {
      createAnalyser() {
        return { fftSize: 512, getByteTimeDomainData() {} }
      }
      createMediaStreamSource() {
        return { connect() {} }
      }
      close() {
        return Promise.resolve()
      }
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Blob,
    URLSearchParams,
    Uint8Array,
    Math,
    Number,
    String,
    Date: { now: () => clock },
  }
  ctx.window.speechSynthesis = undefined
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return {
    els,
    ctx,
    state: () => els.stage.dataset.state,
    text: () => els.text.textContent,
    calls,
    on,
    mic,
    recorders,
    /** Runs the meter's next frame (it drives the rolling passes). */
    frame: () => frames.splice(0).forEach((f) => f()),
    later: (ms) => (clock += ms),
  }
}

const settle = () => new Promise((r) => setImmediate(r))

test("B1: let go before the microphone opened → the orb rests and the turn ends", async () => {
  const p = page()
  p.on.onTalk("start")
  assert.equal(p.state(), "listening")
  assert.equal(p.calls.filter((c) => c[0] === "begin").length, 1)
  p.on.onTalk("stop") // released while the permission prompt is still up
  assert.equal(p.state(), "idle", "rests at once, not stuck on listening")
  p.mic.requests[0].grant() // the person allows the microphone afterwards
  await settle()
  assert.equal(p.state(), "idle")
  assert.equal(p.mic.stopped, 1, "the stream is closed")
  assert.equal(p.recorders.length, 0, "nothing is recorded")
  assert.equal(p.calls.filter((c) => c[0] === "cancel").length, 1, "the turn begun is ended")
  assert.equal(p.calls.filter((c) => c[0] === "final").length, 0)
})

test("B1: pressed again while the microphone still opens → that take goes on", async () => {
  const p = page()
  p.on.onTalk("start")
  p.on.onTalk("stop")
  p.on.onTalk("start")
  assert.equal(p.state(), "listening")
  assert.equal(p.mic.requests.length, 1, "one microphone request, not two")
  p.mic.requests[0].grant()
  await settle()
  assert.equal(p.recorders.length, 1)
  assert.equal(p.calls.filter((c) => c[0] === "cancel").length, 0)
  assert.equal(p.state(), "listening")
})

test("B1: a blocked microphone still says so", async () => {
  const p = page()
  p.on.onTalk("start")
  p.mic.requests[0].deny("NotAllowedError")
  await settle()
  assert.equal(p.state(), "idle")
})

async function recording() {
  const p = page()
  p.on.onTalk("start")
  p.mic.requests[0].grant()
  await settle()
  p.recorders[0].ondataavailable({ data: new Blob(["x"]) })
  return p
}

async function nextPass(p) {
  p.later(2_600)
  p.frame()
  await settle()
  return p.calls.filter((c) => c[0] === "partial").at(-1)
}

test("S2: a dropped pass (null reply) frees the next one; live words come again", async () => {
  const p = await recording()
  const first = await nextPass(p)
  assert.ok(first, "a rolling pass was asked")
  const id1 = first[4]
  assert.equal((await nextPass(p))[4], id1, "one at a time: none while the first runs")
  p.on.onPartial(null, id1) // the app dropped it (another pass was running)
  const second = await nextPass(p)
  assert.notEqual(second[4], id1, "the next pass goes")
  p.on.onPartial("hello there", second[4])
  assert.equal(p.text(), "hello there")
})

test("S2: an answer to an older pass does not free or write over the current one", async () => {
  const p = await recording()
  const first = await nextPass(p)
  p.on.onPartial("old words", first[4] - 1)
  assert.equal(p.text(), "", "not this pass's answer")
  assert.equal((await nextPass(p))[4], first[4], "still waits for its own answer")
})

// #2549: the ring around the orb, or Option/Alt + drag on the orb, only moves it.
const at = (x, y, more = {}) => ({ button: 0, pointerId: 1, screenX: x, screenY: y, ...more })
const named = (p, k) => p.calls.filter((c) => c[0] === k)

test("#2549: a press on the ring moves the orb, even held still, and never talks", () => {
  const p = page()
  const grip = p.els.grip.listeners
  grip.pointerdown(at(100, 100))
  assert.ok(p.els.stage.classes.has("moving"), "the ring shows while moving")
  grip.pointermove(at(100, 101)) // a 1 px move: below the old 4 px threshold
  grip.pointermove(at(160, 140))
  grip.pointerup(at(160, 140))
  assert.deepEqual(named(p, "dragMove").map((c) => c.slice(1)), [[0, 1], [60, 40]])
  assert.equal(named(p, "dragStart").length, 1)
  assert.equal(named(p, "dragEnd").length, 1, "the end saves the place (orb-state.json)")
  assert.ok(!p.els.stage.classes.has("moving"))
  assert.equal(named(p, "begin").length, 0, "no recording")
  assert.equal(p.mic.requests.length, 0)
  assert.equal(p.state(), "idle")
})

test("#2549: the ring moves the orb while the agent speaks, without stopping it", () => {
  const p = page()
  p.on.onState({ state: "speaking" })
  p.els.grip.listeners.pointerdown(at(0, 0))
  p.els.grip.listeners.pointerup(at(0, 0))
  assert.equal(named(p, "cancel").length, 0)
  assert.equal(p.state(), "speaking")
})

test("#2549: Option/Alt + drag on the orb moves it and never talks", () => {
  const p = page()
  const orb = p.els.orb.listeners
  orb.pointerdown(at(10, 10, { altKey: true }))
  orb.pointermove(at(30, 50))
  orb.pointerup(at(30, 50))
  assert.deepEqual(named(p, "dragMove").map((c) => c.slice(1)), [[20, 40]])
  assert.equal(named(p, "dragEnd").length, 1)
  assert.equal(named(p, "begin").length, 0)
})

test("#2549: a plain hold on the orb still talks", async () => {
  const p = page()
  let hold
  p.ctx.setTimeout = (fn) => ((hold = fn), 1)
  p.els.orb.listeners.pointerdown(at(10, 10))
  hold()
  assert.equal(p.state(), "listening")
  assert.equal(named(p, "begin").length, 1)
  p.mic.requests[0].grant()
  await settle()
  p.els.orb.listeners.pointerup(at(10, 10))
  assert.equal(p.state(), "thinking")
  assert.equal(named(p, "dragMove").length, 0)
})
