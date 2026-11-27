// --- Projects in the simple shell (#2454) ---
//
// The centre's Projects pane: each project with its open work (open, in
// progress, blocked, stalled) and a link to its tasks, and the one way to
// add a project: the Add project button, which opens a dialog for its name
// and the repos and agents whose work is its work (projects.ts). The page
// says how a project is made, empty or not, so nobody has to edit
// agentx.json by hand.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { apiGet, apiPost } from "../api"
import { PROJECT_ADD_URL, projectAddBody, projectState, projectTasksHref, type ProjectRow, type ProjectState, type ProjectsReply } from "../projects"
import { FormDialog, type Invalid } from "../settings/dialogs"
import { Field, dialogInput } from "../settings/fields"
import { TASKS_URL } from "../tasks"
import { Badge, Button, EmptyState, Icon, Skeleton, toast } from "../ui"

const BADGE: Record<ProjectState, { word: string; variant: "err" | "warn" | "ok" | "outline" }> = {
  stalled: { word: "Stalled", variant: "err" }, blocked: { word: "Blocked", variant: "warn" }, moving: { word: "Moving", variant: "ok" }, quiet: { word: "No open work", variant: "outline" },
}

/** How a project is made, in one line (the empty and the filled page). */
export const PROJECT_HELP = "A project gathers the work of its repos and agents. Add one with its repo (group/project) or the agents that work on it."

const cols = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_56px_88px_64px_64px_112px]"

/** One row: the name (to its tasks), its counts and its state. */
export function ProjectLine({ r }: { r: ProjectRow }) {
  const st = BADGE[projectState(r)]
  const name = r.project ?? "Other"
  const n = (v: number) => <span className="hidden text-xs tabular-nums sm:block">{v}</span>
  return (
    <a
      href={projectTasksHref(r.project ?? "")} data-project={name}
      className={`grid ${cols} items-center gap-x-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="folder" className="size-3.5 text-muted-foreground" />
        <span className={r.project ? "truncate text-[13px] font-medium" : "truncate pr-0.5 text-[13px] italic text-muted-foreground"}>{name}</span>
        <span className="truncate text-xs text-muted-foreground sm:hidden">{r.open} open</span>
      </span>
      {n(r.open)}{n(r.inProgress)}{n(r.blocked)}{n(r.stalled)}
      <span className="justify-self-end"><Badge variant={st.variant}>{st.word}</Badge></span>
    </a>
  )
}

export interface ProjectsBodyProps {
  rows?: ProjectRow[]
  error?: string | null
  onRetry?: () => void
  /** The Add project button, for the owner; none for a guest. */
  add?: ReactNode
}

/** Loading, error, empty (with how to add one), or the list. */
export function ProjectsBody({ rows, error, onRetry, add }: ProjectsBodyProps) {
  if (error) {
    return (
      <EmptyState title="Could not read the projects" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}</span>
      </EmptyState>
    )
  }
  if (!rows) return <div className="flex flex-col gap-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>
  if (!rows.length) return <EmptyState icon="folder" title="No projects yet" action={add}>{PROJECT_HELP}</EmptyState>
  return (
    <div data-projects="list" className="flex flex-col gap-2">
      <p className="px-1 text-xs text-muted-foreground" data-projects="help">{PROJECT_HELP}</p>
      <div className="rounded-md border border-border">
        <div aria-hidden="true" className={`hidden ${cols} gap-x-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:grid`}>
          <span className="pl-[22px]">Project</span><span>Open</span><span>In progress</span><span>Blocked</span><span>Stalled</span><span />
        </div>
        {rows.map((r) => <ProjectLine key={r.project ?? "\0other"} r={r} />)}
      </div>
    </div>
  )
}

/** The Add project dialog: a name, then its repos and agents. */
export function AddProjectDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: (name: string) => void }) {
  const [f, setF] = useState({ name: "", repos: "", agents: "" })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const submit = async (): Promise<Invalid> => {
    const read = projectAddBody(f)
    if ("problem" in read) return { field: read.field, text: read.problem }
    await apiPost(PROJECT_ADD_URL, read.body)
    setF({ name: "", repos: "", agents: "" })
    onAdded(read.body.name)
  }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add project" description="Work on its repos, or by its agents, is counted under it." submit="Add project" onSubmit={submit}>
      <Field label="Name"><input className={dialogInput} value={f.name} onChange={set("name")} placeholder="Shop" autoComplete="off" autoFocus /></Field>
      <Field label="Repos" help="group/project on GitLab or GitHub, comma separated."><input className={dialogInput + " font-mono"} value={f.repos} onChange={set("repos")} placeholder="example/shop" autoComplete="off" spellCheck={false} /></Field>
      <Field label="Agents" help="Agent ids, comma separated. Optional when a repo is named."><input className={dialogInput + " font-mono"} value={f.agents} onChange={set("agents")} placeholder="coder" autoComplete="off" spellCheck={false} /></Field>
    </FormDialog>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

/** The pane: the same Wall read as Tasks (one request for both). */
export function ProjectsPane({ owner, phoneBar }: { owner: boolean; phoneBar?: ReactNode }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const list = useQuery({
    queryKey: ["shell-tasks"],
    queryFn: () => apiGet<ProjectsReply>(TASKS_URL),
    refetchInterval: (q) => ((q.state.data as ProjectsReply | undefined)?.pending ? 2000 : 30_000),
  })
  const rows = list.data ? list.data.projects ?? [] : undefined
  const addButton = owner ? <Button size="sm" onClick={() => setAdding(true)} data-projects="add"><Icon name="plus" />Add project</Button> : undefined
  const onAdded = (name: string) => { toast.success(`Added ${name}.`); void qc.invalidateQueries({ queryKey: ["shell-tasks"] }) }
  return (
    <section aria-label="Projects" data-shell="projects" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">Projects</h1>
        {rows ? <span className="text-xs tabular-nums text-muted-foreground">{rows.filter((r) => r.project !== null).length}</span> : null}
        {/* flex-1, not ml-auto: the phone bar's panel button has ml-auto too, which would split the space. */}
        {addButton && rows?.length ? <span className="flex flex-1 justify-end">{addButton}</span> : null}
      </header>
      <div className="mx-auto min-h-0 w-full max-w-[880px] flex-1 overflow-y-auto px-4 py-4">
        <ProjectsBody rows={rows} error={list.isError ? errText(list.error) : null} onRetry={() => void list.refetch()} add={addButton} />
      </div>
      {owner ? <AddProjectDialog open={adding} onOpenChange={setAdding} onAdded={onAdded} /> : null}
    </section>
  )
}
