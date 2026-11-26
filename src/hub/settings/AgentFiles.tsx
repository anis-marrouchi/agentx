// --- Settings › Agent › Personality and Skills (#2101 ST2a) ---
//
// The files in the agent's workspace, as the old page lists them
// (GET /api/admin/files): its instruction files (Personality) and its
// skills (Skills). Edit opens the file in a dialog (files/read, then PUT
// files); a skill is added or deleted with files/skill. Up to 200 KB a file.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { apiGet } from "../api"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, cn } from "../ui"
import type { AgentConfig } from "./agent-data"
import { save } from "./GeneralPane"
import { ConfirmDialog, ErrorLine, INPUT, RowMenu, SettingsGroup, SettingsItem, SkeletonRows } from "./parts"

const PANE = "agent"
interface FileList {
  identity?: { path: string; title: string; size: number; exists: boolean }[]
  skills?: { slug: string; title: string; size: number; path: string }[]
}

export function fmtBytes(n: number): string {
  return !n ? "0 B" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1).replace(/\.0$/, "") + " KB" : (n / 1048576).toFixed(2) + " MB"
}

export function FilesTab({ agent: a, part }: { agent: AgentConfig; part: "identity" | "skills" }) {
  const client = useQueryClient()
  const key = ["settings", "files", a.id]
  const files = useQuery({ queryKey: key, queryFn: () => apiGet<FileList>("/api/admin/files?agent=" + encodeURIComponent(a.id)) })
  const [editing, setEditing] = useState("")
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState("")
  const refresh = () => client.invalidateQueries({ queryKey: key })
  const skills = part === "skills"
  const body = files.isPending ? <SkeletonRows /> : files.isError ? (
    <ErrorLine text={`Could not list the files: ${(files.error as Error).message}`} onRetry={() => files.refetch()} />
  ) : skills ? (
    files.data.skills?.length ? files.data.skills.map((s) => (
      <SettingsItem
        key={s.slug} id={"skill-" + s.slug}
        name={<span className="font-mono text-[13px] font-normal">{s.slug}</span>}
        meta={s.title !== s.slug ? s.title : fmtBytes(s.size)}
        control={<Button variant="ghost" size="sm" onClick={() => setEditing(s.path)}>Edit</Button>}
        menu={<RowMenu label={s.slug} items={[{ label: "Delete", icon: "trash-2", destructive: true, onSelect: () => setRemoving(s.slug) }]} />}
      />
    )) : <Empty text="No skills yet." action={<Button variant="outline" size="sm" onClick={() => setAdding(true)}>Add skill</Button>} />
  ) : (
    files.data.identity?.length ? files.data.identity.map((f) => (
      <SettingsItem
        key={f.path} id={"file-" + f.path}
        name={<span className="font-mono text-[13px] font-normal">{f.path}</span>}
        meta={<>{f.title && f.title !== f.path && <><span>{f.title}</span><span aria-hidden="true">·</span></>}<span>{f.exists ? fmtBytes(f.size) : "not made yet"}</span></>}
        control={<Button variant="outline" size="sm" onClick={() => setEditing(f.path)}>{f.exists ? "Edit" : "Create"}</Button>}
      />
    )) : <Empty text="No instruction files in its workspace." />
  )
  return (
    <>
      <SettingsGroup
        pane={PANE} row={skills ? "skills" : "files"}
        help={skills ? <>What <span className="font-mono">@{a.id}</span> knows how to do: one folder with a SKILL.md each.</> : <>The files that tell <span className="font-mono">@{a.id}</span> who it is, in its workspace.</>}
        action={skills ? <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Icon name="plus" className="size-3.5" />Add skill</Button> : undefined}
      >
        {body}
      </SettingsGroup>
      <FileDialog agent={a.id} path={editing} onClose={() => setEditing("")} onSaved={refresh} />
      {skills && <AddSkillDialog open={adding} onOpenChange={setAdding} agent={a.id} onAdded={(p) => { refresh(); setEditing(p) }} />}
      <ConfirmDialog
        open={!!removing} onOpenChange={(v) => { if (!v) setRemoving("") }}
        title={`Delete the skill ${removing}?`} text="Its folder and SKILL.md are removed from the agent's workspace." yes="Delete skill"
        run={async () => { await save("DELETE", "/api/admin/wall/settings/files/skill", { agent: a.id, slug: removing }); await refresh() }}
      />
    </>
  )
}

function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">{text}{action}</div>
}

/** One file, read and saved whole. */
function FileDialog({ agent, path, onClose, onSaved }: { agent: string; path: string; onClose: () => void; onSaved: () => void }) {
  const file = useQuery({
    queryKey: ["settings", "file", agent, path], enabled: !!path, gcTime: 0,
    queryFn: () => apiGet<{ content?: string }>(`/api/admin/files/read?agent=${encodeURIComponent(agent)}&path=${encodeURIComponent(path)}`),
  })
  const [text, setText] = useState<string | null>(null)
  useEffect(() => { setText(null) }, [path])
  const value = text ?? file.data?.content ?? ""
  const put = useMutation({
    mutationFn: () => save("PUT", "/api/admin/wall/settings/files", { agent, path, content: value }),
    onSuccess: () => { onSaved(); onClose() },
  })
  return (
    <Dialog open={!!path} onOpenChange={(v) => { if (!v) { onClose(); put.reset() } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{path}</DialogTitle>
          <DialogDescription>In the workspace of @{agent}. Up to 200 KB.</DialogDescription>
        </DialogHeader>
        {file.isPending ? <SkeletonRows /> : file.isError ? <p role="alert" className="text-sm text-destructive">Could not open it: {(file.error as Error).message}</p> : (
          <textarea
            aria-label={path} rows={16} spellCheck={false} value={value} onChange={(e) => setText(e.target.value)}
            className={cn(INPUT, "h-auto w-full resize-y py-2 font-mono text-xs leading-5 md:text-xs")}
          />
        )}
        {put.isError && <p role="alert" className="text-xs text-destructive">Not saved: {(put.error as Error).message}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={file.isPending || file.isError || put.isPending || text === null} onClick={() => put.mutate()}>{put.isPending ? "Saving…" : "Save file"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddSkillDialog({ open, onOpenChange, agent, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; agent: string; onAdded: (path: string) => void }) {
  const [slug, setSlug] = useState("")
  const [title, setTitle] = useState("")
  const add = useMutation({
    mutationFn: () => save("POST", "/api/admin/wall/settings/files/skill", { agent, slug: slug.trim(), title: title.trim() }) as Promise<{ path?: string }>,
    onSuccess: (r) => { close(false); if (r.path) onAdded(r.path) },
  })
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setSlug(""); setTitle(""); add.reset() } }
  const submit = (e: FormEvent) => { e.preventDefault(); if (slug.trim()) add.mutate() }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add skill</DialogTitle>
          <DialogDescription>A folder with a SKILL.md in @{agent}'s workspace, made from a template you then edit.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <label className="flex flex-col gap-1 text-sm">Slug
            <input autoFocus className={cn(INPUT, "h-9 w-full font-mono")} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="weekly-report" autoComplete="off" />
            <span className="text-xs text-muted-foreground">Lowercase letters, digits and -</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">Title
            <input className={cn(INPUT, "h-9 w-full")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Write the weekly report" />
          </label>
          {add.isError && <p role="alert" className="text-xs text-destructive">Not added: {(add.error as Error).message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={!slug.trim() || add.isPending}>{add.isPending ? "Adding…" : "Add skill"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
