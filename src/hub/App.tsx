// The React Hub's frame for stage 1 (#2218 part 3): it draws the page the
// hash names when React owns it, and nothing otherwise (the old Hub does).
import { Suspense, lazy } from "react"
import type { HubBoot } from "./boot"
import { ConnectionLine } from "./ConnectionLine"
import { hubRegistry } from "./registry"
import { reactPageFor, useHashParams } from "./router"
import { MENU_SLOT, wantsMenuFrame } from "./shell/menu-frame"
// Straight from the parts, not the ./ui barrel: the barrel would pull every
// kit part (cmdk, Select, Popover) into the first load.
import { Skeleton } from "./ui/misc"
import { TooltipProvider } from "./ui/tooltip"

// Toasts answer a click, never the first paint, so Sonner loads after it.
const Toaster = lazy(() => import("./ui/sonner").then((m) => ({ default: m.Toaster })))
// The one side menu on the pages outside the shell (#2593), in the old menu's slot.
const HubMenuFrame = lazy(() => import("./shell/HubMenuFrame").then((m) => ({ default: m.HubMenuFrame })))

export function App({ boot }: { boot: HubBoot }) {
  const params = useHashParams()
  const page = reactPageFor(params, boot.pages)
  const Page = page ? hubRegistry.pageComponent(page) : undefined
  // The page named by the hash, React or old: the shell and the new Settings draw their own menu.
  const framed = boot.owner && hasMenuSlot() && wantsMenuFrame(params.get("page") ?? page, boot)
  const frame = framed ? <Suspense fallback={null}><HubMenuFrame boot={boot} hash={"#" + params.toString()} /></Suspense> : null
  if (!Page) return frame ? <TooltipProvider>{frame}</TooltipProvider> : null
  const Fallback = hubRegistry.route(page!)?.fallback
  return (
    <TooltipProvider>
      {frame}
      <div className="ax-hub" data-hub-page={page}>
        <ConnectionLine />
        <Suspense fallback={Fallback ? <Fallback /> : <div className="flex flex-col gap-3 p-4"><Skeleton className="h-6 w-48" /><Skeleton className="h-24 w-full" /></div>}>
          <Page params={params} />
        </Suspense>
        <Suspense fallback={null}><Toaster /></Suspense>
      </div>
    </TooltipProvider>
  )
}

/** The old Hub drew the menu's slot (wall.ts, simple layout): no slot, no frame. */
function hasMenuSlot(): boolean {
  return typeof document !== "undefined" && !!document.getElementById(MENU_SLOT)
}
