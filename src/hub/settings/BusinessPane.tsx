// --- Settings › Business (#2101 ST3a) ---
//
// The approved mock (settings-mock/full/business.html): the org chart
// (OrgChart.tsx), then projects, clients, the contact map and the task
// boards, each a list with Edit on hover and the rare actions under `…`
// (forms in BusinessDialogs.tsx). It replaces the old Business and Boards
// sections (wall-settings-business.client.ts) with the same calls, under
// the Settings prefix so the owner guard holds every write
// (wall-actions.ts): POST|DELETE …/business/{project,client,contact},
// POST|DELETE …/boards and …/boards/columns. No new endpoint.
import { useState, type ReactNode } from "react"
import { Badge, Button, Icon } from "../ui"
import { oldSettingsHash } from "./address"
import { ProjectDialog, ClientDialog, MappingDialog, BoardDialog, ColumnDialog, NEXT_START } from "./BusinessDialogs"
import { CLIENT_KIND, clientRows, columnMap, contactKey, contactMatch, type Board, type BusinessState, type ClientRow, type Project } from "./business-data"
import { STATE_KEY, WriteNote, useWorkState, useWrite } from "./fields"
import { OrgGroup, useOrgSetup } from "./OrgChart"
import {
  AddButton, Dots, EmptyLine, ErrorLine, Lead, PaneHeader, RowMenu, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows, useConfirm,
} from "./parts"
import { paneDef } from "./panes"

const PANE = "business"

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-xs">{children}</span>
const Edit = ({ onClick }: { onClick: () => void }) => <Button variant="ghost" size="sm" onClick={onClick}>Edit</Button>
const channelName = (c: string) => (c === "telegram" ? "Telegram" : c === "whatsapp" ? "WhatsApp" : c)

