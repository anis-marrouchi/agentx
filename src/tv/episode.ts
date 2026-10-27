// --- One episode of a show: its script, screen by screen ---
//
// An episode is a list of screens. Each screen belongs to a segment, holds
// what is shown (a heading, a few figures, a short list) and what the
// presenter says over it, and has a start and a length in seconds. The
// same episode drives both ways of watching it:
//   - the rendered video (composition.ts → HyperFrames → episode.mp4);
//   - the TV page reading it live, when no video was rendered yet.
//
// Writing is template-based and deterministic: the same day's activity
// always gives the same script, so a replay is the same show. The tone
// picks the phrase bank; the phrase within a bank is picked from the day,
// so two days do not open with the same joke.

import type { BuildActivity, BuildPr } from "./activity"
import { LOOKS, type SegmentKind, type Show, type Tone } from "./shows"

export type Layout = "open" | "headlines" | "story" | "list" | "signoff"

export interface Screen {
  id: string
  segment: SegmentKind
  layout: Layout
  kicker: string
  heading: string
  sub?: string
  /** Figures, shown big: [label, value]. */
  stats?: Array<[string, string]>
  items?: string[]
  /** What the presenter says over this screen. */
  say: string
  start: number
  duration: number
  /** The voice-over file, relative to the episode folder, once rendered. */
  audio?: string
}

export interface Episode {
  id: string
  show: string
  showName: string
  day: string
  madeAt: string
  title: string
  tone: Tone
  look: string
  presenter: string
  voice: string
  /** Where the facts came from; counts only. */
  source: { repo: string; prs: number; issues: number }
  ticker: string[]
  screens: Screen[]
  durationSec: number
  /** Set once rendered: the video's file name in the episode folder. */
  video?: string
  render?: { at: string; host: string; seconds: number }
}

/** Speaking pace for the length estimate, before the real voice is made. */
const WORDS_PER_SEC = 2.6
const MIN_SCREEN = 5
const PAD = 1.2

/** How long a line takes to say, with a breath after it. */
export function speakSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(MIN_SCREEN, Math.round((words / WORDS_PER_SEC + PAD) * 10) / 10)
}

/** "feat(wall): Cost page in the Wall space (#1423)" → "Cost page in the Wall space". */
export function spokenTitle(title: string): string {
  const t = title
    .replace(/^\s*\w+(\([^)]*\))?!?:\s*/, "")
    .replace(/\s*\([^)]*#\d+[^)]*\)/g, "")
    .replace(/\s*#\d+\b/g, "")
    .trim()
  return t ? t[0].toUpperCase() + t.slice(1) : title
}

/** The kind of change, from a conventional-commit prefix. */
function changeKind(title: string): string {
  const m = /^\s*(\w+)/.exec(title)
  const k = m ? m[1].toLowerCase() : ""
  return ({ feat: "a new feature", fix: "a fix", docs: "documentation", chore: "housekeeping", refactor: "a refactor", test: "tests", perf: "a speed-up", ci: "build plumbing" } as Record<string, string>)[k] ?? "a change"
}

function seed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const pick = <T>(list: T[], key: string): T => list[seed(key) % list.length]

const weekday = (day: string) => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long" })
}
const longDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
}
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`
const listSay = (titles: string[]) =>
  titles.length <= 1 ? titles.join("") : titles.slice(0, -1).join("; ") + "; and " + titles.at(-1)

interface Bank {
  hello: string[]
  slow: string[]
  big: Array<(lines: number) => string>
  roundup: string[]
  waiting: string[]
  nothingWaiting: string[]
  bye: string[]
}

const BANKS: Record<Tone, Bank> = {
  funny: {
    hello: [
      "the only news show where the anchor has never once pushed to main",
      "the show that reads the changelog so you don't have to",
      "coming to you live from a very tidy pull request queue",
    ],
    slow: [
      "Nothing merged, nothing opened. Either everyone is on holiday, or the robots have unionised.",
      "A slow news day. The build is green, the coffee is hot, and the bots are suspiciously quiet.",
    ],
    big: [
      (l) => `That's about ${Math.max(1, Math.round(l / 40))} pages of paperback, if paperbacks had semicolons.`,
      (l) => `Stack those ${l} lines end to end and you get one very long scroll, and one very tired reviewer.`,
      (l) => `${l} lines. Somewhere, a code reviewer just felt a disturbance in the force.`,
    ],
    roundup: ["In other news", "Meanwhile, on the merge desk", "Also crossing the finish line"],
    waiting: [
      "They have been very patient. Unlike your anchor.",
      "Give them a look before they start writing poetry in the description.",
    ],
    nothingWaiting: ["Nothing is waiting for you. Enjoy it, it won't last."],
    bye: [
      "Keep your builds green and your merge conflicts small. Good night.",
      "Remember: it works on my machine is not a deployment strategy. Good night.",
    ],
  },
  serious: {
    hello: ["your daily summary of the code that changed"],
    slow: ["No pull requests or issues moved today."],
    big: [(l) => `In total, ${l} lines changed.`],
    roundup: ["Also merged today"],
    waiting: ["They are ready for review."],
    nothingWaiting: ["Nothing is waiting for review."],
    bye: ["That is all for today."],
  },
  sports: {
    hello: ["live from the merge stadium, where every pull request is a final"],
    slow: ["No score today. Both teams are still in the changing room."],
    big: [(l) => `${l} lines! What a strike! The crowd is on its feet!`],
    roundup: ["Elsewhere in the league"],
    waiting: ["They are warming up on the touchline, waiting for the call."],
    nothingWaiting: ["The bench is empty. Everyone is on the pitch."],
    bye: ["What a match. Back to the studio. Good night."],
  },
}

