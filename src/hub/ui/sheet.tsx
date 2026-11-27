// From shadcn/ui's Sheet (MIT, see NOTICE.md), on Radix Dialog, restyled on
// the AgentX tokens: a panel that slides in from an edge, with a scrim, an
// X, and Esc to close (orca-design responsive §1: the phone menu is a Sheet,
// never a Dialog pushed to the edge). It opens in the Hub's portal host.
import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as React from "react"
import { cn } from "./cn"
import { Icon } from "./icons"
import { hubPortal } from "./portal"

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close
export const SheetTitle = DialogPrimitive.Title

const SIDE = {
  left: "inset-y-0 left-0 border-r",
  right: "inset-y-0 right-0 border-l [--ax-sheet-from:100%]",
} as const

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: keyof typeof SIDE; closeLabel?: string }
>(({ side = "left", closeLabel = "Close", className, children, ...props }, ref) => (
  <DialogPrimitive.Portal container={hubPortal()}>
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none"
    />
    <DialogPrimitive.Content
      ref={ref}
      data-slot="sheet-content"
      data-side={side}
      className={cn(
        "fixed z-50 flex h-full w-[min(320px,85vw)] flex-col border-border bg-background text-foreground shadow-float outline-none",
        "data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out motion-reduce:animate-none",
        SIDE[side], className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label={closeLabel}
        className="absolute right-3 top-3 inline-grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        <Icon name="x" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
SheetContent.displayName = "SheetContent"
