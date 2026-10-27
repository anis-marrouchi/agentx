# AgentX TV — spike note (#1471)

The Wall as a TV news channel. Prototype built 2026-10-27 to the owner's refinement: one show (**The Build**), one ~2 min episode from today's public activity on this repository, voice-over + HyperFrames screens, no avatar, tone funny, a TV page behind a TV button. No build issues are filed until the owner has watched it.

## 1. Live or bulletin → bulletin

A live stream needs a renderer running all day and something new to say every minute. A bulletin is made once, from facts that are already final, and replays for free. The prototype makes **episodes** (bulletins) and the TV page plays the day's **line-up** back to back, with a day picker for replay. Recommendation: one episode per show at fixed times (for example 12:00 and 18:00) plus on demand; no live stream.

## 2. Cost per bulletin

Measured on the sample episode (27 Oct, 8 merges, 34 PRs opened, 26 issues filed):

| Item | Measured | Cost |
| --- | --- | --- |
| Facts | 9 GitHub API reads (repo, PR list, issue list, 6 PR sizes) | free |
| Script | template writer, deterministic, no model call | free |
| Voice-over | HyperFrames `tts` (Kokoro-82M, local), 7 lines | free, a few seconds of CPU per line |
| Video | HyperFrames `render`, 1920×1080, 30 fps, 116.6 s of video | 312 s on 4 vCPU / 15 GB (≈2.7× real time) |
| Output | H.264 + AAC MP4 | 10.5 MB |

So a bulletin costs about **5 render-minutes on 4 cores and nothing else**. On a flat-rate rented render server the marginal cost is zero; at 2 bulletins a show a day, 5 shows is ~50 render-minutes a day. The open cost is the **avatar**: HeyGen bills per generated avatar minute, so it would add (avatar minutes per bulletin × price per minute) — about 2 min per bulletin. Not priced here: check the current HeyGen plan before saying yes to the avatar.

## 3. Where it renders → off the Mac

`agentx tv make --render-on <host>` ships the episode folder to the render server over SSH, runs `voice.sh` (tts) then `render.sh` (render) there, and brings `episode.mp4` back. `--render-here` renders on the current machine and is **refused on macOS** in code. Findings from the spike:

- The renderer's headless Chrome may have no internet. A GSAP loaded from a CDN fails the render (`sub_timeline_script_failure`), so GSAP is fetched once per episode with `npm pack` into the folder and loaded locally.
- `tts` needs `kokoro-onnx` + `soundfile` in a Python the server can find (`HYPERFRAMES_PYTHON`, read from `~/.agentx-tv/env`).
- Screens are timed from the **real** voice lengths: pass 1 makes the voice, the episode is retimed, pass 2 renders.
- Without a render server the TV page still works: it draws the same screens (same `tvScreenHtml`) and reads the script with the browser's voice ("read live").

## 4. What goes on air

**The Build** reads only public GitHub data and refuses a private repository. On air: counts (merged, opened, issues in/out), the biggest merge with its size, the other merges, new issues, PRs opened today still waiting. **Never** on air: authors, reviewers or assignees (not read at all), `@handles` and emails in titles, money amounts in titles, links. Shows that would touch client work, decisions or money (Client Corner, Decisions, Money Minute) are marked **internal only** and are not made in the prototype.

## 5. The button

**TV** sits in the Wall's left nav after **Cost** (on a phone, under **More**). It opens `/wall/tv`: today's line-up with one **Play** button, which goes full screen. When no episode exists for the day, an off-air card says so, names `agentx tv make`, and offers the latest day that has one. Keys: Space, N/P, F, C (captions). Show settings are listed read-only.

## Not built yet (from the model in the issue)

On-demand producer chat (script first, then episode); scheduled episodes (today: run `agentx tv make` from a schedule); the other four shows; editable show settings; the avatar presenter; mesh-wide activity beyond one public repository.

## Questions for the owner

1. Is the funny tone right, or too much? (Serious and sports banks exist.)
2. Keep the presenter name "Max Merge"?
3. Avatar next (HeyGen cost per minute), or voice only for now?
4. Which times should episodes be made, and on which render server?
