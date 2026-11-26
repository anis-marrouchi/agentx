// --- The component catalog, #page=catalog (#2218 part 4) ---
//
// Every part of src/hub/ui, in the current theme, with a switch to the other
// one. Owner only (src/hub/pages.ts). This page is the living form of the
// catalog list: a page PR adds a part here when it adds one to the set.
// It also shows the one live connection (C3): its state, the snapshots it
// wrote into the query cache, and how many times it came back after a drop.
import { Fragment, useState } from "react"
import { useLiveSnapshot, useLiveStatus } from "../live-react"
import type { HubPageProps } from "../registry"
import {
  AfCard, AfCount, AfLoader, AfRow, AfSkeletonRows, AfStateLabel, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
  Collapsible, CollapsibleContent, CollapsibleTrigger,
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
  EmptyState, ICON_NAMES, Icon, Kbd, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
  Skeleton, StatusDot, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger, toast,
} from "../ui"

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  )
}

function IconButton({ size, label, icon, shortcut }: { size: "icon-lg" | "icon" | "icon-sm" | "icon-xs"; label: string; icon: string; shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button variant="ghost" size={size} aria-label={label}><Icon name={icon} /></Button></TooltipTrigger>
      <TooltipContent>{label}{shortcut ? <Kbd>{shortcut}</Kbd> : null}</TooltipContent>
    </Tooltip>
  )
}

function RowMenu() {
  const [pinned, setPinned] = useState(true)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions"><Icon name="ellipsis" /></Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent>
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        <DropdownMenuItem><Icon name="pencil" className="text-muted-foreground" />Rename<DropdownMenuShortcut>⌘R</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem><Icon name="history" className="text-muted-foreground" />View logs</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={pinned} onCheckedChange={(v) => setPinned(v === true)}>Pin to the side menu</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Icon name="trash-2" />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FoldSection() {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-md">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md py-1 text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 cursor-pointer">
        <Icon name={open ? "chevron-down" : "chevron-right"} className="size-3.5 text-muted-foreground" />
        Running now
        <span className="text-xs font-normal tabular-nums text-muted-foreground">3</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pl-5.5 text-[13px]">
        <span className="border-b border-border py-1.5">Triage the inbox</span>
        <span className="border-b border-border py-1.5">Fix the login page</span>
        <span className="py-1.5">Weekly report</span>
      </CollapsibleContent>
    </Collapsible>
  )
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
}

function ThemeSwitch() {
  const [theme, setTheme] = useState(currentTheme)
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark"
    document.documentElement.setAttribute("data-theme", next)
    try { localStorage.setItem("ax-theme", next) } catch { /* private window */ }
    setTheme(next)
  }
  return <Button variant="outline" size="sm" onClick={flip}>Show in {theme === "dark" ? "light" : "dark"}</Button>
}

