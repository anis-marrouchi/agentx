import { z } from "zod"

// --- Replies that fit the surface (#2083, PR 1: profiles + surface line) ---
//
//   situations:
//     surfaces:
//       mode: shadow          # off | shadow | active
//       profiles:
//         telegram: { maxChars: 1500 }
//
// A surface profile says how much a person can read (or hear) on one
// surface, and the reply rules the agent is given there. The defaults are
// today's rules, word for word, so moving them here changes no prompt.
//
// `shadow` (the default) builds the surface line on every turn and logs it,
// but does NOT put it in the agent's prompt: it would change the replies
// the trial measures. `active` puts it in. `off` does neither. Profile
// overrides from config are read only in `active`, so in shadow every
// prompt is exactly as before. Switching out of shadow needs Anis's yes.

export type SurfaceId = "telegram" | "whatsapp" | "gitlab" | "discord" | "app" | "app.voice" | "dashboard"

export interface SurfaceProfile {
  /** Readability limit for a whole reply, below any transport limit (the
   *  3900-char Telegram/WhatsApp chunking stays as it is). Unset on
   *  `app.voice`: that one reads voice.spokenMaxChars, the one spoken limit. */
  maxChars?: number
  /** Reply rules the channel layer lists under [Rules]. */
  rules: string[]
  /** The person is listening, not reading. */
  spoken?: boolean
}

/** Today's rules (context.ts buildChannelLayer before #2083), unchanged.
 *  GitLab's non-length rules are here too, so the layer reads one table;
 *  test/surfaces.test.ts pins the text. */
export const DEFAULT_SURFACES: Record<SurfaceId, SurfaceProfile> = {
  telegram: {
    maxChars: 1500,
    rules: [
      "Format responses using Telegram-compatible markdown",
      "Be brief — 2-4 sentences max for the main point. Humans scan, not read",
      "Lead with the action or answer, skip preamble",
    ],
  },
  whatsapp: {
    maxChars: 1000,
    rules: [
      "Be brief — 2-3 sentences max. WhatsApp is mobile-first",
      "No rich formatting — plain text only",
      "Lead with the action or answer, skip preamble",
    ],
  },
  gitlab: {
    maxChars: 3000,
    rules: [
      "Reply as a short, actionable GitLab comment — 3-5 lines for the main message",
      "Do NOT mention Telegram handles — they don't work on GitLab",
      "Do NOT delegate to other agents",
      "Reference issues with #IID and merge requests with !IID",
      "Put verbose details (logs, full commands, step-by-step) inside collapsible sections: <details><summary>Title</summary>\\n\\ncontent\\n</details>",
      "Never narrate what you are about to do — just do it and report the result",
    ],
  },
  discord: {
    maxChars: 1500,
    rules: [
      "Use Discord markdown for formatting",
      "Be brief — 2-4 sentences for the main point",
    ],
  },
  // The app and the dashboard had no rules of their own before; the
  // surface line carries theirs, so these stay empty and nothing changes.
  app: { maxChars: 2000, rules: [] },
  "app.voice": { rules: [], spoken: true },
  dashboard: { maxChars: 6000, rules: [] },
}

const profileOverride = z.object({
  maxChars: z.number().int().min(200).max(20_000).optional(),
  rules: z.array(z.string().min(1).max(400)).max(20).optional(),
})

export const surfacesConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "active"]).default("shadow"),
  profiles: z.record(z.string(), profileOverride).default({}),
}).default({})

export type SurfacesConfig = z.infer<typeof surfacesConfigSchema>

// --- Client hints (untrusted) ---

export type Speaker = "on" | "off"
export type Screen = "phone" | "tablet" | "desktop"
export interface SurfaceHints { speaker?: Speaker; screen?: Screen }

/** Only `on|off` and `phone|tablet|desktop` are kept. Anything else is
 *  dropped, so the `app` profile is used and the raw value never reaches
 *  a prompt or a log (Hakim's suggestion 3). */
export function surfaceHints(raw: { speaker?: unknown; screen?: unknown } | undefined): SurfaceHints {
  const out: SurfaceHints = {}
  if (raw?.speaker === "on" || raw?.speaker === "off") out.speaker = raw.speaker
  if (raw?.screen === "phone" || raw?.screen === "tablet" || raw?.screen === "desktop") out.screen = raw.screen
  return out
}

// --- Picking the profile ---

export interface SurfaceTurn {
  channel: string
  via?: "voice"
  /** Raw from the task context; checked by surfaceHints(). */
  speaker?: unknown
  screen?: unknown
}

