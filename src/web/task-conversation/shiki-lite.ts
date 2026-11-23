// --- The `shiki` that @streamdown/code sees, cut to the languages agents write most (#2101 R16) ---
//
// @streamdown/code imports the full `shiki` bundle, which lists every
// grammar shiki has. In one browser IIFE with no code splitting that would
// put all of them in the page. tsup.web.config.ts points that one import
// here instead: the same three names, with a fixed set of languages and the
// two themes the Task page uses. Anything else highlights as plain text.
import { createHighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

type Loader = () => Promise<any>
export const bundledLanguages: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
}

export const bundledLanguagesInfo = [
  // JavaScript reads well with the TypeScript grammar, JSX with TSX: each
  // grammar is ~180 KB, so the two JS ones are left out, and so are HTML
  // and XML, which pull in JavaScript and Java.
  { id: "typescript", aliases: ["ts", "mts", "cts", "javascript", "js", "mjs", "cjs"] },
  { id: "tsx", aliases: ["jsx"] },
  { id: "json", aliases: [] },
  { id: "jsonc", aliases: ["json5"] },
  { id: "yaml", aliases: ["yml"] },
  { id: "shellscript", aliases: ["bash", "sh", "shell", "zsh", "console"] },
  { id: "diff", aliases: ["patch"] },
  { id: "python", aliases: ["py"] },
  { id: "sql", aliases: [] },
  { id: "css", aliases: [] },
  { id: "go", aliases: ["golang"] },
  { id: "rust", aliases: ["rs"] },
  { id: "dockerfile", aliases: ["docker"] },
  { id: "toml", aliases: [] },
]

const themes: Record<string, Loader> = {
  "github-light": () => import("shiki/themes/github-light.mjs"),
  "github-dark": () => import("shiki/themes/github-dark.mjs"),
}

/** shiki's createHighlighter, for the languages and themes above only. */
export async function createHighlighter(opts: { themes: any[]; langs: string[]; engine?: any }) {
  const langs = opts.langs.filter((l) => l in bundledLanguages).map((l) => bundledLanguages[l]().then((m) => m.default))
  const th = opts.themes.map((t) => (typeof t === "string" ? (themes[t] ?? themes["github-light"])().then((m) => m.default) : t))
  return createHighlighterCore({
    themes: await Promise.all(th),
    langs: await Promise.all(langs),
    engine: opts.engine ?? createJavaScriptRegexEngine({ forgiving: true }),
  })
}
