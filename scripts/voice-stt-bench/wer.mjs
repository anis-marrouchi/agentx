// Word error rate for the speech-to-text benchmark.
//
// Both sides are normalised the same way first, so the score measures the
// words and not the punctuation, capitals or spelling variants a
// transcriber is free to choose: lower case, punctuation removed, Arabic
// short vowels removed and the common letter variants folded together
// (أ إ آ → ا, ى → ي, ة → ه).

/** @param {string} text */
export function normalize(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "") // harakat, dagger alef, tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[’‘`]/g, "'")
    .replace(/[\p{P}\p{S}]+/gu, (m) => (m === "'" ? "'" : " "))
    .replace(/(^|\s)'|'(\s|$)/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** Word-level Levenshtein distance divided by the reference length. */
export function wer(reference, hypothesis) {
  const r = normalize(reference)
  const h = normalize(hypothesis)
  if (r.length === 0) return h.length === 0 ? 0 : 1
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[h.length] / r.length
}

/** Pooled WER over several clips: total edits over total reference words. */
export function pooledWer(pairs) {
  let edits = 0
  let words = 0
  for (const { reference, hypothesis } of pairs) {
    const n = normalize(reference).length
    edits += wer(reference, hypothesis) * n
    words += n
  }
  return words ? edits / words : 0
}
