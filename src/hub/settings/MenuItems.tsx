// --- Settings › Menu: the list of menu items (#2101 ST5) ---
//
// One SettingsItem per item of the #2149 menu, in order. Reorder three
// ways: drag by the grip (a hover pointer), Alt+↑ / Alt+↓ on a focused row
// (or the up and down buttons on hover), and Move up / down / to top in the
// row's "…" menu, which is also how a phone reorders. A name is a button:
// click it to rename in place (Enter or leaving saves, Esc cancels). The
// phone toggle of an item in the bar is its badge, so below 640 px it sits
// under the name (C4); the "…" shows on hover or focus with a pointer.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from "react"
import { Button, Icon, Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import {
  ICON_CHOICES, barIds, inGroup, itemIcon, itemLabel, itemMeta, moveItem, pageNames, removeItem, renameItem, toggleBar,
  type MenuDraft, type MenuItem, type MenuReply, type PageNames,
} from "./menu-model"
import { SettingsItem } from "./parts"

type Change = (d: MenuDraft, done?: string, undo?: MenuDraft) => void

export function MenuItems({ reply, draft, readOnly, onChange }: { reply: MenuReply; draft: MenuDraft; readOnly: boolean; onChange: Change }) {
  const names = pageNames(reply.catalog)
  const max = reply.limits.bar
  const bar = barIds(draft, max)
  const [renaming, setRenaming] = useState("")
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null)
  const [said, setSaid] = useState("")
  const focusAfter = useRef("")
  const list = useRef<HTMLDivElement>(null)

  // A move by keyboard keeps focus on the row that moved.
  useEffect(() => {
    if (!focusAfter.current) return
    list.current?.querySelector<HTMLElement>(`[data-item="mi-${CSS.escape(focusAfter.current)}"]`)?.focus()
    focusAfter.current = ""
  })

  const move = (it: MenuItem, to: number, keep = false) => {
    const items = moveItem(draft.items, it.id, to)
    if (items === draft.items) return
    if (keep) focusAfter.current = it.id
    setSaid(`${itemLabel(it, names)}: ${items.indexOf(it) + 1} of ${items.length}`)
    onChange({ ...draft, items })
  }
  const setBar = (it: MenuItem) => {
    const next = toggleBar(draft, it.id, max)
    if (!next) return setSaid(`The phone bar holds ${max}. Take one out first.`)
    onChange({ ...draft, bar: next }, next.includes(it.id) ? `${itemLabel(it, names)} is in the phone bar` : `${itemLabel(it, names)} is out of the phone bar`)
  }
  const replace = (it: MenuItem, done?: string) => onChange({ ...draft, items: draft.items.map((i) => (i.id === it.id ? it : i)) }, done)
  const remove = (it: MenuItem) => {
    const name = itemLabel(it, names)
    onChange(removeItem(draft, it.id), it.kind === "page" ? `${name} is in More` : `Removed ${name}`, draft)
  }

  const onKey = (it: MenuItem, i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || e.target !== e.currentTarget || !e.altKey) return
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(it, i + (e.key === "ArrowUp" ? -1 : 1), true) }
  }
  const dragProps = (it: MenuItem) => readOnly ? {} : {
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); setDrag({ id: it.id }) },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      if (drag.over !== it.id || drag.after !== after) setDrag({ ...drag, over: it.id, after })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const moving = draft.items.find((x) => x.id === drag?.id)
      if (moving && drag?.over) {
        const rest = draft.items.filter((x) => x.id !== moving.id)
        const at = rest.findIndex((x) => x.id === drag.over) + (drag.after ? 1 : 0)
        move(moving, at)
      }
      setDrag(null)
    },
    onDragEnd: () => setDrag(null),
  }

  return (
    <div ref={list} className="[&>*+*]:border-t [&>*+*]:border-border">
      <p role="status" className="sr-only">{said}</p>
      {draft.items.map((it, i) => {
        const name = itemLabel(it, names)
        const group = it.kind === "group"
        const inBar = bar.includes(it.id)
        const canBar = it.kind === "page" || it.kind === "view"
        const phone = (on: boolean) => (
          <Tip text={on ? "In phone bar" : bar.length >= max ? `The phone bar holds ${max}` : "Add to phone bar"}>
            <Button
              variant="ghost" size="icon" aria-label="In phone bar" aria-pressed={on} disabled={readOnly || (!on && bar.length >= max)}
              className={cn("size-7", on && "bg-accent text-foreground")} onClick={() => setBar(it)}
            ><Icon name="smartphone" className="size-3.5" /></Button>
          </Tip>
        )
        return (
          <SettingsItem
            key={it.id} id={"mi-" + it.id}
            tabIndex={0} aria-label={`${name}, ${i + 1} of ${draft.items.length}`}
            draggable={!readOnly && drag?.id === it.id} onKeyDown={onKey(it, i)} {...dragProps(it)}
            data-drop={drag?.over === it.id && drag.id !== it.id ? (drag.after ? "after" : "before") : undefined}
            className={cn(
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              inGroup(draft.items, i) && "pl-5",
              drag?.id === it.id && "opacity-50",
              "data-[drop=before]:shadow-[inset_0_2px_0_var(--color-ring)] data-[drop=after]:shadow-[inset_0_-2px_0_var(--color-ring)]",
            )}
            lead={<>
              <span
                aria-hidden="true" title="Drag to move"
                onPointerDown={() => !readOnly && setDrag({ id: it.id })} onPointerUp={() => setDrag(null)}
                className="-ml-2 hidden cursor-grab text-muted-foreground/70 can-hover:flex"
              ><Icon name="grip-vertical" className="size-3.5" /></span>
              {!group && <Icon name={itemIcon(it)} className="size-3.5 text-muted-foreground" />}
            </>}
            name={renaming === it.id
              ? <RenameInput value={name} onDone={(v) => { setRenaming(""); if (v !== null && v !== name) replace(renameItem(it, v, names), "Renamed") }} />
              : <button
                  type="button" disabled={readOnly} onClick={() => setRenaming(it.id)} title="Rename"
                  className={cn("max-w-full cursor-text truncate text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline", group ? "text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground" : "font-normal")}
                >{name}</button>}
            meta={<span className="truncate">{itemMeta(it, names)}</span>}
            badge={inBar ? phone(true) : undefined}
            control={readOnly ? undefined : (
              <span className="hidden items-center gap-1 can-hover:flex can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100">
                {canBar && !inBar && phone(false)}
                <Tip text="Move up · Alt ↑"><Button variant="ghost" size="icon" className="size-7" aria-label="Move up" disabled={i === 0} onClick={() => move(it, i - 1)}><Icon name="arrow-up" className="size-3.5" /></Button></Tip>
                <Tip text="Move down · Alt ↓"><Button variant="ghost" size="icon" className="size-7" aria-label="Move down" disabled={i === draft.items.length - 1} onClick={() => move(it, i + 1)}><Icon name="arrow-down" className="size-3.5" /></Button></Tip>
              </span>
            )}
            menu={readOnly ? undefined : (
              <RowMenu
                item={it} name={name} names={names} first={i === 0} last={i === draft.items.length - 1} inBar={inBar} barFull={bar.length >= max}
                onRename={() => setRenaming(it.id)} onReplace={replace} onMove={(to) => move(it, to)} onBar={() => setBar(it)} onRemove={() => remove(it)}
                index={i}
              />
            )}
          />
        )
      })}
    </div>
  )
}

