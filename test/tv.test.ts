import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, writeFileSync } from "fs"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { tmpdir } from "os"
import { join } from "path"
import { readBuildActivity, scrubTitle, type BuildActivity } from "../src/tv/activity"
import { retime, speakSeconds, spokenTitle, writeBuildEpisode } from "../src/tv/episode"
import { compositionHtml } from "../src/tv/composition"
import { checkHost, refuseHere, renderEpisode, renderScript, voiceScript, withVoice, type Exec } from "../src/tv/render"
import { showById, SHOWS } from "../src/tv/shows"
import { episodeDays, episodeDir, lineup, saveEpisode, videoFile } from "../src/tv/store"
import { serveTvVideo, tvLineupReply } from "../src/daemon/wall-tv"
import { renderWallTvPage } from "../src/daemon/ui/pages/wall-tv"
import { TV_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall-tv.client"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// AgentX TV (#1471, experimental): The Build, one show made from one day of
// a public repository, played on the Wall's TV page.

const DAY = "2026-10-27"
const at = (h: number) => new Date(2026, 9, 27, h).toISOString()
const yesterday = new Date(2026, 9, 26, 12).toISOString()
const build = showById("the-build")!

/** A fake GitHub: one public repository and its lists. */
function github(over: { private?: boolean } = {}) {
  const pulls = [
    { number: 12, title: "feat(wall): a TV button (#11)", created_at: at(9), merged_at: at(15), closed_at: at(15), updated_at: at(15), draft: false, user: { login: "someone-real" } },
    { number: 10, title: "fix: pay @someone-real $40 for the logo", created_at: yesterday, merged_at: at(10), closed_at: at(10), updated_at: at(10), draft: false, user: { login: "someone-real" } },
    { number: 13, title: "docs: a guide", created_at: at(11), merged_at: null, closed_at: null, updated_at: at(11), draft: false, user: { login: "someone-real" } },
    { number: 14, title: "wip: draft", created_at: at(12), merged_at: null, closed_at: null, updated_at: at(12), draft: true, user: { login: "someone-real" } },
    { number: 8, title: "old", created_at: yesterday, merged_at: yesterday, closed_at: yesterday, updated_at: yesterday, draft: false, user: { login: "someone-real" } },
  ]
  const issues = [
    { number: 20, title: "Bug: mail me at a@b.co", created_at: at(8), closed_at: null, user: { login: "someone-real" } },
    { number: 21, title: "Old bug", created_at: yesterday, closed_at: at(16), user: { login: "someone-real" } },
    { number: 12, title: "PR in the issues list", created_at: at(9), closed_at: null, pull_request: {}, user: { login: "someone-real" } },
  ]
  const calls: string[] = []
  const fetch = async (url: string) => {
    const path = url.replace("https://api.github.com", "")
    calls.push(path)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (path === "/repos/acme/widgets") return json({ private: over.private ?? false })
    if (path.startsWith("/repos/acme/widgets/pulls?")) return json(pulls)
    if (path.startsWith("/repos/acme/widgets/issues?")) return json(issues)
    const one = /\/pulls\/(\d+)$/.exec(path)
    if (one) return json(one[1] === "12" ? { additions: 400, deletions: 20, changed_files: 6 } : { additions: 3, deletions: 1, changed_files: 1 })
    return new Response("{}", { status: 404 })
  }
  return { fetch: fetch as any, calls }
}

const busy: BuildActivity = {
  repo: "acme/widgets", day: DAY,
  prs: [
    { number: 12, title: "feat(wall): a TV button", openedToday: true, mergedToday: true, open: false, draft: false, additions: 400, deletions: 20, changedFiles: 6 },
    { number: 10, title: "fix: logo", openedToday: false, mergedToday: true, open: false, draft: false, additions: 3, deletions: 1, changedFiles: 1 },
    { number: 13, title: "docs: a guide", openedToday: true, mergedToday: false, open: true, draft: false },
  ],
  issues: [{ number: 20, title: "Bug: it breaks", openedToday: true, closedToday: false, open: true }],
}

describe("The Build's source: one public repository, one day", () => {
  it("cuts people, money and links out of titles", () => {
    expect(scrubTitle("fix: pay @someone-real $40 for the logo")).toBe("fix: pay for the logo")
    expect(scrubTitle("Bug: mail me at a@b.co")).toBe("Bug: mail me at")
    expect(scrubTitle("Costs 30 EUR, see https://x.example/a")).toBe("Costs , see")
    expect(scrubTitle("feat: €4.50 cap (@org/team)")).toBe("feat: cap")
  })

  it("reads the day's pull requests and issues, and never a person", async () => {
    const gh = github()
    const a = await readBuildActivity("acme/widgets", DAY, { fetch: gh.fetch })
    expect(a.prs.map((p) => p.number)).toEqual([14, 13, 12, 10])
    expect(a.prs.find((p) => p.number === 10)).toMatchObject({ openedToday: false, mergedToday: true, title: "fix: pay for the logo" })
    expect(a.prs.find((p) => p.number === 12)).toMatchObject({ additions: 400, deletions: 20, changedFiles: 6 })
    expect(a.issues.map((i) => i.number)).toEqual([21, 20])
    expect(a.issues[0]).toMatchObject({ openedToday: false, closedToday: true, open: false })
    expect(JSON.stringify(a)).not.toContain("someone-real")
  })

  it("refuses a private repository", async () => {
    await expect(readBuildActivity("acme/widgets", DAY, { fetch: github({ private: true }).fetch })).rejects.toThrow("not public")
    await expect(readBuildActivity("not a repo", DAY, { fetch: github().fetch })).rejects.toThrow("owner/name")
  })
})

describe("An episode of The Build", () => {
  it("runs its segments in order: headlines, main story, waiting for you, sign-off", () => {
    const ep = writeBuildEpisode(build, busy, new Date(2026, 9, 27, 18))
    const order = ep.screens.map((s) => s.segment)
    expect(order[0]).toBe("headlines")
    expect(order.at(-1)).toBe("signoff")
    expect(order.indexOf("main")).toBeGreaterThan(order.lastIndexOf("headlines"))
    expect(order.indexOf("waiting")).toBeGreaterThan(order.lastIndexOf("main"))
    expect(ep.screens.find((s) => s.layout === "story")).toMatchObject({ heading: "A TV button", stats: [["Added", "+400"], ["Removed", "−20"], ["Files", "6"]] })
    expect(ep.screens.find((s) => s.segment === "waiting")!.items).toEqual(["#13 A guide"])
    expect(ep.tone).toBe("funny")
    expect(ep.screens[0].say).toContain("I'm Max Merge, and this is The Build")
  })

  it("lays screens end to end, and is the same script when made again", () => {
    const a = writeBuildEpisode(build, busy, new Date(2026, 9, 27, 18))
    const b = writeBuildEpisode(build, busy, new Date(2026, 9, 27, 19))
    expect(a.screens.map((s) => s.say)).toEqual(b.screens.map((s) => s.say))
    a.screens.slice(1).forEach((s, i) => expect(s.start).toBeCloseTo(a.screens[i].start + a.screens[i].duration, 5))
    expect(a.durationSec).toBeGreaterThan(30)
    expect(a.durationSec).toBeLessThan(180)
  })

  it("says it was a slow news day when nothing moved", () => {
    const ep = writeBuildEpisode(build, { repo: "acme/widgets", day: DAY, prs: [], issues: [] })
    expect(ep.screens.map((s) => s.heading)).toEqual(["The Build", "Slow news day", "The Build"])
  })

  it("speaks titles without commit prefixes or references", () => {
    expect(spokenTitle("feat(wall): Cost page in the Wall space (#1423)")).toBe("Cost page in the Wall space")
    expect(spokenTitle("docs: designs round 1 (#1460, #1461)")).toBe("Designs round 1")
    expect(speakSeconds("one two")).toBe(5)
  })

  it("is retimed to the real voice-over", () => {
    const ep = writeBuildEpisode(build, busy)
    const voiced = withVoice(ep, ep.screens.map(() => 10))
    expect(voiced.screens.every((s) => s.duration === 11.2 && s.audio === `vo/${s.id}.wav`)).toBe(true)
    expect(voiced.durationSec).toBeCloseTo(11.2 * ep.screens.length, 5)
    expect(retime([{ start: 9, duration: 2 }, { start: 0, duration: 3 }])).toEqual([{ start: 0, duration: 2 }, { start: 2, duration: 3 }])
  })
})

describe("The episode as a HyperFrames composition", () => {
  it("has one timed clip per screen, voice only where there is one, and a local GSAP", () => {
    const ep = writeBuildEpisode(build, busy)
    const html = compositionHtml(withVoice(ep, ep.screens.map((_, i) => (i === 0 ? 4 : undefined))))
    expect(html).toContain('data-composition-id="root"')
    expect(html).toMatch(/data-duration="[\d.]+" data-width="1920" data-height="1080"/)
    for (const s of ep.screens) expect(html).toContain(`<section id="${s.id}" class="clip"`)
    expect(html.match(/<audio /g)).toHaveLength(1)
    expect(html).toContain('<script src="gsap.min.js"></script>')
    expect(html).not.toContain("cdn.")
    expect(html).toContain('window.__timelines["root"] = tl')
    expect(html).toContain("gsap.timeline({ paused: true })")
  })
})

describe("Where episodes are kept", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-tv-")) })

  it("plays a day's episodes in the order they were made; a video counts once it is on disk", () => {
    const late = { ...writeBuildEpisode(build, busy, new Date(2026, 9, 27, 20)), video: "episode.mp4" }
    const early = writeBuildEpisode(build, busy, new Date(2026, 9, 27, 8))
    saveEpisode(late, root)
    saveEpisode(early, root)
    expect(lineup(DAY, root).map((e) => e.id)).toEqual([early.id, late.id])
    expect(lineup(DAY, root)[1].video).toBeUndefined()
    writeFileSync(join(episodeDir(DAY, late.id, root), "episode.mp4"), "x")
    expect(lineup(DAY, root)[1].video).toBe("episode.mp4")
    expect(videoFile(DAY, late.id, root)).toMatch(/episode\.mp4$/)
    expect(episodeDays(root)).toEqual([DAY])
  })

  it("refuses an address that is not a day and an id", () => {
    expect(() => episodeDir("../x", "a", root)).toThrow()
    expect(() => episodeDir(DAY, "../../etc", root)).toThrow()
    expect(videoFile(DAY, "../x", root)).toBeNull()
    expect(lineup("nope", root)).toEqual([])
  })
})

