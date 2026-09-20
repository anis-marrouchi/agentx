// Lessons for `agentx teach`.
//
// A lesson is a sequence of things to SAY, each optionally paired with
// something to POINT AT. The narration is written to be heard, not read:
// short sentences, no jargon before it is explained, and no URLs — the
// same constraints the voice path has everywhere else.
//
// `find` is a description, not a selector. It goes to the ui-element seat,
// which picks from what is actually on screen — so a lesson keeps working
// when a site moves its buttons, and fails honestly when the screen is not
// where it expected rather than pointing confidently at the wrong thing.

export interface LessonStep {
  /** Spoken aloud, printed, and shown in the on-screen callout. */
  say: string
  /** What to point at, in plain words. Omit for narration only. */
  find?: string
  /** Overrides the label shown on the highlight pill. */
  label?: string
  /** Click the located element. Requires `find`. */
  click?: boolean
  /** Type this after locating (and clicking) — paced like a hand. */
  type?: string
  /** Press a named key afterwards, e.g. "return" to submit. Separate from
   *  `type` so committing a form is always its own deliberate step. */
  key?: string
  holdSeconds?: number
  /** Pause after a click, for pages that navigate. */
  afterClickWaitMs?: number
}

export interface Lesson {
  id: string
  title: string
  /** What should be on screen before starting. */
  appHint: string
  steps: LessonStep[]
}

/**
 * X advanced search operators.
 *
 * Chosen because the gap between what people do and what is possible is
 * unusually wide here. Almost everyone types words into the search box and
 * scrolls. Almost nobody knows the box accepts operators — and one of them,
 * min_faves, turns the search into "show me this person's best work", which
 * is the thing people actually want and have no other way to get.
 */
const xAdvancedSearch: Lesson = {
  id: "x-advanced-search",
  title: "X search: find anyone's best posts",
  appHint: "Open x.com in Chrome first, signed in.",
  steps: [
    {
      say: "Here's something about X search that almost nobody uses. It takes ten seconds and it changes what the site is good for.",
    },
    {
      say: "Let's open search. This is it in the sidebar.",
      find: "the search and explore link in the sidebar",
      label: "Search",
      click: true,
      // x.com navigates here; the input only exists on the page that loads.
      afterClickWaitMs: 2600,
    },
    {
      say: "Here's the box itself. Most people type a few words here and scroll. But it accepts commands, not just words.",
      find: "the search query input field where you type",
      label: "search field",
      click: true,
      afterClickWaitMs: 900,
    },
    {
      // One `type`, not two.
      //
      // Split across two steps, only the second survived: x.com is a SPA
      // and its search field re-rendered between them, discarding the
      // first. The take showed q=min_faves:500 with "from:naval" gone and
      // an error on the results page. Any field with autocomplete or
      // controlled state can do this, so a single query goes in a single
      // call and the narration carries the explanation instead.
      say: "Watch. From colon, then a username, limits it to that person. Then min underscore faves, colon, five hundred — only posts with at least five hundred likes.",
      type: "from:naval min_faves:500",
      holdSeconds: 1.8,
    },
    {
      say: "And submit.",
      key: "return",
      holdSeconds: 3.2,
    },
    {
      say: "There it is. That person's greatest hits — everything they wrote that actually landed. No scrolling through years of replies.",
      holdSeconds: 2,
    },
    {
      say: "Two more that pair well with it. Until colon, and since colon, with a date, pin it to a time period. Useful when you half remember something from a particular month.",
    },
    {
      say: "And filter colon links, or filter colon media, narrows it to posts that shared something, which is usually where the substance is.",
    },
    {
      say: "After you search, check the Latest tab. Top is ranked, Latest is chronological, and for research you almost always want chronological.",
      find: "the Latest tab",
      label: "Latest",
    },
    {
      say: "That's it. From colon someone, min underscore faves colon five hundred. It works on your own account too, which is a quick way to see what people actually responded to.",
    },
  ],
}

/**
 * Bookmark folders. Shipped quietly, still largely unknown, and the
 * closest thing X has to a research tool.
 */
const xBookmarkFolders: Lesson = {
  id: "x-bookmark-folders",
  title: "X bookmarks: turn the pile into folders",
  appHint: "Open x.com in Chrome first, signed in.",
  steps: [
    {
      say: "Most people's bookmarks on X are a single pile they never open again. There's a fix that takes a minute.",
    },
    {
      say: "Bookmarks live here in the sidebar. By default everything you save lands in one list, in the order you saved it.",
      find: "the Bookmarks link in the sidebar",
      label: "Bookmarks",
    },
    {
      say: "But bookmarks support folders. Open bookmarks and look for the add folder control, usually a small plus at the top right.",
      find: "the add folder button",
      label: "new folder",
    },
    {
      say: "The trick is what you name them. Not topics like design or tech, which you'll never search for. Name them after decisions you're going to make, like hiring, or pricing.",
      holdSeconds: 2,
    },
    {
      say: "Then when you save a post, hold the bookmark button instead of tapping it, and it asks which folder. That one gesture is the whole difference between a pile and a library.",
    },
  ],
}

export const LESSONS: Lesson[] = [xAdvancedSearch, xBookmarkFolders]
