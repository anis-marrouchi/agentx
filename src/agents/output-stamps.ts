// --- When each line of a run's live output arrived (#2306) ---
//
// A run's output is one text buffer (registry.ts TaskOutput), written one
// event line at a time (makeStreamEventFormatter). The Task page shows the
// time of every step, so the buffer keeps a short list beside it: for each
// chunk that starts a new line, its offset in the buffer and the time it
// came in. A step's time is the time of the line that starts it.
//
// Pure and standalone (no imports, no closures): the daemon, the Task
// page's script (injectFns) and its React island all use the same three.

/** [offset in the buffer, epoch ms]. Offsets only go up. */
export type OutStamp = [number, number]

/** Note `chunk`, about to be added to `buffer`, at the first line it
 *  starts: the buffer's end when that is a line start, else just after the
 *  chunk's first newline. Every later line of the chunk came in at the
 *  same time, so one stamp covers them. */
export function outStamp(stamps: OutStamp[], buffer: string, chunk: string, at: number): void {
  let offset = buffer.length
  if (buffer && buffer.charAt(buffer.length - 1) !== "\n") {
    const nl = chunk.indexOf("\n")
    if (nl < 0 || nl === chunk.length - 1) return
    offset += nl + 1
  }
  const last = stamps[stamps.length - 1]
  if (last && last[0] >= offset) return
  stamps.push([offset, at])
}

/** The stamps once the buffer's first `cut` characters were dropped: the
 *  stamp in force at the cut moves to offset 0. */
export function outStampTrim(stamps: OutStamp[], cut: number): OutStamp[] {
  const out: OutStamp[] = []
  let carry: OutStamp | null = null
  for (const s of stamps) {
    if (s[0] <= cut) carry = s
    else out.push([s[0] - cut, s[1]])
  }
  if (carry && (!out.length || out[0][0] > 0)) out.unshift([0, carry[1]])
  return out
}

/** The time the text at `offset` came in; 0 when no stamp covers it. */
export function outStampAt(stamps: OutStamp[] | null | undefined, offset: number): number {
  let at = 0
  for (const s of stamps || []) {
    if (s[0] > offset) break
    at = s[1]
  }
  return at
}
