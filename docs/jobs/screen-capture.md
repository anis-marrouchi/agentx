# Capture the screen at the right moment

An agent that checks your screen has to look **when** the thing it wants to see is there. A notification banner (the small message box in the top-right corner of a Mac) is gone within seconds, and a page that is still loading gets caught half-drawn. `agentx screen` takes the picture at the right moment instead of whenever the agent gets round to it:

- **After an action.** AgentX first notes how the screen looks, then runs the action. You get back the first picture after the screen changed and stopped moving.
- **When something changes.** `--until-changed` waits until part of the screen looks different from when you started.
- **When it settles.** `--until-stable` waits until part of the screen stops moving: animations, pages that are loading.
- **A few seconds ago.** An optional buffer keeps the last few seconds of the screen in memory, for an agent that arrives late.

Every picture is cut down to the part of the screen you asked for and shrunk to a size budget. The picture stays on your Mac until an agent sends it to an AI model, which is an online service (see [Your data](../your-data.md)). The agent then pays only for the pixels that matter.

## What you need

- A Mac with the AgentX desktop apps installed (`agentx desktop install`).
- **Screen Recording** permission for the **AgentX Helper** app. macOS asks the first time; you can also turn it on in **System Settings → Privacy & Security → Screen Recording**. Without it, macOS hands back a picture of the empty desktop.

## Choose which part of the screen

Every command takes `--region`. A region is the part of the screen to capture:

