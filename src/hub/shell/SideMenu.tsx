// --- The simple shell's side menu, icon rail and phone Sheet (#2101) ---
//
// The approved orca side-menu mock, as the old Hub draws it since #2388
// (hub-nav.ts, hub-agents.ts), for the React shell (#2226 S3):
//
//   AgentX Hub · Collapse          the header; on a phone, the Sheet's X
//   Search agents and pages ⌘K     narrows the menu; Enter opens the first
//   AGENTS                         one list, grouped by state: Needs you,
//                                  Working, Done today, Not working today;
//                                  each group folds from its header with its
//                                  count, live ones show 3 then Show all (N)
//   WORKSPACE                      the shell's items (shell.ts), Waiting on
//                                  you with its count; More under it
//   Settings · Light / dark        pinned at the foot; Light / dark on a
//                                  phone only (it has no status bar)
//
// At 641-1180 px, and when folded on a computer, the menu is a 56 px icon
// rail that still lists every agent (SideRail). At 640 px and below, a top
// bar opens the same menu as a left Sheet (ShellPage.tsx).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import type { HubLayoutView } from "../layout"
import { shellNav, type ShellNavItem } from "../shell"
import { shortAgo, type ShellPane, type TasksView } from "../tasks"
import { TasksViewSwitch } from "../pages/ShellTasks"
import { AfCount, AfSkeletonRows, Icon, Kbd, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import {
  STATE_ICON, downWords, firstHit, haStateWord, menuGroups, menuRows, readMenuFolds, rowLine, rowStats, saveMenuFolds,
  type HaModel, type HaOpen, type HaRow, type MenuGroup,
} from "./menu"

/** The menu item each centre pane belongs to. */
const PANE_OF: Record<string, ShellPane> = { tasks: "tasks", automations: "automations", needs: "waiting" }

const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
/** A Workspace row. The old Hub's CSS sets `a { font-weight: 600 }`: rows say their weight. */
const itemCls = "flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13.5px] font-normal pointer-coarse:h-11 cursor-pointer " + ring
const itemIdle = "text-(--ax-text-2) hover:bg-(--ax-surface-2) hover:text-foreground"
const itemOn = "bg-accent font-medium text-foreground"

export interface SideMenuProps {
  view: HubLayoutView
  owner: boolean
  /** The agent rows (/api/admin/hub/agents); undefined while loading. */
  model?: HaModel
  /** How many things wait on the owner (Waiting on you's count). */
  needs?: number
  agent?: string
  onAgent?: (id: string) => void
  /** Called after a pick, so the phone sheet closes. */
  onDone?: () => void
  /** What the centre shows; its item is marked in the menu when open. */
  pane?: ShellPane
  /** List or Kanban, switched at the foot of the menu while Tasks is open. */
  tasksView?: TasksView
  onTasksView?: (v: TasksView) => void
  /** The header's button: Collapse on a computer. The Sheet brings its own X. */
  action?: ReactNode
  /** Bumped by ⌘K: each new value puts the cursor in the search box. */
  focusSearch?: number
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-[.06em] text-muted-foreground">{children}</p>
}

function MenuLink({ item, onOpen, active, count }: { item: ShellNavItem; onOpen?: () => void; active?: boolean; count?: number }) {
  return (
    <a href={item.href} data-shell-item={item.id} onClick={onOpen} aria-current={active ? "page" : undefined} className={cn(itemCls, active ? itemOn : itemIdle)}>
      <Icon name={item.icon} />
      <span className="flex-1 truncate">{item.label}</span>
      {count ? <AfCount n={count} tone="warn" label={count + (count === 1 ? " thing waits" : " things wait") + " on you"} /> : null}
    </a>
  )
}

/** A state's lucide icon, coloured for the state only (orca-design C6). */
export function StateIcon({ state, className }: { state: HaRow["state"]; className?: string }) {
  return (
    <Icon
      name={STATE_ICON[state]}
      className={cn("size-3.5", {
        needs: "text-warn-ink", failed: "text-err-ink", done: "text-ok-ink", idle: "text-muted-foreground opacity-60",
        working: "text-(--ax-text-2) animate-spin [animation-duration:1s] motion-reduce:animate-none",
      }[state], className)}
    />
  )
}

/** An agent's face, as the old Hub draws it (#2388 .ha__face): its
 *  initials on a neutral square, the state icon at its corner on the rail. */
export function AgentFace({ r, rail }: { r: HaRow; rail?: boolean }) {
  return (
    <span
      aria-hidden="true" data-slot="agent-face"
      className={cn(
        "relative grid shrink-0 place-items-center rounded-sm border border-border bg-card font-semibold tracking-[.02em] text-(--ax-text-2)",
        rail ? "size-8 text-[11px]" : "size-7 text-[10.5px]",
      )}
    >
      {r.face}
      {rail ? <span className="absolute -right-1 -bottom-1 rounded-full bg-background p-px"><StateIcon state={r.state} className="size-3" /></span> : null}
    </span>
  )
}

/** One agent: its face, name, numbers and age, then the state icon and
 *  what it is doing. Selecting it opens its chat in the centre. */
function AgentRow({ r, current, onPick }: { r: HaRow; current: boolean; onPick: () => void }) {
  const word = haStateWord(r.state)
  const stats = rowStats(r)
  return (
    <div data-slot="menu-agent" data-state={r.state} className={cn("flex min-h-11 items-center rounded-sm pointer-coarse:min-h-12", current ? "bg-accent" : "hover:bg-(--ax-surface-2)")}>
      <button type="button" data-shell-agent={r.id} aria-pressed={current} onClick={onPick} className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left font-normal cursor-pointer", ring)}>
        <AgentFace r={r} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{r.name}</span>
            {stats ? (
              <span className="inline-flex shrink-0 items-center gap-[7px] text-[11px] tabular-nums text-muted-foreground max-[640px]:hidden" title={stats}>
                {r.runs ? <span className="inline-flex items-center gap-0.5"><Icon name="activity" className="size-3" />{r.runs}</span> : null}
                {r.today ? <span className="inline-flex items-center gap-0.5"><Icon name="history" className="size-3" />{r.today}</span> : null}
                <span className="sr-only">{stats}</span>
              </span>
            ) : null}
            {r.ageMs >= 0 ? (
              <time dateTime={r.at ? new Date(r.at).toISOString() : undefined} title={r.at ? new Date(r.at).toLocaleString() : undefined} className="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                {shortAgo(Date.now() - r.ageMs)}
              </time>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-(--ax-text-2)">
            <StateIcon state={r.state} />
            <span className="truncate">{rowLine(r, word)}</span>
          </span>
        </span>
        <span className="sr-only"> ({word})</span>
      </button>
      {r.unread ? <span className="mr-2 shrink-0"><AfCount n={r.unread} tone="warn" label={r.unread + (r.unread === 1 ? " question" : " questions") + " for you"} /></span> : null}
    </div>
  )
}

/** A group: chevron, title and count, then its rows and Show all (N). */
function AgentGroup({ g, agent, onPick, onFold, onMore }: { g: MenuGroup; agent?: string; onPick: (id: string) => void; onFold: () => void; onMore: () => void }) {
  return (
    <section data-shell-group={g.id} aria-label={g.label}>
      <button type="button" aria-expanded={g.open} onClick={onFold} className={cn("mt-1.5 mb-0.5 flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-[13px] font-medium text-foreground hover:bg-(--ax-surface-2) cursor-pointer", ring)}>
        <Icon name="chevron-right" className={cn("size-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", g.open && "rotate-90")} />
        <span className="flex-1">{g.label}</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">{g.total}</span>
      </button>
      {g.open ? (
        <>
          {g.rows.map((r) => <AgentRow key={r.id} r={r} current={r.id === agent} onPick={() => onPick(r.id)} />)}
          {g.more ? (
            <button type="button" aria-expanded={!g.capped} onClick={onMore} className={cn("mb-1 block w-full rounded-sm py-1 pr-2 pl-[46px] text-left text-[12.5px] text-muted-foreground hover:bg-(--ax-surface-2) hover:text-foreground cursor-pointer", ring)}>
              {g.capped ? `Show all (${g.total})` : "Show fewer"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function flipTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"
  document.documentElement.setAttribute("data-theme", next)
  try { localStorage.setItem("ax-theme", next) } catch { /* private window */ }
}

/** The full side menu: header, search, the agents by state, Workspace,
 *  More (the items switched on in Settings › Layout) and the foot. */
export function SideMenu({ view, owner, model, needs, agent, onAgent, onDone, pane = "chat", tasksView = "list", onTasksView, action, focusSearch }: SideMenuProps) {
  const [q, setQ] = useState("")
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focusSearch) { box.current?.focus(); box.current?.select() } }, [focusSearch])
  const [folds, setFolds] = useState<HaOpen>(() => readMenuFolds())
  const setFold = (k: keyof HaOpen, v: boolean) => setFolds((o) => { const n = { ...o, [k]: v }; saveMenuFolds(n); return n })
  const nav = shellNav(view, { owner })
  const needle = q.trim().toLowerCase()
  const hit = (label: string) => !needle || label.toLowerCase().includes(needle)
  const groups = model ? menuGroups(model, folds, needle) : []
  // Search is the box; Agents is the list above Workspace.
  const workspace = nav.main.filter((i) => i.id !== "search" && i.id !== "agents" && hit(i.label))
  const more = nav.more.filter((i) => hit(i.label))
  const pick = (id: string) => { onAgent?.(id); onDone?.() }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); return }
    if (e.key !== "Enter") return
    e.preventDefault()
    const hit = firstHit(onAgent ? groups : [], [...workspace, ...more])
    if (!hit) return
    if ("agent" in hit) { pick(hit.agent); return }
    location.href = hit.href
    onDone?.()
  }
  const down = downWords(model?.down)
  return (
    <nav aria-label="Side menu" data-shell="menu" className="flex h-full min-h-0 flex-col px-4 pt-3 pb-0">
      <div className="mb-2 flex min-h-9 items-center gap-1 pr-10 has-[[data-slot=menu-action]]:pr-0">
        <a href="/hub" className="flex-1 px-1.5 text-base font-semibold tracking-[-.01em] text-foreground">
          AgentX<small className="ml-1 text-[13px] font-normal text-muted-foreground">Hub</small>
        </a>
        {action}
      </div>
      <label data-shell-item="search" className="mb-3 flex h-8 shrink-0 items-center gap-2 rounded-sm border border-border bg-background pr-1.5 pl-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
        <Icon name="search" />
        <input
          ref={box} type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
          placeholder="Search agents and pages" aria-label="Search agents and pages"
          className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-base text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:shadow-none focus:outline-none min-[641px]:text-[13px] [&::-webkit-search-cancel-button]:hidden"
        />
        <Kbd className="hidden min-[641px]:inline-flex">⌘K</Kbd>
      </label>
      <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3">
        <section aria-label="Agents, by what they are doing" data-shell-item="agents">
          <GroupLabel>Agents</GroupLabel>
          {down ? (
            <p role="status" className="mb-2 flex gap-2 rounded-sm border border-border px-2.5 py-2 text-xs leading-[1.45] text-(--ax-text-2)">
              <Icon name="unplug" className="mt-0.5 size-3.5 text-muted-foreground" />
              <span>{down} <a href="#page=running" className="font-normal text-foreground underline underline-offset-2">Open Running now</a></span>
            </p>
          ) : null}
          {!model ? <AfSkeletonRows /> : groups.length ? groups.map((g) => (
            <AgentGroup
              key={g.id} g={g} agent={pane === "chat" ? agent : undefined} onPick={pick}
              onFold={() => setFold(g.fold, !g.open)} onMore={() => { if (g.more) setFold(g.more, g.capped) }}
            />
          )) : needle ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No agent matches.</p>
          ) : (
            <div className="flex flex-col items-start gap-1 px-2 py-2 text-[13px]">
              <strong className="font-medium">No agents yet.</strong>
              <span className="text-xs text-muted-foreground">An agent answers your messages and runs your work.</span>
              <a href="#page=agents" className="mt-1 text-[13px] font-normal text-link hover:underline">Set up an agent</a>
            </div>
          )}
        </section>
        {workspace.length ? (
          <section aria-label="Workspace" data-shell-group="workspace" className="mt-3.5 border-t border-border pt-3.5">
            <GroupLabel>Workspace</GroupLabel>
            <div className="flex flex-col gap-px">
              {workspace.map((item) => (
                <MenuLink key={item.id} item={item} onOpen={onDone} active={PANE_OF[item.id] !== undefined && PANE_OF[item.id] === pane} count={item.id === "needs" ? needs : undefined} />
              ))}
            </div>
          </section>
        ) : null}
        {more.length ? (
          <section aria-label="More" data-shell-group="more" className="mt-3.5">
            <GroupLabel>More</GroupLabel>
            <div className="flex flex-col gap-px">{more.map((item) => <MenuLink key={item.id} item={item} onOpen={onDone} />)}</div>
          </section>
        ) : null}
      </div>
      {pane === "tasks" && onTasksView ? (
        <div className="-mx-4 border-t border-border px-5 py-2">
          <TasksViewSwitch view={tasksView} onView={onTasksView} />
        </div>
      ) : null}
      <div className="-mx-4 flex flex-col gap-px border-t border-border px-4 pt-2 pb-3">
        {nav.foot.map((item) => <MenuLink key={item.id} item={item} onOpen={onDone} />)}
        <button type="button" data-shell-item="theme" onClick={flipTheme} className={cn(itemCls, itemIdle, "min-[641px]:hidden")}>
          <Icon name="sun-moon" />
          <span>Light / dark</span>
        </button>
      </div>
    </nav>
  )
}

/** An icon button of the rail, named by its tooltip (orca-design C14). */
function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

const railBtn = "relative grid size-9 place-items-center rounded-sm text-(--ax-text-2) hover:bg-(--ax-surface-2) hover:text-foreground cursor-pointer " + ring

export interface SideRailProps extends Pick<SideMenuProps, "view" | "owner" | "model" | "needs" | "agent" | "onAgent" | "pane"> {
  /** Opens the full menu: unfolds it on a computer, as a Sheet below 1181 px. */
  onExpand: () => void
  /** Opens the full menu with the cursor in its search box (⌘K). */
  onSearch: () => void
}

/** The 56 px icon rail (641-1180 px, and the folded menu): every agent as
 *  its face with its state icon, in the menu's groups and order with a
 *  hairline between them, then Workspace's icons and Settings. Names,
 *  states and lines are in the tooltips. */
export function SideRail({ view, owner, model, needs, agent, onAgent, pane = "chat", onExpand, onSearch }: SideRailProps) {
  const nav = shellNav(view, { owner })
  const rows = model ? menuRows(model) : []
  const workspace = [...nav.main.filter((i) => i.id !== "search" && i.id !== "agents"), ...nav.more]
  return (
    <nav aria-label="Side menu" data-shell="rail" className="flex h-full min-h-0 flex-col items-center py-2.5">
      <RailTip label="Expand menu (⌘B)">
        <button type="button" aria-label="Expand menu" aria-expanded={false} onClick={onExpand} className={railBtn}><Icon name="panel-left" /></button>
      </RailTip>
      <RailTip label="Search agents and pages (⌘K)">
        <button type="button" aria-label="Search agents and pages" onClick={onSearch} className={cn(railBtn, "mt-1.5 mb-2 border border-border bg-background")}><Icon name="search" /></button>
      </RailTip>
      <div role="group" aria-label="Agents" className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-x-hidden overflow-y-auto">
        {!model ? <AfSkeletonRows rows={3} /> : rows.map((r, i) => {
          const word = haStateWord(r.state)
          const sep = i > 0 && r.state !== rows[i - 1].state && !(r.state === "failed" && rows[i - 1].state === "needs")
          const current = pane === "chat" && r.id === agent
          return (
            <div key={r.id} className="contents">
              {sep ? <hr className="my-1 w-6 border-border" /> : null}
              <RailTip label={r.name + " · " + word + (r.line ? ": " + r.line : "")}>
                <button
                  type="button" data-shell-rail-agent={r.id} aria-pressed={current} aria-label={r.name + ", " + word}
                  onClick={() => onAgent?.(r.id)}
                  className={cn("relative grid size-10 shrink-0 place-items-center rounded-sm cursor-pointer", ring, current ? "bg-accent" : "hover:bg-(--ax-surface-2)")}
                >
                  <AgentFace r={r} rail />
                </button>
              </RailTip>
            </div>
          )
        })}
        <div className="mt-2 flex w-full flex-col items-center gap-0.5 border-t border-border pt-2">
          {workspace.map((item) => {
            const active = PANE_OF[item.id] !== undefined && PANE_OF[item.id] === pane
            const n = item.id === "needs" ? needs ?? 0 : 0
            return (
              <RailTip key={item.id} label={item.label}>
                <a href={item.href} data-shell-item={item.id} aria-label={item.label} aria-current={active ? "page" : undefined} className={cn(railBtn, "font-normal", active && "bg-accent text-foreground")}>
                  <Icon name={item.icon} />
                  {n ? <span className="absolute -top-0.5 -right-1"><AfCount n={n} tone="warn" /></span> : null}
                </a>
              </RailTip>
            )
          })}
        </div>
      </div>
      {nav.foot.map((item) => (
        <RailTip key={item.id} label={item.label}>
          <a href={item.href} data-shell-item={item.id} aria-label={item.label} className={cn(railBtn, "mt-2 font-normal")}><Icon name={item.icon} /></a>
        </RailTip>
      ))}
    </nav>
  )
}
