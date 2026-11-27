// --- Settings › Channels: add or edit a Telegram account, add a mailbox (#2101 ST3a) ---
//
// The old Channels forms (wall-settings-channels.client.ts) in FormDialogs.
// A secret field takes the .env variable's NAME (botTokenEnv, passwordEnv);
// a value that does not look like a name is refused before it is sent.
import { useEffect, useState } from "react"
import { Switch } from "../ui"
import { RESTART, secretName, type TgAccount } from "./channels-data"
import { AgentSelect, Field, FieldRow, dialogInput, type Send } from "./fields"
import { FormDialog, type Invalid } from "./parts"
import { ENV_NAME } from "./work-data"

const mono = dialogInput + " font-mono"

export function TelegramDialog({ account: a, agents, onClose, send }: { account: TgAccount | null | undefined; agents: readonly { id: string }[]; onClose: () => void; send: Send }) {
  const open = a !== undefined
  const literal = !!a && secretName(a.botTokenRef).literal
  const [f, setF] = useState({ id: "", agent: "", user: "", env: "" })
  useEffect(() => { if (open) setF({ id: a?.id ?? "", agent: a?.agentBinding || agents[0]?.id || "", user: a?.botUsername ?? "", env: secretName(a?.botTokenRef).name }) }, [open, a]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const submit = async (): Promise<Invalid> => {
    const env = f.env.trim()
    if (!a && !f.id.trim()) return { field: "id", text: "Give the account a name." }
    if (env && !ENV_NAME.test(env)) return { field: "env", text: "Type the variable name, such as TG_SUPPORT_BOT_TOKEN, not the token." }
    if (a) await send("PATCH", "channels/telegram", { id: a.id, patch: { agentBinding: f.agent, botUsername: f.user.trim(), botTokenEnv: env } }, `Saved ${a.id}. ${RESTART}`)
    else await send("POST", "channels/telegram", { id: f.id.trim(), agentBinding: f.agent, botUsername: f.user.trim(), botTokenEnv: env })
  }
  return (
    <FormDialog
      open={open} onOpenChange={(v) => { if (!v) onClose() }} title={a ? `Edit ${a.id}` : "Add a Telegram account"}
      description={a ? undefined : "The token from BotFather goes in .env; type its variable name here."} submit={a ? "Save" : "Add account"} onSubmit={submit}
    >
      {!a && <Field label="Account name" help="Lowercase"><input className={mono} value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="support" autoComplete="off" spellCheck={false} /></Field>}
      <FieldRow>
        <Field label="Agent"><AgentSelect label="Agent" value={f.agent} onChange={(v) => set("agent", v)} agents={agents} /></Field>
        <Field label="Bot username" help="Optional"><input className={mono} value={f.user} onChange={(e) => set("user", e.target.value)} placeholder="my_bot" autoComplete="off" spellCheck={false} /></Field>
      </FieldRow>
      <Field label="Bot token, as a .env variable name" help={literal ? "Empty keeps the secret in the file. Type a name to move it to .env." : undefined}>
        <input className={mono} value={f.env} onChange={(e) => set("env", e.target.value)} placeholder="TG_SUPPORT_BOT_TOKEN" autoComplete="off" spellCheck={false} />
      </Field>
    </FormDialog>
  )
}

export function MailboxDialog({ open, onOpenChange, agents, send }: { open: boolean; onOpenChange: (v: boolean) => void; agents: readonly { id: string }[]; send: Send }) {
  const blank = () => ({ id: "", agent: agents[0]?.id ?? "", address: "", imap: "", smtp: "", env: "", imapPort: "993", smtpPort: "465", allow: "*" })
  const [f, setF] = useState(blank)
  const [auto, setAuto] = useState(false)
  useEffect(() => { if (open) { setF(blank()); setAuto(false) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof ReturnType<typeof blank>, v: string) => setF((x) => ({ ...x, [k]: v }))
  const submit = async (): Promise<Invalid> => {
    if (!f.id.trim()) return { field: "id", text: "Give the mailbox an account name." }
    if (!f.address.includes("@")) return { field: "address", text: "Type the full address." }
    if (f.env.trim() && !ENV_NAME.test(f.env.trim())) return { field: "env", text: "Type the variable name, such as EMAIL_SUPPORT_PASSWORD, not the password." }
    await send("POST", "channels/email", {
      id: f.id.trim(), agent: f.agent, address: f.address.trim(), imapHost: f.imap.trim(), imapPort: f.imapPort.trim(), smtpHost: f.smtp.trim(), smtpPort: f.smtpPort.trim(),
      passwordEnv: f.env.trim(), allowFrom: f.allow, send: auto ? "auto" : "approve",
    })
  }
  const text = (k: keyof ReturnType<typeof blank>, label: string, ph: string, help?: string) => (
    <Field label={label} help={help}><input className={mono} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} autoComplete="off" spellCheck={false} /></Field>
  )
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange} title="Add a mailbox"
      description="Only new mail is answered, and the mailbox is never changed. To check the login first, run agentx connect email."
      submit="Add mailbox" onSubmit={submit}
      advanced={<>
        <FieldRow>{text("imapPort", "IMAP port", "993")}{text("smtpPort", "SMTP port", "465")}</FieldRow>
        {text("allow", "Who may write", "*", "Addresses, @domain, or * for anyone")}
      </>}
    >
      <FieldRow>
        {text("id", "Account name", "support")}
        <Field label="Answered by"><AgentSelect label="Answered by" value={f.agent} onChange={(v) => set("agent", v)} agents={agents} /></Field>
      </FieldRow>
      {text("address", "Address customers write to", "hello@example.com")}
      <FieldRow>{text("imap", "IMAP server (incoming)", "imap.example.com")}{text("smtp", "SMTP server (outgoing)", "smtp.example.com")}</FieldRow>
      {text("env", "Password, as a .env variable name", "EMAIL_SUPPORT_PASSWORD")}
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="flex flex-col gap-0.5">Send replies at once<span className="text-xs text-muted-foreground">Off: each reply waits in Needs you for your approval.</span></span>
        <Switch checked={auto} onCheckedChange={setAuto} aria-label="Send replies at once" />
      </div>
    </FormDialog>
  )
}
