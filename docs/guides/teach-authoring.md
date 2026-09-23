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
