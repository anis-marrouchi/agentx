// --- Settings, the React page (#2101 ST1) ---
//
// The approved mock (shots/2101-settings-mocks, Hakim PASS c7178199065),
// on orca-design recipes §1: a 280 px side menu of five groups with search
// at its top, one pane at a time in a 784 px column, Back to app and Esc.
// On a phone (below 640 px) the menu is its own screen and a pane opens
// over it with a Settings back link.
//
// Address: #page=settings-preview&section=<pane>&row=<row>. Moving between
// panes replaces the address, so Back to app (history.back) leaves Settings
// in one step. Owner only (pages.ts); the APIs refuse anyone else as well.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from "react"
import { readBoot } from "../boot"
import type { HubPageProps } from "../registry"
import { buildHash, parseHash } from "../router"
import { SHELL_PAGE } from "../shell"
import { Button, EmptyState, Icon, Kbd, Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import { SETTINGS_PAGE, oldSettingsHash } from "./address"
import { DisclosureContext } from "./parts"
import { SETTINGS_GROUPS, SETTINGS_PANES, paneDef, type SettingsPaneDef } from "./panes"
import { buildSettingsIndex, searchSettings, type SettingsHit } from "./search"

/** The panes React draws; the rest open on a line to the old Settings. */
const PANES: Record<string, ComponentType> = {
  general: lazy(() => import("./GeneralPane")),
  jobs: lazy(() => import("./JobsPane")),
  approvals: lazy(() => import("./ApprovalsPane")),
  inbox: lazy(() => import("./InboxPane")),
  agent: lazy(() => import("./AgentPane")),
  actions: lazy(() => import("./ActionsPane")),
  menu: lazy(() => import("./MenuPane")),
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? "⌘" : "Ctrl+"

/** Open a pane and row. A pane's own keys (the Agent pane's `agent`) stay
 *  while the pane does. */
function go(section: string | null, row?: string) {
  const now = parseHash(location.hash)
  const keep: Record<string, string> = {}
  if (now.get("section") === section) now.forEach((v, k) => { if (k !== "page" && k !== "section" && k !== "row") keep[k] = v })
  location.replace(buildHash({ page: SETTINGS_PAGE, section, ...keep, row }))
}

/** A row's `open` is one fold id or a comma list (a tab, then its Advanced). */
const openAll = (open: string, setOpen: (id: string, v: boolean) => void) => open.split(",").forEach((id) => setOpen(id.trim(), true))

function leave() {
  if (history.length > 1) { history.back(); return }
  const boot = readBoot()
  location.hash = boot.layout.layout === "simple" && boot.pages.includes(SHELL_PAGE) ? "#page=" + SHELL_PAGE : ""
}

/** A Radix layer (dialog, menu, select, popover) is open: Esc is its own. */
const layerOpen = () => !!document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper]")

export default function SettingsPage({ params }: HubPageProps) {
  const section = params.get("section")
  const row = params.get("row") || ""
  const pane = paneDef(section)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [open, setOpenIds] = useState<Set<string>>(() => new Set())
  const search = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const index = useMemo(() => buildSettingsIndex(), [])
  const hits = useMemo(() => searchSettings(index, query), [index, query])

  const disclosure = useMemo(() => ({
    isOpen: (id: string) => open.has(id),
    setOpen: (id: string, v: boolean) => setOpenIds((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n }),
  }), [open])

  const pick = useCallback((h: SettingsHit) => {
    if (h.open) openAll(h.open, disclosure.setOpen)
    setQuery("")
    go(h.pane, h.row || undefined)
  }, [disclosure])

  // Mod+F jumps to search; Esc clears it, then leaves Settings.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); search.current?.select(); return }
      if (e.key === "Escape" && !e.defaultPrevented && !layerOpen()) {
        if (document.activeElement === search.current && search.current?.value) return
        e.preventDefault(); leave()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // A row in the address: open its fold, scroll to it once it is drawn, and
  // mark it for a moment so the eye finds it.
  useEffect(() => {
    if (!row) { scroll.current?.scrollTo({ top: 0 }); return }
    const def = pane.rows.find((r) => r.id === row)
    if (def?.open) openAll(def.open, disclosure.setOpen)
    let tries = 0
    const t = window.setInterval(() => {
      const el = scroll.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row)}"]`)
      if (!el && ++tries < 40) return
      window.clearInterval(t)
      if (!el) return
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
      el.scrollIntoView({ block: "center", behavior: "auto" })
      el.animate?.([{ backgroundColor: "var(--ax-surface-3)" }, { backgroundColor: "var(--ax-surface-3)", offset: reduce ? 0.99 : 0.4 }, { backgroundColor: "transparent" }], { duration: 1400, easing: "ease-out" })
    }, 50)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, row])

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === "Enter" && hits[active]) { e.preventDefault(); pick(hits[active]) }
    else if (e.key === "Escape" && query) { e.preventDefault(); setQuery("") }
  }

  const Pane = PANES[pane.id]
  // Phone: the menu is the first screen until a section is chosen.
  const phoneMenu = !section

  return (
    <DisclosureContext.Provider value={disclosure}>
      <div data-slot="settings" className="fixed inset-0 z-30 flex bg-background text-foreground">
        <aside
          aria-label="Settings"
          className={cn(
            "flex w-full shrink-0 flex-col border-r border-border bg-muted/40 sm:w-[240px] lg:w-[280px]",
            !phoneMenu && "max-sm:hidden",
          )}
        >
          <div className="flex h-12 shrink-0 items-center border-b border-border px-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-[13px] font-normal text-muted-foreground" onClick={leave}>
                  <Icon name="arrow-left" />Back to app
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back to app <Kbd>Esc</Kbd></TooltipContent>
            </Tooltip>
          </div>
          <div className="relative shrink-0 border-b border-border px-3 py-3">
            <Icon name="search" className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-expanded={!!query}
              aria-controls="st-search-results"
              aria-activedescendant={hits[active] ? "st-hit-" + active : undefined}
              aria-label="Search settings"
              placeholder="Search settings"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0) }}
              onKeyDown={onSearchKey}
              className="h-8 w-full rounded-md border border-input bg-background/60 pl-9 pr-14 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-[13px]"
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); search.current?.focus() }} className="absolute right-5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground">
                <Icon name="x" className="size-3.5" />
              </button>
            ) : (
              <Kbd className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 max-sm:hidden">{MOD}F</Kbd>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
            {query ? <SearchResults hits={hits} active={active} onPick={pick} onHover={setActive} /> : <SettingsNav current={section ? pane.id : ""} fallback={pane.id} />}
          </div>
        </aside>

        <main className={cn("flex min-w-0 flex-1 flex-col", phoneMenu && "max-sm:hidden")}>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-sm sm:px-5">
            <a href={buildHash({ page: SETTINGS_PAGE })} onClick={(e) => { e.preventDefault(); go(null) }} className="flex items-center gap-1 font-normal text-muted-foreground hover:text-foreground sm:hidden">
              <Icon name="chevron-left" />Settings
            </a>
            <span className="text-muted-foreground max-sm:hidden">Settings</span>
            <span aria-hidden="true" className="text-muted-foreground/60 max-sm:hidden">/</span>
            <span aria-current="page" className="font-medium max-sm:hidden">{pane.label}</span>
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label="Close settings" onClick={leave}><Icon name="x" /></Button>
              </TooltipTrigger>
              <TooltipContent>Close settings <Kbd>Esc</Kbd></TooltipContent>
            </Tooltip>
          </div>
          <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div data-pane={pane.id} className="mx-auto flex w-full max-w-[784px] flex-col gap-6 px-4 pb-24 pt-6 sm:px-8">
              {Pane ? (
                <Suspense fallback={<PaneSkeleton />}><Pane /></Suspense>
              ) : (
                <NotBuilt pane={pane} />
              )}
            </div>
          </div>
        </main>
      </div>
    </DisclosureContext.Provider>
  )
}

