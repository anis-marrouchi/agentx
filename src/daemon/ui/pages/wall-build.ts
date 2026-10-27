// --- The running build on the Wall (#1444) ---
//
// One line in the Wall's header, on every Wall view: the daemon's version,
// short commit and since when it runs, read from GET /api/node/build (the
// same read as the classic top bar, topbar.ts wireBuild). When the code on
// disk is newer, a "restart pending" chip joins it under the same rule
// (diskNewer) and with the same hover text; it opens Wall Live, where the
// machines and their restart live.
//
// Shipped to the browser through injectFns, so it is self-contained: it
// escapes on its own. `since` comes formatted from the page (stamp(): the
// owner's local time with its UTC offset, as every time on the Wall).

import { BUILD_TITLE_OK, BUILD_TITLE_STALE } from "../../topbar"

/** What GET /api/node/build answers (headerBuild in topbar.ts). */
export interface WallBuild {
  node?: string | null
  version?: string | null
  commit?: string | null
  startedAt?: string | null
  diskNewer?: boolean
}

/** The hover text, kept with the line so the two views cannot drift. */
export const WALL_BUILD_TITLES = { ok: BUILD_TITLE_OK, stale: BUILD_TITLE_STALE }

/**
 * The header line's HTML and its hover text. `b` is the route's answer;
 * `undefined` while it has not answered yet, `null` when it failed. A
 * build with no version shows nothing, as in the top bar.
 */
export function wallBuildHtml(b: WallBuild | null | undefined, since: string, titles: { ok: string; stale: string }): { html: string; title: string } {
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  if (b === undefined) return { html: "", title: "" }
  if (b === null) return { html: '<span class="ax-wall__buildv">Daemon version: not reachable</span>', title: "The dashboard could not ask the daemon which build it runs. It asks again every minute." }
  if (!b.version) return { html: "", title: "" }
  // A full hash from a deploy tool is cut to seven, as a build from git is.
  const commit = b.commit ? String(b.commit).replace(/^([0-9a-f]{7})[0-9a-f]{33}/i, "$1") : ""
  const title = (b.diskNewer ? titles.stale : titles.ok) + (b.node ? " Node: " + b.node : "")
  const html = '<span class="ax-wall__buildv">' + esc(b.version) + (commit ? " · " + esc(commit) : "") + "</span>" +
    (since ? "<span>since " + esc(since) + "</span>" : "") +
    (b.diskNewer ? '<a class="chip chip--warn" role="status" href="#page=live">restart pending</a>' : "")
  return { html, title }
}
