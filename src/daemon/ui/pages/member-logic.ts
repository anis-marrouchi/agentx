// --- Pure logic of a teammate's work page (/member) (#489) ---
//
// Sent to the browser with injectFns (member.ts) and tested directly in
// test/member-page.test.ts. Each function stands alone: it is shipped as
// its own source, so it cannot call a sibling.

/** What the strip under the title says, or null when the last load
 *  worked, whatever the browser says about its network (#496). "Offline"
 *  only when the browser itself has no network; a load that fails with
 *  the network up is the server not answering. `loaded`: the lists were
 *  filled at least once, so there is something to show. */
export function connectionNote(failed: boolean, browserOnline: boolean, retrySeconds: number, loaded: boolean): { text: string; retry: boolean } | null {
  if (!failed) return null
  if (!browserOnline) return { text: "Offline. Showing what was last loaded; live state needs a connection.", retry: false }
  return { text: "Can't reach the server. " + (loaded ? "Showing what was last loaded. " : "") + "Trying again every " + retrySeconds + " seconds.", retry: true }
}

/** A message preview as one plain sentence: markdown marks removed, line
 *  breaks folded. A preview is the first 200 characters of the message, so
 *  a mark can be cut in half. Underscores are left alone: in a team's
 *  messages they are far more often part of a name than emphasis. */
export function plainPreview(text: string | null | undefined): string {
  return String(text == null ? "" : text)
    .replace(/```[\w-]*|`/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/\*\*|~~/g, "")
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
}
