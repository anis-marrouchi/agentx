# Spike: a local d1 model watches the camera share (#844)

This is a demo only. It is not part of AgentX and must not be merged into a release as a feature.

**The question:** can a small open vision model run on the Mac, look at the frames from the phone camera share, and raise an alert when it sees something the owner named, like "a phone on the floor"?

`d1_watch.py` has two modes:

- **`bench`** runs a small labelled set of pictures and prints the figures the issue asks for: right and wrong answers, time per frame and memory.
- **`watch`** follows the frames the daemon's local tap writes (no agent turn) and pops up a Mac banner when a named target shows up on two frames in a row.

## The model

| | |
|---|---|
| Models | `LiquidAI/d1-3B` (text and images), `LiquidAI/d1-omni-600M` (text plus images or audio, experimental) |
| Where they come from | Hugging Face, published by Liquid AI on 2026-10-07 |
| Licence | **LFM Open License v1.0**, read from the `LICENSE` file on the Mac (8 October): free to use and change; a company with US$10M or more in yearly revenue needs a commercial licence from Liquid AI. |
| How it answers | It does not write text. You pass named questions (`choice`, `score`, or a yes/no type), and it returns a decision with probabilities in one pass. Asking three questions costs about 1.3× one question. |
| Published speed | About 16 to 50 ms per question on NVIDIA Jetson boards, and under 18 ms for a 384 px image on a desktop GPU. Liquid published **no Mac figures**, so this spike measures them. |

The script asks each target as a two-way `choice` (`yes` / `no`) because that is the type the published image example uses. All targets go into one pass per frame.

> The cloud session that wrote this could not reach huggingface.co, so the script follows the code on the published model card (`AutoModel.from_pretrained(..., trust_remote_code=True)` and `model.system_one(None, questions, images=[photo])`), but it has **not been run against the real weights**. The return shape was not visible either, so `yes_probability()` accepts the likely shapes. On the first run, pass `--raw` and check it.

## Run it on the Mac

1. In Terminal, create a separate Python environment for the spike:
   ```bash
   python3 -m venv ~/.venvs/d1-spike && source ~/.venvs/d1-spike/bin/activate
   ```
2. In Terminal, install the packages:
   ```bash
   pip install -r scripts/camera-d1-spike/requirements.txt
   ```
3. In Terminal, download the weights once (the `LICENSE` file comes with them):
   ```bash
   hf download LiquidAI/d1-3B
   ```
4. Open `~/.cache/huggingface/hub/models--LiquidAI--d1-3B/snapshots/*/LICENSE` and note the licence on the issue.
5. Read the Python files that came with the weights (`*.py` in the same folder) before running them. `trust_remote_code` runs them.
6. From here on, add `--offline` to every command so nothing is fetched or sent.

### Measure: `bench`

1. Make a folder with 15 to 30 pictures taken from the camera share, mixed with and without each target. Use a test room, not anything private.
2. Add `labels.json` next to the pictures, listing which targets each picture really shows (`[]` for none):
   ```json
   {
     "targets": ["a phone on the floor", "a child crawling", "an open door"],
     "images": {
       "frame-000012.png": ["a phone on the floor"],
       "frame-000031.png": [],
       "frame-000044.png": ["an open door", "a phone on the floor"]
     }
   }
   ```
3. In Terminal, run the bench:
   ```bash
   python scripts/camera-d1-spike/d1_watch.py --offline bench --set ~/d1-set --raw --out ~/d1-set/results.json
   ```
4. Copy the printed table, the latency line and the memory line into the issue.
5. Repeat with `--model LiquidAI/d1-omni-600M` to compare the small model.

`--threshold` (default `0.7`) is the probability of "yes" that counts as "seen". Raise it to cut false alarms, or lower it to miss less.

### Demo: `watch` (nothing leaves the Mac)

The first live try (8 October) read the phone **screen** over `adb`, so most frames were chat screens, not the camera. This demo reads real camera frames from the AgentX camera share instead, through a local frame tap added for this spike only.

The tap is three environment variables, read by the daemon when a share starts. It is a spike switch, not a setting: it is not in the config file and not in the docs.

| Variable | What it does | Default |
|---|---|---|
| `AGENTX_CAMERA_TAP_DIR` | Absolute folder. Each share writes its frames to `<folder>/<share id>/`. Unset: no tap. | unset |
| `AGENTX_CAMERA_TAP_SECONDS` | Seconds between frames. A frame is written only when a new one came from the phone. | `1` |
| `AGENTX_CAMERA_TAP_EDGE` | Longest side of a frame, in pixels. Above 768 the model gets about 7x slower. | `768` |