export interface SurfacePick {
  id: SurfaceId
  profile: SurfaceProfile
  /** The limit this turn: the profile's, or voice.spokenMaxChars when spoken. */
  maxChars?: number
  via: "spoken" | "typed"
  speaker?: Speaker
  screen?: Screen
}

/** The profile for one turn, or null for a channel with none (a2a, webhook,
 *  voice, …). Spoken with speaker on → `app.voice`; spoken with speaker off
 *  → `app` (they will read it); typed → `app`. An unknown or missing hint
 *  counts as not given. `overrides` are applied only by the caller in
 *  active mode. */
export function pickSurface(turn: SurfaceTurn, opts: { spokenMaxChars: number; overrides?: SurfacesConfig["profiles"] }): SurfacePick | null {
  const hints = surfaceHints(turn)
  const spoken = turn.via === "voice"
  let id: SurfaceId
  if (turn.channel === "app") id = spoken && hints.speaker !== "off" ? "app.voice" : "app"
  else if (turn.channel in DEFAULT_SURFACES) id = turn.channel as SurfaceId
  else return null
  const base = DEFAULT_SURFACES[id]
  const o = opts.overrides?.[id]
  const profile: SurfaceProfile = o ? { ...base, ...(o.maxChars ? { maxChars: o.maxChars } : {}), ...(o.rules ? { rules: o.rules } : {}) } : base
  const maxChars = profile.spoken ? opts.spokenMaxChars : profile.maxChars
  return {
    id, profile, via: spoken ? "spoken" : "typed",
    ...(maxChars ? { maxChars } : {}),
    ...(hints.speaker ? { speaker: hints.speaker } : {}),
    ...(hints.screen ? { screen: hints.screen } : {}),
  }
}

/** The reply rules for a channel: the defaults, or the active overrides. */
export function surfaceRules(channel: string, overrides?: SurfacesConfig["profiles"]): string[] {
  if (!(channel in DEFAULT_SURFACES)) return []
  return overrides?.[channel]?.rules ?? DEFAULT_SURFACES[channel as SurfaceId].rules
}

const SCREEN_WORDS: Record<Screen, string> = { phone: "phone screen", tablet: "tablet screen", desktop: "large screen" }

/** One line for the channel layer, built fresh every turn so a chat that
 *  goes typed → spoken → typed is told each time. Only whitelisted values
 *  go in. Null for a surface with nothing to say. */
export function surfaceLine(pick: SurfacePick | null): string | null {
  if (!pick) return null
  const where = pick.id === "app" || pick.id === "app.voice" ? "phone app" : pick.id
  const parts = [where]
  if (pick.id === "app" || pick.id === "app.voice") parts.push(pick.via)
  if (pick.speaker) parts.push(`speaker ${pick.speaker}`)
  if (pick.screen) parts.push(SCREEN_WORDS[pick.screen])
  const head = `Surface: ${parts.join(", ")}.`
  if (pick.profile.spoken) {
    return `${head} The person is listening. Answer in 2-3 sentences, no lists or charts. For a long result, write a page and say one line about it.`
  }
  const lead = pick.id === "app" && pick.speaker === "on" ? " Start with one line that reads well aloud." : ""
  const charts = pick.screen === "phone" ? " Put charts and wide tables in a page, not inline." : ""
  const limit = pick.maxChars ? ` Keep the reply under ${pick.maxChars} characters; for a longer result, write a page and give a short summary.` : ""
  return `${head}${lead}${limit}${charts}`
}

/** What one dispatch does with the surface (registry.ts): the line, and
 *  whether it goes in the prompt. Shadow: `line` is for the log only and
 *  `prompt` is empty, so the prompt is exactly as before. */
export function surfaceForTurn(
  cfg: SurfacesConfig | undefined,
  turn: SurfaceTurn,
  spokenMaxChars: number,
): { pick: SurfacePick | null; line: string | null; prompt: { surfaceLine?: string; surfaceProfiles?: SurfacesConfig["profiles"] } } {
  const mode = cfg?.mode ?? "shadow"
  if (mode === "off") return { pick: null, line: null, prompt: {} }
  const active = mode === "active"
  const overrides = active ? cfg?.profiles : undefined
  const pick = pickSurface(turn, { spokenMaxChars, overrides })
  const line = surfaceLine(pick)
  return {
    pick, line,
    prompt: active ? { ...(line ? { surfaceLine: line } : {}), ...(overrides && Object.keys(overrides).length ? { surfaceProfiles: overrides } : {}) } : {},
  }
}