function SettingsNav({ current, fallback }: { current: string; fallback: string }) {
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-5">
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{g.label}</h2>
          {SETTINGS_PANES.filter((p) => p.group === g.id).map((p) => {
            // On a phone nothing is chosen on the menu screen; wider, the pane shown is.
            const on = p.id === current || (!current && p.id === fallback)
            return (
              <a
                key={p.id}
                href={buildHash({ page: SETTINGS_PAGE, section: p.id })}
                onClick={(e) => { e.preventDefault(); go(p.id) }}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  // The old Hub's tokens make every <a> 600; a menu row says its own weight.
                  on ? "font-medium text-foreground sm:bg-accent" : "font-normal text-foreground/60 hover:bg-foreground/8 hover:text-foreground",
                  !current && on && "max-sm:font-normal max-sm:text-foreground/60",
                )}
              >
                <Icon name={p.icon} />
                <span className="truncate">{p.label}</span>
              </a>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function SearchResults({ hits, active, onPick, onHover }: { hits: SettingsHit[]; active: number; onPick: (h: SettingsHit) => void; onHover: (i: number) => void }) {
  if (!hits.length) return <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No setting matches.</p>
  return (
    <ul id="st-search-results" role="listbox" aria-label="Settings found" className="flex flex-col gap-0.5">
      {hits.map((h, i) => (
        <li
          key={h.pane + "/" + h.row}
          id={"st-hit-" + i}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(h)}
          onMouseMove={() => onHover(i)}
          className={cn("flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2", i === active ? "bg-accent" : "")}
        >
          <span className="text-[13px] text-foreground">{h.label}</span>
          <span className="truncate text-xs text-muted-foreground">{h.row ? h.paneLabel : "Section"}{h.help ? " · " + h.help : ""}</span>
        </li>
      ))}
    </ul>
  )
}

function NotBuilt({ pane }: { pane: SettingsPaneDef }) {
  return (
    <>
      <header className="flex flex-col gap-1.5 border-b border-border/60 pb-5">
        <h2 className="text-2xl font-semibold leading-tight">{pane.label}</h2>
        <p className="text-sm leading-6 text-muted-foreground">{pane.help}</p>
      </header>
      <EmptyState
        title="This section is still on the old Settings page"
        action={<Button asChild variant="outline" size="sm"><a href={oldSettingsHash(pane.oldSection)}>Open it there</a></Button>}
      />
    </>
  )
}

function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-8 w-40" /><Skeleton className="h-4 w-3/4" /><Skeleton className="mt-4 h-40 w-full rounded-xl" />
    </div>
  )
}

