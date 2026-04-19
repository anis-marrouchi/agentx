// Shared small utilities for UI renderers.

/**
 * HTML-escape a string so it's safe to interpolate inside attributes or text
 * content. Every page used to ship its own `esc` / `escapeHtml` / `safe` —
 * this is the canonical one.
 */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string))
}

/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}
