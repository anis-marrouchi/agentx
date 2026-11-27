// --- Settings › Channels: the chat apps (#2101 ST3a) ---
//
// Telegram and Email (lists of accounts, forms in ChannelsDialogs.tsx),
// Slack and Discord (one connection each, saved from the tab). The calls:
//   POST …/channels/<name>/toggle, POST|PATCH|DELETE …/telegram,
//   POST|DELETE …/email, POST …/slack, POST …/discord
// A secret shows as its .env variable's name, or "Secret in file" when
// agentx.json holds it; its value is never read, shown or sent.
import { useEffect, useState, type ReactNode } from "react"
import { Badge, Button, Icon, Switch, cn } from "../ui"
import { RESTART, secretName, type ChannelsState, type SecretRef, type TgAccount } from "./channels-data"
import { MailboxDialog, TelegramDialog } from "./ChannelsDialogs"
import { AgentSelect, type Send } from "./fields"
import { ENV_NAME } from "./work-data"
import {
  AddButton, Disclosure, Dots, EmptyLine, INPUT, Lead, RowMenu, SettingsGroup, SettingsItem, SettingsRow, useConfirm,
} from "./parts"

const PANE = "channels"
const API = "channels/"

export const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-xs">{children}</span>
export const At = ({ id }: { id?: string }) => (id ? <Mono>@{id}</Mono> : <>no agent</>)

/** "Secret in file" when agentx.json holds the secret itself (as the Agent pane says it). */
export function SecretBadge({ r }: { r: SecretRef }) {
  return secretName(r).literal ? <Badge variant="warn">Secret in file</Badge> : null
}

/** A secret in a line: its variable's name only. */
function SecretText({ label, r }: { label: string; r: SecretRef }) {
  const s = secretName(r)
  return <>{label} {s.name ? <Mono>{s.name}</Mono> : s.literal ? "in the file" : "not set"}</>
}

