// --- The Hub's name and address (#1485) ---
//
// The dashboard's home page: each request a post with its thread, and what
// runs on each node. It was called the Wall; owner decision 2026-10-27
// renamed it the Hub, and the name may change again, so every visible use
// reads it from here. Code names (wall.ts, renderWallPage, ax-wall__*) keep
// the old word: people never see them. scripts/hub-name-check.mjs fails CI
// on the old name in visible text and the docs.

/** The name people read: nav, page titles, messages. */
export const HUB_NAME = "Hub"

/** The address that serves the Hub. */
export const HUB_PATH = "/hub"

/** Its old address: every /wall... link redirects (301) to the same
 *  /hub... page, so bookmarks and links in old messages keep working. */
export const OLD_HUB_PATH = "/wall"

/**
 * Where an old Hub address now lives: /wall and /wall/... become /hub and
 * /hub/..., with the query kept (the hash stays in the browser). Null for
 * any other path, /wallet included.
 */
export function hubRedirect(path: string, search = ""): string | null {
  if (path !== OLD_HUB_PATH && !path.startsWith(`${OLD_HUB_PATH}/`)) return null
  return HUB_PATH + path.slice(OLD_HUB_PATH.length) + search
}

/** One request on its own, with its thread (#1316). A push about the
 *  request opens it when tapped (#1652). */
export function hubPostPath(requestId: string): string {
  return `${HUB_PATH}#post=${encodeURIComponent(requestId)}`
}

/** The Hub's Needs you view: what waits on the owner (#1440). /approvals,
 *  the classic page it replaced, redirects (301) here. */
export const HUB_NEEDS_YOU = `${HUB_PATH}#status=open&view=decide`
