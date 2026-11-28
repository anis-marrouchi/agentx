// The Hub's built-in extension (#2218 part 2): its pages come in through the
// same defineHubExtension() call a plugin will use. Pages move here one PR
// at a time (step 1: the right panel, step 2: the Task page, ...).
import { defineHubExtension } from "../registry"
// In the main bundle: drawn while the feed's own code loads (no jump).
import { FeedPageSkeleton } from "../feed/frame"

defineHubExtension({
  id: "core",
  routes: [
    { page: "catalog", title: "Components", load: () => import("../pages/CatalogPage") },
    { page: "home", title: "Home", load: () => import("../pages/ShellPage") },
    { page: "settings-preview", title: "Settings", load: () => import("../settings/SettingsPage") },
    { page: "task", title: "Task", load: () => import("../task/TaskPage") },
    { page: "feed-preview", title: "Hub", load: () => import("../feed/FeedPage"), fallback: FeedPageSkeleton },
  ],
})
