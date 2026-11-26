// Lucide icons (ISC, see NOTICE.md) for the Hub, by name. lucide-static
// gives each icon as an SVG string; Icon draws it at size-4 by default and
// hides it from screen readers (the control around it carries the name).
import {
  Activity, ArrowLeft, BookOpen, Bot, ChevronRight, CircleAlert, CircleDot, Clock, ExternalLink, Files, Folder, Gauge, GitBranch, GitPullRequest, Inbox, Kanban, List, ListTodo, Menu, Monitor,
  Network, PanelRight, Radio, Search, Send, Settings, Smartphone, Workflow,
} from "lucide-static"
import { cn } from "./cn"

const ICONS: Record<string, string> = {
  "activity": Activity, "arrow-left": ArrowLeft, "book-open": BookOpen, "bot": Bot, "chevron-right": ChevronRight, "circle-alert": CircleAlert, "circle-dot": CircleDot, "clock": Clock, "external-link": ExternalLink, "files": Files, "folder": Folder,
  "gauge": Gauge, "git-branch": GitBranch, "git-pull-request": GitPullRequest, "inbox": Inbox, "kanban": Kanban, "list": List, "list-todo": ListTodo, "menu": Menu, "monitor": Monitor,
  "network": Network, "panel-right": PanelRight, "radio": Radio, "search": Search, "send": Send,
  "settings": Settings, "smartphone": Smartphone, "workflow": Workflow,
}

/** The icon names the Hub has. */
export const ICON_NAMES = Object.keys(ICONS)

export function Icon({ name, className }: { name: string; className?: string }) {
  const svg = ICONS[name]
  if (!svg) return null
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 [&>svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
