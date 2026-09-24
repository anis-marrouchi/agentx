# Authoring a teach lesson

Lessons currently live in `src/teach/lessons.ts`. There is no `teach create` command or external lesson loader yet. Add a typed `Lesson` object, then include it in `LESSONS`.

A lesson has an `id`, `title`, `appHint`, optional `start` (application, URL and a visible readiness claim), and ordered `steps`. Each step has spoken `say` text, optionally a `find` description and `label`. `click` requires a located target; `type` and `key` operate on the focused control. Every action step must provide a `before` claim that can be verified on screen. Add `verify` to check its result; mandatory checks stop on failure or unavailable verification. `verifyOptional` is only for nonessential observations.

```ts
const example: Lesson = {
  id: "example-tour",
  title: "A tour of Example",
  appHint: "Opens Example in Chrome.",
  start: {
    app: "Google Chrome",
    url: "https://example.com",
    ready: "Google Chrome is frontmost showing the Example Domain page",
  },
  steps: [{
    say: "This link opens more information.",
    find: "the Learn more link",
    label: "Learn more",
  }],
}
```

Build with Node 22 using `npm run build`, then run `agentx teach example-tour`. Run `agentx teach` to list registered lessons. Narration-only rehearsal uses `--no-speak`; it does not disable actions. Sign-in remains a human prerequisite. Page setup opens a browser URL, then checks readiness; a slow page or wrong browser window stops the lesson and requires a retry after correcting the screen.

## Lessons on the AgentX demo

`agentx teach agentx-dashboard-tour` tours the dashboard of the Docker demo (`docker compose -f docker-compose.demo.yml up -d`). It only points and clicks navigation, so it never changes the demo's state.

- Run it from a project directory whose `agentx.json` enables the `ui-element` and `screen-state` decision seats. Without them, every `find` reports "Could not find" and every claim is unverifiable.
- `start.cleanWindow: true` opens a throwaway Chrome profile in app mode. An everyday window's tabs, bookmarks and extensions use up the screen reader's candidates before it reaches the page, and would appear in a recording. The window opens below the callout, which otherwise covers the page's top navigation.
- Write each claim as one plainly visible fact, such as `The text laptop-paris is visible on the page`. Compound claims ("A and B listed") and claims about the browser rather than the page often come back inconclusive, which stops the lesson.
