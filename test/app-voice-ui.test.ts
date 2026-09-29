import { describe, expect, it } from "vitest"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_ORB_SCRIPT } from "../src/daemon/ui/pages/app-orb.client"
import { APP_VOICE_AUDIO_SCRIPT } from "../src/daemon/ui/pages/app-voice-audio.client"
import { APP_VOICE_SCRIPT } from "../src/daemon/ui/pages/app-voice.client"
import { APP_CHAT_SCRIPT } from "../src/daemon/ui/pages/app-chat.client"
import { presenceLook } from "../src/voice/presence"

// The phone's voice orb and bar: the inlined scripts parse, the orb uses the
// Mac orb's numbers and colour fallback, and it holds still with Reduce Motion.

describe("page scripts", () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

  it("ships the orb and audio helpers before the voice bar, after Chat, and every script parses", () => {
    const all = scripts(renderAppPage())
    const chat = all.findIndex((s) => s.includes("window.AXChat ="))
    const voice = all.findIndex((s) => s.includes("window.AXVoice ="))
    expect(chat).toBeGreaterThanOrEqual(0)
    expect(voice).toBeGreaterThan(chat)
    const v = all[voice]
    expect(v.indexOf("window.AXOrb =")).toBeLessThan(v.indexOf("window.AXVoiceIO ="))
    expect(v.indexOf("window.AXVoiceIO =")).toBeLessThan(v.indexOf("window.AXVoice ="))
    for (const s of all) expect(() => new Function(s)).not.toThrow()
  })

  it("holds no backslash, backtick or dollar-brace (they break inside the template literal)", () => {
    for (const s of [APP_ORB_SCRIPT, APP_VOICE_AUDIO_SCRIPT, APP_VOICE_SCRIPT, APP_CHAT_SCRIPT]) {
      expect(s).not.toContain("\\")
      expect(s).not.toContain("`")
      expect(s).not.toContain("${")
    }
  })
})

/** Runs the orb script with a canvas that records its drawing. */
function loadOrb(reduceMotion: boolean) {
  const frames: Function[] = []
  const ops: string[] = []
  const ctx = new Proxy({}, {
    get: (_t, k) => k === "createRadialGradient" ? () => ({ addColorStop: (o: number, c: string) => ops.push(`stop ${o} ${c}`) })
      : (...a: unknown[]) => ops.push(`${String(k)} ${a.join(",")}`),
    set: (_t, k, v) => { ops.push(`${String(k)}=${v}`); return true },
  })
  const window: any = { devicePixelRatio: 2 }
  const document: any = { hidden: false, addEventListener() {} }
  window.matchMedia = () => ({ matches: reduceMotion, addEventListener() {} })
  new Function("window", "document", "matchMedia", "requestAnimationFrame", APP_ORB_SCRIPT)(
    window, document, window.matchMedia, (f: Function) => { frames.push(f); return frames.length })
  const canvas: any = { clientWidth: 150, width: 0, height: 0, getContext: () => ctx }
  return { O: window.AXOrb, canvas, frames, ops }
}

describe("the orb", () => {
  it("falls back to the same colour hash as the daemon and the Mac orb", () => {
    const { O } = loadOrb(false)
    for (const id of ["alpha", "atlas", "devops-agent", "x", "Ünïcode-agent"]) expect(O.colorFor(id)).toBe(presenceLook(id).color)
    expect(O.colorFor("alpha", "#112233")).toBe("#112233")
    expect(O.colorFor("alpha", "red")).toBe(presenceLook("alpha").color)
  })

  it("maps microphone level and speech like OrbMath", () => {
    const { O } = loadOrb(false)
    expect(O.levelFromRms(0.003)).toBe(0)
    expect(O.levelFromRms(0.02)).toBeCloseTo(Math.sqrt(0.016) * 3.2, 6)
    expect(O.levelFromRms(1)).toBe(1)
    for (let t = 0; t < 5; t += 0.137) {
      const e = O.speakingEnvelope(t)
      expect(e).toBeGreaterThanOrEqual(0.15 - 1e-9)
      expect(e).toBeLessThanOrEqual(1)
    }
  })

  it("draws a ring while thinking and animates only while it has something to show", () => {
    const { O, canvas, frames, ops } = loadOrb(false)
    const orb = O.create(canvas)
    expect(orb.state()).toMatchObject({ phase: "idle", still: false })
    orb.show("thinking")
    frames.shift()!(1000)
    expect(ops.some((o) => o === "strokeStyle=rgba(255,255,255,0.75)")).toBe(true)
    expect(orb.state().animating).toBe(true)
    orb.show("idle")
    const n = frames.length
    frames.shift()!(2000)
    expect(frames.length).toBeLessThanOrEqual(n) // no next frame requested
  })

  it("keeps a square bitmap at 2x, where a fresh 300x150 canvas already has the right width", () => {
    const { O, canvas, frames } = loadOrb(false)
    canvas.width = 300; canvas.height = 150
    O.create(canvas).show("thinking")
    frames.shift()!(1000)
    expect([canvas.width, canvas.height]).toEqual([300, 300])
  })

  it("is a still picture per state with Reduce Motion", () => {
    const { O, canvas, frames, ops } = loadOrb(true)
    const orb = O.create(canvas)
    orb.tint("#2563EB")
    orb.show("speaking")
    expect(orb.state()).toMatchObject({ phase: "speaking", still: true, animating: false })
    while (frames.length) frames.shift()!(5000)
    const first = ops.splice(0).join("|")
    orb.show("thinking"); orb.show("speaking")
    while (frames.length) frames.shift()!(9000)
    expect(ops.join("|")).toBe(first)
  })
})
