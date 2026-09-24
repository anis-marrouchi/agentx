// --- Cutting streamed text into speakable sentences ---
//
// Speech starts when the first sentence is complete, not when the whole
// reply is: that is most of the latency a listener hears. A sentence ends
// at . ! ? or … followed by whitespace, or at a line break. Short
// abbreviations ("e.g.", "Dr.") would split early; a spoken turn rarely
// has them, and splitting early costs only a slightly odd pause.

const END = /([.!?…]+["')\]]*\s+|\n+)/g

export class SentenceCutter {
  private buf = ""

  /** Feed a text delta; returns the sentences it completed. */
  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    let last = 0
    END.lastIndex = 0
    for (let m = END.exec(this.buf); m; m = END.exec(this.buf)) {
      const s = this.buf.slice(last, m.index + m[1].length).trim()
      if (s) out.push(s)
      last = m.index + m[1].length
    }
    this.buf = this.buf.slice(last)
    return out
  }

  /** Whatever is left once the stream ends. */
  flush(): string[] {
    const s = this.buf.trim()
    this.buf = ""
    return s ? [s] : []
  }
}

/** Make a line fit for speech: no markdown, links, emoji or stage cues. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}
