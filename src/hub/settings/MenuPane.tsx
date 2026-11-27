// --- Settings › Menu (#2101 ST5) ---
//
// The approved mock (settings-mock/full/menu.html) on the #2149 M1 menu
// store (src/daemon/hub-menu.ts): the menu's items in order, the phone bar,
// the pages in More, Reset to preset, and under Advanced the preset it
// started from plus everything the old Settings › Layout did (Simple or
// full, each item's switch, Reset layout), so nothing is lost when ST4
// switches Settings over.
//
// Every change saves at once: the whole list, with the revision it read
// (409 when another Settings page saved first). Saves run one at a time; a
// change made while one is on its way goes in the next.
//
// No Suggestions group: "not opened for 14 days" needs open counts, and
// while the store has a lastUsed field and POST /menu/used, nothing calls
// it when a page opens yet, so a suggestion would be made from nothing.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState, type ReactNode } from "react"
import { apiGet, apiPost, HubApiError } from "../api"
import { HUB_SWITCH_ITEMS, hubHiddenItems, type HubLayoutPatch, type HubLayoutView } from "../layout"
import { Button, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, cn } from "../ui"
import type { AdminState } from "./data"
import { MenuItems } from "./MenuItems"
import { AddMenu, ResetDialog } from "./MenuDialogs"
import { MENU_API, MENU_QUERY_KEY, addAt, barIds, inMore, newItemId, itemIcon, itemLabel, pageNames, PAGE_ICONS, type MenuDraft, type MenuItem, type MenuReply } from "./menu-model"
import { Disclosure, PaneHeader, SettingsGroup, SettingsItem, SettingsRow } from "./parts"
import { paneDef } from "./panes"
import { MENU_ADVANCED } from "./rows/menu"

const PANE = "menu"
const KEY = MENU_QUERY_KEY

export interface MenuNote { tone: "ok" | "err" | "busy"; text: string; conflict?: boolean; undo?: MenuDraft }

/** The menu, the list on screen (a change not saved yet shows at once) and
 *  `change`, which saves it. */
function useMenuStore() {
  const client = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: () => apiGet<MenuReply>(MENU_API) })
  const [draft, setDraft] = useState<MenuDraft | null>(null)
  const [note, setNote] = useState<MenuNote | null>(null)
  const queue = useRef<{ next: MenuDraft | null; busy: boolean; done?: string; undo?: MenuDraft }>({ next: null, busy: false })

  const flush = async (): Promise<void> => {
    const s = queue.current
    if (s.busy || !s.next) return
    const body = s.next
    s.next = null
    s.busy = true
    setNote({ tone: "busy", text: "Saving…" })
    try {
      const revision = client.getQueryData<MenuReply>(KEY)?.menu.revision
      const r = await apiPost<{ menu: MenuReply["menu"] }>(MENU_API, { revision, items: body.items, bar: body.bar })
      client.setQueryData<MenuReply>(KEY, (d: MenuReply | undefined) => d && { ...d, menu: r.menu, saved: true })
      s.busy = false
      if (s.next) return flush()
      setDraft(null)
      setNote({ tone: "ok", text: s.done || "Saved", undo: s.undo })
    } catch (e) {
      s.busy = false
      s.next = null
      setDraft(null)
      setNote({ tone: "err", text: "Not saved: " + (e as Error).message, conflict: e instanceof HubApiError && e.status === 409 })
    }
  }
  const change = (next: MenuDraft, done?: string, undo?: MenuDraft) => {
    setDraft(next)
    queue.current = { ...queue.current, next, done, undo }
    void flush()
  }
  const reload = () => { setNote(null); return q.refetch() }
  const shown: MenuDraft | null = draft ?? (q.data ? { items: q.data.menu.items, bar: q.data.menu.bar } : null)
  return { q, shown, change, note, setNote, reload }
}

