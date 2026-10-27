// --- AgentX TV: channel, shows, settings, segments (#1471) ---
//
// The Wall as a TV news channel. The words, from the owner's refinement:
//   channel  AgentX TV, behind the TV button on the Wall
//   show     one per type of work (The Build, Ops Desk, Decisions…)
//   settings tone, look, presenter, length, segments
//   segment  a fixed part of a show: headlines → main story → waiting for
//            you → sign-off
//   episode  one generated run of a show (episode.ts)
//   line-up  every episode made on one day, back to back
//
// Experimental. Only The Build is on air; the other starters are listed so
// the TV page can show the channel's shape, and say they are not made yet.
// Settings are code, read-only on the page, until the owner has watched
// the prototype and said which ones become real settings.

export type SegmentKind = "headlines" | "main" | "waiting" | "signoff"
export type Tone = "funny" | "serious" | "sports"

export interface ShowSettings {
  tone: Tone
  /** The screens' colour scheme; a key of LOOKS. */
  look: string
  /** Who reads it: a name on the lower third, and the voice that speaks. */
  presenter: { name: string; voice: string }
  /** Target length in seconds. */
  lengthSec: number
  segments: SegmentKind[]
}

export interface Show {
  id: string
  name: string
  /** One line on what the show covers. */
  about: string
  /** Made by the prototype. The others are listed, not made. */
  onAir: boolean
  /** Never shown outside the team, whatever the screen. */
  internalOnly: boolean
  settings: ShowSettings
}

export const SEGMENT_LABEL: Record<SegmentKind, string> = {
  headlines: "Headlines",
  main: "Main story",
  waiting: "Waiting for you",
  signoff: "Sign-off",
}

const SEGMENTS: SegmentKind[] = ["headlines", "main", "waiting", "signoff"]

/** Colours a screen is drawn in. Broadcast screens keep their own look in
 *  both themes, as a TV channel does; the page around them follows the
 *  Wall's theme. */
export const LOOKS: Record<string, { label: string; bg: string; panel: string; ink: string; muted: string; accent: string; ticker: string }> = {
  newsroom: { label: "Newsroom blue", bg: "#07152e", panel: "#0f2550", ink: "#ffffff", muted: "#a9bbdc", accent: "#ffcc00", ticker: "#d7263d" },
  terminal: { label: "Terminal green", bg: "#050a05", panel: "#0d1a0d", ink: "#d8ffd8", muted: "#7fb07f", accent: "#39ff6a", ticker: "#1e6b2e" },
}

export const SHOWS: Show[] = [
  {
    id: "the-build",
    name: "The Build",
    about: "Code: pull requests opened and merged, issues opened and closed.",
    onAir: true,
    internalOnly: false,
    settings: { tone: "funny", look: "newsroom", presenter: { name: "Max Merge", voice: "am_michael" }, lengthSec: 120, segments: SEGMENTS },
  },
  {
    id: "ops-desk",
    name: "Ops Desk",
    about: "Deploys and incidents.",
    onAir: false,
    internalOnly: false,
    settings: { tone: "serious", look: "terminal", presenter: { name: "Dee Ploy", voice: "bf_emma" }, lengthSec: 120, segments: SEGMENTS },
  },
  {
    id: "decisions",
    name: "Decisions",
    about: "What is waiting for the owner.",
    onAir: false,
    internalOnly: true,
    settings: { tone: "serious", look: "newsroom", presenter: { name: "Max Merge", voice: "am_michael" }, lengthSec: 90, segments: SEGMENTS },
  },
  {
    id: "money-minute",
    name: "Money Minute",
    about: "Cost.",
    onAir: false,
    internalOnly: true,
    settings: { tone: "sports", look: "newsroom", presenter: { name: "Penny Count", voice: "af_nova" }, lengthSec: 60, segments: SEGMENTS },
  },
  {
    id: "client-corner",
    name: "Client Corner",
    about: "Client work. Internal only, never public.",
    onAir: false,
    internalOnly: true,
    settings: { tone: "serious", look: "newsroom", presenter: { name: "Max Merge", voice: "am_michael" }, lengthSec: 120, segments: SEGMENTS },
  },
]

export function showById(id: string): Show | undefined {
  return SHOWS.find((s) => s.id === id)
}
