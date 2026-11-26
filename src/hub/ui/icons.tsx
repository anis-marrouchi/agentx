// Lucide icons (ISC, see NOTICE.md) for the Hub, by name. lucide-static
// gives each icon as an SVG string; Icon draws it at size-4 by default and
// hides it from screen readers (the control around it carries the name).
import {
  Activity, ArrowLeft, BookOpen, Bot, Building2, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleAlert,
  CircleCheck, CircleDot, Clock, Ellipsis, ExternalLink, Files, Folder, Gauge, GitBranch, GitPullRequest, Inbox, Kanban,
  KeyRound, List, ListTodo, Menu, MessageCircle, MessageSquare, Monitor, Network, PanelLeft, PanelRight, Plus, Radio,
  Search, Send, Settings, Settings2, ShieldCheck, Smartphone, TriangleAlert, UserRoundPlus, Workflow, X, Zap,
} from "lucide-static"
import { cn } from "./cn"

const ICONS: Record<string, string> = {
  "activity": Activity, "arrow-left": ArrowLeft, "book-open": BookOpen, "bot": Bot, "building-2": Building2, "calendar-clock": CalendarClock, "check": Check, "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft, "chevron-right": ChevronRight, "chevrons-up-down": ChevronsUpDown, "circle-alert": CircleAlert, "circle-check": CircleCheck, "circle-dot": CircleDot, "clock": Clock, "ellipsis": Ellipsis,
  "external-link": ExternalLink, "files": Files, "folder": Folder, "gauge": Gauge, "git-branch": GitBranch, "git-pull-request": GitPullRequest, "inbox": Inbox, "kanban": Kanban,
  "key-round": KeyRound, "list": List, "list-todo": ListTodo, "menu": Menu, "message-circle": MessageCircle, "message-square": MessageSquare, "monitor": Monitor, "network": Network,
  "panel-left": PanelLeft, "panel-right": PanelRight, "plus": Plus, "radio": Radio, "search": Search, "send": Send, "settings": Settings, "settings-2": Settings2,
  "shield-check": ShieldCheck, "smartphone": Smartphone, "triangle-alert": TriangleAlert, "user-round-plus": UserRoundPlus, "workflow": Workflow, "x": X, "zap": Zap,
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
