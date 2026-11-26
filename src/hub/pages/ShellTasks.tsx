// --- Tasks in the simple shell (#2226 S4) ---
//
// The centre's Tasks pane: the forges' open issues and PRs and the requests
// the old Hub's feed lists, as a List or a Kanban (columns in tasks.ts).
// Opening a request shows its timeline (runs, hand-offs, comments) in the
// same pane, from the same read the old Hub's opened post makes; an issue or
// PR opens on its forge. Read only: no state changes here. A failed read
// keeps what was shown, with the reason in a line above it.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { apiFetch, apiGet } from "../api"
import { buildHash, navigate } from "../router"
import {
  FORGE_TASKS_URL, TASKS_URL, forgePosts, forgeUnread, mergeTasks, shortAgo, taskProjects, taskTone, taskPosts, taskStateLabel, taskThreadUrl, tasksByLane, tasksOfProject,
  type TaskEvent, type TaskLane, type TaskPost, type TaskThreadReply, type TasksReply, type TasksView,
} from "../tasks"
import type { ForgeTasksReply } from "../../daemon/hub-forge-tasks"
import { Badge, Button, EmptyState, Icon, Skeleton, StatusDot, cn } from "../ui"

/** A task's address in the shell; the project filter goes along. */
export const taskHref = (id?: string, project?: string | null) => buildHash({ page: "home", pane: "tasks", project, open: id })

const LANE_TOP: Record<TaskLane["tone"], string> = {
  work: "border-t-primary", warn: "border-t-warn", idle: "border-t-border", err: "border-t-destructive", ok: "border-t-ok",
}