/** Write one episode of The Build from one day's activity. */
export function writeBuildEpisode(show: Show, a: BuildActivity, madeAt = new Date()): Episode {
  const s = show.settings
  const bank = BANKS[s.tone] ?? BANKS.funny
  const key = (slot: string) => `${a.day}:${slot}`
  const merged = a.prs.filter((p) => p.mergedToday)
  const opened = a.prs.filter((p) => p.openedToday)
  const waiting = a.prs.filter((p) => p.open && p.openedToday && !p.draft)
  const issuesOpened = a.issues.filter((i) => i.openedToday)
  const issuesClosed = a.issues.filter((i) => i.closedToday)
  const screens: Omit<Screen, "start" | "duration">[] = []
  const add = (sc: Omit<Screen, "id" | "start" | "duration">) => screens.push({ id: `s${String(screens.length + 1).padStart(2, "0")}`, ...sc })
  const quiet = !merged.length && !opened.length && !a.issues.length

  // Headlines: the open, then the day in figures.
  add({
    segment: "headlines", layout: "open", kicker: show.name.toUpperCase(), heading: show.name, sub: longDate(a.day),
    say: `Good evening, I'm ${s.presenter.name}, and this is ${show.name}: ${pick(bank.hello, key("hello"))}. Here is what shipped on ${weekday(a.day)}.`,
  })
  if (quiet) {
    add({ segment: "headlines", layout: "headlines", kicker: "HEADLINES", heading: "Slow news day", say: pick(bank.slow, key("slow")) })
  } else {
    const top = merged.slice(0, 3).map((p) => spokenTitle(p.title))
    add({
      segment: "headlines", layout: "headlines", kicker: "HEADLINES", heading: "Today in figures",
      stats: [["Merged", String(merged.length)], ["Opened", String(opened.length)], ["Issues in", String(issuesOpened.length)], ["Issues out", String(issuesClosed.length)]],
      items: top,
      say: `Tonight's headlines. ${n(merged.length, "pull request")} merged, ${opened.length} opened, ${n(issuesOpened.length, "issue")} filed and ${issuesClosed.length} closed.` +
        (top.length ? ` Top of the hour: ${listSay(top)}.` : ""),
    })
  }

  // Main story: the biggest merge, then the rest, then the issue desk.
  const main = biggest(merged)
  if (main) {
    const lines = (main.additions ?? 0) + (main.deletions ?? 0)
    const sized = main.additions != null
    add({
      segment: "main", layout: "story", kicker: "MAIN STORY", heading: spokenTitle(main.title), sub: `Pull request #${main.number} · merged`,
      stats: sized ? [["Added", `+${main.additions}`], ["Removed", `−${main.deletions}`], ["Files", String(main.changedFiles)]] : undefined,
      say: `Our main story: ${changeKind(main.title)}. ${spokenTitle(main.title)}, pull request ${main.number}, is in.` +
        (sized ? ` ${main.additions} lines added, ${main.deletions} taken away, across ${n(main.changedFiles ?? 0, "file")}. ${pick(bank.big, key("big"))(lines)}` : ""),
    })
  }
  const rest = merged.filter((p) => p !== main)
  if (rest.length) {
    const said = rest.slice(0, 4).map((p) => spokenTitle(p.title))
    add({
      segment: "main", layout: "list", kicker: "ALSO MERGED", heading: pick(bank.roundup, key("roundup")),
      items: rest.slice(0, 6).map((p) => `#${p.number} ${spokenTitle(p.title)}`),
      say: `${pick(bank.roundup, key("roundup"))}: ${listSay(said)}.` + (rest.length > 4 ? ` Plus ${n(rest.length - 4, "more", "more")}.` : ""),
    })
  }
  if (issuesOpened.length || issuesClosed.length) {
    const said = issuesOpened.slice(0, 3).map((i) => spokenTitle(i.title))
    add({
      segment: "main", layout: "list", kicker: "THE ISSUE DESK", heading: `${n(issuesOpened.length, "issue")} filed, ${issuesClosed.length} closed`,
      items: issuesOpened.slice(0, 6).map((i) => `#${i.number} ${spokenTitle(i.title)}`),
      say: `Over at the issue desk, ${n(issuesOpened.length, "new issue")} and ${issuesClosed.length} closed.` + (said.length ? ` New on the list: ${listSay(said)}.` : ""),
    })
  }

  // Waiting for you: pull requests opened today that nobody merged yet.
  if (!quiet) {
    add({
      segment: "waiting", layout: "list", kicker: "WAITING FOR YOU",
      heading: waiting.length ? `${n(waiting.length, "pull request")} to review` : "All clear",
      items: waiting.slice(0, 6).map((p) => `#${p.number} ${spokenTitle(p.title)}`),
      say: waiting.length
        ? `Waiting for you: ${n(waiting.length, "pull request")} opened today and not merged yet. ${pick(bank.waiting, key("waiting"))}`
        : pick(bank.nothingWaiting, key("nothing")),
    })
  }

  add({
    segment: "signoff", layout: "signoff", kicker: "GOOD NIGHT", heading: show.name, sub: `with ${s.presenter.name}`,
    say: `That's ${show.name} for ${weekday(a.day)}. I'm ${s.presenter.name}. ${pick(bank.bye, key("bye"))}`,
  })

  const timed = retime(screens.map((sc) => ({ ...sc, start: 0, duration: speakSeconds(sc.say) })))
  const ticker = [...merged.map((p) => `MERGED #${p.number} ${spokenTitle(p.title)}`), ...waiting.map((p) => `OPEN #${p.number} ${spokenTitle(p.title)}`), ...issuesOpened.map((i) => `ISSUE #${i.number} ${spokenTitle(i.title)}`)]
  const stamp = madeAt.toISOString().slice(11, 19).replace(/:/g, "")
  return {
    id: `${show.id}-${stamp}`,
    show: show.id,
    showName: show.name,
    day: a.day,
    madeAt: madeAt.toISOString(),
    title: `${show.name}, ${longDate(a.day)}`,
    tone: s.tone,
    look: LOOKS[s.look] ? s.look : "newsroom",
    presenter: s.presenter.name,
    voice: s.presenter.voice,
    source: { repo: a.repo, prs: a.prs.length, issues: a.issues.length },
    ticker: ticker.length ? ticker : [`${show.name.toUpperCase()} · ${longDate(a.day).toUpperCase()}`],
    screens: timed,
    durationSec: total(timed),
  }
}

/** Lay screens end to end. With `voiced`, each screen lasts as long as
 *  its voice-over plus a breath (never shorter than MIN_SCREEN). */
export function retime<T extends { start: number; duration: number }>(screens: T[], voiced?: Array<number | undefined>): T[] {
  let at = 0
  return screens.map((sc, i) => {
    const v = voiced?.[i]
    const duration = v != null ? Math.max(MIN_SCREEN, Math.round((v + PAD) * 10) / 10) : sc.duration
    const out = { ...sc, start: Math.round(at * 10) / 10, duration }
    at += duration
    return out
  })
}

const total = (screens: Array<{ start: number; duration: number }>) => {
  const last = screens.at(-1)
  return last ? Math.round((last.start + last.duration) * 10) / 10 : 0
}

/** The merge that changed the most lines; the newest when sizes are unknown. */
function biggest(merged: BuildPr[]): BuildPr | undefined {
  if (!merged.length) return undefined
  const sized = merged.filter((p) => p.additions != null)
  if (!sized.length) return merged[0]
  return sized.reduce((a, b) => ((b.additions! + b.deletions!) > (a.additions! + a.deletions!) ? b : a))
}
