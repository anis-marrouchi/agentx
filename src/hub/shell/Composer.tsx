// --- The Hub composer card, in React (#2453) ---
//
// The approved ask box of the old Hub chat (#2182, mock V1 of #2101 P7,
// wall-chat-input.client.ts), drawn for the React shell so every way into
// a chat shows the same card: "To <agent>" on top, the files waiting to
// go, the message, then a row of round buttons: attach, the model picker,
// the mic (#2267) with Check before sending and Hear my message, and the
// send arrow. It glows blue while the mic records.
//
// It talks to the same endpoints as the old card: a file goes up when it
// is picked (POST /api/assistant/upload), a recording is written down by
// POST /api/assistant/voice/transcribe. The model choice and the Check
// switch are kept per browser under the old card's keys, so both cards
// share them.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react"
import { modelChoices } from "../../daemon/assistant-model"
import { HubApiError } from "../api"
import { Icon, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"

/** Files one message may carry (assistant-upload.ts ATTACH_MAX). */
export const ATTACH_MAX = 5
export const MODEL_KEY = "ax-hub-chat-model"
export const CHECK_KEY = "ax-hub-chat-mic-check"
const MAX_REC_MS = 120_000

export interface ComposerAgent { id: string; name: string; model?: string; tier?: string }
export interface Attachment { name: string; path: string }
export interface ComposerSend { message: string; attachments?: Attachment[]; model?: string; spoken?: boolean }

interface Draft { key: number; name: string; path: string }

function token(): string | undefined {
  return typeof window !== "undefined" ? window.AX_LOCAL_TOKEN : undefined
}
async function postRaw<T>(path: string, body: Blob, type: string, extra: Record<string, string> = {}): Promise<T> {
  const h = new Headers({ "Content-Type": type, ...extra })
  const t = token()
  if (t) h.set("Authorization", "Bearer " + t)
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: h, body })
  const d = (await res.json().catch(() => ({}))) as T & { error?: string; hint?: string }
  if (!res.ok) throw new HubApiError(res.status, d.hint || d.error || "HTTP " + res.status)
  return d
}

function readStore<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T) } catch { return fallback }
}
function writeStore(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode: kept for this page only */ }
}

/** "claude-opus-4-6" reads as "Opus": the choice its name contains, else the name. */
export function ownModelLabel(own: string | undefined, choices: string[]): string {
  if (!own) return "Own model"
  const short = choices.find((c) => own.toLowerCase().includes(c))
  return (short ? short.charAt(0).toUpperCase() + short.slice(1) : own) + " (own)"
}

/** The text sent when only files go: the old card's words. */
export function filesOnlyText(n: number): string {
  return n === 1 ? "See the attached file." : "See the attached files."
}

const send = "inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--ax-blue-d)] text-white transition-colors hover:bg-[var(--ax-blue)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45"
const round = "inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

/** Says an answer back in the agent's voice: the node answers with audio,
 *  or asks the browser to say it (the old card's onSpokenAnswer). */
export async function sayAnswer(threadId: string, node: string | undefined, text: string): Promise<void> {
  const h = new Headers({ "Content-Type": "application/json" })
  const t = token()
  if (t) h.set("Authorization", "Bearer " + t)
  const r = await fetch("/api/assistant/voice/speak", { method: "POST", credentials: "same-origin", headers: h, body: JSON.stringify({ threadId, node: node || undefined, text }) })
  const type = r.headers.get("Content-Type") || ""
  if (r.ok && type.startsWith("audio/")) { await new Audio(URL.createObjectURL(await r.blob())).play(); return }
  const d = (await r.json().catch(() => ({}))) as { fallback?: string; text?: string; error?: string }
  if (d.fallback === "browser" && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function") {
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(d.text || text))
    return
  }
  if (!r.ok) throw new Error(d.error || "HTTP " + r.status)
}

