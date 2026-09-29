import { encodePng } from "./png"

// --- From a decoded video frame to a picture an agent can open ---
//
// The WebRTC bot hands over frames as they leave the decoder: I420 (a
// luma plane, then two half-size chroma planes) with the rotation the phone
// recorded. This turns one into an upright RGBA picture no larger than
// `maxEdge` on its long side, then into a PNG. Everything is plain
// JavaScript so it is testable without the native module.

export interface I420Frame {
  width: number
  height: number
  /** width*height luma bytes, then (width/2)*(height/2) Cb, then Cr. */
  data: Uint8Array | Uint8ClampedArray
  /** Degrees clockwise the picture must turn to be upright: 0, 90, 180, 270. */
  rotation?: number
}

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** BT.601 limited-range conversion, the same maths libyuv uses for I420. */
export function i420ToRgba(frame: I420Frame): RgbaImage {
  const { width, height, data } = frame
  const chromaW = (width + 1) >> 1
  const ySize = width * height
  const uOff = ySize
  const vOff = ySize + chromaW * ((height + 1) >> 1)
  if (data.length < vOff + chromaW * ((height + 1) >> 1)) {
    throw new Error(`i420ToRgba: ${data.length} bytes is too few for ${width}x${height}`)
  }
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const cRow = (y >> 1) * chromaW
    for (let x = 0; x < width; x++) {
      const c = 1.164 * (data[y * width + x] - 16)
      const d = data[uOff + cRow + (x >> 1)] - 128
      const e = data[vOff + cRow + (x >> 1)] - 128
      const o = (y * width + x) * 4
      out[o] = clamp(c + 1.596 * e)
      out[o + 1] = clamp(c - 0.392 * d - 0.813 * e)
      out[o + 2] = clamp(c + 2.017 * d)
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

/** Turn the picture clockwise by 0, 90, 180 or 270 degrees. */
export function rotateRgba(img: RgbaImage, degrees: number): RgbaImage {
  const turn = ((Math.round(degrees / 90) % 4) + 4) % 4
  if (turn === 0) return img
  const { width: w, height: h, data } = img
  const [nw, nh] = turn === 2 ? [w, h] : [h, w]
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = turn === 1 ? h - 1 - y : turn === 2 ? w - 1 - x : y
      const ny = turn === 1 ? x : turn === 2 ? h - 1 - y : w - 1 - x
      const s = (y * w + x) * 4
      const d = (ny * nw + nx) * 4
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3]
    }
  }
  return { width: nw, height: nh, data: out }
}

/** Shrink the picture so its longer side is at most `maxEdge` pixels.
 *  Nearest neighbour: a frame is looked at, not printed. Unchanged when
 *  it already fits. */
export function downscaleRgba(img: RgbaImage, maxEdge: number): RgbaImage {
  const long = Math.max(img.width, img.height)
  if (!(maxEdge > 0) || long <= maxEdge) return img
  const scale = maxEdge / long
  const nw = Math.max(1, Math.round(img.width * scale))
  const nh = Math.max(1, Math.round(img.height * scale))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) / scale))
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) / scale))
      const s = (sy * img.width + sx) * 4
      const d = (y * nw + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { width: nw, height: nh, data: out }
}

export interface FramePng {
  png: Buffer
  width: number
  height: number
}

/** The upright, bounded PNG of a decoded frame. `toRgba` lets the caller
 *  plug in the native converter when it is available. */
export function frameToPng(frame: I420Frame, opts: { maxEdge: number; toRgba?: (f: I420Frame) => RgbaImage }): FramePng {
  const upright = rotateRgba((opts.toRgba ?? i420ToRgba)(frame), frame.rotation ?? 0)
  const fitted = downscaleRgba(upright, opts.maxEdge)
  return { png: encodePng(fitted.data, fitted.width, fitted.height), width: fitted.width, height: fitted.height }
}
