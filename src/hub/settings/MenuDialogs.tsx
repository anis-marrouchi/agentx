// --- Settings › Menu: Add and Reset to preset (#2101 ST5) ---
//
// Add is a small menu (page, saved view, link, group header), each opening
// one short dialog; the item goes into the list through the pane's save.
// Reset to preset asks which preset and replaces the list
// (POST /api/admin/wall/menu/reset); links are kept, the store says so.
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent, type ReactNode } from "react"
import { apiPost } from "../api"
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon,
  Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../ui"
import { ICON_CHOICES, MENU_API, VIEW_STATUS, addAt, inMore, newItemId, pageNames, type MenuDraft, type MenuItem, type MenuPresetId, type MenuReply } from "./menu-model"

type Kind = "page" | "view" | "link" | "group"
const TITLE: Record<Kind, { title: string; sub: string; submit: string }> = {
  page: { title: "Add a page", sub: "A page from More. It goes before your links.", submit: "Add page" },
  view: { title: "Add a saved view", sub: `The Hub with its filters set, one click away.`, submit: "Add view" },
  link: { title: "Add a link", sub: "Shows in the menu and on the phone, like a pinned page.", submit: "Add link" },
  group: { title: "Add a group header", sub: "Items below it, up to the next header, sit in the group.", submit: "Add header" },
}
const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function AddMenu({ reply, draft, disabled, onAdd }: { reply: MenuReply; draft: MenuDraft; disabled: boolean; onAdd: (d: MenuDraft, done?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind | null>(null)
  const more = inMore(draft.items, reply.catalog).length
  const full = draft.items.length >= reply.limits.items
  const links = draft.items.filter((i) => i.kind === "link").length >= reply.limits.links
  const row = "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
  const choice = (k: Kind, icon: string, label: string, sub?: string, off = false) => (
    <button type="button" role="menuitem" className={row} disabled={off} onClick={() => { setOpen(false); setKind(k) }}>
      <Icon name={icon} className="mt-0.5 size-3.5" /><span className="flex flex-col">{label}{sub && <span className="text-xs text-muted-foreground">{sub}</span>}</span>
    </button>
  )
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" data-row="add-item" disabled={disabled || full} title={full ? `A menu holds at most ${reply.limits.items} items` : undefined}>
            <Icon name="plus" className="size-3.5" />Add
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-1" role="menu" aria-label="Add to the menu">
          {choice("page", "file", "Page", more ? `${more} in More` : "Every page is in the menu", !more)}
          {choice("view", "bookmark", "Saved view", "The Hub with filters")}
          {choice("link", "link", "Link", links ? `At most ${reply.limits.links} links` : "https only", links)}
          <div role="separator" className="my-1 h-px bg-border" />
          {choice("group", "heading", "Group header")}
        </PopoverContent>
      </Popover>
      {kind && <AddDialog kind={kind} reply={reply} draft={draft} onClose={() => setKind(null)} onAdd={onAdd} />}
    </>
  )
}

function AddDialog({ kind, reply, draft, onClose, onAdd }: { kind: Kind; reply: MenuReply; draft: MenuDraft; onClose: () => void; onAdd: (d: MenuDraft, done?: string) => void }) {
  const names = pageNames(reply.catalog)
  const pages = inMore(draft.items, reply.catalog)
  const [f, setF] = useState({ page: pages[0] ?? "", label: "", url: "", icon: kind === "link" ? "link" : "bookmark", project: "", status: "open" })
  const [error, setError] = useState<{ field: string; text: string } | null>(null)
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setError(null) }
  const t = TITLE[kind]
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const label = f.label.trim().replace(/\s+/g, " ")
    let it: MenuItem
    if (kind === "page") {
      if (!f.page) return
      it = { id: newItemId("page"), kind: "page", page: f.page }
    } else {
      if (!label) return setError({ field: "label", text: kind === "group" ? "Give the group a name." : kind === "view" ? "Give the view a name." : "Give the link a name." })
      if (kind === "group") it = { id: newItemId("group"), kind: "group", label }
      else if (kind === "view") {
        const filter: Record<string, string> = {}
        if (f.project.trim()) filter.project = f.project.trim()
        if (f.status) filter.status = f.status
        it = { id: newItemId("view"), kind: "view", page: "wall", label, icon: f.icon, filter }
      } else {
        const url = f.url.trim()
        if (!/^https:\/\/[^\s@/]+/.test(url)) return setError({ field: "url", text: "Use an https address with no user name or password in it." })
        if (draft.items.some((i) => i.kind === "link" && (i.url === url || i.label.toLowerCase() === label.toLowerCase()))) {
          return setError({ field: "label", text: `You already have a link called ${label} or to that page.` })
        }
        it = { id: newItemId("link"), kind: "link", label, url, icon: f.icon }
      }
    }
    onAdd({ ...draft, items: addAt(draft.items, it) }, `Added ${it.kind === "page" ? names.get(it.page) : label}`)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t.title}</DialogTitle><DialogDescription>{t.sub}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {kind === "page" ? (
            <Field label="Page">
              <Select value={f.page} onValueChange={(v) => set("page", v)}>
                <SelectTrigger className="h-9 w-full" aria-label="Page"><SelectValue /></SelectTrigger>
                <SelectContent>{pages.map((k) => <SelectItem key={k} value={k}>{names.get(k) ?? k}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          ) : (
            <label className="flex flex-col gap-1 text-sm">Name
              <input autoFocus className={input} maxLength={40} value={f.label} onChange={(e) => set("label", e.target.value)} aria-invalid={error?.field === "label"}
                placeholder={kind === "group" ? "Clients" : kind === "view" ? "Client site work" : "Grafana"} />
            </label>
          )}
          {kind === "link" && (
            <label className="flex flex-col gap-1 text-sm">Address
              <input className={input + " font-mono"} value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://" aria-invalid={error?.field === "url"} autoComplete="off" spellCheck={false} />
            </label>
          )}
          {kind === "view" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">Project
                <input className={input + " font-mono"} value={f.project} onChange={(e) => set("project", e.target.value)} placeholder="Any" autoComplete="off" />
              </label>
              <Field label="Status">
                <Select value={f.status || "any"} onValueChange={(v) => set("status", v === "any" ? "" : v)}>
                  <SelectTrigger className="h-9 w-full" aria-label="Status"><SelectValue /></SelectTrigger>
                  <SelectContent>{VIEW_STATUS.map((s) => <SelectItem key={s.label} value={s.id || "any"}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
          )}
          {(kind === "view" || kind === "link") && (
            <Field label="Icon">
              <Select value={f.icon} onValueChange={(v) => set("icon", v)}>
                <SelectTrigger className="h-9 w-full" aria-label="Icon"><SelectValue /></SelectTrigger>
                <SelectContent>{ICON_CHOICES.map((n) => <SelectItem key={n} value={n}><span className="flex items-center gap-2"><Icon name={n} className="size-3.5" />{n}</span></SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          {error && <p role="alert" className="text-xs text-destructive">{error.text}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit">{t.submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1 text-sm">{label}{children}</div>
}

const PRESET_HELP: Partial<Record<MenuPresetId, string>> = { everything: "Every page, in today's order", blank: "No pages: every page in More" }

export function ResetDialog({ open, onOpenChange, reply, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; reply: MenuReply; onDone: (text: string) => void }) {
  const client = useQueryClient()
  const [preset, setPreset] = useState<MenuPresetId>(reply.menu.preset)
  const [error, setError] = useState("")
  const reset = useMutation({
    mutationFn: (p: MenuPresetId) => apiPost<{ menu: MenuReply["menu"] }>(MENU_API + "/reset", { revision: reply.menu.revision, preset: p }),
    onSuccess: (r, p) => {
      client.setQueryData<MenuReply>(["settings", "menu"], (d: MenuReply | undefined) => d && { ...d, menu: r.menu, saved: true })
      onDone(`Menu reset to ${reply.presets.find((x) => x.id === p)?.label ?? p}`)
      onOpenChange(false)
    },
    onError: (e) => setError("Not reset: " + (e as Error).message),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setError("") }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset to preset</DialogTitle>
          <DialogDescription>Your list is replaced. Links are kept, and pages you leave out stay in More.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); reset.mutate(preset) }} className="flex flex-col gap-3">
          <fieldset className="flex flex-col divide-y divide-border rounded-lg border border-border">
            <legend className="sr-only">Preset</legend>
            {reply.presets.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                <input type="radio" name="preset" value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} className="size-4 accent-primary" />
                <span className="flex flex-col">{p.label}{PRESET_HELP[p.id] && <span className="text-xs text-muted-foreground">{PRESET_HELP[p.id]}</span>}</span>
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={reset.isPending}>{reset.isPending ? "Replacing…" : "Replace menu"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
