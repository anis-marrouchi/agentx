// Lucide icons (ISC, see NOTICE.md) for the Hub, by name. lucide-static
// gives each icon as an SVG string; Icon draws it at size-4 by default and
// hides it from screen readers (the control around it carries the name).
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowRightLeft, ArrowUp, ArrowUpRight, ArrowUpToLine, AtSign, Ban, BellDot, Bookmark, BookOpen, Bot,
  Briefcase, Building2, CalendarClock, ChartLine, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Circle, CircleAlert, CircleCheck,
  CircleDashed, CircleDollarSign, CircleDot, CircleX, Clock, Cog, Copy, Download, Ellipsis, ExternalLink, Eye, EyeOff, File, FilePenLine, Files,
  FileText, Folder, FolderGit2, Gauge, GitBranch, GitMerge, GitPullRequest, Globe, GripVertical, Hash, Heading, History, Hourglass, House, Inbox,
  Info, Kanban, KeyRound, LayoutDashboard, LayoutList, Link, List, ListChecks, ListFilter, ListTodo, LoaderCircle, Mail, Megaphone, Menu,
  MessageCircle, MessageSquare, MessageSquareMore, Mic, Monitor, Moon, Network, OctagonX, PanelLeft, PanelRight, Pause, Pencil, PencilLine, Phone,
  Play, Plug, Plus, Radio, RefreshCw, Repeat2, RotateCcw, Rows3, Search, Send, Server, Settings, Settings2, Shapes, ShieldCheck, Smartphone, Square,
  SquareKanban, SquareTerminal, Star, SunMoon, Table, Timer, Trash2, TriangleAlert, Undo2, Unlink, Unplug, User, UserRound, UserRoundPlus, Users,
  Webhook, Workflow, X, Zap,
} from "lucide-static"
import { cn } from "./cn"

const ICONS: Record<string, string> = {
  "activity": Activity, "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight, "arrow-right-left": ArrowRightLeft,
  "arrow-up": ArrowUp, "arrow-up-right": ArrowUpRight, "arrow-up-to-line": ArrowUpToLine, "at-sign": AtSign, "ban": Ban, "bell-dot": BellDot,
  "book-open": BookOpen, "bookmark": Bookmark, "bot": Bot, "briefcase": Briefcase, "building-2": Building2, "calendar-clock": CalendarClock,
  "chart-line": ChartLine, "check": Check, "chevron-down": ChevronDown, "chevron-left": ChevronLeft, "chevron-right": ChevronRight,
  "chevrons-up-down": ChevronsUpDown, "circle": Circle, "circle-alert": CircleAlert, "circle-check": CircleCheck, "circle-dashed": CircleDashed,
  "circle-dollar-sign": CircleDollarSign, "circle-dot": CircleDot, "circle-x": CircleX, "clock": Clock, "cog": Cog, "copy": Copy,
  "download": Download, "ellipsis": Ellipsis, "external-link": ExternalLink, "eye": Eye, "eye-off": EyeOff, "file": File,
  "file-pen-line": FilePenLine, "file-text": FileText, "files": Files, "folder": Folder, "folder-git-2": FolderGit2, "gauge": Gauge,
  "git-branch": GitBranch, "git-merge": GitMerge, "git-pull-request": GitPullRequest, "globe": Globe, "grip-vertical": GripVertical, "hash": Hash,
  "heading": Heading, "history": History, "hourglass": Hourglass, "house": House, "inbox": Inbox, "info": Info, "kanban": Kanban,
  "key-round": KeyRound, "layout-dashboard": LayoutDashboard, "layout-list": LayoutList, "link": Link, "list": List, "list-checks": ListChecks,
  "list-filter": ListFilter, "list-todo": ListTodo, "loader-circle": LoaderCircle, "mail": Mail, "megaphone": Megaphone, "menu": Menu,
  "message-circle": MessageCircle, "message-square": MessageSquare, "message-square-more": MessageSquareMore, "mic": Mic, "monitor": Monitor,
  "moon": Moon, "network": Network, "octagon-x": OctagonX, "panel-left": PanelLeft, "panel-right": PanelRight, "pause": Pause, "pencil": Pencil,
  "pencil-line": PencilLine, "phone": Phone, "play": Play, "plug": Plug, "plus": Plus, "radio": Radio, "refresh-cw": RefreshCw, "repeat-2": Repeat2,
  "rotate-ccw": RotateCcw, "rows-3": Rows3, "search": Search, "send": Send, "server": Server, "settings": Settings, "settings-2": Settings2,
  "shapes": Shapes, "shield-check": ShieldCheck, "smartphone": Smartphone, "square": Square, "square-kanban": SquareKanban,
  "square-terminal": SquareTerminal, "star": Star, "sun-moon": SunMoon, "table": Table, "timer": Timer, "trash-2": Trash2,
  "triangle-alert": TriangleAlert, "undo-2": Undo2, "unlink": Unlink, "unplug": Unplug, "user": User, "user-round": UserRound,
  "user-round-plus": UserRoundPlus, "users": Users, "webhook": Webhook, "workflow": Workflow, "x": X, "zap": Zap,
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
