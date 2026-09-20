// What a paste can become.
//
// Every transform here is DETERMINISTIC code. No model rewrites the text —
// a model only picks which of these to run, and the picking is the whole
// of its job. That split matters for three reasons:
//
//   1. Jev writes no prose. It chooses. A "smart paste" built on a
//      generative rewrite is a different, slower, more expensive product
//      that happens to have a decision model bolted on.
//   2. The clipboard holds passwords, tokens and private messages. Pasting
//      should not ship them to an API, and here only a short preview ever
//      leaves the machine — see previewFor().
//   3. A deterministic transform can be reviewed, tested and undone. A
//      generated one cannot be any of those.
//
// A transform returns null when it does not apply, and an inapplicable
// option is never offered. Same discipline as the ui-element candidate
// set: a model asked to choose from options that cannot work will choose
// one anyway.

export interface Transform {
  id: string
  /** Shown to the model as the criterion for picking this one. */
  criterion: string
  /** Shown to a person, in the widget and the CLI. */
  label: string
  /** The transformed text, or null when this does not apply. */
  apply: (text: string) => string | null
}

/** Tracking parameters worth removing. Deliberately a fixed list rather
 *  than a heuristic: dropping a query parameter that turns out to be load
 *  bearing breaks the link silently, and a link that merely carries a
 *  campaign tag still works. */
const TRACKING = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref_src",
  "ref_url", "s", "si", "spm", "scid", "twclid", "yclid", "_hsenc", "_hsmi",
])

const looksLikeUrl = (t: string) => /^https?:\/\/\S+$/i.test(t.trim())

