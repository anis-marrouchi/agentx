// Settings › Menu: the rows the pane draws, the one source search reads
// (panes.ts, condition 1). The layout switches come from src/hub/layout.ts,
// so a switch added there is a row here and in search at once.
import { HUB_SWITCH_ITEMS } from "../../layout"
import type { SettingsRowDef } from "../panes"

export const MENU_ADVANCED = "menu-advanced"

export const MENU_ROWS: readonly SettingsRowDef[] = [
  { id: "reset", label: "Reset to preset", help: "Solo builder, Team / agency, Business automation, Everything or Blank", words: "preset default start again solo team business automation everything blank" },
  { id: "items", label: "Menu items", help: "Drag a row, or focus it and press Alt+↑ or Alt+↓. Click a name to rename it.", words: "side menu sidebar nav order reorder move rename hide group pin link saved view" },
  { id: "add-item", label: "Add to the menu", help: "A page from More, a saved view, a link or a group header", words: "add new page view link pin group header" },
  { id: "bar", label: "Phone bar", help: "Up to four pages or views at the bottom of the phone", words: "phone mobile bottom bar tab four" },
  { id: "more", label: "In More", help: "Pages not in the menu. Still one tap away in More.", words: "hidden pages more show add back" },
  { id: "from", label: "Started from", help: "The preset this menu was built from. Reset starts again from any preset.", words: "preset", open: MENU_ADVANCED },
  { id: "layout", label: "Layout", help: "Simple shows agents, chat, Waiting on you, Jobs and Settings. Full shows everything.", words: "simple full layout", open: MENU_ADVANCED },
  ...HUB_SWITCH_ITEMS.map((i) => ({ id: "show-" + i.id, label: i.label, help: i.hint, words: "show hide layout " + i.id, open: MENU_ADVANCED })),
  { id: "reset-layout", label: "Reset layout", help: "Menu and panel widths, collapsed panels and folded sections go back to how they start, in this browser.", words: "widths folds collapsed panels", open: MENU_ADVANCED },
]