| Region | What it covers |
|---|---|
| `window` | The window you are using (the default) |
| `screen` | The whole screen |
| `menubar` | The strip at the top of the screen, where recording and sync icons live |
| `notifications` | The top-right corner of the main screen, where banners appear |
| `x,y,w,h` | Any rectangle, in screen points measured from the top-left corner |
| a name | A region you saved yourself (see [Save a region](#save-a-region)) |

A saved region with a built-in name replaces the built-in one. For example, save `notifications` if your banners appear somewhere else.

## Capture what a command did

1. **Terminal:** put the command after `--`. This example shows a test banner:
   ```sh
   agentx screen capture --region notifications -- osascript -e 'display notification "hello"'
   ```
2. Read the result. The first line is the picture; the second says where it was taken and what AgentX saw while it waited:
   ```
     /var/folders/…/agentx-capture-1790404376019-98390.png
     420×180 at 1020,26 · 57KB · changed, stable after 1001ms
   ```

The command always runs, even when the capture cannot (no helper, no permission): the picture is evidence, not a gate. AgentX exits with the command's own exit code.

## Prove that a notification showed

`agentx notify --proof` does the same for its own banner, in one call.

1. **Terminal:** send a notification with proof:
   ```sh
   agentx notify "Build finished" --proof
   ```
2. Read the result. `✓ banner:` is followed by the picture of the banner:
   ```
     → sent
     ✓ banner: /var/folders/…/agentx-capture-1790404313275-96886.png · 1731ms
   ```

With `--json`, the result has a `proof` field. It holds the picture, or an `error` that says why there is none: the message was held because you are in Focus, the banner is turned off, or the corner never changed because Do Not Disturb is on. See [Get notified](./notifications.md).

## Wait for a change, or for things to settle

1. **Terminal:** pick the wait you need:
   ```sh
   agentx screen capture --region menubar --until-changed      # first picture after something changes
   agentx screen capture --until-stable                        # the current window, once it stops moving
   agentx screen capture --region 0,0,800,600 --until-changed --until-stable
   ```

With both, AgentX waits for a change and then for the change to finish. A capture that runs out of time still gives you a picture, marked `timed out`, so the agent knows it did not see the moment it asked for.

Useful extras:

- `--json` prints the picture's path, the region, and what the wait saw: `changed`, `stable`, `timedOut` and `waitedMs`.
- `--out <path>` chooses where the picture is saved.
- `--max-pixels <n>` changes the size budget for this one capture.

## In screen checks and lessons

The same waiting is used elsewhere:

- **`agentx look --settle`** waits for the window to stop moving before the AI model looks at it. It works with `--verify` too.
- **Lessons (`agentx teach`)** wait for the screen to stop moving after a click, typing or a key press, before checking that the step worked.

Both use the wait settings below. With an older AgentX Helper that cannot wait, they take the picture straight away, as before; run `agentx desktop install` to update it.

## Look back a few seconds

The buffer is off by default. When you turn it on, the AgentX background service keeps the last few seconds of one region **in memory only**. Pictures are written to disk only when an agent asks for them, and deleted again after 10 minutes.

1. **Terminal:** turn the buffer on and choose what it watches:
   ```sh
   agentx screen config --buffer on --buffer-region notifications --buffer-seconds 10
   ```
2. **Terminal:** later, ask for the last 5 seconds:
   ```sh
   agentx screen recent --seconds 5
   ```
3. Read the result. Each line is one picture and how long ago it was taken:
   ```
     /var/folders/…/agentx-screen-Ab12Cd/frame-000.png 4.5s ago · 483×207
     /var/folders/…/agentx-screen-Ab12Cd/frame-001.png 2.2s ago · 483×207
   ```

Only pictures that differ from the one before are kept, so a still screen costs one picture. The list also includes the picture that was already showing when the 5 seconds began.

`agentx screen recent` needs the background service running on the same Mac. It only answers requests from that Mac.

The buffer watches a fixed rectangle. `window` means whichever window was in front when the buffer started, so prefer `screen`, `notifications` or a saved region.

## Settings

Everything lives in the `screen` block of `agentx.json`. The background service applies a change without a restart, including turning the buffer on or off.

```json
{
  "screen": {
    "maxPixels": 1200000,
    "timeoutMs": 5000,
    "intervalMs": 100,
    "changeThreshold": 0.015,
    "stableMs": 400,
    "regions": { "chat": { "x": 0, "y": 60, "width": 720, "height": 800 } },
    "buffer": { "enabled": false, "seconds": 10, "fps": 2, "region": "screen", "maxPixels": 300000 }
  }
}
```

| Setting | Default | What it does |
|---|---|---|
| `maxPixels` | 1200000 | Size budget for a picture. Bigger pictures are shrunk, keeping their shape |
| `timeoutMs` | 5000 | Longest a capture waits for a change or for things to settle, in milliseconds |
| `intervalMs` | 100 | How often the screen is checked while waiting, in milliseconds |
| `changeThreshold` | 0.015 | How different the screen must look (0 to 1) to count as a change. Raise it if a blinking cursor triggers captures |
| `stableMs` | 400 | How long the screen must stay still to count as settled, in milliseconds |
| `regions` | none | Your saved regions, in screen points |
| `buffer.enabled` | false | Keep recent pictures in memory |
| `buffer.seconds` | 10 | How far back the buffer reaches (up to 120) |
| `buffer.fps` | 2 | Pictures per second (up to 10) |
| `buffer.region` | `screen` | Region the buffer watches |
| `buffer.maxPixels` | 300000 | Size budget per buffered picture |

### Change settings in the browser

1. **Browser:** open the dashboard and select **Settings**.
2. **Browser:** open the **Channels** tab.
3. **Browser:** expand **Screen capture**.
4. **Browser:** change the values you need. Saved regions go one per line, as `name=x,y,width,height`.
5. **Browser:** select **Save screen capture**. The message **Saved** appears next to the button.

<!-- No screenshot yet: this card needs a re-shoot from the docs demo instance (pnpm docs:demo / docs:shots), which was not run for this change. -->

### Change settings in the terminal

1. **Terminal:** show the current settings:
   ```sh
   agentx screen config
   ```
2. **Terminal:** change one or more values, for example:
   ```sh
   agentx screen config --max-pixels 800000 --stable-ms 600
   ```

`agentx screen config` changes `./agentx.json`. Pass `-c /path/to/agentx.json` to change another file.

### Save a region

1. **Terminal:** save a region named `chat`:
   ```sh
   agentx screen config --region chat=0,60,720,800
   ```
2. **Terminal:** use it:
   ```sh
   agentx screen capture --region chat --until-stable
   ```
3. **Terminal:** remove it when you no longer need it:
   ```sh
   agentx screen config --remove-region chat
   ```

To find a rectangle's numbers, capture the whole screen with `agentx screen capture --region screen --json` and measure in the picture. The picture may be shrunk: scale your numbers by the `region` width in the result divided by the picture's width.

<!-- No screenshots of the capture results: they would show a real desktop, and docs screenshots come only from the demo instance. -->

## Check it worked

1. **Terminal:** run `agentx screen capture --region notifications -- osascript -e 'display notification "test"'`.
2. Open the picture it prints. It shows the banner.
3. **Terminal:** run `agentx notify "hello" --proof`. It prints `✓ banner:` and a path.
4. **Terminal:** run `agentx screen config --buffer on --buffer-region notifications`.
5. Show any notification, and wait for it to go away.
6. **Terminal:** run `agentx screen recent`. One of the pictures shows the banner.

## If something is wrong

- **The picture shows only the desktop background.** AgentX Helper has no Screen Recording permission. Turn it on in **System Settings → Privacy & Security → Screen Recording**, then try again.
- **`helper not built`.** The desktop apps are not installed. Run `agentx desktop install`.
- **`AgentX Helper is out of date and cannot wait`.** Your helper predates waiting. Run `agentx desktop install`.
- **`--proof` says the banner region did not change.** Do Not Disturb or a Focus mode is hiding banners, or AgentX Helper is not allowed to post them. Check **System Settings → Notifications → AgentX Helper**. If your banners appear elsewhere on screen, save your own `notifications` region.
- **Every capture says `timed out`.** Something in the region keeps moving (a clock, a video, a blinking cursor). Pick a smaller region, or raise `changeThreshold` a little.
- **`screen buffer is off`.** Turn it on with `agentx screen config --buffer on`. The buffer only runs on a Mac.
- **`could not reach the daemon`.** Start the background service with `agentx daemon start --detach`, and run `agentx screen recent` on the same Mac.
- **`unknown region`.** Check the spelling, or list saved regions with `agentx screen config`.
