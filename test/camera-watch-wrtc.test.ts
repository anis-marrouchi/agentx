import { afterAll, describe, expect, it } from "vitest"
import { createRequire } from "module"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { WebRtcSignalBroker } from "../src/channels/webrtc-signal"
import { WebRtcBot, nativeI420ToRgba } from "../src/channels/webrtc-bot"
import { CameraWatchManager } from "../src/camera/watch"
import { i420ToRgba } from "../src/camera/frame-image"

// The real thing, end to end, when @roamhq/wrtc is installed: a fake phone
// publishes a video track and only answers, the agent's bot offers through
// the broker, RTCVideoSink delivers frames, the newest one becomes a PNG
// the turn can read, and the folder is gone after the share. Skipped
// where the native module is missing (headless nodes without calls).

let wrtc: any = null
try { wrtc = createRequire(import.meta.url)("@roamhq/wrtc") } catch { /* not installed here */ }

describe.skipIf(!wrtc)("camera watch over WebRTC", () => {
  const dir = wrtc ? mkdtempSync(join(tmpdir(), "agentx-camera-wrtc-")) : ""
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it("frames from the phone reach the agent as a PNG, and nothing is left behind", async () => {
    const broker = new WebRtcSignalBroker("Node-A", [], () => {})
    const callId = "cam-wrtc0001"
    const logs: string[] = []
    const seen: string[] = []

    // The phone (app-camera.client.ts): a video track, answers only.
    const phone = new wrtc.RTCPeerConnection({ iceServers: [] })
    const source = new wrtc.nonstandard.RTCVideoSource()
    phone.addTrack(source.createTrack())
    phone.onicecandidate = (ev: any) => {
      if (!ev.candidate) return
      void broker.handleOutgoing({ kind: "ice", callId, from: "Node-A", to: "bot:writer", candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex } })
    }
    broker.subscribeInternal(callId, "Node-A", (sig) => {
      void (async () => {
        if (sig.kind === "offer") {
          await phone.setRemoteDescription({ type: "offer", sdp: sig.sdp })
          const ans = await phone.createAnswer()
          await phone.setLocalDescription(ans)
          await broker.handleOutgoing({ kind: "answer", callId, from: "Node-A", to: sig.from, sdp: ans.sdp })
        } else if (sig.kind === "ice") {
          await phone.addIceCandidate(sig.candidate)
        }
      })()
    })
    const W = 160, H = 120
    const i420 = new Uint8ClampedArray(W * H * 1.5)
    i420.fill(235, 0, W * H); i420.fill(128, W * H)   // white
    const feed = setInterval(() => source.onFrame({ width: W, height: H, data: i420 }), 50)

    const mgr = new CameraWatchManager({
      config: () => ({ frameIntervalSeconds: 0, maxSessionMinutes: 1, maxFrameEdge: 160, keepFrames: false }),
      startBot: async ({ callId, agentId, onFrame, onClosed }) => {
        const bot = new WebRtcBot({ callId, botName: `bot:${agentId}`, target: "Node-A", iceServers: [], broker, log: (...a) => logs.push(a.join(" ")), onVideoFrame: onFrame, alwaysOffer: true, onClosed })
        await bot.start()
        return { close: (r) => bot.close(r) }
      },
      workspaceOf: () => dir,
      agentName: () => "Writer",
      turn: async ({ message }) => {
        const path = message.split("\n")[1]
        seen.push(path)
        const png = readFileSync(path)
        expect(png.subarray(1, 4).toString()).toBe("PNG")
        return "A white wall."
      },
      toRgba: (f) => {
        const native = nativeI420ToRgba()
        if (!native) return i420ToRgba(f)
        const rgba = { width: f.width, height: f.height, data: new Uint8ClampedArray(f.width * f.height * 4) }
        native(f, rgba)
        return rgba
      },
      log: (m) => logs.push(m),
    })

    try {
      const started = await mgr.start({ callId, agentId: "writer" })
      expect(started.ok).toBe(true)
      // The bot offered (it always does for a camera share) and the phone answered.
      expect(logs.some((l) => /role=caller, offer sent to Node-A/.test(l))).toBe(true)
      const deadline = Date.now() + 15_000
      while ((mgr.get(callId)?.frames ?? 0) < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(mgr.get(callId)?.frames).toBeGreaterThanOrEqual(3)

      const look = await mgr.look(callId, "what colour?")
      expect(look.ok).toBe(true)
      if (!look.ok) return
      expect(look.reply.text).toBe("A white wall.")
      expect(look.frame.width).toBe(160)
      expect(look.frame.height).toBe(120)
      expect(seen).toEqual([look.frame.path])
      expect(existsSync(look.frame.path)).toBe(false)   // keepFrames off

      const snap = mgr.snapshot("writer")
      expect(snap.ok && existsSync(snap.frame.path)).toBe(true)
      mgr.stop(callId, "test over")
      expect(existsSync(join(dir, ".agentx", "camera", callId))).toBe(false)
      expect(logs.some((l) => /closing \(test over\)/.test(l))).toBe(true)
    } finally {
      clearInterval(feed)
      mgr.shutdown()
      phone.close()
      broker.shutdown()
    }
  }, 30_000)
})
