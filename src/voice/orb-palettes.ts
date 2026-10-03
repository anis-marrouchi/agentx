// --- The voice orb's colour palettes, drawn from nature ---
//
// Each agent's orb in AgentX Voice flows through one of these gradients.
// An agent picks one with presence.palette; without one it gets the
// palette whose hue is nearest its own presence.color, so it stays
// recognisable as the same agent as its on-screen pointer; with neither
// it gets the default, voice.palette. The app draws whatever colours the
// daemon sends, so this file is the only list.

export interface OrbPalette {
  id: string
  label: string
  /** Five stops, deep to light. The orb's mesh uses all five; the last
   *  is its bright core. */
  colors: [string, string, string, string, string]
  /** The hue (0–360) an agent colour is matched against. */
  hue: number
}

export const ORB_PALETTES: OrbPalette[] = [
  { id: "sunrise", label: "Sunrise", hue: 18, colors: ["#E8505B", "#F2726F", "#F79A5A", "#FBBF4A", "#FFE3A3"] },
  { id: "desert", label: "Desert", hue: 36, colors: ["#A4492C", "#C8683E", "#D9905E", "#E7B98A", "#F6E3C4"] },
  { id: "forest", label: "Forest", hue: 100, colors: ["#2F5D34", "#4C7D3A", "#6FA046", "#9CC25E", "#D5EBA4"] },
  { id: "lagoon", label: "Lagoon", hue: 172, colors: ["#0B6E73", "#0E9594", "#1FBFB2", "#56DCCB", "#B8F4EA"] },
  { id: "ocean", label: "Ocean", hue: 205, colors: ["#15457E", "#1C6BA8", "#2B93CF", "#5DBBE8", "#BFE6FA"] },
  { id: "dusk", label: "Dusk", hue: 268, colors: ["#2E2A7A", "#5B3E9E", "#8C4FB0", "#C8649E", "#F4A7B9"] },
  { id: "blossom", label: "Blossom", hue: 330, colors: ["#A3245B", "#CF3F78", "#E8699A", "#F49BB8", "#FFD6E0"] },
]

/** What shows the assistant's state in AgentX Voice (voice.look): the
 *  orb, or the character that wears the same palette. */
export const VOICE_LOOKS = ["orb", "character"] as const
export type VoiceLook = (typeof VOICE_LOOKS)[number]

/** How often the character plays a small animation by itself when idle. */
export const VOICE_ANIMATIONS = ["off", "rarely", "sometimes", "often"] as const
export type VoiceAnimations = (typeof VOICE_ANIMATIONS)[number]

export const ORB_PALETTE_IDS = ORB_PALETTES.map((p) => p.id) as [string, ...string[]]

/** #RRGGBB to its hue in degrees, or null when it is grey or not a colour. */
function hueOf(hex: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return null
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (d < 0.04) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/** The palette nearest an agent colour by hue. Grey or invalid: lagoon. */
export function paletteForColor(hex: string): OrbPalette {
  const hue = hueOf(hex)
  if (hue === null) return ORB_PALETTES.find((p) => p.id === "lagoon")!
  let best = ORB_PALETTES[0], bestDistance = 360
  for (const p of ORB_PALETTES) {
    const d = Math.abs(p.hue - hue)
    const distance = Math.min(d, 360 - d)
    if (distance < bestDistance) { best = p; bestDistance = distance }
  }
  return best
}

/** The palette of an agent that chose neither a palette nor a colour,
 *  unless voice.palette names another. */
export const DEFAULT_PALETTE = "lagoon"

/** An agent's palette: the one it chose (presence.palette), else the one
 *  nearest the colour it chose (presence.color), else `fallback`
 *  (voice.palette). `set` says whether it chose the palette itself. */
export function agentPalette(
  presence: { palette?: string; color?: string } | undefined,
  fallback: string = DEFAULT_PALETTE,
): OrbPalette & { set: boolean } {
  const byId = (id?: string) => ORB_PALETTES.find((p) => p.id === id)
  const picked = byId(presence?.palette)
  if (picked) return { ...picked, set: true }
  const color = presence?.color
  const unchosen = color && hueOf(color) !== null ? paletteForColor(color) : byId(fallback) ?? byId(DEFAULT_PALETTE)!
  return { ...unchosen, set: false }
}
