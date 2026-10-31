# Desktop helper and Windows

Computer use is AgentX reading your screen, pointing at things on it, and clicking and typing for you. The commands are `agentx point`, `agentx teach`, live lessons, and acting on a screen. AgentX does this through a small separate program called the **desktop helper**. AgentX asks the helper for one thing at a time ("read the window", "point here", "click") and the helper answers with a short text reply.

This page explains where AgentX looks for the helper, what works on which computer today, and what a helper for a new system has to do.

## What works where

| | macOS | Windows | Linux |
|---|---|---|---|
| Point, teach, act (computer use) | Yes, with the AgentX Helper app | Not yet: the Windows helper is still being built ([#1594](https://github.com/anis-marrouchi/agentx/issues/1594)) | Not yet |
| Notification banners | Yes | Yes, posted through Windows PowerShell | No |
| System sounds | Yes | Yes, from the Windows sound files | No |
| Idle time (how long since you last touched the keyboard or mouse) | Yes | Yes | No |
| Reminders, notes, Focus | Yes | No | No |
| Lesson screen recording (`agentx teach --record`) | Yes | No: the lesson runs without a recording | No |

When something is not available, AgentX says so in plain words instead of failing silently. To see what your computer offers, run `agentx doctor`.

## Where AgentX looks for the helper

AgentX picks the helper for your system, in this order:

1. The path in the `AGENTX_DESKTOP_HELPER` environment variable, if it is set. This works on every system.
2. On a Mac only, the path in `AGENTX_MAC_HELPER`. This is the older name and still works.
3. The installed helper:
   - **macOS:** `~/Applications/AgentX Helper.app`
   - **Windows:** `%LOCALAPPDATA%\Programs\AgentX\agentx-helper.exe` (`%LOCALAPPDATA%` is your own app-data folder, usually `C:\Users\<you>\AppData\Local`)
4. A helper built inside the AgentX installation:
   - **macOS:** `apps/mac-helper/build`
   - **Windows:** `apps\win-helper\build\agentx-helper.exe`

To use a helper from another folder:

1. **Terminal (macOS):** run `export AGENTX_DESKTOP_HELPER=/path/to/agentx-mac-helper`.
2. **PowerShell (Windows):** run `$env:AGENTX_DESKTOP_HELPER = "D:\tools\agentx-helper.exe"`.
3. Run the AgentX command again from the same window.

## What a helper does

Every helper, on every system, answers the same requests, so `point`, `teach` and lessons work the same everywhere. Each request is the helper's name followed by a word (the **verb**) and options, for example `agentx-helper point --x 100 --y 200 --w 80 --h 24`. The helper prints one JSON reply (a small block of structured text). When something goes wrong it exits with an error and prints `{"ok":false,"error":"..."}`.

Positions are screen points measured from the top-left corner, the same for every verb, so a position from `read` can go straight to `point` or `click`. On Windows the helper reports positions in scaled pixels, so a 150% display gives the same numbers as the Mac would.

| Verb | What it does | Needed for |
|---|---|---|
| `read` | Lists the controls in the window you are using | point |
| `ocr` | Reads text off the screen, on the computer | point |
| `point` | Moves the cursor to a control and highlights it | point |
| `focused`, `hittest` | Says what has keyboard focus, or what is on top at a spot | lessons |
| `click`, `type`, `key`, `scroll`, `drag` | Presses, types and scrolls | lessons, acting |
| `hud`, `presence` | Shows the lesson panel and the agent's own cursor with its name tag | lessons |
| `capture`, `screens`, `buffer` | Takes screenshots and reports the size of each display | looking, checks |
| `notify`, `notify-status` | Posts a banner, and says whether banners are allowed | banners |
| `trusted` | Says whether the helper may read and act | setup checks |

The full list, with what each system uses underneath, is kept in `src/computer-use/contract.ts`. A test checks that this list and the Mac helper answer the same verbs.

## Check it worked

1. **Terminal:** run `agentx point "the search field"` while a search field is on screen.
2. On a Mac with the helper installed, the cursor moves to the field and it is highlighted.
3. On Windows or Linux today, the command prints a line saying the helper is not found or computer use is not available yet, and does nothing else.
4. **Terminal:** run `agentx doctor`. On Windows it lists banners and sounds as available.

## If something is wrong

- **`helper not built`** (macOS): run `agentx desktop install`, or build it with `apps/mac-helper/build.sh`.
- **`Windows helper not found`:** the Windows helper is not released yet. If you have a test build, put `agentx-helper.exe` in `%LOCALAPPDATA%\Programs\AgentX`, or set `AGENTX_DESKTOP_HELPER` to its path.
- **`AGENTX_MAC_HELPER` is ignored on Windows:** that name only works on a Mac. Use `AGENTX_DESKTOP_HELPER`.
- **No banner appears on Windows:** open **Settings → System → Notifications** and check that notifications are on, and that **Windows PowerShell** is allowed to show them.
- **A sound name is not accepted on Windows:** use the name of a `.wav` file in `C:\Windows\Media` without the `.wav`, for example `tada`.
