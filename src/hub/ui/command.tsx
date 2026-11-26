// From shadcn/ui (MIT, see NOTICE.md), on cmdk (MIT), restyled on the AgentX tokens.
// A searchable list; put it inside a PopoverContent (className="p-0") for a picker.
import { Command as CommandPrimitive } from "cmdk"
import * as React from "react"
import { cn } from "./cn"
import { Icon } from "./icons"

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>, React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    data-slot="command"
    className={cn("flex size-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground", className)}
    {...props}
  />
))
Command.displayName = "Command"

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 border-b border-border px-3">
    <Icon name="search" className="size-4 text-muted-foreground" />
    <CommandPrimitive.Input
      ref={ref}
      data-slot="command-input"
      className={cn(
        "flex h-full w-full bg-transparent py-2 text-base outline-none md:text-sm",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
))
CommandInput.displayName = "CommandInput"

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    data-slot="command-list"
    className={cn("max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden", className)}
    {...props}
  />
))
CommandList.displayName = "CommandList"

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty ref={ref} data-slot="command-empty" className={cn("py-6 text-center text-sm text-muted-foreground", className)} {...props} />
))
CommandEmpty.displayName = "CommandEmpty"

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    data-slot="command-group"
    className={cn(
      "overflow-hidden p-1 text-foreground",
      "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium",
      "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.18em] [&_[cmdk-group-heading]]:text-muted-foreground",
      className,
    )}
    {...props}
  />
))
CommandGroup.displayName = "CommandGroup"

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} data-slot="command-separator" className={cn("-mx-1 h-px bg-border", className)} {...props} />
))
CommandSeparator.displayName = "CommandSeparator"

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    data-slot="command-item"
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none",
      "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className,
    )}
    {...props}
  />
))
CommandItem.displayName = "CommandItem"

export const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span data-slot="command-shortcut" className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)} {...props} />
)