const MODEL_GROUPS = [
  { engine: "Claude Code", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  { engine: "Codex", models: ["gpt-5.1-codex", "gpt-5.1-codex-mini"] },
]

function ModelPicker() {
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState("claude-opus-5-5")
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" role="combobox" aria-expanded={open} className="h-7 w-[180px] justify-between font-mono text-xs font-normal">
          <span className="truncate">{model}</span>
          <Icon name="chevrons-up-down" className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList>
            <CommandEmpty>No model found.</CommandEmpty>
            {MODEL_GROUPS.map((g, i) => (
              <Fragment key={g.engine}>
                {i > 0 && <CommandSeparator />}
                <CommandGroup heading={g.engine}>
                  {g.models.map((m) => (
                    <CommandItem key={m} value={m} onSelect={() => { setModel(m); setOpen(false) }} className="font-mono text-xs">
                      {m}
                      <Icon name="check" className={m === model ? "ml-auto size-3.5" : "ml-auto size-3.5 invisible"} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface LiveSnap { ts?: string; nodes?: { agents?: unknown[] }[] }

function LiveCard() {
  const status = useLiveStatus()
  const { data, isLoading } = useLiveSnapshot<LiveSnap>()
  const nodes = data?.nodes?.length ?? 0
  const agents = (data?.nodes ?? []).reduce((n, node) => n + (node.agents?.length ?? 0), 0)
  const dot = status.state === "open" ? "ok" : status.state === "reconnecting" ? "warn" : "idle"
  return (
    <Card className="w-full max-w-md" data-live-state={status.state}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><StatusDot state={dot} label={status.state} /> Live connection</CardTitle>
        <CardDescription>One stream for the whole app, written into the query cache.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? <Skeleton className="h-12 w-full" /> : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">State</dt><dd data-testid="live-state">{status.state}</dd>
            <dt className="text-muted-foreground">Machines / agents</dt><dd>{nodes} / {agents}</dd>
            <dt className="text-muted-foreground">Snapshots</dt><dd data-testid="live-snapshots">{status.snapshots}</dd>
            <dt className="text-muted-foreground">Came back after a drop</dt><dd data-testid="live-reconnects">{status.reconnects}</dd>
            <dt className="text-muted-foreground">Last snapshot</dt><dd>{status.lastAt ? new Date(status.lastAt).toLocaleTimeString() : "—"}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

export default function CatalogPage(_: HubPageProps) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <h1 className="text-2xl font-semibold leading-tight">Components</h1>
          <p className="text-sm leading-6 text-muted-foreground">The Hub's one component set (src/hub/ui). Pages use these, or add to them here.</p>
        </div>
        <ThemeSwitch />
      </header>

      <Section title="Button">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
        <Button size="xs">Extra small</Button>
        <Button disabled>Disabled</Button>
      </Section>

      <Section title="Icon button">
        <IconButton size="icon-lg" label="Add agent" icon="plus" />
        <IconButton size="icon" label="Search" icon="search" shortcut="⌘K" />
        <IconButton size="icon-sm" label="Settings" icon="settings" />
        <IconButton size="icon-xs" label="Close" icon="x" />
      </Section>

      <Section title="Badge and status">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="ok"><StatusDot state="ok" label="done" /> Done</Badge>
        <Badge variant="warn"><StatusDot state="warn" label="waiting" /> Waiting on you</Badge>
        <Badge variant="err"><StatusDot state="err" label="failed" /> Failed</Badge>
        <span className="inline-flex items-center gap-2 text-sm"><StatusDot state="work" label="working" /> Working</span>
        <span className="inline-flex items-center gap-2 text-sm"><StatusDot state="idle" label="idle" /> Idle</span>
      </Section>

      <Section title="Keys">
        <span className="inline-flex items-center gap-1 text-sm">Open the switcher <Kbd>⌘</Kbd><Kbd>K</Kbd></span>
      </Section>

      <Section title="Icons">
        {ICON_NAMES.map((n) => (
          <span key={n} className="inline-flex w-40 items-center gap-2 text-muted-foreground">
            <Icon name={n} />
            <span className="truncate font-mono text-[11px]">{n}</span>
          </span>
        ))}
      </Section>
      <Section title="Tabs">
        <Tabs defaultValue="changes" className="w-full max-w-md">
          <TabsList>
            <TabsTrigger value="changes">Changes</TabsTrigger>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="changes" className="text-sm">Three files changed.</TabsContent>
          <TabsContent value="plan" className="text-sm">Step 2 of 4.</TabsContent>
          <TabsContent value="files" className="text-sm">No files yet.</TabsContent>
        </Tabs>
      </Section>

      <Section title="Dialog and tooltip">
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">Open a dialog</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Stop this run?</DialogTitle>
              <DialogDescription>The agent stops after its current step. You can start it again later.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Keep going</Button></DialogClose>
              <DialogClose asChild><Button variant="destructive">Stop</Button></DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Tooltip>
          <TooltipTrigger asChild><Button variant="ghost">Hover me</Button></TooltipTrigger>
          <TooltipContent>Opens on hover and on keyboard focus <Kbd>⌘K</Kbd></TooltipContent>
        </Tooltip>
      </Section>

      <Section title="Sheet">
        {(["left", "right"] as const).map((side) => (
          <Sheet key={side}>
            <SheetTrigger asChild><Button variant="outline">Open from the {side}</Button></SheetTrigger>
            <SheetContent side={side}>
              <SheetHeader>
                <SheetTitle>Files</SheetTitle>
                <SheetDescription>What this task wrote, newest first.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
        ))}
      </Section>

      <Section title="Dropdown menu">
        <RowMenu />
      </Section>

      <Section title="Collapsible">
        <FoldSection />
      </Section>

      <Section title="Toast">
        <Button variant="outline" onClick={() => toast.success("Saved")}>Show a toast</Button>
      </Section>

      <Section title="Switch">
        <label className="inline-flex items-center gap-2 text-sm"><Switch defaultChecked /> Notify on finish</label>
        <label className="inline-flex items-center gap-2 text-sm"><Switch /> Auto-approve reads</label>
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Switch disabled /> Disabled</label>
      </Section>

      <Section title="Select">
        <Select defaultValue="claude-code">
          <SelectTrigger className="w-[160px]" aria-label="Engine"><SelectValue placeholder="Pick an engine" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="claude-code">Claude Code</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
            <SelectItem value="gemini">Gemini CLI</SelectItem>
          </SelectContent>
        </Select>
      </Section>

      <Section title="Popover">
        <Popover>
          <PopoverTrigger asChild><Button variant="outline">Open a popover</Button></PopoverTrigger>
          <PopoverContent className="flex flex-col gap-1">
            <p className="text-sm font-medium">Run limits</p>
            <p className="text-[12.5px] text-muted-foreground">Stops a run after 30 minutes or 200 steps.</p>
          </PopoverContent>
        </Popover>
      </Section>

      <Section title="Model picker">
        <ModelPicker />
      </Section>

      <Section title="Card, skeleton and empty state">
        <Card className="w-full max-w-xs">
          <CardHeader><CardTitle>Card title</CardTitle><CardDescription>A short line under it.</CardDescription></CardHeader>
          <CardContent className="text-sm">The body of the card.</CardContent>
          <CardFooter><Button size="sm">Open</Button></CardFooter>
        </Card>
        <div className="flex w-full max-w-xs flex-col gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-16 w-full" /></div>
        <EmptyState className="w-full max-w-xs" icon="inbox" title="Nothing waiting on you" action={<Button size="sm" variant="outline">Open the Desk</Button>}>
          New asks from your agents show here.
        </EmptyState>
      </Section>

      <Section title="affectUI treatments">
        <AfCard className="w-full max-w-md" title="Needs you" count={2} action={<AfCount n={1} tone="warn" label="1 overdue" />}>
          <AfRow name="Read" meta="src/hub/ui/affect.tsx" state="done" />
          <AfRow name="Edit" meta="src/hub/pages/CatalogPage.tsx" state="running" />
          <AfRow name="Approve" meta="deploy to production" state="waiting" />
          <AfRow name="Test" meta="vitest run" state="error" />
          <AfRow name="Plan" meta="not started" state="idle" />
        </AfCard>
        <div className="flex w-full max-w-xs flex-col gap-3">
          <AfLoader>Thinking…</AfLoader>
          <span className="inline-flex flex-wrap items-center gap-3"><AfStateLabel state="running" /><AfStateLabel state="done" /><AfStateLabel state="waiting" /><AfStateLabel state="error" /><AfStateLabel state="idle" /></span>
          <AfSkeletonRows />
        </div>
      </Section>

      <Section title="Live">
        <LiveCard />
      </Section>
    </div>
  )
}
