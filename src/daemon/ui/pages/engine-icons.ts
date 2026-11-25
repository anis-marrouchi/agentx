// --- The AI engines' own logos, in their own colours (#2272) ---
//
// One map for every Hub page that shows an engine (an agent's tier:
// claude-code, codex-cli, gemini-cli, opencode, sdk) or a model family
// (anthropic, openai, google, from ltProvider in wall-tree.ts). Anis
// (req-01M8A6K917P220JRN9A49SXC0W, 2026-11-25): the original icons, with
// the original colours.
//
// The marks are the vendors' published ones, as redrawn by
// @lobehub/icons-static-svg 1.106.0 (MIT). Marks the vendor publishes in one
// colour (OpenAI, Anthropic, OpenCode) take the text colour, so they show in
// the light and the dark theme. Orchestrator and anything unknown keep a
// plain circle of our own: no brand.
//
// Functions, not a const map, so they ship to the browser with injectFns
// (../inject.ts): inject engineIconKey and engineIcon together. The output
// is the same for the same input, so a repaint check can compare it; each
// gradient fill names a plain colour to fall back on when its gradient is
// not found.

/** The engine or model family an icon stands for, from a tier or a provider. */
export function engineIconKey(key: string): string {
  const k = String(key || "").toLowerCase()
  if (k === "claude-code" || k === "claude") return "claude-code"
  if (k === "anthropic") return "anthropic-model"
  if (k === "sdk") return "anthropic-api"
  if (k === "codex-cli" || k === "codex") return "codex"
  if (k === "openai") return "openai"
  if (k === "gemini-cli") return "gemini-cli"
  if (k === "google" || k === "gemini") return "gemini"
  if (k === "opencode") return "opencode"
  return "other"
}

/** The icon as inline SVG. `cls` is its class (size it in CSS); `label`,
 *  when given, names it for a screen reader, else it is hidden from one. */
export function engineIcon(key: string, cls?: string, label?: string): string {
  const which = engineIconKey(key)
  const id = "ax-eng-" + which + "-"
  const spark = "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
  const bodies: Record<string, string> = {
    "claude-code": '<path fill="#D97757" fill-rule="evenodd" clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/>',
    "anthropic-model": '<path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    "anthropic-api": '<path fill="currentColor" d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/>',
    codex: '<path fill="#fff" d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"/>' +
      '<path fill="url(#' + id + 'c) #7A9DFF" d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"/>',
    openai: '<path fill="currentColor" fill-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>',
    "gemini-cli": '<path fill="url(#' + id + 'g) #207CFE" d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z"/>' +
      '<path fill="#1E1E2E" fill-rule="evenodd" clip-rule="evenodd" d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z"/>',
    gemini: '<path fill="#3186FF" d="' + spark + '"/><path fill="url(#' + id + 'a) none" d="' + spark + '"/><path fill="url(#' + id + 'b) none" d="' + spark + '"/><path fill="url(#' + id + 'd) none" d="' + spark + '"/>',
    opencode: '<path fill="currentColor" fill-rule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>',
    other: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  }
  const grads = (w: string): string => {
    const id = "ax-eng-" + w + "-"
    const g: Record<string, string> = {
      codex: '<linearGradient id="' + id + 'c" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient>',
      "gemini-cli": '<linearGradient id="' + id + 'g" gradientUnits="userSpaceOnUse" x1="24" x2="0" y1="6.587" y2="16.494"><stop stop-color="#EE4D5D"/><stop offset=".328" stop-color="#B381DD"/><stop offset=".476" stop-color="#207CFE"/></linearGradient>',
      gemini: '<linearGradient id="' + id + 'a" gradientUnits="userSpaceOnUse" x1="7" x2="11" y1="15.5" y2="12"><stop stop-color="#08B962"/><stop offset="1" stop-color="#08B962" stop-opacity="0"/></linearGradient>' +
        '<linearGradient id="' + id + 'b" gradientUnits="userSpaceOnUse" x1="8" x2="11.5" y1="5.5" y2="11"><stop stop-color="#F94543"/><stop offset="1" stop-color="#F94543" stop-opacity="0"/></linearGradient>' +
        '<linearGradient id="' + id + 'd" gradientUnits="userSpaceOnUse" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stop-color="#FABC12"/><stop offset=".46" stop-color="#FABC12" stop-opacity="0"/></linearGradient>',
    }
    return g[w] || ""
  }
  // The gradients (#2276 review C1). Every icon names the same ids, and
  // url(#id) takes the first one in the document; if that one sits in a
  // folded <details>, Chrome may not resolve it and every later icon shows
  // its fallback colour. In a browser they live once in a hidden block at the
  // top of <body>, outside every fold; without a document they stay inline.
  // Either way the output stays the same for the same input.
  const doc = typeof document !== "undefined" ? document : null
  if (doc && doc.body && !doc.getElementById("ax-eng-defs")) {
    const all = ["codex", "gemini-cli", "gemini"].map(grads).join("")
    doc.body.insertAdjacentHTML("afterbegin", '<svg id="ax-eng-defs" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>' + all + "</defs></svg>")
  }
  const defs = !doc && grads(which) ? "<defs>" + grads(which) + "</defs>" : ""
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  const a11y = label ? ' role="img" aria-label="' + esc(label) + '"' : ' aria-hidden="true"'
  return '<svg class="' + esc(cls || "ax-eng") + '" data-engine="' + which + '" viewBox="0 0 24 24" focusable="false"' + a11y + ">" + bodies[which] + defs + "</svg>"
}