describe("Making the video, off the Mac", () => {
  it("never renders on a Mac, and only takes a plain SSH host", () => {
    expect(refuseHere("darwin")).toContain("never run on a Mac")
    expect(refuseHere("linux")).toBeNull()
    expect(() => checkHost("-oProxyCommand=x")).toThrow()
    expect(() => checkHost("box; rm -rf /")).toThrow()
    expect(checkHost("me@render-box")).toBe("me@render-box")
  })

  it("pins its tools and fetches GSAP to a file, not a CDN", () => {
    expect(voiceScript("am_michael")).toContain('npx --yes hyperframes@0.8.207')
    expect(voiceScript("am;rm")).toContain('--voice "amrm"')
    expect(renderScript()).toContain("npm pack gsap@3.12.5")
    expect(renderScript()).toContain("render . -o episode.mp4")
  })

  it("refuses here on a Mac before doing anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentx-tv-"))
    const ep = writeBuildEpisode(build, busy)
    const dir = saveEpisode(ep, root)
    await expect(renderEpisode(dir, ep, { platform: "darwin", exec: async () => Buffer.alloc(0) })).rejects.toThrow("Mac")
    expect(existsSync(join(dir, "voice.sh"))).toBe(false)
  })

  it("voices, retimes and renders on the render server over SSH", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentx-tv-"))
    const ep = writeBuildEpisode(build, busy)
    const dir = saveEpisode(ep, root)
    const seen: string[] = []
    const exec: Exec = async (cmd, args) => {
      seen.push(`${cmd} ${args.join(" ")}`)
      const remote = args[1] ?? ""
      // What the server would leave behind for the pull that follows.
      if (cmd === "ssh" && remote.endsWith("voice.sh")) for (const s of ep.screens) writeFileSync(join(dir, "vo", `${s.id}.json`), 'notice\n{"ok":true,"durationSeconds":6}\n')
      if (cmd === "ssh" && remote.endsWith("render.sh")) writeFileSync(join(dir, "episode.mp4"), "video")
      return Buffer.alloc(0)
    }
    const out = await renderEpisode(dir, ep, { host: "render-box", platform: "darwin", exec })
    const ssh = seen.filter((c) => c.startsWith("ssh "))
    expect(ssh[0]).toMatch(/^ssh render-box mkdir -p \.agentx-tv\/2026-10-27\/the-build-\d+ && tar/)
    expect(ssh.some((c) => c.endsWith("voice.sh"))).toBe(true)
    expect(ssh.some((c) => c.endsWith("render.sh"))).toBe(true)
    expect(out.video).toBe("episode.mp4")
    expect(out.render?.host).toBe("render-box")
    expect(out.screens.every((s) => s.duration === 7.2)).toBe(true)
    expect(existsSync(join(dir, "index.html"))).toBe(true)
  })
})