The tap writes a frame with **no agent turn**: no frame goes to a model provider. It keeps only the last 3 files and deletes the share's folder when the share ends.

1. In Terminal, build AgentX from this branch so the daemon has the tap (`pnpm install && pnpm build` in the repo, or however the Mac's daemon is installed from source).
2. In Terminal, turn the tap on and restart the daemon (the daemon runs under launchd, so the variable is set there):
   ```bash
   launchctl setenv AGENTX_CAMERA_TAP_DIR /tmp/agentx-camera-tap
   agentx daemon restart
   ```
   The daemon log then shows `local frame tap on` when a share starts.
3. Check that `channels.webrtc.camera.bot.frameIntervalSeconds` is `0` in the config. Then the agent gets a frame only when you tap **Look now**.
4. On the phone, open the AgentX app and tap **Start camera**, then pick any agent. Do not tap **Look now** or **Keep watching** during the test: those send a frame to the agent.
5. In Terminal, check that frames arrive (one new file about every second):
   ```bash
   ls /tmp/agentx-camera-tap/*/
   ```
6. In a second Terminal window, start the watcher on that folder:
   ```bash
   python scripts/camera-d1-spike/d1_watch.py --offline --model LiquidAI/d1-omni-600M watch \
     --frames /tmp/agentx-camera-tap \
     --target "a phone" --target "a baby or toddler crawling"
   ```
7. Put a phone in view of the camera. After two frames in a row a "Camera watcher" banner appears on the Mac, and an `ALERT` line is printed.
8. Press Ctrl-C in the watcher window. It prints peak memory.
9. On the phone, stop the share. The tap folder for that share is deleted.
10. In Terminal, turn the tap off:
    ```bash
    launchctl unsetenv AGENTX_CAMERA_TAP_DIR
    agentx daemon restart
    ```

The 600M runs on `llama-server` (GGUF) on the Mac were made with a separate script in the Mac's spike folder. To use that script instead of `d1_watch.py`, point its frame source at the newest `frame-*.png` under `/tmp/agentx-camera-tap/`.

Alerts stay on the Mac by default. `--notify` also sends the alert **text** (never the picture) with `agentx notify`, and that goes out as a phone push.

## Findings so far

Full figures are on #844.

- **Weights and licence:** `LiquidAI/d1-omni-600M-GGUF` and `LiquidAI/d1-3B-GGUF` on Hugging Face, **LFM Open License v1.0** (read from the `LICENSE` file): free below US$10M in yearly revenue.
- **d1-omni-600M on an 8 GB M2, 49 public photos:** "a phone" 48/49 right, no false alarms. "A small child crawling" found only 3/9 with that wording, 8/9 as "Is a baby or toddler crawling?" (wording picked on the same set, so optimistic). About 0.4 s per frame at 640 to 768 px for two questions, 676 MB. At 1024 px: 3.1 s and 1.6 GB. Hence the 768 px default here and in the tap.
- **Live try over Wi-Fi:** not conclusive. The source was the phone screen, so 37 of 39 frames were app screens, and on text-only screens "crawling" answered yes 17 times. The tap above fixes the source.
- **d1-3B:** weights are on the Mac, comparison not run yet.
- **What a real feature would need:** the tap as a proper setting with its own docs, the 768 px shrink, the named targets as config, the alert sent as text only, and a test set from the owner's own camera position.

## Check it worked

- Running `bench` prints a table with one row per target, then a latency line and a memory line.
- Running `watch` prints one line per new frame with a probability for each target. A banner appears when a target is in view.

## If something is wrong

- **`trust_remote_code` or `system_one` errors:** the model card's code may have changed. Check the card and update `load_model()` or `ask()`.
- **`unexpected answer for 't0'`:** run `bench --raw`, look at what came back, and adjust `yes_probability()`.
- **`watch` prints nothing:** check that `frame-*.png` files appear under `/tmp/agentx-camera-tap/<share id>/`. If the folder stays empty, look for `local frame tap on` in the daemon log. No such line: the daemon did not get `AGENTX_CAMERA_TAP_DIR` (it must be an absolute path), or it runs a build without the tap.
- **The tap writes nothing although the share is on:** the phone sends no video yet. The share's frame count on the dashboard should go up.
- **Very slow on the first frame:** MPS compiles on first use. `bench` leaves that frame out of its figures.
