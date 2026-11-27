// --- The tilting phone on the Mobile app page (#2459) ---
//
// Anis 2026-11-27: "a mobile app preview, like a 3D that tilts and displays
// the mobile app, like animated through the pages". A phone frame that leans
// slowly (6 degrees or less) and cross-fades through real phone app screens.
// The screens come from docs/.scripts/hub-phone-screens.mjs (the docs' phone
// app shots, made small); that file says how to refresh them. Reduced
// motion: a still phone on the first screen.
import { useEffect, useState } from "react"
import { cn } from "../ui"
import chat from "../assets/phone/chat.webp"
import desk from "../assets/phone/desk.webp"
import fleet from "../assets/phone/fleet.webp"
import alerts from "../assets/phone/alerts.webp"

export const PHONE_SCREENS: readonly { src: string; label: string; alt: string }[] = [
  { src: chat, label: "Chat", alt: "The phone app's Chat: a conversation with an agent and the hold-to-talk button" },
  { src: desk, label: "Desk", alt: "The phone app's Desk: questions and approvals that wait for you" },
  { src: fleet, label: "Fleet", alt: "The phone app's Fleet: your machines and their health" },
  { src: alerts, label: "Alerts", alt: "The phone app's Alerts: finished runs and questions from agents" },
]

/** How long each screen stays, in ms. */
export const PHONE_SCREEN_MS = 4000

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true

export function PhonePreview({ className }: { className?: string }) {
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (reducedMotion()) return
    const t = setInterval(() => setAt((i) => (i + 1) % PHONE_SCREENS.length), PHONE_SCREEN_MS)
    return () => clearInterval(t)
  }, [])
  return (
    <figure data-mobile="phone" aria-label="The AgentX phone app" className={cn("flex flex-col items-center gap-3", className)}>
      <div className="[perspective:1200px]">
        <div className="relative aspect-[390/844] w-[220px] rounded-[2.25rem] border border-black/10 bg-[#111] p-[7px] dark:border-white/15 shadow-xl animate-ax-phone-tilt reduce-effects:animate-none [transform-style:preserve-3d]">
          <div className="relative size-full overflow-hidden rounded-[1.8rem] bg-background">
            {PHONE_SCREENS.map((s, i) => (
              <img key={s.label} src={s.src} alt={i === at ? s.alt : ""} aria-hidden={i === at ? undefined : true} loading={i === 0 ? "eager" : "lazy"} decoding="async" draggable={false}
                className={cn("absolute inset-0 size-full object-cover object-top transition-opacity duration-700 ease-in-out reduce-effects:transition-none", i === at ? "opacity-100" : "opacity-0")} />
            ))}
          </div>
        </div>
      </div>
      <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{PHONE_SCREENS[at].label}</span>
        <span aria-hidden="true" className="flex gap-1">
          {PHONE_SCREENS.map((s, i) => <span key={s.label} className={cn("size-1.5 rounded-full transition-colors duration-300", i === at ? "bg-foreground" : "bg-border")} />)}
        </span>
      </figcaption>
    </figure>
  )
}
