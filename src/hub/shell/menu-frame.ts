// --- Which pages get the one side menu (#2593) ---
//
// Plain data, in the main bundle: App.tsx decides here, and only then loads
// the frame itself (HubMenuFrame.tsx).
import type { HubBoot } from "../boot"
import { SHELL_PAGE } from "../shell"
import { SETTINGS_PAGE } from "../settings/old-sections"

/** The old menu's slot the frame draws into (wall.ts). */
export const MENU_SLOT = "hub-react-menu"

/** Does this page get the frame: the simple layout, a viewer with the shell,
 *  and a page that has no menu of its own (the shell, the new Settings). */
export function wantsMenuFrame(page: string | null, boot: Pick<HubBoot, "pages" | "layout">): boolean {
  if (boot.layout.layout !== "simple" || !boot.pages.includes(SHELL_PAGE)) return false
  return page !== SHELL_PAGE && page !== SETTINGS_PAGE
}
