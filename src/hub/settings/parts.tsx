// --- Settings: the parts every pane is built from (#2101 ST1) ---
//
// orca-design recipes §1: the pane header, groups with their title outside
// the card, rows split by hairlines, and the Advanced disclosure kept
// mounted so search can open it. A row is drawn from its definition in
// panes.ts (condition 1), so its label and help are the ones search shows.
// The dialogs live in dialogs.tsx and are re-exported here: one import.
import { Fragment, createContext, useContext, useState, type ComponentProps, type ReactNode } from "react"
import { engineIcon } from "../../daemon/ui/pages/engine-icons"
import {
  Button, Command, CommandItem, CommandList, Icon,
  Popover, PopoverContent, PopoverTrigger, Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import { rowDef, type SettingsPaneDef } from "./panes"

export { ConfirmDialog, FormDialog, useConfirm, type ConfirmSpec, type Invalid } from "./dialogs"

/** A text field in a row or a dialog; `text-base` on phones so they do not
 *  zoom. The one input class of every pane (fields.tsx uses it too). */
export const INPUT =
  "h-8 rounded-md border border-input bg-background px-2.5 text-base shadow-xs md:text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive disabled:opacity-50"

export function PaneHeader({ pane, action }: { pane: SettingsPaneDef; action?: ReactNode }) {
  return (
    <header data-slot="settings-pane-header" className="flex items-start justify-between gap-4 border-b border-border/60 pb-5 max-sm:flex-col max-sm:gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className="text-2xl font-semibold leading-tight">{pane.label}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{pane.help}</p>
      </div>
      {action}
    </header>
  )
}

/** A group: title and one line outside the card, the rows inside it. With
 *  `row`, the group is that row of the pane (search jumps to it). */
export function SettingsGroup({ pane, row, title, help, action, children }: {
  pane: string; row?: string; title?: string; help?: ReactNode; action?: ReactNode; children: ReactNode
}) {
  const def = row ? rowDef(pane, row) : undefined
  return (
    <section data-slot="settings-group" data-row={def?.id} aria-label={title ?? def?.label} className="flex scroll-mt-6 flex-col gap-2.5 rounded-xl">
      {(title ?? def) && (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-[15px] font-semibold">{title ?? def?.label}</h3>
            {help !== undefined ? <p className="text-xs text-muted-foreground">{help}</p> : def?.help && <p className="text-xs text-muted-foreground">{def.help}</p>}
          </div>
          {action}
        </div>
      )}
      <div data-slot="settings-card" className="overflow-hidden rounded-xl border border-border bg-card/50 px-5 shadow-xs [&>*+*]:border-t [&>*+*]:border-border">
        {children}
      </div>
    </section>
  )
}

/** One row from its definition: label and help on the left, the control on
 *  the right. On a phone (below 640 px) the control wraps under them, still
 *  right-aligned, when both do not fit; on wider screens long help wraps in
 *  its own column and the control stays on the line. `label` replaces the text only (a status dot, a mono name). */
export function SettingsRow({ pane, row, label, help, control, layout = "inline" }: {
  pane: string; row: string; label?: ReactNode; help?: ReactNode; control?: ReactNode
  /** `stack` puts the control under the label (a list of chips, checks). */
  layout?: "inline" | "stack"
}) {
  const def = rowDef(pane, row)
  return (
    <div data-slot="settings-row" data-row={def.id} data-layout={layout} className={cn("flex min-h-11 scroll-mt-6 py-[9px]", layout === "stack" ? "flex-col gap-2" : "items-center justify-between gap-x-4 gap-y-2 max-sm:flex-wrap")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{label ?? def.label}</span>
        {(help ?? def.help) && <span className="text-[12.5px] text-muted-foreground">{help ?? def.help}</span>}
      </div>
      {control && <div className={layout === "stack" ? "flex min-w-0 flex-wrap items-center gap-2" : "flex shrink-0 items-center gap-2 max-sm:ml-auto"}>{control}</div>}
    </div>
  )
}

export interface RowMenuItem { label: string; icon: string; onSelect: () => void; destructive?: boolean }

/** A row's `…` menu (rare actions, principle 3): a Command list in a
 *  Popover, so arrows and Enter work. Put it in SettingsItem's `menu`. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label={"More for " + label}><Icon name="ellipsis" className="size-3.5" /></Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-44 p-1">
        <Command>
          <CommandList>
            {items.map((it, i) => (
              <Fragment key={it.label}>
                {it.destructive && i > 0 && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
                <CommandItem onSelect={() => { setOpen(false); it.onSelect() }} className={it.destructive ? "text-destructive data-[selected=true]:text-destructive" : undefined}>
                  <Icon name={it.icon} className="size-3.5" />{it.label}
                </CommandItem>
              </Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A row in a list the pane reads from the server (an agent, a machine). It
 *  is part of its group's row in search, so it carries `data-item`, not
 *  `data-row`. Below 640 px the badge moves under the name (friction note 1);
 *  the `…` menu shows on hover or focus with a pointer, always on touch
 *  (friction note 2). Other props go to the row (a list that reorders sets
 *  its keys and drag on it). */
export function SettingsItem({ id, lead, name, meta, badge, control, menu, muted, className, ...props }: {
  id: string; lead?: ReactNode; name: ReactNode; meta?: ReactNode; badge?: ReactNode; control?: ReactNode; menu?: ReactNode; muted?: boolean
} & Omit<ComponentProps<"div">, "id">) {
  return (
    <div data-slot="settings-item" data-item={id} className={cn("group flex min-h-11 items-center gap-3 py-3", muted && "opacity-70", className)} {...props}>
      {lead}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{name}</span>
        {meta && <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground">{meta}</span>}
        {badge && <span className="mt-1 flex sm:hidden">{badge}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge && <span className="hidden sm:flex">{badge}</span>}
        {control}
        {menu && <span className="flex can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100">{menu}</span>}
      </div>
    </div>
  )
}

/** Which folds are open: the shell keeps it, so search can open one. */
export const DisclosureContext = createContext<{ isOpen: (id: string) => boolean; setOpen: (id: string, open: boolean) => void }>({
  isOpen: () => false, setOpen: () => {},
})

/** The Advanced fold (rule B): closed by default, kept mounted (`hidden`) so
 *  search can open it and scroll to a row inside. */
export function Disclosure({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { isOpen, setOpen } = useContext(DisclosureContext)
  const open = isOpen(id)
  const onOpenChange = (v: boolean) => setOpen(id, v)
  return (
    <div data-slot="settings-disclosure" data-disclosure={id} data-state={open ? "open" : "closed"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={"st-dis-" + id}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="chevron-right" className={cn("size-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        {label}
      </button>
      <div id={"st-dis-" + id} hidden={!open} className="pl-5 [&>*+*]:border-t [&>*+*]:border-border">
        {children}
      </div>
    </div>
  )
}

/** A state dot before a line: colour for state only, with the word in the text. */
export function ToneDot({ tone }: { tone: "ok" | "warn" | "err" }) {
  return <span aria-hidden="true" className={cn("mr-2 inline-block size-1.5 shrink-0 rounded-full align-middle", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-destructive")} />
}

/** One relative time format (orca-design C17): `now`, `2m`, `1h`, `2d`, the
 *  full stamp in its tooltip. */
export function Ago({ iso, prefix = "" }: { iso: string; prefix?: string }) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild><time dateTime={iso}>{prefix}{relTime(ms) === "now" ? "now" : relTime(ms) + " ago"}</time></TooltipTrigger>
      <TooltipContent>{new Date(ms).toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

export function SkeletonRows() {
  return <div className="flex flex-col gap-3 py-4" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-3/5" /></div>
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 py-3 text-sm">
      <span className="text-destructive">{text}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  )
}

/** A list with nothing in it yet, inside its card. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-4 text-sm text-muted-foreground">{children}</p>
}

/** A group's add button (its `action`). */
export function AddButton({ label, onClick, row }: { label: string; onClick: () => void; row?: string }) {
  return <Button variant="outline" size="sm" data-row={row} onClick={onClick}><Icon name="plus" className="size-3.5" />{label}</Button>
}

/** An engine's logo, the size of a line of text. */
export function EngineLogo({ tier }: { tier?: string }) {
  return <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: engineIcon(tier || "claude-code") }} />
}

/** One of your agents in a line: its engine's logo and its id in mono. */
export function AgentChip({ id, tier, at }: { id: string; tier?: string; at?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><EngineLogo tier={tier} /><span className="font-mono text-xs text-foreground">{at ? "@" : ""}{id}</span></span>
}

/** The square before an item: two letters, or an icon. */
export function Lead({ text, icon }: { text?: string; icon?: string }) {
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center self-start rounded-md border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
      {icon ? <Icon name={icon} className="size-3.5" /> : text}
    </span>
  )
}

/** Parts of a meta line, split by a quiet dot. */
export function Dots({ items }: { items: ReactNode[] }) {
  const parts = items.filter((c) => c !== null && c !== undefined && c !== false && c !== "")
  return <>{parts.map((c, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <span aria-hidden="true">·</span>}{c}</span>)}</>
}

/** A quiet icon button with its tooltip and sr-only name (C14). */
export function IconButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={label} onClick={onClick} disabled={disabled}><Icon name={icon} className="size-3.5" /></Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
