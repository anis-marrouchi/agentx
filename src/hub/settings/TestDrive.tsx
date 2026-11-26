// --- Settings › Agent › Test drive (#2101 ST2a) ---
//
// Send the agent a message and read its answer here, before it answers on a
// real channel (the old page's POST agents/test). It runs for real, on its
// own engine, in a chat of its own per visit.
import { useMutation } from "@tanstack/react-query"
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { Button, Kbd, cn } from "../ui"
import type { AgentConfig } from "./agent-data"
import { save } from "./GeneralPane"
import { inputClass } from "./fields"
import { SettingsGroup } from "./parts"

interface Msg { kind: "you" | "agent" | "err"; text: string }
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+"

export function TestDrive({ agent: a }: { agent: AgentConfig }) {
  const chat = useRef("hub-settings-" + Date.now())
  const [log, setLog] = useState<Msg[]>([])
  const [text, setText] = useState("")
  const send = useMutation({
    mutationFn: (message: string) => save("POST", "/api/admin/wall/settings/agents/test", { agent: a.id, message, chatId: chat.current }) as Promise<{ response?: { content?: string; error?: string } }>,
    onSuccess: (r) => setLog((l) => [...l, r.response?.error ? { kind: "err", text: r.response.error } : { kind: "agent", text: r.response?.content || "(no answer)" }]),
    onError: (e) => setLog((l) => [...l, { kind: "err", text: "Not sent: " + (e as Error).message }]),
  })
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t || send.isPending) return
    setLog((l) => [...l, { kind: "you", text: t }])
    setText("")
    send.mutate(t)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit() }
  return (
    <SettingsGroup pane="agent" row="test-drive" help="Send it a message and read the answer here. It runs for real, on its own engine.">
      <div className="flex flex-col gap-3 py-4">
        {log.length > 0 && (
          <ol aria-live="polite" className="flex flex-col gap-2">
            {log.map((m, i) => (
              <li key={i} className={cn("max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-5",
                m.kind === "you" ? "self-end bg-muted" : m.kind === "err" ? "self-start border border-destructive/30 text-destructive" : "self-start border border-border")}
              >{m.text}</li>
            ))}
            {send.isPending && <li role="status" className="self-start px-1 text-xs text-muted-foreground">Thinking…</li>}
          </ol>
        )}
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            aria-label="Test drive message" placeholder={"Message " + (a.name || a.id)} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            maxLength={4000} className={cn(inputClass, "h-9 min-w-0 flex-1")}
          />
          <Button type="submit" variant="outline" disabled={!text.trim() || send.isPending}>Send</Button>
          <Kbd className="max-sm:hidden">{MOD}↵</Kbd>
        </form>
      </div>
    </SettingsGroup>
  )
}