function Tip({ text, children }: { text: string; children: ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const done = useRef(false)
  const end = (out: string | null) => { if (done.current) return; done.current = true; onDone(out) }
  return (
    <input
      autoFocus aria-label="New name" value={v} maxLength={40}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); end(v) }
        // Esc cancels here; preventDefault keeps Settings from closing.
        else if (e.key === "Escape") { e.preventDefault(); end(null) }
        e.stopPropagation()
      }}
      onBlur={() => end(v)}
      className="h-8 w-[220px] max-w-full rounded-md border border-input bg-background px-2 text-base font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
    />
  )
}

function RowMenu({ item, name, names, index, first, last, inBar, barFull, onRename, onReplace, onMove, onBar, onRemove }: {
  item: MenuItem; name: string; names: PageNames; index: number; first: boolean; last: boolean; inBar: boolean; barFull: boolean
  onRename: () => void; onReplace: (it: MenuItem, done?: string) => void; onMove: (to: number) => void; onBar: () => void; onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [icons, setIcons] = useState(false)
  const pick = (f: () => void) => () => { setOpen(false); setIcons(false); f() }
  const row = "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
  const catalogName = item.kind === "page" ? names.get(item.page) : undefined
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setIcons(false) }}>
      <Tip text="More actions">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={"More actions for " + name}><Icon name="ellipsis" className="size-3.5" /></Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-56 p-1" role="menu" aria-label={name}>
        {icons ? (
          <div className="grid grid-cols-4 gap-1 p-1">
            {ICON_CHOICES.map((n) => (
              <button key={n} type="button" role="menuitemradio" aria-checked={itemIcon(item) === n} aria-label={n} title={n}
                onClick={pick(() => onReplace({ ...item, icon: n } as MenuItem, "Icon changed"))}
                className={cn(row, "justify-center", itemIcon(item) === n && "bg-accent")}><Icon name={n} /></button>
            ))}
          </div>
        ) : (
          <>
            <button type="button" role="menuitem" className={row} onClick={pick(onRename)}><Icon name="pencil" className="size-3.5" />Rename</button>
            {(item.kind === "view" || item.kind === "link") && (
              <button type="button" role="menuitem" className={row} onClick={() => setIcons(true)}><Icon name="shapes" className="size-3.5" />Change icon</button>
            )}
            {item.kind === "page" && item.label && catalogName && (
              <button type="button" role="menuitem" className={row} onClick={pick(() => onReplace(renameItem(item, catalogName, names), "Name reset"))}><Icon name="undo-2" className="size-3.5" />Reset name to {catalogName}</button>
            )}
            {(item.kind === "page" || item.kind === "view") && (
              <button type="button" role="menuitem" className={row} disabled={!inBar && barFull} onClick={pick(onBar)}><Icon name="smartphone" className="size-3.5" />{inBar ? "Take out of phone bar" : "Add to phone bar"}</button>
            )}
            <button type="button" role="menuitem" className={row} disabled={first} onClick={pick(() => onMove(index - 1))}><Icon name="arrow-up" className="size-3.5" />Move up</button>
            <button type="button" role="menuitem" className={row} disabled={last} onClick={pick(() => onMove(index + 1))}><Icon name="arrow-down" className="size-3.5" />Move down</button>
            <button type="button" role="menuitem" className={row} disabled={first} onClick={pick(() => onMove(0))}><Icon name="arrow-up-to-line" className="size-3.5" />Move to top</button>
            <div role="separator" className="my-1 h-px bg-border" />
            {item.kind === "page" ? (
              <button type="button" role="menuitem" className={row} onClick={pick(onRemove)}><Icon name="eye-off" className="size-3.5" />Hide (move to More)</button>
            ) : (
              <button type="button" role="menuitem" className={cn(row, "text-destructive")} onClick={pick(onRemove)}><Icon name="trash-2" className="size-3.5" />{item.kind === "group" ? "Remove group header" : "Remove"}</button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
