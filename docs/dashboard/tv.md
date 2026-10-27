# AgentX TV — watch the Wall as a news channel

::: warning Experimental
AgentX TV is a prototype. It has one show, **The Build**, and its settings can be read but not changed yet. Expect it to change.
:::

AgentX TV turns your team's day into a short news programme you can play full screen, on a computer or in a TV's web browser. A **show** covers one kind of work. An **episode** is one programme of a show, about two minutes long: screens with the day's figures and stories, read by a presenter. The episodes made on one day form that day's **line-up**, and the TV page plays them one after another.

The first show is **The Build**: what happened in one public GitHub repository today. It covers pull requests (proposed code changes) opened and merged, and issues (bug reports and requests) opened and closed.

![How an episode is made and watched](/diagrams/agentx-tv.svg)

## Watch today's line-up

1. **Browser:** open the Wall and select **TV** in the nav on the left. On a phone, it is under **More** in the bottom bar. You can also open `/wall/tv` directly.

   ![The TV button in the Wall's nav](/screenshots/tv/wall-button.png)

2. The TV page opens on today's line-up. The list on the right shows each episode with the time it was made, its length, and **video** or **read live** (see [Video or read live](#video-or-read-live)).

   ![The TV page with today's line-up and the shows](/screenshots/tv/line-up.png)

   *Fictional data; your repository and stories will differ.*

3. Select **Play today's line-up**. The player goes full screen and plays every episode back to back. Select one episode in the list to start from it.
4. While it plays, use the buttons at the bottom of the picture, or these keys:
   - **Space**: pause or play,
   - **N** / **P**: next or previous episode,
   - **F**: leave or enter full screen,
   - **C**: captions (the presenter's words as text) on or off.

   The buttons fade after three seconds; move the mouse or press a key to bring them back.

   ![An episode playing, with captions and the ticker](/screenshots/tv/playing.png)

5. At the end of the line-up the player says so. Select **Play it again** to start over.

### On a TV

1. **TV:** open the TV's web browser and go to your dashboard's address followed by `/wall/tv`.
2. Sign in as you would on any other machine away from the computer running AgentX.
3. Use the remote's arrows to reach **Play today's line-up** and press **OK**. It plays full screen.

### On a phone

The player takes the full width and the shows move under it. Captions sit under the picture when you hold the phone upright, so they cover nothing.

![AgentX TV on a phone in dark mode](/screenshots/tv/phone.png)

## Replay another day

1. **Browser:** on the TV page, open the **Day** list at the top.
2. Pick a day. The list only offers days that have at least one episode, plus today.
3. Select **Play the line-up**.

When a day has no episode, the page says **Nothing on air yet** and offers the most recent day that has one.

![The off-air card for a day with no episode](/screenshots/tv/off-air.png)

## Video or read live

An episode plays in one of two ways:

- **video**: the episode was made into a video on a render server (a separate machine that does the heavy work; see [Make the video on a render server](#make-the-video-on-a-render-server)). It has a recorded voice.
- **read live**: there is no video yet. The page draws the same screens itself and reads the script aloud with your browser's own voice. If a video cannot be played, the page reads the episode live instead.

## Show settings

The **Shows** box lists every planned show and its settings. In this prototype they are fixed; only **The Build** is made.

| Setting | What it means | The Build |
| --- | --- | --- |
| Tone | How the presenter talks: **Funny**, **Serious** or **Sports commentary** | Funny |
| Look | The colours of the screens | Newsroom blue |
| Presenter | The name on screen, and the voice that reads | Max Merge (voice only, no on-screen person yet) |
| Length | About how long an episode lasts | about 2 min |
| Segments | The parts of every episode, in order | Headlines → Main story → Waiting for you → Sign-off |

The segments of The Build:

- **Headlines**: the day in figures (merged, opened, issues in and out) and the top three merges.
- **Main story**: the merge that changed the most lines, then the other merges, then the issue desk.
- **Waiting for you**: pull requests opened today that nobody has merged yet.
- **Sign-off**.

The other shows are **Ops Desk** (deploys and incidents), **Decisions** (what waits for you), **Money Minute** (cost) and **Client Corner** (client work). Shows marked **Internal only** will never be made for a public screen.

## What goes on air

The Build only reads what anyone can see on GitHub without signing in. It refuses a private repository. From that, it never shows:

- **people**: no author, reviewer or assignee is read. Names written as `@name` and email addresses are removed from titles,
- **money**: amounts such as `$40` or `30 EUR` are removed from titles,
- **links**: web addresses are removed from titles.

## Make an episode

Episodes are made from the terminal on the computer running AgentX.

1. **Terminal:** go to a folder whose Git origin is the GitHub repository to cover, or name it with `--repo`.
2. **Terminal:** run

   ```sh
   agentx tv make --repo acme/widgets
   ```

   It reads today's activity, writes the script and prints how many screens it has and how long it lasts.
3. **Browser:** open the TV page. The new episode is at the end of today's line-up, marked **read live**.

| Option | What it does |
| --- | --- |
| `--show <id>` | The show to make. Only `the-build` can be made now. |
| `--repo <owner/name>` | The public repository to cover. Default: the current folder's Git origin. |
| `--day <YYYY-MM-DD>` | The day to cover. Default: today. |
| `--render-on <host>` | Also make the voice and the video, on this render server. |
| `--render-here` | Also make the voice and the video, on this machine. Refused on a Mac. |

To list a day's episodes, run `agentx tv list` (add `--day <YYYY-MM-DD>` for another day, or `--json`).

GitHub allows 60 reads an hour without signing in, and an episode takes about ten. To read more, set the environment variable `GITHUB_TOKEN` to a GitHub token before running `agentx tv make`.

## Make the video on a render server

Making a video is heavy, so it never runs on a Mac: AgentX sends the script to a render server over SSH (the standard way to run commands on another machine) and brings the finished video back. The server makes the voice with a free voice model that runs on the server itself, so the script never goes to an outside service.

On a server with 4 processor cores, a two-minute episode takes about five minutes to make.

### Set up the render server once

1. **Render server terminal:** install Node.js 22 or later, `ffmpeg` and Python 3.
2. **Render server terminal:** install the voice model's tools in their own folder:

   ```sh
   python3 -m venv ~/.agentx-tv/venv
   ~/.agentx-tv/venv/bin/pip install kokoro-onnx soundfile
   ```

3. **Render server terminal:** tell the scripts where they are:

   ```sh
   echo "export HYPERFRAMES_PYTHON=$HOME/.agentx-tv/venv/bin/python" > ~/.agentx-tv/env
   ```

   The scripts read `~/.agentx-tv/env` before they start. `HYPERFRAMES_PYTHON` is the Python with the voice tools. `HYPERFRAMES` can name an installed copy of the video tool instead of downloading it each time.

4. **Your computer, terminal:** check you can reach the server without a password prompt:

   ```sh
   ssh render-box echo ok
   ```

   `render-box` is the server's name in your `~/.ssh/config`, or `user@address`.

### Make an episode with its video

1. **Your computer, terminal:** run

   ```sh
   agentx tv make --repo acme/widgets --render-on render-box
   ```

2. It prints `voice-over`, then `render`, then the video's length and how long it took.
3. **Browser:** open the TV page. The episode is marked **video**.

On the server, each episode has a folder under `~/.agentx-tv/`, with the scripts `voice.sh` and `render.sh`. You can run them again by hand there.

## Where episodes are kept

Each episode is a folder under `~/.agentx/tv/<day>/` on the computer running AgentX, with `episode.json` (the script, screen by screen) and, once made, `episode.mp4`. Set the environment variable `AGENTX_TV_DIR` to keep them somewhere else. Delete a folder to take an episode off the line-up.

## Check it worked

1. **Terminal:** `agentx tv make --repo acme/widgets` prints a line starting with a green tick and the episode's title.
2. **Terminal:** `agentx tv list` shows it under today's date.
3. **Browser:** the TV page lists it in **Today's line-up**, and **Play today's line-up** shows the opening screen with the show's name and today's date.
4. With `--render-on`, the episode says **video** in the list, and you hear the presenter's recorded voice.

## If something is wrong

- **"… is not public; The Build only airs public repositories"**: pick a public repository with `--repo`.
- **"GitHub …: 403"**: GitHub's limit for reads without signing in was reached. Set `GITHUB_TOKEN` and run it again, or wait an hour.
- **"no --repo, and this folder has no GitHub origin"**: add `--repo owner/name`.
- **"renders never run on a Mac"**: use `--render-on <host>` with your render server.
- **"voice-over failed for N screens"**: on the server, check `~/.agentx-tv/env` names the Python with `kokoro-onnx`, then look at the `.json` files in the episode's `vo` folder.
- **The render fails on the server**: run `sh ~/.agentx-tv/<day>/<id>/render.sh` there to see the full message. The server needs to reach the npm registry once per episode to fetch the animation library.
- **No sound when reading live**: browsers only play sound after a press; select **Play** rather than opening a link that starts playing. Check the TV or computer is not muted.
- **The page says "Could not load the line-up"**: sign in to the dashboard again, then select **Try again**.
- **Nothing happens on the TV's remote**: some TV browsers do not send **Space**; move to the on-screen buttons with the arrows and press **OK**.
