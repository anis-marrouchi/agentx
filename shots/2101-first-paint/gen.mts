// Writes the Hub wall page from a source tree, with a probe at the end of the
// markup (the frame the browser can paint before the page scripts run).
import { writeFileSync } from "node:fs"
const [src, out] = process.argv.slice(2)
const { renderWallPage } = await import(src + "/src/daemon/ui/pages/wall.ts")
const probe = `<script>window.__probe=[];function __snap(at){var c=document.getElementById('wall-compose'),t=document.getElementById('wall-title'),r=c.getBoundingClientRect(),q=t.getBoundingClientRect();window.__probe.push({at:at,cls:document.querySelector('.ax-wall').className,composer:c.offsetParent?{left:Math.round(r.left),width:Math.round(r.width)}:'hidden',title:{left:Math.round(q.left),top:Math.round(q.top)},loading:(function(){var l=document.getElementById('wall-loading');return !!(l&&l.offsetParent)})()})}__snap('end of markup, before page scripts');</script>`
let html = renderWallPage()
const at = html.indexOf("<script>window.AX_WALL_EDITOR")
if (at < 0) throw new Error("no script anchor")
html = html.slice(0, at) + probe + html.slice(at)
writeFileSync(out, html)
