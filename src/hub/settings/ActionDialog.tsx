// --- Settings › Actions: add or edit one (#2101 ST2a) ---
//
// The old form (wall-settings-actions.client.ts) in a dialog, as the mock
// draws it: the kind first (Shell command or Web call), id and title, the
// command or the address, the inputs; working folder, headers, body and
// timeout under Advanced. One POST actions saves it whole.
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger, cn,
} from "../ui"
import { inputsText, parseInputs, type ActionDef } from "./agent-data"
import { AGENT_ID } from "./data"
import { Disclosed, save } from "./GeneralPane"
import { inputClass } from "./fields"

const METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"]
interface Form { kind: "shell" | "http"; id: string; title: string; description: string; command: string; method: string; url: string; inputs: string; cwd: string; headers: string; body: string; timeout: string }

function formOf(a: ActionDef | null): Form {
  return {
    kind: a?.kind ?? "shell", id: a?.id ?? "", title: a?.title ?? "", description: a?.description ?? "", command: a?.command ?? "",
    method: a?.method ?? "POST", url: a?.url ?? "", inputs: inputsText(a?.inputs), cwd: "", headers: "", body: "", timeout: String(a?.timeoutMs ?? 30000),
  }
}

export function ActionDialog({ open, onOpenChange, action, isNew, taken }: { open: boolean; onOpenChange: (v: boolean) => void; action: ActionDef | null; isNew: boolean; taken: string[] }) {
  const client = useQueryClient()
  const [f, setF] = useState<Form>(() => formOf(action))
  const [more, setMore] = useState(false)
  const [error, setError] = useState<{ field?: keyof Form; text: string } | null>(null)
  useEffect(() => { if (open) { setF(formOf(action)); setError(null); setMore(false) } }, [open, action])
  const set = (k: keyof Form, v: string) => { setF((x) => ({ ...x, [k]: v })); setError(null) }
  const put = useMutation({
    mutationFn: (body: Record<string, unknown>) => save("POST", "/api/admin/wall/settings/actions", body),
    onSuccess: () => { onOpenChange(false); return client.invalidateQueries({ queryKey: ["settings", "state"] }) },
    onError: (e) => setError({ text: "Not saved: " + (e as Error).message }),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const id = f.id.trim(), title = f.title.trim()
    if (!id) return setError({ field: "id", text: "Give it an id." })
    if (!AGENT_ID.test(id)) return setError({ field: "id", text: "Use lowercase letters, digits, - and _." })
    if (isNew && taken.includes(id)) return setError({ field: "id", text: `${id} already exists.` })
    if (!title) return setError({ field: "title", text: "Give it a title." })
    const body: Record<string, unknown> = { id, title, kind: f.kind, inputs: parseInputs(f.inputs), timeoutMs: parseInt(f.timeout, 10) || 30000 }
    if (f.description.trim()) body.description = f.description.trim()
    if (f.kind === "shell") {
      if (!f.command.trim()) return setError({ field: "command", text: "A shell action needs a command." })
      body.command = f.command.trim()
      if (f.cwd.trim()) body.cwd = f.cwd.trim()
    } else {
      if (!f.url.trim()) return setError({ field: "url", text: "A web call needs an address." })
      body.url = f.url.trim()
      body.method = f.method
      if (f.headers.trim()) {
        try { body.headers = JSON.parse(f.headers) } catch { setMore(true); return setError({ field: "headers", text: "The headers are not a JSON object." }) }
      }
      if (f.body) body.body = f.body
    }
    put.mutate(body)
  }
  const field = (k: keyof Form, label: string, o: { mono?: boolean; ph?: string; help?: ReactNode; area?: boolean } = {}) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">{label}
      {o.area
        ? <textarea rows={3} className={cn(inputClass, "h-auto w-full py-2", o.mono && "font-mono")} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={o.ph} aria-invalid={error?.field === k} />
        : <input className={cn(inputClass, "h-9 w-full", o.mono && "font-mono")} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={o.ph} autoComplete="off" aria-invalid={error?.field === k} autoFocus={k === "id" && isNew} />}
      {o.help && <span className="text-xs text-muted-foreground">{o.help}</span>}
    </label>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add action" : "Edit " + (action?.title ?? "")}</DialogTitle>
          <DialogDescription>{isNew ? "Workflows call it by its id." : "Saving replaces it: write its working folder, headers or body again under Advanced if it has them."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Tabs value={f.kind} onValueChange={(v) => set("kind", v)}>
            <TabsList aria-label="Kind" className="w-full">
              <TabsTrigger value="shell" className="flex-1">Shell command</TabsTrigger>
              <TabsTrigger value="http" className="flex-1">Web call</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-col gap-3 sm:flex-row">
            {field("id", "Id", { mono: true, ph: "deploy-staging", help: "Workflows call it by this." })}
            {field("title", "Title", { ph: "Deploy staging" })}
          </div>
          {field("description", "Description", { ph: "Build, push, restart staging" })}
          {f.kind === "shell" ? field("command", "Command", { mono: true, ph: "git pull && make deploy VERSION={{version}}", help: "Runs on this machine." }) : (
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex flex-col gap-1 text-sm">Method
                <Select value={f.method} onValueChange={(v) => set("method", v)}>
                  <SelectTrigger className="h-9 w-28 font-mono text-xs" aria-label="Method"><SelectValue /></SelectTrigger>
                  <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {field("url", "Address", { mono: true, ph: "https://api.example.com/deploy" })}
            </div>
          )}
          {field("inputs", "Inputs", { mono: true, ph: "version:string!, dryRun:boolean", help: "name:type, comma separated; ! marks a required one." })}
          <Disclosed open={more} onOpenChange={setMore}>
            {f.kind === "shell" ? field("cwd", "Working folder", { mono: true, ph: "/srv/staging" }) : <>
              {field("headers", "Headers", { mono: true, ph: '{"Authorization":"Bearer $DEPLOY_TOKEN"}', help: "A JSON object. A secret goes in as its $VAR." })}
              {field("body", "Body", { mono: true, area: true, ph: '{"version":"{{version}}"}', help: "A template. Skipped on GET and DELETE." })}
            </>}
            {field("timeout", "Timeout", { mono: true, help: "Milliseconds." })}
          </Disclosed>
          {error && <p role="alert" className="text-xs text-destructive">{error.text}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={put.isPending}>{put.isPending ? "Saving…" : isNew ? "Add action" : "Save action"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
