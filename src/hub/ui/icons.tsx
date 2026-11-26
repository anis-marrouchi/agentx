// Lucide icons (ISC, see NOTICE.md) for the Hub, by name. lucide-static
// gives each icon as an SVG string; Icon draws it at size-4 by default and
// hides it from screen readers (the control around it carries the name).
import {
  Activity, ArrowDown, ArrowLeft, ArrowUp, ArrowUpToLine, BellDot, BookOpen, Bookmark, Bot, Briefcase, Building2, CalendarClock, ChartLine,
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleAlert, CircleCheck, CircleDollarSign, CircleDot, Clock, Ellipsis,
  ExternalLink, EyeOff, File, Files, Folder, Gauge, GitBranch, GitPullRequest, Globe, GripVertical, Heading, History, Inbox,
  Kanban, KeyRound, LayoutDashboard, LayoutList, Link, List, ListChecks, ListTodo, Megaphone, Menu, MessageCircle, MessageSquare,
  Monitor, Network, PanelLeft, PanelRight, Pencil, Plus, Radio, RotateCcw, Search, Send, Settings, Settings2, Shapes, ShieldCheck,
  Smartphone, Star, Trash2, TriangleAlert, Undo2, UserRoundPlus, Users, Workflow, X, Zap,
} from "lucide-static"
import { cn } from "./cn"

const ICONS: Record<string, string> = {
  "activity": Activity, "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-up": ArrowUp, "arrow-up-to-line": ArrowUpToLine, "bell-dot": BellDot,
  "book-open": BookOpen, "bookmark": Bookmark, "bot": Bot, "briefcase": Briefcase, "building-2": Building2, "calendar-clock": CalendarClock, "chart-line": ChartLine,
  "check": Check, "chevron-down": ChevronDown, "chevron-left": ChevronLeft, "chevron-right": ChevronRight, "chevrons-up-down": ChevronsUpDown,
  "circle-alert": CircleAlert, "circle-check": CircleCheck, "circle-dollar-sign": CircleDollarSign, "circle-dot": CircleDot, "clock": Clock, "ellipsis": Ellipsis,
  "external-link": ExternalLink, "eye-off": EyeOff, "file": File, "files": Files, "folder": Folder, "gauge": Gauge, "git-branch": GitBranch,
  "git-pull-request": GitPullRequest, "globe": Globe, "grip-vertical": GripVertical, "heading": Heading, "history": History, "inbox": Inbox,
  "kanban": Kanban, "key-round": KeyRound, "layout-dashboard": LayoutDashboard, "layout-list": LayoutList, "link": Link, "list": List,
  "list-checks": ListChecks, "list-todo": ListTodo, "megaphone": Megaphone, "menu": Menu, "message-circle": MessageCircle, "message-square": MessageSquare,
  "monitor": Monitor, "network": Network, "panel-left": PanelLeft, "panel-right": PanelRight, "pencil": Pencil, "plus": Plus, "radio": Radio,
  "rotate-ccw": RotateCcw, "search": Search, "send": Send, "settings": Settings, "settings-2": Settings2, "shapes": Shapes, "shield-check": ShieldCheck,
  "smartphone": Smartphone, "star": Star, "trash-2": Trash2, "triangle-alert": TriangleAlert, "undo-2": Undo2, "user-round-plus": UserRoundPlus, "users": Users,
  "workflow": Workflow, "x": X, "zap": Zap,
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