export default function BusinessPane() {
  const pane = paneDef(PANE)
  const state = useWorkState()
  const org = useOrgSetup()
  const { run: send, note } = useWrite(STATE_KEY)
  const confirm = useConfirm()
  const [project, setProject] = useState<Project | null | undefined>(undefined)
  const [clientEdit, setClientEdit] = useState<ClientRow | null | undefined>(undefined)
  const [mapping, setMapping] = useState(false)
  const [board, setBoard] = useState<Board | null | undefined>(undefined)
  const [column, setColumn] = useState<Board | null>(null)

  const data = state.data as BusinessState | undefined
  const b = data?.business
  const projects = b?.projects ?? []
  const clients = clientRows(b)
  const contacts = b?.contactMap ?? []
  const boards = data?.boards ?? []
  const nameOf = (ref?: string) => org.data?.setup?.members.find((m) => m.ref === ref)?.name ?? ref ?? ""
  const remove = (title: string, text: string, yes: string, path: string, body: unknown, done: string) =>
    confirm.ask({ title, text, yes, run: () => send("DELETE", path, body, done) })

  const loading = state.isPending ? <SkeletonRows /> : state.isError
    ? <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
    : null
  const add = (label: string, onClick: () => void) => data && <AddButton label={label} onClick={onClick} />

  return (
    <>
      <PaneHeader pane={pane} />
      <div className="flex flex-col gap-8">
        {b && !b.enabled && (
          <SettingsGroup pane={PANE}>
            <SettingsRow
              pane={PANE} row="layer"
              label={<span className="inline-flex items-center gap-2">Business layer <Badge variant="secondary">Off</Badge></span>}
              control={<Button asChild variant="outline" size="sm"><a href={oldSettingsHash("advanced")}>Open agentx.json</a></Button>}
            />
          </SettingsGroup>
        )}

        <OrgGroup />

        <SettingsGroup
          pane={PANE} row="projects" action={add("Add project", () => setProject(null))}
          help={data ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} · the PM drives the PM gate` : undefined}
        >
          {loading ?? (projects.length === 0 ? <EmptyLine>No project yet.</EmptyLine> : projects.map((p) => (
            <SettingsItem
              key={p.id} id={"pj-" + p.id}
              lead={<Lead icon="folder-git-2" />}
              name={p.name && p.name !== p.id ? <>{p.name}<span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{p.id}</span></> : <Mono>{p.id}</Mono>}
              meta={<>
                <Dots items={[p.pm ? <>PM <Mono>@{p.pm}</Mono></> : "No PM", p.lead && <>Lead {nameOf(p.lead)}</>, p.client && <>Client <Mono>{p.client}</Mono></>]} />
                <span className="basis-full">{p.team?.length ? <>Team: <Mono>{p.team.join(", ")}</Mono></> : "No team set"}</span>
              </>}
              menu={<>
                <Edit onClick={() => setProject(p)} />
                <RowMenu label={p.id} items={[
                  { label: "Remove project", icon: "trash-2", destructive: true, onSelect: () => remove(`Remove the project ${p.id}?`, `The PM gate stops checking it. ${NEXT_START}`, "Remove project", "business/project", { id: p.id }, `Removed the project ${p.id}.`) },
                ]} />
              </>}
            />
          )))}
        </SettingsGroup>

        <SettingsGroup pane={PANE} row="clients" action={add("Set up a client", () => setClientEdit(null))}>
          {loading ?? (clients.length === 0 ? <EmptyLine>No client yet: add a project or a contact mapping.</EmptyLine> : clients.map((c) => (
            <SettingsItem
              key={c.id} id={"cl-" + c.id}
              lead={<Lead icon={c.cfg?.kind === "own" ? "house" : c.cfg?.kind === "internal" ? "cog" : "briefcase"} />}
              name={c.cfg?.name ? <>{c.cfg.name}<span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{c.id}</span></> : <Mono>{c.id}</Mono>}
              meta={c.cfg ? (
                <Dots items={[
                  CLIENT_KIND[c.cfg.kind || "client"] ?? c.cfg.kind,
                  c.cfg.respondWithin ? `Respond within ${c.cfg.respondWithin}` : "No response clock",
                  c.cfg.standing?.length ? <>Standing: <Mono>{c.cfg.standing.join(", ")}</Mono></> : null,
                ]} />
              ) : (
                <Dots items={[c.namedBy === "contact" ? "Named by a contact mapping" : "Named by a project", "Treated as a client, no response clock"]} />
              )}
              control={!c.cfg && <Button variant="outline" size="sm" onClick={() => setClientEdit(c)}>Set up</Button>}
              menu={c.cfg && <>
                <Edit onClick={() => setClientEdit(c)} />
                <RowMenu label={c.id} items={[
                  { label: "Reset to defaults", icon: "rotate-ccw", destructive: true, onSelect: () => remove(`Reset ${c.id} to the defaults?`, "It stays a client while a project or contact names it.", "Reset", "business/client", { id: c.id }, `${c.id} is back to the defaults.`) },
                ]} />
              </>}
            />
          )))}
        </SettingsGroup>

        <SettingsGroup pane={PANE} row="contacts" action={add("Add mapping", () => setMapping(true))}>
          {loading ?? (contacts.length === 0 ? <EmptyLine>No contact mapping. Every chat counts as internal.</EmptyLine> : contacts.map((c, i) => {
            const [k, v] = contactKey(c)
            return (
              <SettingsItem
                key={i + k + v} id={"cm-" + i}
                lead={<Lead icon={k === "chat" ? "users" : "user"} />}
                name={c.displayName || <Mono>{v}</Mono>}
                meta={<>
                  <Dots items={[c.channel && channelName(c.channel), <>{k} <Mono>{v}</Mono></>]} />
                  <span className="inline-flex basis-full items-center gap-1"><Icon name="arrow-right" className="size-3" /><Mono>{c.client}{c.project ? " / " + c.project : ""}</Mono></span>
                </>}
                menu={<RowMenu label={c.displayName || v} items={[
                  { label: "Remove mapping", icon: "trash-2", destructive: true, onSelect: () => remove("Remove this mapping?", `The chat ${k} ${v} counts as internal again. ${NEXT_START}`, "Remove mapping", "business/contact", contactMatch(c), "Removed the mapping.") },
                ]} />}
              />
            )
          }))}
        </SettingsGroup>

        <SettingsGroup pane={PANE} row="boards" action={add("Add board", () => setBoard(null))}>
          {loading ?? (boards.length === 0 ? <EmptyLine>No board yet.</EmptyLine> : boards.map((bd) => (
            <BoardItem
              key={bd.id} board={bd} onEdit={() => setBoard(bd)} onAddColumn={() => setColumn(bd)}
              onRemove={() => remove(`Remove the board ${bd.id}?`, "The dashboard stops showing it. The GitLab issues stay.", "Remove board", "boards", { id: bd.id }, `Removed the board ${bd.id}.`)}
              onRemoveColumn={(c) => remove(`Remove the column ${c.title}?`, `From the board ${bd.name}. Cards keep their labels.`, "Remove column", "boards/columns", { boardId: bd.id, columnId: c.id }, `Removed the column ${c.title}.`)}
            />
          )))}
        </SettingsGroup>
        <WriteNote note={note} />
      </div>

      <ProjectDialog project={project} agents={data?.agents ?? []} onClose={() => setProject(undefined)} send={send} />
      <ClientDialog row={clientEdit} onClose={() => setClientEdit(undefined)} send={send} />
      <MappingDialog open={mapping} onOpenChange={setMapping} send={send} />
      <BoardDialog board={board} onClose={() => setBoard(undefined)} send={send} />
      <ColumnDialog board={column} onClose={() => setColumn(null)} send={send} />
      {confirm.dialog}
    </>
  )
}

function BoardItem({ board: b, onEdit, onAddColumn, onRemove, onRemoveColumn }: {
  board: Board; onEdit: () => void; onAddColumn: () => void; onRemove: () => void; onRemoveColumn: (c: NonNullable<Board["columns"]>[number]) => void
}) {
  const cols = b.columns ?? []
  return (
    <SettingsItem
      id={"bd-" + b.id}
      lead={<Lead icon="square-kanban" />}
      name={<>{b.name}<span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{b.id}</span></>}
      meta={<>
        <Dots items={[
          b.source?.projects?.length ? <Mono>{b.source.projects.join(", ")}</Mono> : "No GitLab project",
          b.primaryToolLabel && <>Every card has <Mono>{b.primaryToolLabel}</Mono></>,
          `Open ${b.timeRangeDays ?? 30} days, closed ${b.closedWindowDays ?? 30} days`,
        ]} />
        <span className="mt-2 flex basis-full flex-wrap items-center gap-1.5">
          {cols.length === 0 && <span className="mr-1">No columns: the board uses the default flow.</span>}
          {cols.map((c) => (
            <span key={c.id} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-background pl-2 text-xs text-foreground">
              {c.title}<span className="font-mono text-[11px] text-muted-foreground">{columnMap(c)}</span>
              <button type="button" aria-label={`Remove the column ${c.title}`} title="Remove column" onClick={() => onRemoveColumn(c)} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon name="x" className="size-3" />
              </button>
            </span>
          ))}
        </span>
      </>}
      menu={<>
        <Edit onClick={onEdit} />
        <RowMenu label={b.name} items={[
          { label: "Add column", icon: "plus", onSelect: onAddColumn },
          { label: "Remove board", icon: "trash-2", destructive: true, onSelect: onRemove },
        ]} />
      </>}
    />
  )
}
