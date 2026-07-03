/** Telegram's hard per-message ceiling (text + captions cap lower, but 4096
 *  is the text limit). */
export const TG_MAX_MESSAGE_CHARS = 4096
/** Chunk target we split at — under TG_MAX_MESSAGE_CHARS so markdown→HTML
 *  expansion (e.g. `**x**`→`<b>x</b>`) can't push a chunk over the hard cap. */
export const TG_CHUNK_CHARS = 3900

export function splitMessageText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" "),
    )
    const cut = splitAt > Math.floor(maxChars * 0.55) ? splitAt + (window[splitAt] === "." ? 1 : 0) : maxChars
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}
