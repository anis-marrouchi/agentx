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

/** What letting go of Talk means (#687): a press held 400 ms or more is
 *  hold-to-talk, so letting go sends; a shorter one is a tap, which keeps
 *  listening until the next tap. Self-contained: it runs in the browser. */
export function talkRelease(heldMs: number): "send" | "listen" {
  return heldMs >= 400 ? "send" : "listen"
}

/** The Keep watching button's label: "Keep watching 1 min", "Keep watching 45 s". */
export function streamLabel(seconds: number | null | undefined): string {
  const s = Math.max(1, Math.round(seconds || 60))
  return "Keep watching " + (s % 60 === 0 ? s / 60 + " min" : s + " s")
}
