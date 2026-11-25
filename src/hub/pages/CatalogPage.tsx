// --- The component catalog, #page=catalog (#2218 part 4) ---
//
// Every part of src/hub/ui, in the current theme, with a switch to the other
// one. Owner only (src/hub/pages.ts). This page is the living form of the
// catalog list: a page PR adds a part here when it adds one to the set.
// It also shows the one live connection (C3): its state, the snapshots it
// wrote into the query cache, and how many times it came back after a drop.
import { useState } from "react"
import { useLiveSnapshot, useLiveStatus } from "../live-react"
import type { HubPageProps } from "../registry"
import {
  Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  EmptyState, Kbd, Skeleton, StatusDot, Tabs, TabsContent, TabsList, TabsTrigger,
  Tooltip, TooltipContent, TooltipTrigger,
} from "../ui"

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Components</h1>
          <p className="text-sm text-muted-foreground">The Hub's one component set (src/hub/ui). Pages use these, or add to them here.</p>
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
        <Button disabled>Disabled</Button>
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
          <TooltipContent>Opens on hover and on keyboard focus</TooltipContent>
        </Tooltip>
      </Section>

      <Section title="Card, skeleton and empty state">
        <Card className="w-full max-w-xs">
          <CardHeader><CardTitle>Card title</CardTitle><CardDescription>A short line under it.</CardDescription></CardHeader>
          <CardContent className="text-sm">The body of the card.</CardContent>
          <CardFooter><Button size="sm">Open</Button></CardFooter>
        </Card>
        <div className="flex w-full max-w-xs flex-col gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-16 w-full" /></div>
        <EmptyState className="w-full max-w-xs" title="Nothing waiting on you" action={<Button size="sm" variant="outline">Open the Desk</Button>}>
          New asks from your agents show here.
        </EmptyState>
      </Section>

      <Section title="Live">
        <LiveCard />
      </Section>
    </div>
  )
}
