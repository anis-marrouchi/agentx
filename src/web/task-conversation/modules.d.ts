// CSS files imported as strings (via tsup's `loader: { ".css": "text" }`).
// Pure build-time shim — emits no runtime code.
declare module "*.css" {
  const content: string
  export default content
}

// shiki's subpath exports, which this repo's "node" module resolution does
// not read (shiki-lite.ts). Typed loosely; shiki checks its own input.
declare module "shiki/core" { export const createHighlighterCore: (opts: any) => Promise<any> }
declare module "shiki/engine/javascript" { export const createJavaScriptRegexEngine: (opts?: any) => any }
declare module "shiki/langs/*" { const lang: any; export default lang }
declare module "shiki/themes/*" { const theme: any; export default theme }