export default function MenuPane() {
  const pane = paneDef(PANE)
  const { q, shown, change, note, setNote, reload } = useMenuStore()
  const [resetting, setResetting] = useState(false)
  const data = q.data
  const readOnly = !data || data.damaged
  return (
    <>
      <PaneHeader
        pane={pane}
        action={<Button variant="outline" size="sm" data-row="reset" disabled={readOnly} onClick={() => setResetting(true)}><Icon name="rotate-ccw" className="size-3.5" />Reset to preset</Button>}
      />
      <div className="flex flex-col gap-8">
        {q.isPending ? <Loading /> : q.isError ? (
          <Alert text={`Could not read the menu: ${(q.error as Error).message}`} action={<Button variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>} />
        ) : data && shown && (
          <>
            {data.damaged && <Alert text="The menu file (.agentx/menu.json) can't be read whole. Fix or remove it on the computer; until then the menu can't change." action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>} />}
            <SettingsGroup
              pane={PANE} row="items"
              action={<AddMenu reply={data} draft={shown} disabled={readOnly} onAdd={change} />}
            >
              {data.fixedLinks.map((l) => (
                <SettingsItem
                  key={l.id} id={"fixed-" + l.id}
                  lead={<span className="flex w-[34px] justify-end text-muted-foreground"><Icon name="link" className="size-3.5" /></span>}
                  name={l.label}
                  meta={<>Link · <span className="font-mono text-xs">{l.url.replace(/^https:\/\//, "")}</span> · set in agentx.json</>}
                />
              ))}
              <MenuItems reply={data} draft={shown} readOnly={readOnly} onChange={change} />
              <div className="flex items-center gap-1.5 py-3 text-[12.5px] text-muted-foreground">
                <Icon name="settings" className="size-3.5" />Settings always sits at the foot of the menu, for you only.
              </div>
              {note && <NoteLine note={note} onUndo={(d) => change(d, "Put back")} onReload={reload} onClose={() => setNote(null)} />}
            </SettingsGroup>
            <PhoneBar reply={data} draft={shown} />
            <InMore reply={data} draft={shown} readOnly={readOnly} onChange={change} />
            <Advanced reply={data} />
          </>
        )}
      </div>
      {data && <ResetDialog open={resetting} onOpenChange={setResetting} reply={data} onDone={(text) => setNote({ tone: "ok", text })} />}
    </>
  )
}

function NoteLine({ note, onUndo, onReload, onClose }: { note: MenuNote; onUndo: (d: MenuDraft) => void; onReload: () => void; onClose: () => void }) {
  return (
    <div role="status" className={cn("flex items-center gap-3 py-2.5 text-xs", note.tone === "err" ? "text-destructive" : "text-muted-foreground")}>
      <span className="min-w-0 flex-1">{note.text}</span>
      {note.undo && <Button variant="ghost" size="xs" onClick={() => { onUndo(note.undo!); onClose() }}>Undo</Button>}
      {note.conflict && <Button variant="outline" size="xs" onClick={onReload}>Reload</Button>}
    </div>
  )
}

function PhoneBar({ reply, draft }: { reply: MenuReply; draft: MenuDraft }) {
  const names = pageNames(reply.catalog)
  const max = reply.limits.bar
  const ids = barIds(draft, max)
  const items = ids.map((id) => draft.items.find((i) => i.id === id)).filter((i): i is MenuItem => !!i)
  const slot = "flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[11px] text-muted-foreground"
  return (
    <SettingsGroup pane={PANE} row="bar" help={`${items.length} of ${max}. More holds everything else.`}>
      <div aria-label="Phone bar preview" className="-mx-5 flex">
        {items.map((it) => (
          <span key={it.id} className={slot}><Icon name={itemIcon(it)} className="text-foreground" /><span className="max-w-full truncate">{itemLabel(it, names)}</span></span>
        ))}
        {Array.from({ length: Math.max(0, max - items.length) }, (_, n) => (
          <span key={"empty" + n} className={slot}><span aria-hidden="true" className="h-4 w-4 rounded-sm border border-dashed border-border" />Empty</span>
        ))}
        <span className={slot}><Icon name="ellipsis" className="text-foreground" />More</span>
      </div>
    </SettingsGroup>
  )
}

function InMore({ reply, draft, readOnly, onChange }: { reply: MenuReply; draft: MenuDraft; readOnly: boolean; onChange: (d: MenuDraft, done?: string) => void }) {
  const names = pageNames(reply.catalog)
  const hidden = inMore(draft.items, reply.catalog)
  const full = draft.items.length >= reply.limits.items
  const add = (page: string) => {
    onChange({ ...draft, items: addAt(draft.items, { id: newItemId("page"), kind: "page", page }) }, `Added ${names.get(page) ?? page}`)
  }
  return (
    <SettingsGroup pane={PANE} row="more" help={hidden.length ? `${hidden.length} ${hidden.length === 1 ? "page" : "pages"} not in the menu. Still one tap away in More.` : "Every page is in the menu."}>
      {hidden.length ? hidden.map((k) => (
        <SettingsItem
          key={k} id={"more-" + k}
          lead={<Icon name={PAGE_ICONS[k] || "file"} className="size-3.5 text-muted-foreground" />}
          name={<span className="font-normal">{names.get(k) ?? k}</span>}
          control={<Button variant="ghost" size="sm" disabled={readOnly || full} onClick={() => add(k)}><Icon name="plus" className="size-3.5" />Add to menu</Button>}
        />
      )) : (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Icon name="check" className="size-3.5" />Nothing in More.</div>
      )}
    </SettingsGroup>
  )
}

/** Rare rows (rule B): the preset, and the old Settings › Layout. */
function Advanced({ reply }: { reply: MenuReply }) {
  const client = useQueryClient()
  const state = useQuery({ queryKey: ["settings", "state"], queryFn: () => apiGet<AdminState & { hubLayout?: HubLayoutView }>("/api/admin/state") })
  const [error, setError] = useState("")
  const view = state.data?.hubLayout
  const put = useMutation({
    mutationFn: (patch: HubLayoutPatch) => apiPost<{ layout: HubLayoutView }>("/api/admin/wall/settings/hub-layout", patch),
    onSuccess: (r) => {
      setError("")
      // As the old page does: the Hub shows and hides at once, no reload.
      document.documentElement.setAttribute("data-hub-hide", hubHiddenItems(r.layout).join(" "))
      client.setQueryData(["settings", "state"], (d: object | undefined) => d && { ...d, hubLayout: r.layout })
    },
    onError: (e) => setError("Not saved: " + (e as Error).message),
  })
  const preset = reply.presets.find((p) => p.id === reply.menu.preset)?.label ?? reply.menu.preset
  const busy = !view || put.isPending
  return (
    <section data-slot="settings-group" aria-label="Advanced" className="rounded-xl border border-border bg-card/50 px-5 shadow-xs">
      <Disclosure id={MENU_ADVANCED} label="Advanced">
        <SettingsRow pane={PANE} row="from" control={<span className="text-[12.5px] text-muted-foreground">{reply.saved ? preset : `${preset} (not saved yet)`}</span>} />
        <SettingsRow
          pane={PANE} row="layout"
          help={error ? <span className="text-destructive">{error}</span> : undefined}
          control={
            <Select value={view?.layout} disabled={busy} onValueChange={(v) => put.mutate({ layout: v as HubLayoutView["layout"] })}>
              <SelectTrigger className="w-[120px]" aria-label="Layout"><SelectValue placeholder="…" /></SelectTrigger>
              <SelectContent><SelectItem value="simple">Simple</SelectItem><SelectItem value="full">Full</SelectItem></SelectContent>
            </Select>
          }
        />
        {HUB_SWITCH_ITEMS.map((i) => {
          const id = i.id as keyof HubLayoutView["show"]
          const own = !!view?.overrides.includes(id)
          return (
            <SettingsRow
              key={i.id} pane={PANE} row={"show-" + i.id}
              control={<>
                {own && <Button variant="ghost" size="xs" disabled={busy} title="Use the layout's default" onClick={() => put.mutate({ show: { [id]: null } })}>Reset</Button>}
                <Switch checked={!!view?.show[id]} disabled={busy} onCheckedChange={(v) => put.mutate({ show: { [id]: v } })} aria-label={i.label} />
              </>}
            />
          )
        })}
        {/* hub-folds.ts answers [data-hub-reset] on the whole document: one Reset layout. */}
        <SettingsRow pane={PANE} row="reset-layout" control={<Button variant="ghost" size="sm" data-hub-reset>Reset layout</Button>} />
      </Disclosure>
    </section>
  )
}

function Loading() {
  return <div className="flex flex-col gap-3" aria-busy="true"><Skeleton className="h-5 w-40" /><Skeleton className="h-64 w-full rounded-xl" /></div>
}

function Alert({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-border px-5 py-3 text-sm">
      <span className="text-destructive">{text}</span>{action}
    </div>
  )
}
