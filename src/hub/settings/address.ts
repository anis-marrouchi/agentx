// --- Settings: its address (#2101 ST1) ---
//
// Until all 13 panes are built (ST4), React Settings answers on a review id,
// `#page=settings-preview`, and the old Settings stays `#page=settings`.
// ST4 changes SETTINGS_PAGE to "settings"; nothing else names the id.
import { buildHash } from "../router"

export const SETTINGS_PAGE = "settings-preview"

/** `#page=settings-preview&section=<pane>&row=<row>`; `section` is the old
 *  Settings' key, so links read the same on both. */
export function settingsHash(section?: string, row?: string): string {
  return buildHash({ page: SETTINGS_PAGE, section, row })
}

/** The old Settings' section, for panes React does not draw yet. */
export function oldSettingsHash(section: string): string {
  return buildHash({ page: "settings", section })
}
