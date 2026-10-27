import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import { readBuildActivity, localDay } from "@/tv/activity"
import { writeBuildEpisode } from "@/tv/episode"
import { checkHost, refuseHere, renderEpisode } from "@/tv/render"
import { showById, SHOWS } from "@/tv/shows"
import { episodeDays, isDay, lineup, saveEpisode, tvRoot } from "@/tv/store"

// --- `agentx tv` — AgentX TV, the Wall as a news channel (#1471) ---
//
// Experimental. `make` writes one episode of a show from today's public
// activity and, with a render server, makes its video; the Wall's TV page
// plays the day's line-up. Without a video, the TV page reads the script
// live in the browser.
//
//   agentx tv make                          script only, from this repo
//   agentx tv make --render-on render-box   + voice and video, on that server
//   agentx tv list                          today's line-up

/** owner/name of this folder's GitHub origin, if it has one. */
function originRepo(): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(url)?.[1]
  } catch {
    return undefined
  }
}

const make = new Command("make")
  .description("make one episode of a show from a day's public activity")
  .option("--show <id>", "the show to make", "the-build")
  .option("--repo <owner/name>", "the public GitHub repository it covers (default: this folder's origin)")
  .option("--day <YYYY-MM-DD>", "the day it covers (default: today)")
  .option("--render-on <host>", "make the voice-over and video on this render server, over SSH")
  .option("--render-here", "make the voice-over and video on this machine (never on a Mac)")
  .action(async (opts) => {
    const fail = (msg: string) => { console.log(chalk.red(`  ${msg}`)); process.exit(1) }
    const show = showById(opts.show)
    if (!show) return fail(`no show "${opts.show}"; shows: ${SHOWS.map((s) => s.id).join(", ")}`)
    if (!show.onAir) return fail(`${show.name} is not on air yet; only ${SHOWS.filter((s) => s.onAir).map((s) => s.id).join(", ")} can be made`)
    const day = opts.day ?? localDay()
    if (!isDay(day)) return fail(`--day wants YYYY-MM-DD, got ${opts.day}`)
    const repo = opts.repo ?? originRepo()
    if (!repo) return fail("no --repo, and this folder has no GitHub origin")
    if (opts.renderOn && opts.renderHere) return fail("pick one of --render-on and --render-here")
    // Checked before GitHub is read, so a bad flag costs nothing.
    try { if (opts.renderOn) checkHost(opts.renderOn) } catch (e: any) { return fail(e.message) }
    if (opts.renderHere && refuseHere()) return fail(refuseHere()!)

    try {
      console.log(chalk.dim(`  reading ${repo} for ${day}…`))
      const activity = await readBuildActivity(repo, day, { token: process.env.GITHUB_TOKEN })
      let ep = writeBuildEpisode(show, activity)
      const dir = saveEpisode(ep)
      console.log(`  ${chalk.green("✓")} ${chalk.bold(ep.title)}: ${ep.screens.length} screens, about ${Math.round(ep.durationSec)}s`)
      console.log(chalk.dim(`    ${dir}`))
      if (opts.renderOn || opts.renderHere) {
        ep = await renderEpisode(dir, ep, { host: opts.renderOn, log: (l) => console.log(chalk.dim(`  ${l}`)) })
        saveEpisode(ep)
        console.log(`  ${chalk.green("✓")} video: ${Math.round(ep.durationSec)}s, made in ${ep.render!.seconds}s on ${ep.render!.host}`)
      } else {
        console.log(chalk.dim("    no video: the TV page reads it live. Add --render-on <host> for the video."))
      }
    } catch (e: any) {
      fail(e?.message ?? String(e))
    }
  })

const list = new Command("list")
  .description("list a day's line-up, and the days that have one")
  .option("--day <YYYY-MM-DD>", "the day (default: today)")
  .option("--json", "print it as JSON")
  .action((opts) => {
    const day = opts.day ?? localDay()
    const eps = lineup(day)
    if (opts.json) { console.log(JSON.stringify({ day, days: episodeDays(), episodes: eps }, null, 2)); return }
    console.log(chalk.bold(`  AgentX TV · ${day}`) + chalk.dim(`  (${tvRoot()})`))
    if (!eps.length) console.log(chalk.dim("    nothing made this day yet: agentx tv make"))
    for (const e of eps) {
      console.log(`    ${e.madeAt.slice(11, 16)}  ${e.title}  ${Math.round(e.durationSec)}s  ${e.video ? chalk.green("video") : chalk.yellow("script only")}`)
    }
    const others = episodeDays().filter((d) => d !== day)
    if (others.length) console.log(chalk.dim(`    other days: ${others.slice(0, 7).join(", ")}`))
  })

export const tv = new Command("tv")
  .description("AgentX TV (experimental): the Wall as a news channel")
  .addCommand(make)
  .addCommand(list)
