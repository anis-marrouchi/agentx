// --- Settings › Channels (#2101 ST3a) ---
//
// The approved mock (settings-mock/full/channels.html): one tab per chat app
// or developer tool (a Select below 640 px), a dot on the tabs that are on,
// and WhatsApp as a link to its own pane. Chat apps are in ChannelsChat.tsx,
// developer tools in ChannelsDev.tsx. A tab is a fold of the shell
// (DisclosureContext), as in Jobs, so search opens it before it scrolls.
// Same calls as the old Channels section (wall-settings-channels.client.ts),
// under the Settings prefix so the owner guard holds every write
// (wall-actions.ts). A secret is never shown or sent: each field takes the
// NAME of the .env variable that holds it (channels-data.ts secretName).
import { useContext } from "react"
import { Icon, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "../ui"
import { settingsHash } from "./address"
import { CHANNEL_TABS, channelsOn, type ChannelTab, type ChannelsState } from "./channels-data"
import { DiscordTab, EmailTab, SlackTab, TelegramTab } from "./ChannelsChat"
import { CallsTab, GitHubTab, GitLabTab } from "./ChannelsDev"
import { Choice, STATE_KEY, WriteNote, useWorkState, useWrite } from "./fields"
import { DisclosureContext, ErrorLine, PaneHeader, SkeletonRows, TAB_TRIGGER } from "./parts"
import { paneDef } from "./panes"

const PANE = "channels"
const TABS = CHANNEL_TABS.map(([id]) => id)
/** An Advanced fold inside a tab opens that tab too. */
const INSIDE: Record<string, ChannelTab> = { "sl-adv": "slack", "gl-adv": "gitlab" }

const trigger = cn(TAB_TRIGGER, "gap-1.5")

export default function ChannelsPane() {
  const pane = paneDef(PANE)
  const state = useWorkState()
  const { isOpen, setOpen } = useContext(DisclosureContext)
  const { run: send, note, setNote } = useWrite(STATE_KEY)
  const tab: ChannelTab = TABS.find((t) => isOpen("ch-tab-" + t)) ?? Object.entries(INSIDE).find(([id]) => isOpen(id))?.[1] ?? "telegram"
  const pick = (t: string) => { TABS.forEach((x) => setOpen("ch-tab-" + x, x === t)); setNote(null) }
  const s = state.data as ChannelsState | undefined
  const on = channelsOn(s)
  const dot = (id: ChannelTab) => on.has(id) && <span role="img" aria-label="on" className="size-1.5 rounded-full bg-ok" />

  return (
    <>
      <PaneHeader pane={pane} />
      <Tabs value={tab} onValueChange={pick} className="flex flex-col gap-8">
        <div className="sm:hidden">
          <Choice
            label="Channel" value={tab} onChange={pick}
            options={CHANNEL_TABS.map(([id, label, icon]) => ({ value: id, label: <span className="inline-flex items-center gap-2"><Icon name={icon} className="size-3.5" />{label}{dot(id)}</span> }))}
          />
        </div>
        <TabsList aria-label="Channels" className="-mt-2 h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 max-sm:hidden">
          {CHANNEL_TABS.map(([id, label]) => <TabsTrigger key={id} value={id} className={trigger}>{label}{dot(id)}</TabsTrigger>)}
          <a data-row="ch-whatsapp" href={settingsHash("whatsapp")} className="inline-flex items-center gap-1 whitespace-nowrap px-2.5 pb-2.5 pt-1 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            WhatsApp<Icon name="arrow-up-right" className="size-3" />
          </a>
        </TabsList>
        {state.isPending ? <SkeletonRows /> : state.isError ? (
          <ErrorLine text={`Could not read the channels: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
        ) : (
          <>
            <TabsContent value="telegram" className="mt-0 flex flex-col gap-8"><TelegramTab s={s} send={send} /></TabsContent>
            <TabsContent value="email" className="mt-0 flex flex-col gap-8"><EmailTab s={s} send={send} /></TabsContent>
            <TabsContent value="slack" className="mt-0 flex flex-col gap-8"><SlackTab s={s} send={send} /></TabsContent>
            <TabsContent value="discord" className="mt-0 flex flex-col gap-8"><DiscordTab s={s} send={send} /></TabsContent>
            <TabsContent value="gitlab" className="mt-0 flex flex-col gap-8"><GitLabTab s={s} send={send} /></TabsContent>
            <TabsContent value="github" className="mt-0 flex flex-col gap-8"><GitHubTab s={s} /></TabsContent>
            <TabsContent value="calls" className="mt-0 flex flex-col gap-8"><CallsTab /></TabsContent>
          </>
        )}
        <WriteNote note={note} />
      </Tabs>
    </>
  )
}