describe("The TV page and its routes", () => {
  let root: string
  let server: Server
  let base = ""
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "agentx-tv-"))
    const ep = { ...writeBuildEpisode(build, busy), video: "episode.mp4" }
    const dir = saveEpisode(ep, root)
    writeFileSync(join(dir, "episode.mp4"), "0123456789")
    server = createServer((req, res) => serveTvVideo(req, res, req.url!, root))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/wall/tv/media/${DAY}/${ep.id}.mp4`
  })
  afterEach(() => server.close())

  it("lists a day's line-up with each video's address", () => {
    const r = tvLineupReply(new URLSearchParams({ day: DAY }), { root, today: DAY }) as any
    expect(r.status).toBe(200)
    expect(r.body.days).toEqual([DAY])
    expect(r.body.episodes[0].videoUrl).toMatch(new RegExp(`^/wall/tv/media/${DAY}/the-build-\\d+\\.mp4$`))
    expect(tvLineupReply(new URLSearchParams({ day: "x" }), { root }).status).toBe(400)
    expect((tvLineupReply(new URLSearchParams({ day: "2026-01-01" }), { root }).body as any).episodes).toEqual([])
  })

  it("serves the video whole or by byte range", async () => {
    const whole = await fetch(base)
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe("0123456789")
    const part = await fetch(base, { headers: { Range: "bytes=2-4" } })
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10")
    expect(await part.text()).toBe("234")
    expect((await fetch(base, { headers: { Range: "bytes=-3" } }).then((r) => r.text()))).toBe("789")
    expect((await fetch(base, { headers: { Range: "bytes=20-" } })).status).toBe(416)
    expect((await fetch(base.replace(/the-build-\d+/, "nope"))).status).toBe(404)
  })

  it("shows every starter show's settings, read-only, with The Build on air", () => {
    const html = renderWallTvPage()
    for (const s of SHOWS) expect(html).toContain(`<b>${s.name}</b>`)
    expect(html).toContain('<details class="tv__show" open>\n  <summary><b>The Build</b> <span class="ax-badge ax-badge--live">On air</span>')
    expect(html).toContain("<dt>Tone</dt><dd>Funny</dd>")
    expect(html).toContain("Headlines → Main story → Waiting for you → Sign-off")
    expect(html).toContain("<b>Client Corner</b> <span class=\"ax-badge\">Not made yet</span> <span class=\"ax-badge ax-badge--warn\">Internal only</span>")
    expect(html).not.toMatch(/<input|<textarea/)
  })

  it("draws screens with the same functions the video is made from, and parses", () => {
    expect(TV_PAGE_SCRIPT).toContain('__axBind("tvScreenHtml"')
    expect(TV_PAGE_SCRIPT).toContain('__axBind("tvChromeHtml"')
    expect(TV_PAGE_SCRIPT).toContain("/api/admin/tv")
    expect(() => new Function(TV_PAGE_SCRIPT)).not.toThrow()
  })

  it("is one press from the Wall's nav", () => {
    expect(renderWallPage()).toContain('data-nav="tv" href="/wall/tv"')
  })
})
