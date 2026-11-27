// Lucide's chevron-right (ISC), turned down when open: the one fold icon
// (orca-design C9: no ▸/▾ glyphs standing in for icons).
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="axc-tool__chev" data-open={open} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
