// --- Settings › Actions (#2101 ST2a) ---
//
// The mock's Actions (shots/2101-settings-mocks, settings/actions.html): the
// registered shell commands and web calls workflows run by id, each with
// its inputs and the workflows that run it, Run to try one here, and Edit,
// Duplicate and Remove in its `…`. The old Settings' calls
// (wall-settings-actions.client.ts): /api/admin/state lists them, POST and
// DELETE actions save and remove, POST actions/run runs one. Which workflow
// runs one comes from /api/workflows (an `actionId` in a node's config).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiGet } from "../api"
import { Badge, Button, Icon, Switch, cn } from "../ui"
import { ActionDialog } from "./ActionDialog"
import { actionUsers, type ActionDef, type AgentState } from "./agent-data"
import { save, useGeneralData } from "./GeneralPane"
import { ConfirmDialog, RowMenu, inputClass } from "./fields"
import { ErrorLine, PaneHeader, SettingsGroup, SettingsItem, SkeletonRows } from "./parts"
import { paneDef } from "./panes"

const PANE = "actions"

export default function ActionsPane() {
  const client = useQueryClient()
  const { state } = useGeneralData()
  const workflows = useQuery({ queryKey: ["settings", "workflows"], queryFn: () => apiGet<{ workflows?: Parameters<typeof actionUsers>[0] }>("/api/workflows") })
  const users = actionUsers(workflows.data?.workflows)
  const list = (state.data as AgentState | undefined)?.actions ?? []
  const [running, setRunning] = useState("")
  const [editing, setEditing] = useState<{ action: ActionDef | null; copy?: boolean } | null>(null)
  const [removing, setRemoving] = useState<ActionDef | null>(null)
  const add = <Button variant="outline" size="sm" data-row="add-action" onClick={() => setEditing({ action: null })}><Icon name="plus" className="size-3.5" />Add action</Button>
  const usedBy = (id: string) => users.get(id) ?? []
  return (
    <>
      <PaneHeader pane={paneDef(PANE)} action={add} />
      <SettingsGroup
        pane={PANE} row="actions" title={state.data ? (list.length === 1 ? "1 action" : `${list.length} actions`) : "Actions"}
        help={<>Inputs fill <span className="font-mono">{"{{name}}"}</span>; <span className="font-mono">$VAR</span> comes from the daemon's environment.</>}
      >
        {state.isPending ? <SkeletonRows /> : state.isError ? (
          <ErrorLine text={`Could not read the actions: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
        ) : list.length === 0 ? (
          <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">No actions yet.<Button variant="outline" size="sm" onClick={() => setEditing({ action: null })}>Add action</Button></div>
        ) : list.map((a) => {
          const open = running === a.id
          const by = usedBy(a.id)
          return (
            <SettingsItem
              key={a.id} id={"action-" + a.id}
              lead={<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center self-start rounded-md border border-border bg-muted text-muted-foreground"><Icon name={a.kind === "shell" ? "square-terminal" : "globe"} className="size-3.5" /></span>}
              name={<>{a.title}<span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{a.id}</span></>}
              meta={<>
                <span className="w-full truncate font-mono text-xs text-foreground/80">{a.kind === "shell" ? a.command : `${a.method || "POST"} ${a.url}`}</span>
                {a.inputs?.length ? a.inputs.map((i) => <Badge key={i.name} variant="secondary" className="rounded-sm px-1.5 py-0 font-mono text-[11px] font-normal">{i.name}{i.required ? "*" : ""}: {i.type}</Badge>) : <span>No inputs</span>}
                <span aria-hidden="true">·</span>
                {workflows.isSuccess ? (by.length ? <span>used by <span className="font-mono text-xs">{by.join(", ")}</span></span> : <span>no workflow uses it</span>) : null}
                {open && <RunPanel action={a} />}
              </>}
              control={<Button variant={open ? "ghost" : "outline"} size="sm" aria-expanded={open} onClick={() => setRunning(open ? "" : a.id)}>{!open && <Icon name="play" className="size-3.5" />}{open ? "Close" : "Run"}</Button>}
              menu={<RowMenu name={a.title} items={[
                { label: "Edit", icon: "pencil", onSelect: () => setEditing({ action: a }) },
                { label: "Duplicate", icon: "copy", onSelect: () => setEditing({ action: { ...a, id: a.id + "-copy", title: a.title + " copy" }, copy: true }) },
                { label: "Remove", icon: "trash-2", destructive: true, onSelect: () => setRemoving(a) },
              ]} />}
            />
          )
        })}
      </SettingsGroup>
      <ActionDialog
        open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null) }} action={editing?.action ?? null} isNew={!editing?.action || !!editing?.copy}
        taken={list.map((a) => a.id)}
      />
      <ConfirmDialog
        open={!!removing} onOpenChange={(v) => { if (!v) setRemoving(null) }}
        title={`Remove ${removing?.title ?? ""}?`} action={"Remove " + (removing?.id ?? "")}
        body={removing && usedBy(removing.id).length ? `${usedBy(removing.id).join(", ")} call${usedBy(removing.id).length === 1 ? "s" : ""} ${removing.id} and fail${usedBy(removing.id).length === 1 ? "s" : ""} until it is back.` : "No workflow calls it."}
        run={async () => { await save("DELETE", "/api/admin/wall/settings/actions", { id: removing!.id }); await client.invalidateQueries({ queryKey: ["settings", "state"] }) }}
      />
    </>
  )
}

interface RunResult { ok?: boolean; status?: number; durationMs?: number; output?: string; errors?: string }

/** Run one now with its inputs, and show what it printed. */
function RunPanel({ action: a }: { action: ActionDef }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries((a.inputs ?? []).map((i) => [i.name, i.type === "boolean" ? String(i.defaultValue) === "true" : i.defaultValue != null ? String(i.defaultValue) : ""])))
  const run = useMutation({
    mutationFn: () => {
      const inputs: Record<string, string | boolean> = {}
      for (const [k, v] of Object.entries(values)) if (v !== "") inputs[k] = v
      return save("POST", "/api/admin/wall/settings/actions/run", { id: a.id, inputs }) as Promise<{ result?: RunResult }>
    },
  })
  const r = run.data?.result
  const out = r ? [r.output, r.errors && (r.output ? "--- stderr ---\n" : "") + r.errors].filter(Boolean).join("\n") || "(no output)" : ""
  return (
    <span data-slot="action-run" className="mt-2 flex w-full flex-col gap-3 rounded-lg border border-border bg-muted/50 p-3 text-foreground">
      {(a.inputs ?? []).map((i) => (
        <span key={i.name} className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs">{i.name}{i.required && <span className="ml-1.5 font-sans text-muted-foreground">required</span>}</span>
          {i.type === "boolean"
            ? <Switch checked={!!values[i.name]} onCheckedChange={(v) => setValues((x) => ({ ...x, [i.name]: v }))} aria-label={i.name} />
            : <input aria-label={i.name} type={i.type === "number" ? "number" : "text"} placeholder={i.description || i.name} value={String(values[i.name] ?? "")}
                onChange={(e) => setValues((x) => ({ ...x, [i.name]: e.target.value }))} className={cn(inputClass, "w-40 font-mono")} />}
        </span>
      ))}
      {!a.inputs?.length && <span className="text-xs text-muted-foreground">No inputs: it runs as written.</span>}
      <span><Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>Run now</Button></span>
      {run.isPending && <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="loader-circle" className="size-3.5 animate-spin motion-reduce:animate-none" />Running…</span>}
      {run.isError && <span role="alert" className="text-xs text-destructive">Not run: {(run.error as Error).message}</span>}
      {r && <>
        <span role="status"><Badge variant={r.ok ? "ok" : "err"}>{r.ok ? "Done" : "Failed"} · {a.kind === "shell" ? "exit" : "HTTP"} {r.status} · {((r.durationMs ?? 0) / 1000).toFixed(1)} s</Badge></span>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{out}</pre>
      </>}
    </span>
  )
}
