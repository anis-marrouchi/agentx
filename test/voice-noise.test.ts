import { describe, it, expect } from "vitest"
import { isNoiseTranscript, NOISE_MARKERS } from "../src/voice/noise"
import { daemonConfigSchema } from "../src/daemon/config"

// #614: a transcript with no words ("[background noise]") started a full
// agent turn. Short real speech ("Yes") must still get through.

describe("isNoiseTranscript", () => {
  it("drops a transcript that is only a noise marker", () => {
    for (const t of ["[background noise]", "[mumbling]", "[babbling]", "(unintelligible)", " [Background Noise]. ", "[BLANK_AUDIO]", "[pause] [mumbling]"]) {
      expect(isNoiseTranscript(t), t).toBe(true)
    }
  })

  it("drops an empty transcript", () => {
    for (const t of ["", "   ", "\n", "...", "?"]) expect(isNoiseTranscript(t), t).toBe(true)
  })

  it("keeps real speech, however short and in any script", () => {
    for (const t of ["Yes", "Stop", "OK。", "是", "Post it, please", "عملت ايه ولا", "2"]) {
      expect(isNoiseTranscript(t), t).toBe(false)
    }
  })

  it("keeps speech that has a marker beside it", () => {
    expect(isNoiseTranscript("[background noise] call Atlas")).toBe(false)
    expect(isNoiseTranscript("Yes (mumbling)")).toBe(false)
  })

  it("keeps a bracketed text that is not on the list", () => {
    expect(isNoiseTranscript("[deploy now]")).toBe(false)
    expect(isNoiseTranscript("[outro jingle]", ["mumbling"])).toBe(false)
  })

  it("takes the marker list from the caller", () => {
    expect(isNoiseTranscript("[door slam]")).toBe(false)
    expect(isNoiseTranscript("[door slam]", ["Door Slam"])).toBe(true)
  })
})

describe("voice.noiseFilter", () => {
  const voice = (v: object = {}) => daemonConfigSchema.parse({ node: { id: "test", name: "test" }, voice: v }).voice

  it("is on by default with the built-in markers", () => {
    expect(voice().noiseFilter).toEqual({ enabled: true, markers: NOISE_MARKERS })
  })

  it("can be switched off or given another list", () => {
    expect(voice({ noiseFilter: { enabled: false } }).noiseFilter.enabled).toBe(false)
    expect(voice({ noiseFilter: { markers: ["door slam"] } }).noiseFilter.markers).toEqual(["door slam"])
  })
})
