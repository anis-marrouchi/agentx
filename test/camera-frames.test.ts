import { describe, it, expect, vi, afterEach } from "vitest"
import { inflateSync } from "zlib"
import { crc32, encodePng } from "../src/camera/png"
import { downscaleRgba, frameToPng, i420ToRgba, rotateRgba, type I420Frame } from "../src/camera/frame-image"
import { FrameSampler } from "../src/camera/sampler"

// A camera frame on its way to an agent (#325 phase 2): the PNG encoder,
// the frame conversions, and the sampler that keeps only the newest frame.

/** Read back what encodePng wrote: every chunk's CRC, the header, the pixels. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let off = 8
  let width = 0, height = 0
  const idat: Buffer[] = []
  const types: string[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.subarray(off + 4, off + 8).toString("ascii")
    const data = png.subarray(off + 8, off + 8 + len)
    const crc = png.readUInt32BE(off + 8 + len)
    expect(crc).toBe(crc32(png.subarray(off + 4, off + 8 + len)))
    types.push(type)
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0])
    }
    if (type === "IDAT") idat.push(data)
    off += 12 + len
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"])
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, rgba }
}

describe("png", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it("round-trips RGBA pixels", () => {
    const w = 3, h = 2
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff
    const png = encodePng(rgba, w, h)
    const back = decodePng(png)
    expect(back.width).toBe(3)
    expect(back.height).toBe(2)
    expect([...back.rgba]).toEqual([...rgba])
  })

  it("refuses a buffer that does not match the size", () => {
    expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow(/expected 16 bytes/)
    expect(() => encodePng(new Uint8Array(0), 0, 1)).toThrow(/bad size/)
  })
})

/** A frame that is one flat colour, in I420. */
function flat(width: number, height: number, y: number, u: number, v: number, rotation = 0): I420Frame {
  const data = new Uint8Array(width * height + 2 * ((width + 1) >> 1) * ((height + 1) >> 1))
  data.fill(y, 0, width * height)
  data.fill(u, width * height, width * height + ((width + 1) >> 1) * ((height + 1) >> 1))
  data.fill(v, width * height + ((width + 1) >> 1) * ((height + 1) >> 1))
  return { width, height, data, rotation }
}

describe("frame image", () => {
  it("converts I420 to RGBA (BT.601): white, black, red", () => {
    const white = i420ToRgba(flat(2, 2, 235, 128, 128))
    expect([...white.data.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    const black = i420ToRgba(flat(2, 2, 16, 128, 128))
    expect([...black.data.subarray(0, 4)]).toEqual([0, 0, 0, 255])
    const red = i420ToRgba(flat(2, 2, 81, 90, 240))
    const [r, g, b, a] = red.data.subarray(0, 4)
    expect(r).toBeGreaterThan(240); expect(g).toBeLessThan(20); expect(b).toBeLessThan(20); expect(a).toBe(255)
    expect(() => i420ToRgba({ width: 4, height: 4, data: new Uint8Array(3) })).toThrow(/too few/)
  })

  it("rotates clockwise so a phone held upright gives an upright picture", () => {
    // 2 wide, 1 tall: [A B]. Turned 90° clockwise it is 1 wide, 2 tall: [A] over [B].
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]) }
    const r90 = rotateRgba(img, 90)
    expect([r90.width, r90.height]).toEqual([1, 2])
    expect([...r90.data]).toEqual([1, 1, 1, 255, 2, 2, 2, 255])
    const r180 = rotateRgba(img, 180)
    expect([r180.width, r180.height]).toEqual([2, 1])
    expect([...r180.data]).toEqual([2, 2, 2, 255, 1, 1, 1, 255])
    const r270 = rotateRgba(img, 270)
    expect([r270.width, r270.height]).toEqual([1, 2])
    expect([...r270.data]).toEqual([2, 2, 2, 255, 1, 1, 1, 255])
    expect(rotateRgba(img, 0)).toBe(img)
    expect(rotateRgba(img, 360)).toBe(img)
  })

  it("shrinks to the longer edge and leaves a small picture alone", () => {
    const big = { width: 400, height: 200, data: new Uint8ClampedArray(400 * 200 * 4).fill(7) }
    const small = downscaleRgba(big, 100)
    expect([small.width, small.height]).toEqual([100, 50])
    expect(small.data.every((b) => b === 7)).toBe(true)
    const tall = downscaleRgba({ width: 200, height: 400, data: big.data }, 100)
    expect([tall.width, tall.height]).toEqual([50, 100])
    expect(downscaleRgba(big, 400)).toBe(big)
    expect(downscaleRgba(big, 0)).toBe(big)
  })

  it("frameToPng: upright, bounded, and a real PNG", () => {
    const png = frameToPng(flat(64, 32, 235, 128, 128, 90), { maxEdge: 32 })
    expect([png.width, png.height]).toEqual([16, 32])
    const back = decodePng(png.png)
    expect([back.width, back.height]).toEqual([16, 32])
    expect([...back.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    // A caller's converter (the native one, in the daemon) is used when given.
    const toRgba = vi.fn(() => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(9) }))
    const custom = frameToPng(flat(2, 2, 0, 0, 0), { maxEdge: 100, toRgba })
    expect(toRgba).toHaveBeenCalledOnce()
    expect([...decodePng(custom.png).rgba]).toEqual(new Array(16).fill(9))
  })
})

describe("frame sampler", () => {
  afterEach(() => vi.useRealTimers())

  it("keeps only the latest frame, and taking it does not consume it", () => {
    const s = new FrameSampler<string>({ intervalMs: 0, now: () => 5 })
    expect(s.take()).toBeNull()
    s.push("first"); s.push("second"); s.push("third")
    expect(s.received).toBe(3)
    expect(s.take()).toEqual({ frame: "third", receivedAt: 5, seq: 3 })
    expect(s.take()).toEqual({ frame: "third", receivedAt: 5, seq: 3 })
    s.stop()
    expect(s.take()).toBeNull()
    s.push("late")
    expect(s.received).toBe(3)
  })

  it("on demand only when the interval is 0", () => {
    vi.useFakeTimers()
    const onSample = vi.fn()
    const s = new FrameSampler<number>({ intervalMs: 0, onSample })
    s.start()
    s.push(1)
    vi.advanceTimersByTime(60_000)
    expect(onSample).not.toHaveBeenCalled()
    s.stop()
  })

  it("samples the newest frame on the interval, only when a new one arrived", async () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const s = new FrameSampler<number>({ intervalMs: 1000, onSample: async (x) => { seen.push(x.frame) } })
    s.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([])                  // nothing arrived yet
    s.push(1); s.push(2); s.push(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([3])                 // the newest, not each one
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toEqual([3])                 // a frozen camera is not re-sampled
    s.push(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([3, 4])
    s.stop()
    s.push(5)
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toEqual([3, 4])
  })

  it("does not overlap a slow sample, and a failing one is logged, not fatal", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const calls: number[] = []
    const logs: string[] = []
    const s = new FrameSampler<number>({
      intervalMs: 100,
      onSample: (x) => {
        calls.push(x.frame)
        if (x.frame === 1) return new Promise<void>((r) => { release = r })
        if (x.frame === 2) throw new Error("boom")
      },
      log: (m) => logs.push(m),
    })
    s.start()
    s.push(1)
    await vi.advanceTimersByTimeAsync(100)
    s.push(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toEqual([1])                // still busy with the first
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toEqual([1, 2])
    expect(logs).toEqual([expect.stringMatching(/sample 2 failed: boom/)])
    s.stop()
  })
})
