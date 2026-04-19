// Public surface for src/daemon/ui — everything a page file or route
// handler needs. Import from here, not from sub-modules, so future
// reorganisations don't ripple through callers.

export { AX_TOKENS_CSS } from "./tokens"
export { AX_COMPONENTS_CSS } from "./components.css"
export { renderShell, type ShellOpts } from "./shell"
export { esc, cx } from "./util"

export {
  dot, badge, btn, stat, statStrip, field, row, card, stepCard, spacer,
  type DotKind, type BadgeKind, type BtnOpts, type StatOpts, type FieldOpts,
  // Settings-page primitives
  pageHead, healthCard, healthStrip, witBanner, sectionHead,
  avatar, pill, rowCard, connector, emptyState, secLabel,
  TOAST_HTML, TOAST_SCRIPT, ROW_CARD_SCRIPT,
  type PageHeadOpts, type HealthCardOpts, type WitOpts, type SectionHeadOpts,
  type AvatarVariant, type PillKind, type RowCardOpts, type ConnectorOpts,
  type EmptyOpts, type SecLabelOpts,
} from "./components"

// Re-export topbar types so pages can describe their own peers.
export type { TopbarPeer, TopbarTab } from "../topbar"
