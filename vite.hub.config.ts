// --- The React Hub's build (#2218) ---
//
// Vite for the browser app in src/hub: one React for every page, lazy pages
// as their own chunks, a CSS file, hashed names. Output goes to
// dist/web/hub/, served by the daemon at /assets/hub/ (board-dashboard.ts).
// The daemon reads manifest.json to write the entry's <script> and <link>
// into /hub (src/daemon/ui/hub-react.ts). tsup still builds the daemon, the
// CLI and the three older bundles (tsup.web.config.ts).
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { defineConfig } from "vite"

const root = fileURLToPath(new URL("./src/hub", import.meta.url))

export default defineConfig({
  root,
  base: "/assets/hub/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: fileURLToPath(new URL("./dist/web/hub", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "",
    manifest: "manifest.json",
    sourcemap: true,
    target: "es2020",
    cssCodeSplit: true,
    rollupOptions: { input: { hub: fileURLToPath(new URL("./src/hub/main.tsx", import.meta.url)) } },
  },
})
