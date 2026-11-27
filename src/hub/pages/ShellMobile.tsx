// --- The Mobile app page in the simple shell (#2457) ---
//
// The old Hub's #page=mobile (hub-nav.ts hubMobilePageHtml, Anis
// 2026-11-24): why to try the phone app, then how to install it. Same
// words, drawn in the shell's centre; a static page, no read.
import { useEffect, useState, type ReactNode } from "react"
import { Button, Icon, cn } from "../ui"
import { PhonePreview } from "./PhonePreview"

// The docs website page, never the raw .md on GitHub (Anis 2026-11-25).
export const MOBILE_GUIDE = "https://agentx-docs.pages.dev/dashboard/mobile-app"

export const MOBILE_WHY: readonly { icon: string; title: string; text: string }[] = [
  { icon: "mic", title: "Talk, don't type.", text: "Hold the button, say it, let go. The agent answers aloud, and the talk stays in its chat." },
  { icon: "inbox", title: "Say yes from anywhere.", text: "Questions and approvals land on the phone's Desk; one tap answers, as here." },
  { icon: "git-pull-request", title: "See the diff on the go.", text: "The Changes screen shows what an agent changed, and your line comment goes back to it." },
  { icon: "smartphone", title: "Nothing to download.", text: "No app store, no account. It is a page your own computer serves, added to the home screen, on iPhone and Android." },
]

export const MOBILE_SERVE = "tailscale serve --bg --set-path /app http://127.0.0.1:4202/app\ntailscale serve --bg --set-path /api/app http://127.0.0.1:4202/api/app"
export const MOBILE_PAIR = 'agentx app pair --name "My phone"'

const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** A command with a Copy button; the button says Copied for 2 s. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => {
    // No clipboard on an http page that is not localhost (#2514 C2).
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))
  }
  return (
    <div data-mobile="command" className="mt-2 flex items-start gap-1 rounded-md border border-border bg-muted pr-1">
      <pre className="min-w-0 flex-1 overflow-x-auto py-2.5 pl-3 font-mono text-[12px] leading-relaxed text-foreground"><code>{text}</code></pre>
      <Button variant="ghost" size="icon" className="mt-1 size-7 shrink-0" aria-label={copied ? "Copied" : "Copy the command"} title={copied ? "Copied" : "Copy"} onClick={copy}>
        <Icon name={copied ? "check" : "copy"} className="size-3.5" />
      </Button>
    </div>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium tabular-nums text-muted-foreground">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-sm leading-relaxed text-(--ax-text-2)">{children}</div>
    </li>
  )
}

const b = "font-medium text-foreground"

/** The page: a short why, the five install steps, the note and the guide link. */
export function MobilePane({ phoneBar }: { phoneBar?: ReactNode }) {
  return (
    <section aria-label="Mobile app" data-shell="mobile" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">Mobile app</h1>
        <a href={MOBILE_GUIDE} target="_blank" rel="noopener noreferrer" className={cn("ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground", ring)}>
          Full guide<Icon name="external-link" className="size-3.5" />
        </a>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-2xl gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:max-w-5xl lg:grid-cols-[minmax(0,42rem)_15rem] lg:justify-between lg:gap-x-12">
          <div data-mobile="why">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Your agents, in your pocket</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">The same agents and the same chats as here, on your phone. Hold to talk to the agent you are with, answer what waits for you on the Desk with one tap, and get a note when a run ends or an agent asks you something.</p>
            <ul className="mt-5 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {MOBILE_WHY.map((w) => (
                <li key={w.title} className="flex gap-3 bg-background p-4">
                  <Icon name={w.icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm leading-relaxed text-(--ax-text-2)"><span className={b}>{w.title}</span> {w.text}</p>
                </li>
              ))}
            </ul>
          </div>
          {/* Between the why and the steps on a narrow window, beside them on a wide one. */}
          <div className="lg:col-start-2 lg:row-span-4 lg:row-start-1">
            <PhonePreview className="lg:sticky lg:top-4" />
          </div>
          <div data-mobile="install">
            <h2 className="text-sm font-medium text-foreground">Install it in five minutes</h2>
            <ol className="mt-4 flex flex-col gap-5">
              <Step n={1}><span className={b}>Link the phone and this computer with Tailscale</span>, a free private network: install it on both and sign in to the same account. Nothing is opened to the internet.</Step>
              <Step n={2}><span className={b}>On this computer</span>, give the phone app its private address:<Command text={MOBILE_SERVE} /></Step>
              <Step n={3}><span className={b}>Pair the phone</span> from the folder that holds <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">agentx.json</code>. A QR code and a pairing code appear:<Command text={MOBILE_PAIR} /></Step>
              <Step n={4}><span className={b}>On the phone</span>, point the camera at the QR code and open the link.</Step>
              <Step n={5}><span className={b}>Add it to the home screen</span>: iPhone Safari, Share, then Add to Home Screen; Android Chrome, the ⋮ menu, then Install app.</Step>
            </ol>
          </div>
          <p data-mobile="note" className="flex gap-2.5 rounded-md border border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <Icon name="shield-check" className="mt-px size-3.5 shrink-0" />
            <span>The app is for your own phone only: it opens chat with every agent of yours. A teammate gets their own work page instead. The pairing code works once, for 10 minutes.</span>
          </p>
          <div>
            <Button asChild variant="outline" size="sm">
              <a href={MOBILE_GUIDE} target="_blank" rel="noopener noreferrer">Full guide, with screenshots<Icon name="external-link" className="size-3.5" /></a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