/** The connector's on/off row; without `toggle` it is not set up yet. */
export function ConnectorRow({ row, name, on, help, toggle, send }: { row: string; name: string; on?: boolean; help: ReactNode; toggle?: string; send: Send }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const flip = async (v: boolean) => {
    setBusy(true); setErr("")
    try { await send("POST", API + toggle, { enabled: v }, `${name} is ${v ? "on" : "off"}. ${RESTART}`) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <SettingsRow
      pane={PANE} row={row}
      label={<span className="inline-flex items-center gap-2">{name} connector {toggle ? <Badge variant={on ? "ok" : "secondary"}>{on ? "On" : "Off"}</Badge> : <Badge variant="secondary">Not set up</Badge>}</span>}
      help={err ? <span className="text-destructive">Not changed: {err}</span> : help}
      control={toggle && <Switch checked={!!on} disabled={busy} onCheckedChange={flip} aria-label={`${name} connector on`} />}
    />
  )
}

/** Save for a tab's form: the button turns into Saving…, the error stays beside it. */
export function SaveFoot({ label, run }: { label: string; run: () => Promise<string | void> }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const go = async () => {
    setBusy(true); setErr("")
    try { const bad = await run(); if (bad) setErr(bad) } catch (e) { setErr("Not saved: " + (e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="flex items-center justify-end gap-2 py-3">
      {err && <span role="alert" className="mr-auto text-xs text-destructive">{err}</span>}
      <Button size="sm" disabled={busy} onClick={go}>{busy ? "Saving…" : label}</Button>
    </div>
  )
}

/** A tab form's fields, reset when what is saved changes. */
export function useFields<T extends Record<string, string>>(init: () => T, saved: unknown): [T, (k: keyof T, v: string) => void] {
  const [f, setF] = useState(init)
  useEffect(() => { setF(init()) }, [JSON.stringify(saved)]) // eslint-disable-line react-hooks/exhaustive-deps
  return [f, (k, v) => setF((x) => ({ ...x, [k]: v }))]
}

/** A secret field: the variable's name, with the badge when the file holds the secret. */
export function EnvInput({ label, r, value, onChange, ph }: { label: string; r: SecretRef; value: string; onChange: (v: string) => void; ph: string }) {
  return (
    <span className="flex items-center gap-2">
      <SecretBadge r={r} />
      <input className={cn(INPUT, "w-36 font-mono sm:w-[230px]")} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph} autoComplete="off" spellCheck={false} />
    </span>
  )
}

export const badEnv = (...names: string[]) => (names.some((n) => n && !ENV_NAME.test(n)) ? "Type the variable's name, not the secret." : "")

export function TelegramTab({ s, send }: { s?: ChannelsState; send: Send }) {
  const accounts = s?.telegram?.accounts ?? []
  const literal = accounts.filter((a) => secretName(a.botTokenRef).literal)
  const [edit, setEdit] = useState<TgAccount | null | undefined>(undefined)
  const confirm = useConfirm()
  return (
    <>
      <SettingsGroup pane={PANE} title="Telegram" help="One bot per account.">
        <ConnectorRow row="ch-telegram" name="Telegram" on={s?.telegram?.enabled} toggle="telegram/toggle" send={send}
          help={`${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} · turning it off stops every bot`} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} row="tg-accounts" title="Accounts" action={<AddButton label="Add account" onClick={() => setEdit(null)} />}>
        {accounts.length === 0 ? <EmptyLine>No Telegram account yet.</EmptyLine> : accounts.map((a) => (
          <SettingsItem
            key={a.id} id={"tg-" + a.id}
            lead={<Lead icon="bot" />}
            name={<>{a.id}{a.botUsername && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">@{a.botUsername}</span>}</>}
            meta={<Dots items={[<>Answers as <At id={a.agentBinding} /></>, <SecretText label="Token" r={a.botTokenRef} />]} />}
            badge={<SecretBadge r={a.botTokenRef} />}
            menu={<>
              <Button variant="ghost" size="sm" onClick={() => setEdit(a)}>Edit</Button>
              <RowMenu label={a.id} items={[
                { label: "Delete account", icon: "trash-2", destructive: true, onSelect: () => confirm.ask({
                  title: `Delete the Telegram account ${a.id}?`, text: "Its bot stops answering. The token stays in .env.", yes: "Delete account",
                  run: () => send("DELETE", API + "telegram", { id: a.id }, `Deleted the Telegram account ${a.id}.`),
                }) },
              ]} />
            </>}
          />
        ))}
        {literal.length > 0 && (
          <p className="flex items-start gap-2 py-2.5 text-xs text-muted-foreground">
            <Icon name="triangle-alert" className="mt-px size-3.5" />
            <span>{literal.map((a) => a.id).join(", ")} {literal.length === 1 ? "keeps its token" : "keep their tokens"} in agentx.json. Edit and type a .env variable name to move it.</span>
          </p>
        )}
      </SettingsGroup>
      <TelegramDialog account={edit} agents={s?.agents ?? []} onClose={() => setEdit(undefined)} send={send} />
      {confirm.dialog}
    </>
  )
}

export function EmailTab({ s, send }: { s?: ChannelsState; send: Send }) {
  const boxes = s?.email?.accounts ?? []
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()
  return (
    <>
      <SettingsGroup pane={PANE} title="Email" help="Mailboxes your agents read and answer.">
        <ConnectorRow row="ch-email" name="Email" on={s?.email?.enabled} toggle={boxes.length ? "email/toggle" : undefined} send={send}
          help="Only mail that arrives after the daemon starts reading is answered." />
      </SettingsGroup>
      <SettingsGroup pane={PANE} row="em-boxes" action={<AddButton label="Add mailbox" onClick={() => setAdding(true)} />}>
        {boxes.length === 0 ? <EmptyLine>No mailbox yet.</EmptyLine> : boxes.map((b) => (
          <SettingsItem
            key={b.id} id={"em-" + b.id}
            lead={<Lead icon="mail" />}
            name={b.address || b.id}
            meta={<>
              <Dots items={[<>Answered by <At id={b.agent} /></>, <>IMAP <Mono>{b.imap}</Mono></>, <>SMTP <Mono>{b.smtp}</Mono></>]} />
              <span className="flex basis-full flex-wrap items-center gap-x-1.5">
                <Dots items={[
                  <>Who may write: {b.allowFrom?.length ? <Mono>{b.allowFrom.join(", ")}</Mono> : "nobody"}</>,
                  b.send === "auto" ? "Replies sent at once" : "Replies wait for your approval",
                  <SecretText label="Password" r={b.passwordRef} />,
                ]} />
              </span>
            </>}
            badge={<SecretBadge r={b.passwordRef} />}
            menu={<RowMenu label={b.address || b.id} items={[
              { label: "Remove mailbox", icon: "trash-2", destructive: true, onSelect: () => confirm.ask({
                title: `Remove the mailbox ${b.address || b.id}?`, text: "Its password stays in .env. The mailbox itself is not changed.", yes: "Remove mailbox",
                run: () => send("DELETE", API + "email", { id: b.id }, `Removed the mailbox ${b.id}.`),
              }) },
            ]} />}
          />
        ))}
      </SettingsGroup>
      <MailboxDialog open={adding} onOpenChange={setAdding} agents={s?.agents ?? []} send={send} />
      {confirm.dialog}
    </>
  )
}

export function SlackTab({ s, send }: { s?: ChannelsState; send: Send }) {
  const sl = s?.slack ?? {}
  const configured = secretName(sl.botTokenRef).set && secretName(sl.appTokenRef).set
  const [f, set] = useFields(() => ({ bot: secretName(sl.botTokenRef).name, app: secretName(sl.appTokenRef).name, agent: sl.agentBinding ?? "" }), sl)
  return (
    <>
      <SettingsGroup pane={PANE} title="Slack" help="Socket Mode: no public address needed.">
        <ConnectorRow row="ch-slack" name="Slack" on={sl.enabled} toggle={configured ? "slack/toggle" : undefined} send={send}
          help={configured ? <>Answers as <At id={sl.agentBinding} /></> : "Not connected yet: fill in the tokens below."} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title={configured ? "Connection" : "Connect Slack"} help="Saving moves the bot to the default agent.">
        <SettingsRow pane={PANE} row="sl-bot" control={<EnvInput label="Bot token variable" r={sl.botTokenRef} value={f.bot} onChange={(v) => set("bot", v)} ph="SLACK_BOT_TOKEN" />} />
        <SettingsRow pane={PANE} row="sl-app" control={<EnvInput label="App token variable" r={sl.appTokenRef} value={f.app} onChange={(v) => set("app", v)} ph="SLACK_APP_TOKEN" />} />
        <SettingsRow pane={PANE} row="sl-agent" control={<AgentSelect label="Default agent" className="h-8 w-36 sm:w-[230px]" value={f.agent} onChange={(v) => set("agent", v)} agents={s?.agents ?? []} none="None" />} />
        <Disclosure id="sl-adv" label="Slack app setup">
          <SettingsRow pane={PANE} row="sl-scopes" help={<>Bot: <Mono>chat:write</Mono>, <Mono>app_mentions:read</Mono>, <Mono>channels:history</Mono>, <Mono>im:history</Mono>. App-level token: <Mono>connections:write</Mono>.</>} />
        </Disclosure>
        <SaveFoot label={configured ? "Save" : "Connect"} run={async () => {
          const bad = badEnv(f.bot.trim(), f.app.trim()); if (bad) return bad
          await send("POST", API + "slack", { botTokenEnv: f.bot.trim(), appTokenEnv: f.app.trim(), agentBinding: f.agent, moveBot: true })
        }} />
      </SettingsGroup>
    </>
  )
}

export function DiscordTab({ s, send }: { s?: ChannelsState; send: Send }) {
  const d = s?.discord ?? {}
  const configured = secretName(d.tokenRef).set
  const [f, set] = useFields(() => ({ token: secretName(d.tokenRef).name, agent: d.agentBinding ?? "" }), d)
  return (
    <>
      <SettingsGroup pane={PANE} title="Discord" help="The bot answers when @-mentioned in channels, and always in direct messages.">
        <ConnectorRow row="ch-discord" name="Discord" on={d.enabled} toggle={configured ? "discord/toggle" : undefined} send={send}
          help={configured ? <>Answers as <At id={d.agentBinding} /></> : "Discord is not connected."} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title={configured ? "Connection" : "Connect Discord"} help="Turn on the MESSAGE_CONTENT intent in the Discord Developer Portal first.">
        <SettingsRow pane={PANE} row="dc-token" control={<EnvInput label="Bot token variable" r={d.tokenRef} value={f.token} onChange={(v) => set("token", v)} ph="DISCORD_BOT_TOKEN" />} />
        <SettingsRow pane={PANE} row="dc-agent" control={<AgentSelect label="Default agent" className="h-8 w-36 sm:w-[230px]" value={f.agent} onChange={(v) => set("agent", v)} agents={s?.agents ?? []} none="None" />} />
        <SaveFoot label={configured ? "Save" : "Connect"} run={async () => {
          const bad = badEnv(f.token.trim()); if (bad) return bad
          await send("POST", API + "discord", { tokenEnv: f.token.trim(), agentBinding: f.agent, moveBot: true })
        }} />
      </SettingsGroup>
    </>
  )
}
