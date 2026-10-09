# Spike: a local d1 model watches the camera share (#844)

This is a demo only. It is not part of AgentX and must not be merged into a release as a feature.

**The question:** can a small open vision model run on the Mac, look at the frames from the phone camera share, and raise an alert when it sees something the owner named, like "a phone on the floor"?

`d1_watch.py` has two modes:

- **`bench`** runs a small labelled set of pictures and prints the figures the issue asks for: right and wrong answers, time per frame and memory.
- **`watch`** follows the camera share's frame folder and pops up a Mac banner when a named target shows up on two frames in a row.

## The model

| | |
|---|---|
| Models | `LiquidAI/d1-3B` (text and images), `LiquidAI/d1-omni-600M` (text plus images or audio, experimental) |
| Where they come from | Hugging Face, published by Liquid AI on 2026-10-07 |
| Licence | Third-party copies of the cards name the **LFM Open License v1.0**: free use, but commercial use needs a licence from Liquid AI for companies with US$10M or more in yearly revenue. **Read the `LICENSE` file in the repo on the Mac before relying on this.** Liquid's own blog says "without restrictions", which does not match the cards. |
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

### Demo: `watch`

AgentX keeps only the newest camera frame in memory and writes it to disk only when an agent looks. The demo uses existing settings to make frames land in a folder:

1. Open the AgentX config and, under `channels.webrtc.camera.bot`, set `keepFrames` to `true` and `frameIntervalSeconds` to `2`. Then restart the daemon.
2. On the phone, start the camera share to an agent (**Start camera**, pick the agent).
3. In Terminal, start the watcher on that agent's workspace:
   ```bash
   python scripts/camera-d1-spike/d1_watch.py --offline watch \
     --frames <agent-workspace>/.agentx/camera \
     --target "a phone on the floor" --target "a child crawling"
   ```
4. Put a phone on the floor in view. After two frames, a "Camera watcher" banner appears on the Mac and an `ALERT` line is printed.
5. Press Ctrl-C to stop. The watcher prints peak memory.
6. Set `keepFrames` and `frameIntervalSeconds` back, delete `<agent-workspace>/.agentx/camera/`, and restart the daemon.

**Caution: this demo path sends frames off the Mac.** Every interval frame is also given to that agent as a turn, and (per [Show the camera](../../docs/dashboard/mobile-camera.md)) each picture goes to the agent's online model provider. That breaks the issue's "nothing is sent off the machine" rule. Use it only with the owner's OK, in a test room, for a short share. The `bench` mode is fully local. A real build would read frames straight from the in-memory sampler (`src/camera/sampler.ts`) with no agent turn. See the findings below.

Alerts stay on the Mac by default. `--notify` also sends the alert **text** (never the picture) with `agentx notify`, and that goes out as a phone push.

## Findings so far

- **Weights:** open, on Hugging Face, under the LFM Open License v1.0 (to be confirmed from the `LICENSE` file).
- **Fit for a watcher:** good on paper. One pass answers several named yes/no questions with probabilities, which is exactly the alert rule. No text generation and no prompt parsing are needed.
- **Frame access is the main gap in AgentX:** there is no way for a local process to read the newest frame without an agent turn. `/webrtc/camera/look` needs a running turn of the agent, and files exist only while a turn looks at them. A watcher feature would need a frame tap on `FrameSampler` that never writes to disk or calls a model provider.
- **Still to measure on the Mac:** accuracy on the labelled set, time per frame on MPS, and memory, for both models.

## Check it worked

- Running `bench` prints a table with one row per target, then a latency line and a memory line.
- Running `watch` prints one line per new frame with a probability for each target. A banner appears when a target is in view.

## If something is wrong

- **`trust_remote_code` or `system_one` errors:** the model card's code may have changed. Check the card and update `load_model()` or `ask()`.
- **`unexpected answer for 't0'`:** run `bench --raw`, look at what came back, and adjust `yes_probability()`.
- **`watch` prints nothing:** check that `keepFrames` is on, that `frameIntervalSeconds` is above 0, and that the daemon was restarted. Then check that `frame-*.png` files appear under the agent's `.agentx/camera/` folder.
- **Very slow on the first frame:** MPS compiles on first use. `bench` leaves that frame out of its figures.
