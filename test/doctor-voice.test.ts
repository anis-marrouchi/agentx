import { describe, expect, it } from "vitest"
import { daemonVoiceCheck } from "../src/commands/doctor"

// `agentx doctor` reports what the running daemon's /health says about
// ffmpeg: the service's PATH, which is not this shell's (#118, #233).

describe("daemonVoiceCheck", () => {
  it("is ok when the daemon can measure phone recordings", () => {
    expect(daemonVoiceCheck({ canMeasure: true, allowUnmeasured: false })?.severity).toBe("ok")
  })

  it("warns that phone voice input is refused when the daemon has no ffmpeg", () => {
    const c = daemonVoiceCheck({ canMeasure: false, allowUnmeasured: false })
    expect(c?.severity).toBe("warn")
    expect(c?.title).toMatch(/refused/)
    expect(c?.fix).toMatch(/AGENTX_FFMPEG/)
  })

  it("warns that recordings go unmeasured under voice.allowUnmeasured", () => {
    expect(daemonVoiceCheck({ canMeasure: false, allowUnmeasured: true })?.title).toMatch(/unmeasured/)
  })

  it("says nothing for a daemon too old to report it", () => {
    expect(daemonVoiceCheck(undefined)).toBeNull()
    expect(daemonVoiceCheck({})).toBeNull()
  })
})
