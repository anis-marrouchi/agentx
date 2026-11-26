// --- Lucide icons for the string-HTML Hub (#2101, orca-design C9) ---
//
// The React Hub draws lucide through src/hub/ui/icons.tsx; the old Hub
// script (wall.ts, hub-nav.ts and their client scripts) writes HTML strings,
// so it gets the same icons here, as strings. One file per icon is imported
// (not the lucide-static index), so the daemon loads only these. Lucide is
// ISC (src/hub/ui/NOTICE.md).
//
// Add a name here before using it; hubIcon() of an unknown name is "".

import ArrowDown from "lucide-static/dist/esm/icons/arrow-down.js"
import ArrowLeft from "lucide-static/dist/esm/icons/arrow-left.js"
import ArrowRight from "lucide-static/dist/esm/icons/arrow-right.js"
import ArrowUp from "lucide-static/dist/esm/icons/arrow-up.js"
import AtSign from "lucide-static/dist/esm/icons/at-sign.js"
import Ban from "lucide-static/dist/esm/icons/ban.js"
import Check from "lucide-static/dist/esm/icons/check.js"
import ChevronDown from "lucide-static/dist/esm/icons/chevron-down.js"
import ChevronRight from "lucide-static/dist/esm/icons/chevron-right.js"
import ChevronsUpDown from "lucide-static/dist/esm/icons/chevrons-up-down.js"
import Circle from "lucide-static/dist/esm/icons/circle.js"
import CircleAlert from "lucide-static/dist/esm/icons/circle-alert.js"
import CircleCheck from "lucide-static/dist/esm/icons/circle-check.js"
import CircleDashed from "lucide-static/dist/esm/icons/circle-dashed.js"
import CircleX from "lucide-static/dist/esm/icons/circle-x.js"
import Clock from "lucide-static/dist/esm/icons/clock.js"
import Ellipsis from "lucide-static/dist/esm/icons/ellipsis.js"
import Folder from "lucide-static/dist/esm/icons/folder.js"
import Hourglass from "lucide-static/dist/esm/icons/hourglass.js"
import Link from "lucide-static/dist/esm/icons/link.js"
import ListFilter from "lucide-static/dist/esm/icons/list-filter.js"
import LoaderCircle from "lucide-static/dist/esm/icons/loader-circle.js"
import MessageCircle from "lucide-static/dist/esm/icons/message-circle.js"
import MessageSquare from "lucide-static/dist/esm/icons/message-square.js"
import Paperclip from "lucide-static/dist/esm/icons/paperclip.js"
import Pause from "lucide-static/dist/esm/icons/pause.js"
import Phone from "lucide-static/dist/esm/icons/phone.js"
import Radio from "lucide-static/dist/esm/icons/radio.js"
import RefreshCw from "lucide-static/dist/esm/icons/refresh-cw.js"
import Repeat2 from "lucide-static/dist/esm/icons/repeat-2.js"
import RotateCcw from "lucide-static/dist/esm/icons/rotate-ccw.js"
import Rows3 from "lucide-static/dist/esm/icons/rows-3.js"
import Search from "lucide-static/dist/esm/icons/search.js"
import Server from "lucide-static/dist/esm/icons/server.js"
import SlidersHorizontal from "lucide-static/dist/esm/icons/sliders-horizontal.js"
import Square from "lucide-static/dist/esm/icons/square.js"
import Table from "lucide-static/dist/esm/icons/table.js"
import Timer from "lucide-static/dist/esm/icons/timer.js"
import TriangleAlert from "lucide-static/dist/esm/icons/triangle-alert.js"
import X from "lucide-static/dist/esm/icons/x.js"

const SVG: Record<string, string> = {
  "arrow-down": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  "at-sign": AtSign,
  "ban": Ban,
  "check": Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevrons-up-down": ChevronsUpDown,
  "circle": Circle,
  "circle-alert": CircleAlert,
  "circle-check": CircleCheck,
  "circle-dashed": CircleDashed,
  "circle-x": CircleX,
  "clock": Clock,
  "ellipsis": Ellipsis,
  "folder": Folder,
  "hourglass": Hourglass,
  "link": Link,
  "list-filter": ListFilter,
  "loader-circle": LoaderCircle,
  "message-circle": MessageCircle,
  "message-square": MessageSquare,
  "paperclip": Paperclip,
  "pause": Pause,
  "phone": Phone,
  "radio": Radio,
  "refresh-cw": RefreshCw,
  "repeat-2": Repeat2,
  "rotate-ccw": RotateCcw,
  "rows-3": Rows3,
  "search": Search,
  "server": Server,
  "sliders-horizontal": SlidersHorizontal,
  "square": Square,
  "table": Table,
  "timer": Timer,
  "triangle-alert": TriangleAlert,
  "x": X,
}

/** The icon names this file carries. */
export const HUB_ICON_NAMES: readonly string[] = Object.keys(SVG)

/** One icon as an SVG string: hidden from screen readers (the control
 *  around it carries the name), `size` px square (16 = size-4; 14 =
 *  size-3.5 in dense rows), colour from the text, and `cls` added to its
 *  class. "" for a name not listed above. */
export function hubIcon(name: string, cls = "", size = 16): string {
  const svg = SVG[name]
  if (!svg) return ""
  return svg.replace(/\s+/g, " ").replace(/> </g, "><").trim()
    .replace(/ width="24" height="24"/, ` width="${size}" height="${size}"`)
    .replace(/class="lucide ([^"]*)"/, (_m, c: string) => `class="lucide ${c}${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"`)
}

/** Several icons by name, for a browser script that cannot import:
 *  `var IC = ${JSON.stringify(hubIconMap([...]))}`. */
export function hubIconMap(names: readonly string[], size = 16): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of names) out[n] = hubIcon(n, "", size)
  return out
}