/** List or Kanban: two pressed-state buttons, the choice kept by the caller. */
export function TasksViewSwitch({ view, onView, className, compact }: { view: TasksView; onView: (v: TasksView) => void; className?: string; compact?: boolean }) {
  const item = (v: TasksView, label: string, icon: string) => (
    <button
      type="button" aria-pressed={view === v} data-tasks-view={v} onClick={() => onView(v)}
      aria-label={compact ? label : undefined} title={compact ? label : undefined}
      className={cn(
        "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === v ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5" />{compact ? null : label}
    </button>
  )
  return (
    <div role="group" aria-label="Tasks view" data-shell="tasks-switch" className={cn("flex gap-0.5 rounded-md bg-muted p-0.5", className)}>
      {item("list", "List", "list")}
      {item("kanban", "Kanban", "kanban")}
    </div>
  )
}

/** The project filter: all projects, or one the tasks name. The pick is
 *  in the address (`project=`), so Back and a shared link keep it. */
export function TasksProjectFilter({ projects, project, className }: { projects: string[]; project: string | null; className?: string }) {
  // A project picked from a link that no task names now still shows, so the filter says what is applied.
  const list = project && !projects.includes(project) ? [project, ...projects] : projects
  return (
    <label className={cn("relative inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground focus-within:ring-2 focus-within:ring-ring", className)}>
      <Icon name="folder" className="size-3.5" />
      <select
        aria-label="Project" data-shell="tasks-project" value={project ?? ""}
        onChange={(e) => navigate({ page: "home", pane: "tasks", project: e.target.value || null })}
        className="max-w-[96px] cursor-pointer sm:max-w-[160px] appearance-none truncate bg-transparent pr-1 text-foreground outline-none"
      >
        <option value="">All projects</option>
        {list.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>
  )
}

/** Where a task opens: an issue or PR on its forge, a request in the pane. */
const taskLink = (p: TaskPost, project?: string | null) =>
  p.forge ? { href: p.forge.url, target: "_blank", rel: "noreferrer" } : { href: taskHref(p.id, project) }

const KIND: Record<string, { icon: string; label: string }> = {
  issue: { icon: "circle-dot", label: "Issue" }, pr: { icon: "git-pull-request", label: "Pull request" }, request: { icon: "bot", label: "Request" },
}

/** What the task is: an issue, a pull request, or a request to an agent. */
function TaskKind({ post }: { post: TaskPost }) {
  const k = KIND[post.forge?.kind ?? "request"]
  return <span data-task-kind={post.forge?.kind ?? "request"} title={k.label} className="inline-flex text-muted-foreground"><Icon name={k.icon} className="size-3.5" /><span className="sr-only">{k.label}</span></span>
}

function TaskMeta({ post }: { post: TaskPost }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {post.owner ? <span className="truncate">@{post.owner}</span> : null}
      {post.project ? <span className="truncate font-mono text-[11px]">{post.project}{post.forge?.ref ?? ""}</span> : null}
      {post.updatedAt ? <span className="ml-auto shrink-0 tabular-nums">{shortAgo(post.updatedAt)}</span> : null}
    </span>
  )
}

/** One row per task, under its column's heading; empty columns left out. */
export function TaskList({ posts, project }: { posts: TaskPost[]; project?: string | null }) {
  return (
    <div data-tasks="list" className="flex flex-col gap-4">
      {tasksByLane(posts).filter((g) => g.posts.length).map(({ lane, posts: rows }) => (
        <section key={lane.id} aria-label={lane.label} data-lane={lane.id}>
          <h2 className="flex items-center gap-2 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {lane.label}<span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{rows.length}</span>
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((p) => (
              <li key={p.id}>
                <a {...taskLink(p, project)} data-task={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <StatusDot state={taskTone(p.state)} label={taskStateLabel(p.state)} />
                  <TaskKind post={p} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{p.headline || p.id}</span>
                  <span className="hidden w-[40%] max-w-[280px] sm:flex"><TaskMeta post={p} /></span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** One column per state, every column shown; a card per task. */
export function TaskBoard({ posts, project }: { posts: TaskPost[]; project?: string | null }) {
  return (
    <div data-tasks="kanban" className="flex min-h-0 gap-3 overflow-x-auto pb-2">
      {tasksByLane(posts).map(({ lane, posts: cards }) => (
        <section key={lane.id} aria-label={lane.label} data-lane={lane.id} className={cn("flex w-[260px] shrink-0 flex-col rounded-md border border-t-2 border-border", LANE_TOP[lane.tone])}>
          <h2 className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 pl-3 pr-2 text-[12px] font-semibold">
            {lane.label}<span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-normal tabular-nums text-muted-foreground">{cards.length}</span>
          </h2>
          <div className="flex flex-col gap-1.5 px-1.5 py-2">
            {cards.length === 0 ? (
              <p className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">Empty</p>
            ) : cards.map((p) => (
              <a key={p.id} {...taskLink(p, project)} data-task={p.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-background px-2.5 py-2 shadow-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex items-start gap-1.5"><span className="mt-0.5"><TaskKind post={p} /></span><span className="line-clamp-2 text-[13px]">{p.headline || p.id}</span></span>
                {lane.id === "closed" && p.state !== "done" ? <Badge variant="outline" className="self-start text-[11px]">{taskStateLabel(p.state)}</Badge> : null}
                <TaskMeta post={p} />
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export interface TasksBodyProps {
  view: TasksView
  posts?: TaskPost[]
  /** Why the last read failed. With no tasks yet it fills the pane; with
   *  tasks already shown it is one line above them, and they stay. */
  error?: string | null
  /** Projects the forges could not be read for, said above the tasks. */
  notice?: string | null
  onRetry?: () => void
  /** The project picked in the filter; its tasks only are shown. */
  project?: string | null
}

/** One quiet line above the tasks: a failed read (with Try again), or the
 *  projects not read. The tasks below are the last ones read. */
function TasksNotice({ error, notice, onRetry }: Pick<TasksBodyProps, "error" | "notice" | "onRetry">) {
  if (!error && !notice) return null
  return (
    <div data-tasks="notice" className="mb-3 flex flex-col gap-1 text-xs">
      {error ? (
        <p role="alert" className="flex items-center gap-2 text-err-ink">
          <Icon name="circle-alert" className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">Could not refresh: {error}. Showing the last tasks read.</span>
          <Button size="xs" variant="ghost" onClick={onRetry}>Try again</Button>
        </p>
      ) : null}
      {notice ? <p role="status" className="truncate text-muted-foreground" title={notice}>{notice}</p> : null}
    </div>
  )
}

/** Loading, error, empty, or the tasks in the chosen view. */
export function TasksBody({ view, posts, error, notice, onRetry, project = null }: TasksBodyProps) {
  if (error && !posts) {
    return (
      <EmptyState title="Could not read the tasks" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}</span>
      </EmptyState>
    )
  }
  if (!posts) return <div className="flex flex-col gap-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-2/3" /></div>
  const shown = tasksOfProject(posts, project)
  const body = project && shown.length === 0 ? (
    <EmptyState title={`No tasks in ${project}`} action={<a className="text-sm text-link hover:underline" href={taskHref()}>All projects</a>}>
      No open issue or PR, and no request in the last 7 days. Pick another project, or all of them.
    </EmptyState>
  ) : posts.length === 0 ? (
    <EmptyState title="No tasks" action={<a className="text-sm text-link hover:underline" href={buildHash({ page: "home" })}>Ask an agent</a>}>
      Open issues and PRs of your repositories, and requests you give an agent, show here.
    </EmptyState>
  ) : view === "kanban" ? <TaskBoard posts={shown} project={project} /> : <TaskList posts={shown} project={project} />
  return <><TasksNotice error={error} notice={notice} onRetry={onRetry} />{body}</>
}

const EVENT_WORD: Record<string, string> = {
  asked: "Asked", run: "Run", handoff: "Hand-off", home: "Home", link: "Link", comment: "Comment",
  plan: "Plan", waiting: "Waiting", attention: "Attention", closed: "Closed",
}

/** An opened task: its state, then its timeline, oldest first. */
export function TaskThread({ post, events, error }: { post: TaskPost; events?: TaskEvent[]; error?: string | null }) {
  return (
    <article data-tasks="open" data-task={post.id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-medium">{post.headline || post.id}</h2>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusDot state={taskTone(post.state)} label={taskStateLabel(post.state)} />
          <span>{taskStateLabel(post.state)}</span>
          {post.owner ? <span>@{post.owner}</span> : null}
          {post.project ? <span className="font-mono text-[11px]">{post.project}</span> : null}
          {post.node?.name ? <span>{post.node.name}</span> : null}
          <a href={"#post=" + encodeURIComponent(post.id)} className="ml-auto inline-flex items-center gap-1 text-link hover:underline">
            Full record <Icon name="external-link" className="size-3" />
          </a>
        </p>
      </div>
      {error ? <p role="alert" className="text-sm text-err-ink">{error}</p>
        : !events ? <Skeleton className="h-16 w-full" />
        : events.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded on this task yet.</p>
        : (
          <ol className="flex flex-col divide-y divide-border border-y border-border" data-tasks="timeline">
            {events.map((e, i) => (
              <li key={i} data-event={e.kind} className="flex flex-col gap-1 py-2.5">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{EVENT_WORD[e.kind] || e.kind}</span>
                  {e.who ? <span>@{e.who}</span> : null}
                  {e.status ? <span className="font-mono text-[11px]">{e.status}</span> : null}
                  <span className="ml-auto tabular-nums">{shortAgo(e.at)}</span>
                </span>
                {e.text ? <p className="text-[13px] whitespace-pre-wrap break-words">{e.text}</p> : null}
              </li>
            ))}
          </ol>
        )}
    </article>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

/** The pane: reads the tasks (again while a node is still checking) and
 *  draws the list, the board, or the task opened from them. */
export function TasksPane({ view, onView, open, project = null, phoneBar }: { view: TasksView; onView: (v: TasksView) => void; open: string | null; project?: string | null; phoneBar?: ReactNode }) {
  const list = useQuery({
    queryKey: ["shell-tasks"],
    queryFn: () => apiGet<TasksReply>(TASKS_URL),
    refetchInterval: (q) => ((q.state.data as TasksReply | undefined)?.pending ? 2000 : 30_000),
  })
  const forge = useQuery({
    queryKey: ["shell-tasks-forge"],
    queryFn: () => apiGet<ForgeTasksReply>(FORGE_TASKS_URL),
    refetchInterval: (q) => ((q.state.data as ForgeTasksReply | undefined)?.pending ? 2000 : 30_000),
  })
  // Drawn once both reads have settled, and while either has data; a
  // refetch that fails keeps the data (react-query) and says why above it.
  const settled = !list.isPending && !forge.isPending
  const posts = settled && (list.data || forge.data) ? mergeTasks(taskPosts(list.data), forgePosts(forge.data)) : undefined
  const errors = [list.isError ? "requests: " + errText(list.error) : null, forge.isError ? "issues and PRs: " + errText(forge.error) : null].filter(Boolean)
  const error = errors.length ? errors.join("; ") : null
  const retry = () => { if (list.isError) void list.refetch(); if (forge.isError) void forge.refetch() }
  const post = open ? posts?.find((p) => p.id === open) : undefined
  const thread = useQuery({
    queryKey: ["shell-task", open, post?.node?.peer],
    queryFn: () => apiFetch<TaskThreadReply>(taskThreadUrl(open!), { headers: post?.node?.peer ? { "X-Agentx-Peer": post.node.peer } : {} }),
    enabled: !!post,
  })
  return (
    <section aria-label="Tasks" data-shell="tasks" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        {open ? (
          <a href={taskHref(undefined, project)} aria-label="Back to the tasks" title="Back to the tasks" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="arrow-left" />
          </a>
        ) : null}
        <h1 className="truncate text-sm font-medium">Tasks</h1>
        {!open && posts ? <span className="text-xs tabular-nums text-muted-foreground">{tasksOfProject(posts, project).length}</span> : null}
        {!open && posts ? <TasksProjectFilter projects={taskProjects(posts)} project={project} className="ml-auto" /> : null}
        {!open ? <TasksViewSwitch view={view} onView={onView} compact className={cn("w-[64px] md:hidden", posts ? "" : "ml-auto")} /> : null}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", view === "kanban" && !open ? "" : "mx-auto w-full max-w-[784px]")}>
        {open ? (
          error && !posts ? <TasksBody view={view} error={error} onRetry={retry} />
            : !posts ? <Skeleton className="h-16 w-full" />
            : !post ? <EmptyState title="Task not found" action={<a className="text-sm text-link hover:underline" href={taskHref()}>All tasks</a>}>It is closed for more than 7 days, or on a computer that is not answering.</EmptyState>
            : <TaskThread post={thread.data?.post ? { ...post, ...thread.data.post } : post} events={thread.data?.events} error={thread.isError ? "Could not read this task: " + errText(thread.error) : null} />
        ) : (
          <TasksBody view={view} posts={posts} project={project} error={error} notice={forgeUnread(forge.data)} onRetry={retry} />
        )}
      </div>
    </section>
  )
}
