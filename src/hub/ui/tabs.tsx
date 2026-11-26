// From shadcn/ui (MIT, see NOTICE.md), on Radix Tabs, restyled on the AgentX tokens.
import * as TabsPrimitive from "@radix-ui/react-tabs"
import * as React from "react"
import { cn } from "./cn"

export const Tabs = TabsPrimitive.Root

/** `line`: a row of words over a hairline, the active one underlined (a
 *  page's sections, as Settings › Agent); the default is the segmented pill. */
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: "default" | "line" }
>(({ className, variant = "default", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-variant={variant}
    className={cn(
      "group/tabs inline-flex items-center text-muted-foreground",
      variant === "line" ? "h-10 w-full justify-start gap-1 overflow-x-auto border-b border-border" : "h-9 gap-1 rounded-md bg-muted p-1",
      className,
    )}
    {...props}
  />
))
TabsList.displayName = "TabsList"

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center rounded-sm px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors cursor-pointer",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
      "data-[state=active]:text-foreground",
      "group-data-[variant=default]/tabs:data-[state=active]:bg-background group-data-[variant=default]/tabs:data-[state=active]:shadow-sm",
      "group-data-[variant=line]/tabs:-mb-px group-data-[variant=line]/tabs:h-10 group-data-[variant=line]/tabs:rounded-none group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:border-transparent group-data-[variant=line]/tabs:px-2.5 group-data-[variant=line]/tabs:font-normal group-data-[variant=line]/tabs:hover:text-foreground",
      "group-data-[variant=line]/tabs:data-[state=active]:border-foreground group-data-[variant=line]/tabs:data-[state=active]:font-medium",
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = "TabsTrigger"

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props} />
))
TabsContent.displayName = "TabsContent"
