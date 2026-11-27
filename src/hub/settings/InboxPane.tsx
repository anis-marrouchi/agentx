// --- Settings › Inbox (#2101 ST2b) ---
//
// The mock's Inbox (settings-mock/full/inbox.html): where a ping goes, which
// events send one, what `agentx notify` does on this machine, and phone push
// through ntfy. Changes gather in a draft with one Save, as the old page's
// one call (POST notifications, as `agentx notifications`) takes them; only
// a real ntfy change is sent, since a write to channels.* asks for a daemon
// restart. On ntfy the topic is a password: the page takes the NAME of the
// .env variable that holds it.
import { useState, type ReactNode } from "react"
import { Badge, Button, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, cn } from "../ui"
import { STATE_KEY, useWorkState, useWrite, WriteNote } from "./fields"
import { Disclosure, ErrorLine, INPUT, PaneHeader, SettingsGroup, SettingsRow, SkeletonRows } from "./parts"
import { paneDef } from "./panes"
import { NTFY_KEYS, SOUNDS, inboxBody, inboxChanged, inboxForm, type InboxForm } from "./work-data"

const PANE = "inbox"
const NONE = "__none"
const RESTART = "agentx daemon restart --when-idle"

export default function InboxPane() {
  const pane = paneDef(PANE)
  const state = useWorkState()
  const saved = inboxForm(state.data?.notifications)
  const [draft, setDraft] = useState<Partial<InboxForm>>({})
  const f: InboxForm = { ...saved, ...draft }
  const changed = inboxChanged(saved, f)
  const { write, busy, note, setNote } = useWrite(STATE_KEY)
  const set = <K extends keyof InboxForm>(k: K, v: InboxForm[K]) => { setDraft((d) => ({ ...d, [k]: v })); setNote(null) }
  const ntfy = state.data?.notifications?.ntfy
  const node = state.data?.nodeName as string | undefined

  const save = () => {
    const r = inboxBody(saved, f)
    if ("error" in r) { setNote({ tone: "err", text: "Not saved: " + r.error }); return }
    write("POST", "notifications", r.body, r.restart ? `Saved. Restart the daemon for phone push: ${RESTART}` : "Saved").then((ok) => ok && setDraft({}))
  }

  const text = (k: keyof InboxForm, label: string, placeholder: string, w = "w-[200px]") => (
    <input value={String(f[k])} onChange={(e) => set(k, e.target.value as never)} aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false} className={cn(INPUT, w, "max-w-full font-mono")} />
  )
  const num = (k: "long" | "volume", label: string, unit?: string) => (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <input value={f[k]} onChange={(e) => set(k, e.target.value)} inputMode="decimal" aria-label={label} className={cn(INPUT, "w-16 text-right tabular-nums")} />{unit}
    </span>
  )
  const sw = (k: "done" | "failed" | "queued" | "banner" | "sound" | "ntfy", label: string) => <Switch checked={f[k]} onCheckedChange={(v) => set(k, v)} aria-label={label} />

  if (state.isPending) return <><PaneHeader pane={pane} /><SkeletonRows /></>
  if (state.isError) return <><PaneHeader pane={pane} /><ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} /></>

  return (
    <>
      <PaneHeader pane={pane} />
      <div className="flex flex-col gap-8">
        <SettingsGroup pane={PANE} title="Where it goes" help={saved.channel ? <>Goes to <span className="font-mono">{saved.channel}:{saved.chat}</span>{saved.account && <> · account <span className="font-mono">{saved.account}</span></>}</> : "No destination: notifications go to the daemon log only."}>
          <SettingsRow pane={PANE} row="in-channel" control={
            <Select value={f.channel || NONE} onValueChange={(v) => set("channel", v === NONE ? "" : v)}>
              <SelectTrigger className="w-[200px]" aria-label="Channel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None (daemon log)</SelectItem>
                <SelectItem value="telegram"><span className="flex items-center gap-2"><Icon name="send" className="size-3.5" />Telegram</span></SelectItem>
                <SelectItem value="whatsapp"><span className="flex items-center gap-2"><Icon name="message-circle" className="size-3.5" />WhatsApp</span></SelectItem>
                {f.channel && !["telegram", "whatsapp"].includes(f.channel) && <SelectItem value={f.channel}>{f.channel}</SelectItem>}
              </SelectContent>
            </Select>
          } />
          {f.channel && <SettingsRow pane={PANE} row="in-chat" control={text("chat", "Chat id", "-1001234567890")} />}
          <Disclosure id="in-adv" label="Advanced">
            <SettingsRow pane={PANE} row="in-account" control={text("account", "Account", "default")} />
          </Disclosure>
        </SettingsGroup>
        <SettingsGroup pane={PANE} title="When" help="The events that send a ping.">
          <SettingsRow pane={PANE} row="in-done" control={sw("done", "A task is done")} />
          <SettingsRow pane={PANE} row="in-failed" control={sw("failed", "A task failed")} />
          <SettingsRow pane={PANE} row="in-queued" control={sw("queued", "A task is queued")} />
          <SettingsRow pane={PANE} row="in-long" control={num("long", "Long-task threshold", "seconds")} />
        </SettingsGroup>
        <SettingsGroup pane={PANE} title="On this machine" help={<>When <span className="font-mono">agentx notify</span> delivers on {node ? <span className="font-mono">{node}</span> : "the machine"}{node ? ", the machine" : ""} that serves this Hub.</>}>
          <SettingsRow pane={PANE} row="in-banner" control={sw("banner", "Show a banner")} />
          <SettingsRow pane={PANE} row="in-sound" control={sw("sound", "Play a sound")} />
          {f.sound && <>
            <SettingsRow pane={PANE} row="in-sound-name" control={
              <Select value={f.soundName} onValueChange={(v) => set("soundName", v)}>
                <SelectTrigger className="w-[140px]" aria-label="Sound"><SelectValue /></SelectTrigger>
                <SelectContent>{[...new Set([...SOUNDS, f.soundName])].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            } />
            <SettingsRow pane={PANE} row="in-volume" control={num("volume", "Volume")} />
          </>}
          <Disclosure id="inb-adv" label="Advanced">
            <SettingsRow pane={PANE} row="in-icon" control={text("icon", "Banner icon", "~/Pictures/agentx.icns", "w-[220px]")} />
          </Disclosure>
        </SettingsGroup>
        <SettingsGroup pane={PANE} title="Phone push (ntfy)" help="Used by agentx notify. Changes here apply after a daemon restart.">
          <SettingsRow pane={PANE} row="ntfy-on" label={<span className="flex items-center gap-2">Phone push{ntfy?.enabled ? <Badge variant="ok">On</Badge> : <Badge variant="secondary">Off</Badge>}</span>} control={sw("ntfy", "Phone push")} />
          <SettingsRow pane={PANE} row="ntfy-topic" help={ntfy?.topicSet ? "Set in .env. Type a variable name to use another; empty keeps it." : "Not set. The topic is a password: it goes in .env."} control={text("topic", "Topic variable name", "NTFY_TOPIC")} />
          <Disclosure id="ntfy-adv" label="Advanced">
            <SettingsRow pane={PANE} row="ntfy-server" control={text("server", "ntfy server", "https://ntfy.sh")} />
            <SettingsRow pane={PANE} row="ntfy-token" help={ntfy?.tokenSet ? "Set in .env. Type a variable name to use another; empty keeps it." : undefined} control={text("token", "Token variable name", "NTFY_TOKEN")} />
          </Disclosure>
        </SettingsGroup>
        {changed.length > 0 ? (
          <SaveBar
            title={changed.length === 1 ? "1 change not saved" : `${changed.length} changes not saved`}
            help={changed.some((k) => (NTFY_KEYS as readonly string[]).includes(k)) ? "Phone push applies after a daemon restart." : "Applies to the next ping."}
            note={note?.tone === "err" ? note.text : ""}
          >
            <Button variant="ghost" size="sm" onClick={() => { setDraft({}); setNote(null) }}>Discard</Button>
            <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
          </SaveBar>
        ) : <WriteNote note={note} />}
      </div>
    </>
  )
}

/** The draft's one bar: it floats at the bottom of the pane while there is
 *  something to save (a floating surface, so it carries a shadow). */
function SaveBar({ title, help, note, children }: { title: string; help: string; note: string; children: ReactNode }) {
  return (
    <div role="region" aria-label="Changes not saved" data-slot="settings-savebar" className="sticky bottom-4 z-10 flex items-center justify-between gap-4 rounded-xl border border-border bg-popover px-4 py-2.5 shadow-float">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium">{title}</span>
        <span role={note ? "alert" : undefined} className={cn("text-xs", note ? "text-destructive" : "text-muted-foreground")}>{note || help}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
