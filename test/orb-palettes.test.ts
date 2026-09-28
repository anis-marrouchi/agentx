import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { daemonConfigSchema } from "../src/daemon/config"
import { applyVoiceSettings, checkVoiceSettings, saveVoiceSettings, voiceSettingsView } from "../src/daemon/voice-settings-api"
import { ORB_PALETTES, agentPalette, paletteForColor } from "../src/voice/orb-palettes"

// #211: nature palettes for the voice orb, and the answer card's limits.

const rawConfig = () => ({
  node: { id: "n", name: "n" },
  agents: {
    writer: { name: "Writer", tier: "claude-code", workspace: "/tmp" },
    researcher: { name: "Researcher", tier: "claude-code", workspace: "/tmp", presence: { color: "#2563EB", palette: "forest" } },
  },
})
const config = () => daemonConfigSchema.parse(rawConfig())

describe("orb palettes", () => {
  it("offers at least five nature palettes, each of five #RRGGBB stops", () => {
    expect(ORB_PALETTES.length).toBeGreaterThanOrEqual(5)
    expect(ORB_PALETTES.map((p) => p.id)).toEqual(expect.arrayContaining(["lagoon", "forest", "sunrise", "dusk", "desert"]))
    for (const p of ORB_PALETTES) {
      expect(p.colors).toHaveLength(5)
      for (const c of p.colors) expect(c).toMatch(/^#[0-9A-F]{6}$/)
    }
    expect(new Set(ORB_PALETTES.map((p) => p.id)).size).toBe(ORB_PALETTES.length)
  })

  it("derives the default from the agent colour, nearest by hue", () => {
    // The eight colours presenceLook derives from an agent id.
    expect(paletteForColor("#0D9488").id).toBe("lagoon")
    expect(paletteForColor("#65A30D").id).toBe("forest")
    expect(paletteForColor("#EA580C").id).toBe("sunrise")
    expect(paletteForColor("#7C3AED").id).toBe("dusk")
    expect(paletteForColor("#C026D3").id).toBe("dusk")
    expect(paletteForColor("#DB2777").id).toBe("blossom")
    expect(paletteForColor("#2563EB").id).toBe("ocean")
    expect(paletteForColor("#0891B2").id).toBe("ocean")
    expect(paletteForColor("#C8883E").id).toBe("desert")
    // Hue wraps: a red just below 360° is near sunrise, not blossom.
    expect(paletteForColor("#FF1A0A").id).toBe("sunrise")
  })

  it("falls back to lagoon for grey or a bad colour", () => {
    expect(paletteForColor("#808080").id).toBe("lagoon")
    expect(paletteForColor("teal").id).toBe("lagoon")
  })

  it("a chosen palette wins over the colour; an unknown one is ignored", () => {
    expect(agentPalette("forest", "#DB2777")).toMatchObject({ id: "forest", set: true })
    expect(agentPalette(undefined, "#DB2777")).toMatchObject({ id: "blossom", set: false })
    expect(agentPalette("jungle", "#DB2777")).toMatchObject({ id: "blossom", set: false })
  })

  it("the config schema accepts known palettes only", () => {
    const bad: any = rawConfig()
    bad.agents.writer.presence = { palette: "jungle" }
    expect(daemonConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe("palettes and the card in the settings window", () => {
  it("shows each agent's palette, its default, every palette and the card limits", () => {
    const view = voiceSettingsView(config(), [])
    const writer = view.agents.find((a) => a.id === "writer")!
    const researcher = view.agents.find((a) => a.id === "researcher")!
    expect(writer.palette).toBeUndefined()
    expect(writer.paletteDefault).toBe(paletteForColor(writer.color).id)
    expect(researcher).toMatchObject({ palette: "forest", paletteDefault: "ocean" })
    expect(view.palettes.map((p) => p.id)).toEqual(ORB_PALETTES.map((p) => p.id))
    expect(view.palettes[0].colors).toHaveLength(5)
    expect(view.general.card).toEqual({ timeout: 30, maxHeight: 320 })
  })

  it("refuses an unknown palette and out-of-range card values", () => {
    const errors = checkVoiceSettings({
      agents: { writer: { palette: "jungle" } },
      general: { card: { timeout: -1, maxHeight: 5000 } },
    }, config())
    expect(errors.map((e) => e.path).sort()).toEqual(["agents.writer.palette", "general.card.maxHeight", "general.card.timeout"])
    expect(checkVoiceSettings({ general: { card: { width: 3 } as any } }, config())[0].path).toBe("general.card.width")
    expect(checkVoiceSettings({ general: { card: { timeout: 0, maxHeight: 120 } } }, config())).toEqual([])
  })

  it("writes the palette under presence and clears it back to the default", () => {
    const raw: any = rawConfig()
    applyVoiceSettings(raw, { agents: { writer: { palette: "dusk" }, researcher: { palette: null } } })
    expect(raw.agents.writer.presence).toEqual({ palette: "dusk" })
    expect(raw.agents.researcher.presence).toEqual({ color: "#2563EB" })
    applyVoiceSettings(raw, { agents: { writer: { palette: "" } } })
    expect(raw.agents.writer.presence).toBeUndefined()
  })

  describe("saving", () => {
    let dir: string, path: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "orb-palettes-"))
      path = join(dir, "agentx.json")
      writeFileSync(path, JSON.stringify(rawConfig(), null, 2) + "\n")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it("saves the card and a palette into agentx.json", async () => {
      const res = await saveVoiceSettings({ general: { card: { timeout: 0 } }, agents: { writer: { palette: "desert" } } }, config(), path)
      expect(res).toEqual({ ok: true, path })
      const saved = JSON.parse(readFileSync(path, "utf8"))
      expect(saved.voice.card).toEqual({ timeout: 0 })
      expect(saved.agents.writer.presence.palette).toBe("desert")
      expect(daemonConfigSchema.parse(saved).voice.card).toEqual({ timeout: 0, maxHeight: 320 })
    })
  })
})
