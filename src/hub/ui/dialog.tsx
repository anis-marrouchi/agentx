// From shadcn/ui (MIT, see NOTICE.md), on Radix Dialog, restyled on the AgentX tokens.
// It opens in the Hub's own portal host (portal.ts), so its styles apply.
// Sheet (sheet.tsx) is the same Radix Dialog at a screen edge and reuses the
// overlay and the close button from here.
import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as React from "react"
import { Button } from "./button"
import { cn } from "./cn"
import { Icon } from "./icons"
import { hubPortal } from "./portal"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn("fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-ax-fade-in data-[state=closed]:animate-ax-fade-out", className)}
    {...props}
  />
))
DialogOverlay.displayName = "DialogOverlay"

/** The X in the top right corner of a dialog or sheet. */
export function DialogCloseX() {
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" size="icon-xs" aria-label="Close" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground">
        <Icon name="x" />
      </Button>
    </DialogPrimitive.Close>
  )
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal container={hubPortal()}>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      data-slot="dialog-content"
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3",
        "rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-float",
        "data-[state=open]:animate-ax-dialog-in data-[state=closed]:animate-ax-dialog-out",
        className,
      )}
      {...props}
    >
      {children}
      <DialogCloseX />
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = "DialogContent"

export const DialogHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) =>
  <div data-slot="dialog-header" className={cn("flex flex-col gap-1 pr-6", className)} {...p} />
export const DialogFooter = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) =>
  <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...p} />

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn("text-base font-semibold", className)} {...props} />)
DialogTitle.displayName = "DialogTitle"

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />)
DialogDescription.displayName = "DialogDescription"
