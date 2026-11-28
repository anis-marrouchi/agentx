// --- One side menu on every Hub page (#2593) ---
//
// The simple layout's side menu (SideMenu.tsx, the approved orca mock) is
// the only menu the owner sees. The shell (#page=home) draws its own; on
// every other page, React or old, this frame draws the same menu into the
// old menu's place (#hub-react-menu inside #wall-nav, wall.ts), and the old
// menu's own rows step aside (`.is-react-menu`, wall.ts). The old frame
// keeps doing what it does well: the column's width and its drag edge, the
// icon rail at 641-1180 px or when folded (`.is-rail`), and the phone Sheet
// (`.is-sheet`); this frame follows those classes and asks the old buttons
// to fold, expand or close.
//
// The new Settings keeps its own menu (#2101 ST1-ST5), as before.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { apiGet } from "../api"
import type { HubBoot } from "../boot"
import { navigate } from "../router"
import { MENU_SLOT } from "./menu-frame"
import { SHELL_PAGE, currentLayout, hubFeedHref, shellItemFor, shellNav } from "../shell"
import { MENU_API, MENU_QUERY_KEY, type MenuReply } from "../settings/menu-model"
import { WAITING_URL, waitingCount, type WaitingReply } from "../waiting"
import { Button, Icon, Tooltip, TooltipContent, TooltipTrigger } from "../ui"
import { SideMenu, SideRail } from "./SideMenu"
import { hubAgentsUrl, idleModel, type HaModel } from "./menu"
import { rowOpens, runHref } from "./latest"

/** The old frame's state, read from `.ax-wall`'s classes (hub-panels.ts). */
type FrameState = "wide" | "rail" | "sheet"
function frameNow(): FrameState {
  const w = document.querySelector(".ax-wall")
  if (!w) return "wide"
  if (w.classList.contains("is-sheet")) return "sheet"
  return w.classList.contains("is-rail") ? "rail" : "wide"
}
function onFrame(cb: () => void): () => void {
  const w = document.querySelector(".ax-wall")
  if (!w || typeof MutationObserver === "undefined") return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(w, { attributes: true, attributeFilter: ["class"] })
  return () => mo.disconnect()
}

/** Press one of the old frame's buttons (fold, open or close the Sheet). */
function press(sel: string): void {
  const b = document.querySelector<HTMLElement>(sel)
  b?.click()
}
const FOLD = '[data-panel-toggle="nav"]'
const SHEET_OPEN = ".hub-rail-open"
const SHEET_CLOSE = "#wall-nav [data-sheet-close]"

function FrameButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label.replace(/ \(⌘B\)$/, "")} data-slot="menu-action" className="size-8" onClick={onClick}>
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The side menu in the old menu's slot, on every page but the shell's. */
export function HubMenuFrame({ boot, hash }: { boot: HubBoot; hash: string }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => { setSlot(document.getElementById(MENU_SLOT)) }, [])
  const frame = useSyncExternalStore(onFrame, frameNow, () => "wide" as FrameState)
  const [kTick, setKTick] = useState(0)
  const view = currentLayout(boot)
  // The same reads, under the same keys, as the shell (ShellPage.tsx): one cache.
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => apiGet<{ id?: string; name?: string }[]>("/api/agents") })
  const rows = useQuery({ queryKey: ["hub-agents"], queryFn: () => apiGet<HaModel>(hubAgentsUrl()), refetchInterval: 5_000 })
  const waiting = useQuery({ queryKey: ["shell-waiting"], queryFn: () => apiGet<WaitingReply>(WAITING_URL), refetchInterval: 15_000 })
  const menu = useQuery({ queryKey: MENU_QUERY_KEY, queryFn: () => apiGet<MenuReply>(MENU_API), enabled: boot.owner })
  if (!slot) return null
  const list = Array.isArray(agents.data) ? agents.data.filter((a) => a && (a.id || a.name)).map((a) => ({ id: String(a.id || a.name), name: String(a.name || a.id) })) : undefined
  const model = rows.data ?? (list ? idleModel(list) : undefined)
  const hubHref = hubFeedHref(boot.pages)
  const current = shellItemFor(hash, shellNav(view, { owner: boot.owner, menu: menu.data, hubHref }))
  // An agent at work opens its live run (#2101 R26); the others open their chat in the shell.
  const onAgent = (id: string) => {
    const row = rows.data?.rows.find((r) => r.id === id)
    if (row && rowOpens(row) === "run") { location.hash = runHref(row); return }
    navigate({ page: SHELL_PAGE, agent: id })
  }
  const props = { view, owner: boot.owner, model, needs: waitingCount(waiting.data), onAgent, menu: menu.data, hubHref, current }
  const body = frame === "rail" ? (
    <SideRail
      {...props}
      onExpand={() => press(innerWidth <= 1180 ? SHEET_OPEN : FOLD)}
      onSearch={() => { press(innerWidth <= 1180 ? SHEET_OPEN : FOLD); setKTick((t) => t + 1) }}
    />
  ) : (
    <SideMenu
      {...props} focusSearch={kTick}
      onDone={frame === "sheet" ? () => press(SHEET_CLOSE) : undefined}
      action={frame === "sheet"
        ? <FrameButton label="Close the menu" icon="x" onClick={() => press(SHEET_CLOSE)} />
        : <FrameButton label="Collapse menu (⌘B)" icon="panel-left" onClick={() => press(FOLD)} />}
    />
  )
  return createPortal(<div className="ax-hub h-full min-h-0" data-shell-frame={frame}>{body}</div>, slot)
}
