// From shadcn/ui (MIT, see NOTICE.md), on Radix Dialog, restyled on the AgentX tokens.
// It opens in the Hub's own portal host (portal.ts), so its styles apply.
import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as React from "react"
import { cn } from "./cn"
import { hubPortal } from "./portal"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal container={hubPortal()}>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3",
        "rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-float",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close aria-label="Close" className="absolute right-3 top-3 rounded-sm px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer">
        ✕
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = "DialogContent"

export const DialogHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) =>
  <div className={cn("flex flex-col gap-1 pr-6", className)} {...p} />
export const DialogFooter = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) =>
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...p} />

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...props} />)
DialogTitle.displayName = "DialogTitle"

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />)
DialogDescription.displayName = "DialogDescription"
