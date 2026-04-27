/** Inline SVG icons — small, crisp, consistent 14px stroke set.
 *  Ported verbatim from the redesign's icons.jsx with TSX typing. */

import type { ReactNode, SVGProps } from "react"

interface SvgProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  children: ReactNode
  size?: number
}

const Svg = ({ children, size = 14, ...rest }: SvgProps) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {children}
  </svg>
)

export const Icon = {
  gitlab:  () => <Svg><path d="M8 14L2 7l1.2-4.5L5 7h6l1.8-4.5L14 7z"/></Svg>,
  clock:   () => <Svg><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></Svg>,
  hook:    () => <Svg><path d="M4 3v4a4 4 0 0 0 4 4h4"/><path d="M10 9l2 2-2 2"/></Svg>,
  play:    () => <Svg><path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/></Svg>,
  box:     () => <Svg><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6h11M6 2.5v11"/></Svg>,
  branch:  () => <Svg><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="4" r="1.5"/><path d="M4 5.5v3a2 2 0 0 0 2 2h4.5"/><path d="M12 5.5v5"/></Svg>,
  stop:    () => <Svg><rect x="3" y="3" width="10" height="10" rx="1"/></Svg>,
  msg:     () => <Svg><path d="M2.5 3.5h11v8h-6l-3 2.5v-2.5h-2z"/></Svg>,
  tag:     () => <Svg><path d="M8 2h5v5l-6 6-5-5z"/><circle cx="10.5" cy="5.5" r={0.8} fill="currentColor"/></Svg>,
  bell:    () => <Svg><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0"/></Svg>,
  globe:   () => <Svg><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/></Svg>,
  search:  () => <Svg><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></Svg>,
  undo:    () => <Svg><path d="M4 7h6a3 3 0 0 1 0 6H7"/><path d="M6.5 4.5L4 7l2.5 2.5"/></Svg>,
  redo:    () => <Svg><path d="M12 7H6a3 3 0 0 0 0 6h3"/><path d="M9.5 4.5L12 7 9.5 9.5"/></Svg>,
  save:    () => <Svg><path d="M3 3h8l2 2v8H3z"/><path d="M5 3v4h6V3M5 13v-4h6v4"/></Svg>,
  run:     () => <Svg><path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/></Svg>,
  stop2:   () => <Svg><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></Svg>,
  sun:     () => <Svg><circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></Svg>,
  moon:    () => <Svg><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/></Svg>,
  plus:    () => <Svg><path d="M8 3v10M3 8h10"/></Svg>,
  trash:   () => <Svg><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 8h6l.5-8"/></Svg>,
  chev:    () => <Svg><path d="M4 6l4 4 4-4"/></Svg>,
  x:       () => <Svg><path d="M4 4l8 8M12 4l-8 8"/></Svg>,
  more:    () => <Svg><circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/></Svg>,
  check:   () => <Svg><path d="M3 8.5l3 3 7-7"/></Svg>,
  warn:    () => <Svg><path d="M8 2l6 11H2z"/><path d="M8 6.5v3M8 11.2v.3"/></Svg>,
  err:     () => <Svg><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.5v.3"/></Svg>,
  zoomin:  () => <Svg><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5M5 7h4M7 5v4"/></Svg>,
  zoomout: () => <Svg><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5M5 7h4"/></Svg>,
  fit:     () => <Svg><path d="M3 5V3h2M13 5V3h-2M3 11v2h2M13 11v2h-2"/><rect x="6" y="6" width="4" height="4" rx={0.5}/></Svg>,
  minus:   () => <Svg><path d="M3 8h10"/></Svg>,
  kbd:     () => <Svg><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 7h.5M6 7h.5M8 7h.5M10 7h.5M4 10h7"/></Svg>,
  lightning: () => <Svg><path d="M9 2L3 9h4l-1 5 6-7H8z" fill="currentColor" fillOpacity={0.2}/></Svg>,
  variable: () => <Svg><path d="M4 3c-2 3-2 7 0 10M12 3c2 3 2 7 0 10"/><path d="M6 7.5h.5l1 1 1-1h.5M6 10l1.5-1.5M9 10l-1.5-1.5"/></Svg>,
  users:   () => <Svg><circle cx="6" cy="6" r="2"/><path d="M2.5 12c.5-2 2-3 3.5-3s3 1 3.5 3"/><circle cx="11" cy="5" r="1.5"/><path d="M10 10.5c.5-1 1.2-1.5 2-1.5 1 0 2 .8 2.3 2"/></Svg>,
  grid:    () => <Svg><rect x="2.5" y="2.5" width="4" height="4"/><rect x="9.5" y="2.5" width="4" height="4"/><rect x="2.5" y="9.5" width="4" height="4"/><rect x="9.5" y="9.5" width="4" height="4"/></Svg>,
  eye:     () => <Svg><path d="M1.5 8C3 5 5.3 3.5 8 3.5S13 5 14.5 8C13 11 10.7 12.5 8 12.5S3 11 1.5 8z"/><circle cx="8" cy="8" r="1.8"/></Svg>,
  slide:   () => <Svg><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M5 6h6M5 8.5h4M5 11h5"/></Svg>,
  gear:    () => <Svg><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></Svg>,
  flag:    () => <Svg><path d="M3 13V3h7l-1 2.5L10 8H3"/></Svg>,
  dup:     () => <Svg><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 9V3h6"/></Svg>,
  layout:  () => <Svg><path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 7h11M7 7v5.5"/></Svg>,
  panelLeft:  () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/><rect x="2.5" y="3.5" width="3.5" height="9" fill="currentColor" fillOpacity={0.18} stroke="none"/></Svg>,
  panelRight: () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/><rect x="10" y="3.5" width="3.5" height="9" fill="currentColor" fillOpacity={0.18} stroke="none"/></Svg>,
}

export type IconName = keyof typeof Icon