export const TRANSFORMS: Transform[] = [
  {
    id: "asIs",
    criterion:
      "Paste it unchanged. The text is already in the right shape for where it is going, or it is something whose exact bytes matter — a password, a token, a command, code, an identifier.",
    label: "unchanged",
    apply: (t) => t,
  },
  {
    id: "unwrap",
    criterion:
      "Join lines that were hard-wrapped back into continuous paragraphs, keeping blank lines as paragraph breaks. For text copied out of a PDF, an email or a terminal, where every line ends at a fixed width mid-sentence.",
    label: "unwrap lines",
    apply: (t) => {
      // Only when there is real wrapping to undo: several consecutive
      // lines that end without sentence punctuation.
      const lines = t.split("\n")
      if (lines.length < 3) return null
      let wrapped = 0
      for (let i = 0; i < lines.length - 1; i++) {
        const cur = lines[i].trim(), next = lines[i + 1].trim()
        if (cur.length > 40 && next.length > 0 && !/[.!?:;]$/.test(cur)) wrapped++
      }
      if (wrapped < 2) return null
      return t
        .split(/\n\s*\n/)
        .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean).join(" "))
        .filter(Boolean)
        .join("\n\n")
    },
  },
  {
    id: "bullets",
    criterion:
      "Turn the lines into a markdown bullet list. For several short lines that are plainly separate items, going somewhere that renders markdown.",
    label: "bullet list",
    apply: (t) => {
      const lines = t.split("\n").map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) return null
      // Already a list — nothing to do.
      if (lines.every((l) => /^([-*+]|\d+[.)])\s/.test(l))) return null
      return lines.map((l) => `- ${l}`).join("\n")
    },
  },
  {
    id: "quote",
    criterion:
      "Prefix every line with a markdown blockquote marker. For quoting someone else's words into a document, an issue or a message.",
    label: "blockquote",
    apply: (t) => {
      const lines = t.split("\n")
      if (lines.every((l) => l.startsWith(">") || !l.trim())) return null
      return lines.map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")
    },
  },
  {
    id: "codeFence",
    criterion:
      "Wrap it in a fenced code block. For code, a command, a log line or structured output going somewhere that renders markdown.",
    label: "code block",
    apply: (t) => {
      if (t.trim().startsWith("```")) return null
      return "```\n" + t.replace(/\n+$/, "") + "\n```"
    },
  },
  {
    id: "prettyJson",
    criterion:
      "Re-indent it as readable JSON. Only for text that already parses as JSON.",
    label: "format JSON",
    apply: (t) => {
      const trimmed = t.trim()
      if (!/^[[{]/.test(trimmed)) return null
      try {
        const parsed = JSON.parse(trimmed)
        const out = JSON.stringify(parsed, null, 2)
        return out === trimmed ? null : out
      } catch {
        return null
      }
    },
  },
  {
    id: "cleanUrl",
    criterion:
      "Strip campaign and tracking parameters from the link, keeping the rest of it intact. For a URL copied out of a share sheet, a newsletter or a social post.",
    label: "clean the link",
    apply: (t) => {
      const trimmed = t.trim()
      if (!looksLikeUrl(trimmed)) return null
      try {
        const url = new URL(trimmed)
        let removed = 0
        for (const key of [...url.searchParams.keys()]) {
          if (TRACKING.has(key.toLowerCase())) {
            url.searchParams.delete(key)
            removed++
          }
        }
        if (removed === 0) return null
        // Drop a '?' left behind with nothing after it.
        return url.toString().replace(/\?$/, "")
      } catch {
        return null
      }
    },
  },
  {
    id: "slug",
    criterion:
      "Convert to a lowercase hyphenated slug. For a title or phrase going into a branch name, a filename or a URL path.",
    label: "slug",
    apply: (t) => {
      const trimmed = t.trim()
      if (trimmed.includes("\n") || trimmed.length > 90 || trimmed.length < 3) return null
      const slug = trimmed
        .normalize("NFKD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      return slug && slug !== trimmed ? slug : null
    },
  },
  {
    id: "collapseSpace",
    criterion:
      "Collapse runs of whitespace and trim the ends, leaving one clean line. For text copied out of a web page that arrived padded with stray spaces, tabs and newlines.",
    label: "tidy whitespace",
    apply: (t) => {
      const out = t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim()
      return out === t ? null : out
    },
  },
]

/** The transforms that actually do something to this text. */
export function applicable(text: string): Array<{ transform: Transform; result: string }> {
  const out: Array<{ transform: Transform; result: string }> = []
  for (const transform of TRANSFORMS) {
    const result = transform.apply(text)
    // asIs always applies and is always the fallback; the rest have to earn
    // their place by producing something different from the input.
    if (result === null) continue
    if (transform.id !== "asIs" && result === text) continue
    out.push({ transform, result })
  }
  return out
}

/**
 * What the decision model is allowed to see of the clipboard.
 *
 * The clipboard is the most sensitive buffer on the machine — it is where
 * passwords and tokens are, for the seconds between copy and paste. The
 * seat needs to know the SHAPE of the text to choose a transform, not its
 * contents, so it gets a bounded head and tail and never the middle.
 */
export function previewFor(text: string, budget = 320): string {
  if (text.length <= budget) return text
  const head = Math.floor(budget * 0.7)
  const tail = budget - head
  return `${text.slice(0, head)}\n…[${text.length - budget} more characters]…\n${text.slice(-tail)}`
}

/** True when the text looks like something that must never be altered.
 *
 *  Checked in code, before any model is asked, because "do not mangle my
 *  password" is not a judgement call to delegate. */
export function looksSecret(text: string): boolean {
  const t = text.trim()
  if (t.includes("\n") || t.length > 200) return false
  return (
    /^(sk|pk|ghp|gho|ghs|glpat|xox[abps])[-_][A-Za-z0-9_-]{16,}$/.test(t) ||
    /^[A-Za-z0-9+/]{40,}={0,2}$/.test(t) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(t) ||
    // High-entropy single token with no spaces and mixed classes.
    (t.length >= 20 && !/\s/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) &&
     !/^https?:\/\//i.test(t) && !/\.(com|org|net|io|ai|tn)$/i.test(t))
  )
}
