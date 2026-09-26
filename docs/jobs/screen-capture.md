# Capture the screen at the right moment

An agent that checks the screen needs to look **when** the thing it is looking for is visible. A notification banner is gone within seconds, and a page that is still loading is caught half-drawn. `agentx screen` captures at the right moment instead of whenever the agent gets round to it:

- **After an action.** Capture is armed first, then the action runs. The frame returned is the first one after the region changed and settled.
- **When something changes.** `--until-changed` waits for the region to look different from when the capture started.
- **When it settles.** `--until-stable` waits until the region stops moving: animations, page loads.
- **A little while ago.** An opt-in buffer keeps the last few seconds of a region in memory, for an agent that arrives late.

Every capture is cropped to its region and downscaled to a pixel budget, so a model reading it spends tokens only on the pixels that matter.

## What you need

A Mac with the AgentX desktop apps installed (`agentx desktop install`). The **AgentX Helper** app does the capturing and needs **Screen Recording** permission: allow it in **System Settings → Privacy & Security → Screen Recording** when macOS asks. Without it, macOS returns an image of the bare desktop.

## Regions

Every command takes `--region`:

| Region | What it covers |
|---|---|
| `window` | The focused window (default) |
| `screen` | The whole screen with the active window |
| `menubar` | The menu bar strip, where recording and sync indicators live |
| `notifications` | The top-right corner of the main screen, where banners appear |
| `x,y,w,h` | Any rectangle, in screen points from the top-left |
| a name | A region you saved in `screen.regions` (see [Settings](#settings)) |

A saved region with a built-in name replaces it. For example, save `notifications` if your banners appear somewhere else.

## Capture after an action

Put the action after `--`. AgentX arms the capture, runs the command, and prints the frame that shows what the command did:

```sh
agentx screen capture --region notifications -- osascript -e 'display notification "hi"'
```

```
  /var/folders/…/agentx-capture-1790404376019-98390.png
  420×180 at 1020,26 · 57KB · changed, stable after 1001ms
```

The command always runs, even when the capture cannot (no helper, no permission). The capture is evidence, not a gate. The exit code is the command's.

### Proof that a notification showed

`agentx notify --proof` does the same for its own banner, in one call:

```sh
agentx notify "Build finished" --proof
```

```
  → sent
  ✓ banner: /var/folders/…/agentx-capture-1790404313275-96886.png · 1731ms
```

With `--json`, the result has a `proof` field: the frame, or an `error` explaining why there is none. For example, the message was held for Focus, or the banner region never changed because Do Not Disturb is on. See [Get notified](./notifications.md).

## Wait for a change, or for things to settle

```sh
agentx screen capture --region menubar --until-changed   # first frame after something changes
agentx screen capture --until-stable                     # the focused window, once it stops moving
agentx screen capture --region 0,0,800,600 --until-changed --until-stable
```

Both together wait for a change, then for it to finish. A capture that runs out of time still returns a frame, marked `timed out`, so the agent knows it did not see the moment it asked for.

`--json` prints the path, the region, and what the wait saw: `changed`, `stable`, `timedOut` and `waitedMs`. `--out <path>` chooses the file, and `--max-pixels <n>` changes the size budget for one capture.

## Look back: the recent-frames buffer

Off by default. When on, the daemon keeps the last few seconds of one region **in memory**. Nothing is written to disk until an agent asks:

```sh
agentx screen config --buffer on --buffer-region notifications --buffer-seconds 10
agentx screen recent --seconds 5
```

```
  /var/folders/…/agentx-screen-Ab12Cd/frame-000.png 4.5s ago · 483×207
  /var/folders/…/agentx-screen-Ab12Cd/frame-001.png 2.2s ago · 483×207
```

Only frames that differ from the one before are kept, so a still screen costs one frame. The frames returned include the one that was already showing when the window opened. `agentx screen recent` needs the daemon running. It uses `MESH_TOKEN` when the daemon asks for one, because the frames show this Mac's screen.

The buffer watches a fixed region. `window` means whichever window was focused when the buffer started, so prefer `screen`, `notifications` or a saved region.

## Settings

Everything lives in the `screen` block of `agentx.json`. The daemon applies a change without a restart, including turning the buffer on or off.

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
| `maxPixels` | 1200000 | Pixel budget for a captured frame. Larger captures are scaled down, keeping the aspect ratio |
| `timeoutMs` | 5000 | Longest a capture waits for a change or for things to settle |
| `intervalMs` | 100 | Time between samples while waiting |
| `changeThreshold` | 0.015 | Mean difference (0 to 1) that counts as a change. Raise it if a blinking cursor triggers captures |
| `stableMs` | 400 | How long a region must hold still to count as stable |
| `regions` | none | Named regions, in screen points |
| `buffer.enabled` | false | Keep recent frames in memory |
| `buffer.seconds` | 10 | How far back the buffer reaches (up to 120) |
| `buffer.fps` | 2 | Samples per second (up to 10) |
| `buffer.region` | `screen` | Region the buffer watches |
| `buffer.maxPixels` | 300000 | Pixel budget per buffered frame |

::: info In the browser
Open **Settings → Channels → Screen capture**. Named regions go one per line, as `name=x,y,width,height`. Select **Save screen capture**.
:::

::: info Terminal
```sh
agentx screen config                                   # show the settings
agentx screen config --max-pixels 800000 --stable-ms 600
agentx screen config --region chat=0,60,720,800        # save a region
agentx screen config --remove-region chat
agentx screen config --buffer on --buffer-fps 4 --buffer-region chat
```
:::

## Check it worked

1. Run `agentx screen capture --region notifications -- osascript -e 'display notification "test"'`. Open the printed PNG: it shows the banner.
2. Run `agentx notify "hello" --proof`. It prints `✓ banner:` and a path.
3. Turn the buffer on, show any notification, wait for it to go, and run `agentx screen recent`. One of the frames shows the banner.
