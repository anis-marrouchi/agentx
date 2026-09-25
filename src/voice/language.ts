// --- Which language a spoken line is in: English, French or Arabic ---
//
// An agent may hold one system voice per language, so a French answer is
// read by a French voice. Replies are short and the choice is between
// three very different languages, so a script check and a handful of
// common words are enough; a model would be slower and no more useful.

export type Language = "en" | "fr" | "ar"

const EN = new Set("the and is are was were i you he she we they it this that to of in for with not but yes what have has will would can your my".split(" "))
const FR = new Set("le la les des du de un une et est sont je tu il elle nous vous ils elles ce cette c'est pas pour que qui avec dans sur au aux mais très oui non merci bonjour votre mon".split(" "))
const ACCENT = /[éèêëàâçùûîïôœ]/

/** The line's language, or null when nothing in it says which. */
export function detectLanguage(text: string): Language | null {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length
  const latin = (text.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length
  if (arabic && arabic >= latin) return "ar"
  let en = 0, fr = 0
  for (const w of text.toLowerCase().replace(/[’]/g, "'").match(/[a-zà-ÿœ']+/g) ?? []) {
    if (EN.has(w)) en++
    if (FR.has(w) || w.startsWith("l'") || w.startsWith("d'") || w.startsWith("qu'")) fr++
    else if (ACCENT.test(w)) fr += 0.5
  }
  if (en === fr) return null
  return en > fr ? "en" : "fr"
}