export function Composer({ agent, node, busy, onSend, onStop, children }: {
  agent?: ComposerAgent
  /** The node that holds the conversation, so files go up where the agent runs. */
  node?: string
  busy?: boolean
  /** Resolves true when the message was taken. */
  onSend: (s: ComposerSend) => Promise<boolean>
  /** Set while a reply runs: Send turns into Stop, which calls it (A3). */
  onStop?: () => void
  /** Lines under the card (the machine, a send error). */
  children?: ReactNode
}) {
  const [text, setText] = useState("")
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null)
  const [model, setModel] = useState("")
  const [canRecord, setCanRecord] = useState(false)
  const [recording, setRecording] = useState(false)
  const [checkFirst, setCheckFirst] = useState(false)
  const [lastUrl, setLastUrl] = useState("")
  const box = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const rec = useRef<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[]; at: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const nextKey = useRef(0)

  const choices = modelChoices(agent?.tier)
  const say = (t: string, err?: boolean) => setNote(t ? { text: t, err } : null)

  // The browser's own parts are read after the first draw, so the server render matches.
  useEffect(() => {
    const nav = window.navigator as Navigator | undefined
    setCanRecord(!!(nav?.mediaDevices?.getUserMedia && typeof window.MediaRecorder === "function"))
    // The old card keeps the plain "1" / "0", not JSON.
    try { setCheckFirst(localStorage.getItem(CHECK_KEY) === "1") } catch { /* private mode: off */ }
  }, [])
  // A new agent: its kept model, no files from the last one.
  useEffect(() => {
    const kept = agent ? readStore<Record<string, string>>(MODEL_KEY, {})[agent.id] ?? "" : ""
    setModel(choices.includes(kept) ? kept : "")
    setDrafts([])
    setNote(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, agent?.tier])
  // The box grows with the message, up to 160 px, then scrolls.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
  }, [text])
  useEffect(() => () => { if (lastUrl) URL.revokeObjectURL(lastUrl) }, [lastUrl])

  const uploading = drafts.some((d) => !d.path)
  const ready = drafts.filter((d) => d.path).map((d) => ({ name: d.name, path: d.path }))
  const canSend = !!agent && !busy && !uploading && (!!text.trim() || ready.length > 0)

  const pickModel = (v: string) => {
    setModel(v)
    if (!agent) return
    const m = readStore<Record<string, string>>(MODEL_KEY, {})
    if (v) m[agent.id] = v; else delete m[agent.id]
    writeStore(MODEL_KEY, m)
  }

  const upload = (file: File) => {
    if (!agent) return
    const key = nextKey.current++
    const name = file.name || "file"
    setDrafts((d) => [...d, { key, name, path: "" }])
    const q = new URLSearchParams({ agent: agent.id, name })
    if (node) q.set("node", node)
    postRaw<{ path?: string; name?: string }>("/api/assistant/upload?" + q.toString(), file, "application/octet-stream")
      .then((d) => {
        if (!d.path) throw new Error("no path")
        setDrafts((all) => all.map((x) => (x.key === key ? { ...x, path: d.path!, name: d.name || x.name } : x)))
      })
      .catch((e: unknown) => {
        setDrafts((all) => all.filter((x) => x.key !== key))
        say(`Not attached: ${name} (${e instanceof Error ? e.message : "failed"})`, true)
      })
  }
  const addFiles = (list: File[]) => {
    if (!agent) { say("Pick an agent first.", true); return }
    const room = ATTACH_MAX - drafts.length
    if (list.length > room) say(`A message carries ${ATTACH_MAX} files at most.`, true)
    else say("")
    list.slice(0, Math.max(0, room)).forEach(upload)
  }
  const onFiles = (e: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = "" }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length) { e.preventDefault(); addFiles(files) }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) { e.preventDefault(); addFiles(files) }
  }

  const sendNow = async (message: string, spoken?: boolean): Promise<boolean> => {
    const words = message.trim() || (ready.length ? filesOnlyText(ready.length) : "")
    if (!words || !agent || busy || uploading) return false
    const ok = await onSend({ message: words, attachments: ready.length ? ready : undefined, model: model || undefined, spoken: spoken || undefined })
    if (ok) { setDrafts([]); say("") }
    return ok
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const was = text
    setText("")
    void sendNow(was).then((ok) => { if (!ok) setText((t) => t || was) })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) submit() }
  }

  // --- The mic: record, write it down, then send it or leave it in the box ---
  const toggleCheck = () => {
    const v = !checkFirst
    setCheckFirst(v)
    try { localStorage.setItem(CHECK_KEY, v ? "1" : "0") } catch { /* kept for this page only */ }
    say(v ? "Recordings now wait in the box for you to send." : "Recordings now send when you stop.")
  }
  const stopRec = () => { const c = rec.current; if (c) { clearTimeout(c.timer); if (c.r.state !== "inactive") c.r.stop() } }
  const finish = async () => {
    const c = rec.current
    rec.current = null
    setRecording(false)
    if (!c) return
    c.stream.getTracks().forEach((t) => t.stop())
    const type = c.r.mimeType || "audio/webm"
    const blob = new Blob(c.chunks, { type })
    if (!blob.size) { say("Nothing was recorded.", true); return }
    setLastUrl(URL.createObjectURL(blob))
    say("Writing it down…")
    try {
      const d = await postRaw<{ text?: string }>("/api/assistant/voice/transcribe", blob, type.split(";")[0], { "X-Audio-Duration-Ms": String(Date.now() - c.at) })
      if (!d.text) throw new Error("no words")
      if (checkFirst) {
        setText((t) => (t.trim() ? t.trim() + " " + d.text : d.text!))
        box.current?.focus()
        say("Check it, then send.")
        return
      }
      say("")
      await sendNow(d.text, true)
    } catch (e) {
      say("Not written down: " + (e instanceof Error ? e.message : "failed"), true)
    }
  }
  const startRec = () => {
    if (!agent) { say("Pick an agent first.", true); return }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const r = new MediaRecorder(stream)
      const c = { r, stream, chunks: [] as Blob[], at: Date.now(), timer: setTimeout(stopRec, MAX_REC_MS) }
      r.addEventListener("dataavailable", (e) => { if (e.data?.size) c.chunks.push(e.data) })
      r.addEventListener("stop", () => { void finish() })
      rec.current = c
      r.start()
      setRecording(true)
      say(checkFirst ? "Recording… press the mic again to stop." : "Recording… press the mic again to send.")
    }).catch(() => say("The browser did not give the microphone.", true))
  }
  const play = () => {
    if (!lastUrl) return
    new Audio(lastUrl).play().catch(() => say("Could not play the recording.", true))
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-[760px] shrink-0 px-4 pb-4" data-shell="composer">
      <div
        onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault() }} onDrop={onDrop}
        className={cn(
          "flex flex-col gap-1.5 rounded-2xl border border-input bg-card px-3 py-2.5 shadow-[0_1px_0_var(--ax-border),0_8px_24px_rgba(10,20,40,.06)] transition-[border-color,box-shadow] duration-150",
          "focus-within:border-[var(--ax-blue-e)]",
          recording && "border-[var(--ax-blue-d)] shadow-[0_0_0_4px_var(--ax-blue-t)]",
        )}
        data-live={recording ? "true" : undefined}
      >
        {agent ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ax-blue-t)] py-0.5 pl-0.5 pr-2.5 font-semibold text-foreground" data-shell="to">
              <span aria-hidden="true" className="grid size-[18px] place-items-center rounded-md bg-[var(--ax-blue-d)] text-[10.5px] font-bold text-white">{agent.name.charAt(0).toUpperCase()}</span>
              To {agent.name}
            </span>
          </div>
        ) : null}
        {drafts.length ? (
          <div className="flex flex-wrap gap-1.5" data-shell="files-draft">
            {drafts.map((d) => (
              <span key={d.key} className={cn("inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs", !d.path && "text-muted-foreground")}>
                {d.name}{d.path ? "" : " …"}
                <button type="button" aria-label={"Remove " + d.name} className="ml-0.5 text-muted-foreground hover:text-foreground" onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))}>
                  <Icon name="x" className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={box} rows={1} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
          disabled={!agent} aria-label={agent ? `Message ${agent.name}` : "Message"}
          placeholder={agent ? `Message ${agent.name}…` : "Pick an agent first"}
          className="block max-h-40 min-h-[30px] w-full resize-none bg-transparent px-0.5 pb-1.5 pt-1 text-base leading-snug outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        />
        <div className="flex items-center gap-2">
          <button type="button" className={round} aria-label="Attach files" title="Attach files" disabled={!agent} onClick={() => fileInput.current?.click()}>
            <Icon name="plus" />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
          {!agent ? null : choices.length ? (
            <select
              aria-label="Model" title="Model for this message" value={model} onChange={(e) => pickModel(e.target.value)}
              className="max-w-[40%] cursor-pointer truncate rounded-lg bg-transparent px-1.5 py-1 text-[12.5px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-shell="model"
            >
              <option value="">{ownModelLabel(agent.model, choices)}</option>
              {choices.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
          ) : agent.model ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="max-w-[40%] truncate px-1.5 font-mono text-[11.5px] text-muted-foreground" data-shell="model">{agent.model}</span>
              </TooltipTrigger>
              <TooltipContent>This agent runs on its own model</TooltipContent>
            </Tooltip>
          ) : null}
          <span className="ml-auto" />
          {canRecord ? (
            <>
              <button
                type="button" className={cn(round, recording && "border-transparent bg-[var(--ax-red-t)] text-err-ink hover:bg-[var(--ax-red-t)]")}
                aria-label="Record a voice message" aria-pressed={recording} title="Record a voice message" disabled={!agent}
                onClick={() => (recording ? stopRec() : startRec())}
              >
                <Icon name="mic" />
              </button>
              <button
                type="button" className={cn(round, checkFirst && "border-transparent bg-[var(--ax-blue-t)] text-[var(--ax-blue-d)]")}
                aria-label="Check before sending" aria-pressed={checkFirst} onClick={toggleCheck}
                title={checkFirst ? "Check before sending: on. Your words go in the box; you send them." : "Check before sending: off. A recording sends when you stop."}
              >
                <Icon name="pencil-line" />
              </button>
              {lastUrl ? (
                <button type="button" className={round} aria-label="Hear my message" title="Hear my message" onClick={play}>
                  <Icon name="play" />
                </button>
              ) : null}
            </>
          ) : null}
          {onStop ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="Stop" disabled={busy} onClick={onStop} className={send} data-shell="stop">
                  <Icon name="square" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Stop</TooltipContent>
            </Tooltip>
          ) : (
            <button type="submit" aria-label="Send" title="Send (Enter)" disabled={!canSend} className={send}>
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
      {children}
      {note ? <p role={note.err ? "alert" : "status"} className={cn("mt-1 px-1 text-xs", note.err ? "text-err-ink" : "text-muted-foreground")} data-shell="note">{note.text}</p> : null}
    </form>
  )
}
