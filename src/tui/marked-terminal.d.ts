// Minimal ambient declaration — marked-terminal ships no types.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked"
  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension
}
