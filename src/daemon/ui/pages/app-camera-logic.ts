// Pure helpers for the phone app's Share camera (#325), shipped to the
// browser with injectFns and tested in node.

export interface CameraSettings {
  width: number
  height: number
  frameRate: number
  maxSeconds: number
}

/** getUserMedia constraints: video only, never the microphone. The
 *  fallbacks mirror channels.webrtc.camera's defaults, for a daemon that
 *  predates it. Self-contained: it runs in the browser. */
export function cameraConstraints(s: CameraSettings | null | undefined, facing: string): MediaStreamConstraints {
  const d = { width: 1280, height: 720, frameRate: 15 }
  const c = s || d
  return {
    audio: false,
    video: {
      facingMode: { ideal: facing === "user" ? "user" : "environment" },
      width: { ideal: c.width || d.width },
      height: { ideal: c.height || d.height },
      frameRate: { ideal: c.frameRate || d.frameRate },
    },
  }
}

/** "9:05" for the time the share has left. */
export function shareClock(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ":" + (r < 10 ? "0" : "") + r
}
