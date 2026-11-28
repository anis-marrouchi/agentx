# Desktop app

The AgentX desktop app opens the **Hub** in its own window. The Hub is the dashboard page where you chat with your agents and see what they are doing. The app also puts an AgentX icon in the top bar of your screen. On macOS that is the menu bar. On Windows and Ubuntu it is the notification area next to the clock. The same app runs on macOS, Windows and Ubuntu.

The app does not run your agents. The AgentX **daemon** runs them: it is the background program you start with `agentx daemon start`. The app is a window onto that daemon's dashboard on the same computer.

## Before you start

- AgentX is installed and the daemon is running on this computer. The dashboard opens in a browser at `http://127.0.0.1:4202`.
- A microphone, if you want to talk to your agents from the Hub.

## Install

The app is still in preview. Each change to it is built for all three systems by the **Desktop app** job on GitHub, and the builds are not signed yet.

1. Open the repository's **Actions** tab on GitHub and select the latest green **Desktop app** run.
2. Under **Artifacts**, download the file for your system: `agentx-desktop-macos` (a `.dmg`), `agentx-desktop-windows` (an `.exe` installer) or `agentx-desktop-linux` (an `.AppImage` and a `.deb`).
3. Install it:
   - **macOS**: open the `.dmg` and drag **AgentX** into **Applications**. The build is not signed, so the first time, right-click **AgentX** in Applications, click **Open**, then click **Open** again.
   - **Windows**: run the `.exe`. If SmartScreen warns you, click **More info**, then **Run anyway**.
   - **Ubuntu**: run `sudo apt install ./agentx-desktop_*.deb` in a terminal, or make the `.AppImage` executable and open it.

## Use it

1. Start the app. The Hub opens in a window, already signed in, because the dashboard trusts its own computer.
2. To talk to an agent, click the microphone next to **Send** in the Hub. The first time, the system asks whether AgentX may use the microphone. Click **Allow** (macOS: **OK**).
3. Close the window when you are done. The app keeps running in the top bar, unless you chose **Closing the window › Quit the app** (see below).
4. To bring the window back, click the AgentX icon in the top bar and choose **Show AgentX**. On Windows and Ubuntu you can also click the icon once. Choose **Hide AgentX** to put it away again.
5. To stop the app, choose **Quit AgentX** from the icon's menu.

### The icon's menu

| Item | What it does |
|---|---|
| **Show AgentX** / **Hide AgentX** | Shows or hides the Hub window. |
| **Show orb** / **Hide orb** | Shows or hides the floating orb (see [The orb](#the-orb)). |
| **Orb talks to** | The agent the orb sends your words to. |
| **Talk: …** | Says how the talk key works now: off, hold to talk, or press twice, with the reason. |
| **Global talk key** | Turns on ⌥Space (Alt+Space on Windows and Ubuntu) from any app. Off by default. |
| **Daemon: running** / **stopped** | Whether the daemon answers. Checked every 5 seconds. |
| **Start** | Runs `agentx daemon start --detach` in the folder of `AGENTX_CONFIG`. Off, with the reason in brackets, while a launchd job or systemd unit for the daemon is loaded (**Start (kept by launchd tn.noqta.agentx)**): the service starts it, and a second daemon would run next to it. Once the app has seen the daemon run under launchd or systemd, Start stays off while it is down (for example during an upgrade), until the app restarts. Also off when `AGENTX_CONFIG` is not set (**Start (set AGENTX_CONFIG)**). |
| **Stop** | Stops the daemon. It finishes its running tasks first. Only for a daemon you started from a terminal: a daemon kept running by launchd or systemd would start again at once, so the menu says so and leaves Stop off. Use **Restart** for it. Stop is also off for a daemon on another machine (`AGENTX_DAEMON_URL` not on 127.0.0.1, ::1 or localhost), and it refuses when the process the daemon names is not an `agentx` process on this computer (a port forwarded from another machine). |
| **Restart…** | Asks first, then runs `agentx daemon restart --when-idle --abort-on-timeout`: it waits until no task is running (up to 30 minutes) and then restarts. If tasks are still running after 30 minutes, it does not restart. It works for both kinds. |
| **Open at login** | Starts the app when you log in. macOS and Windows only. The first time the app starts, it shows what the system already has. |
| **Show the window at launch** | Off: the app starts in the top bar only. |
| **Closing the window** | **Hide to the tray** (the default) or **Quit the app**. |
| **Quit AgentX** | Closes the app. The daemon keeps running. |

Start, Stop and Restart act on this computer only. When the app points at a daemon on another machine (`AGENTX_DAEMON_URL` not on 127.x.x.x, ::1 or localhost; `0.0.0.0` counts as another machine), all three are off and say **(on another machine)**, whether that daemon is up or down.

### The orb

A small round orb floats above your other windows, on every desktop, also over full-screen apps on macOS. The orb itself is not in the taskbar or the Dock. The app is: on a Mac, AgentX stays in the Dock and in Command–Tab while the orb is shown, and a click on its Dock icon brings the Hub window to the front.

- To move the orb, drag the thin ring around it (it shows as a dashed line when the pointer is over the orb), or hold Option (Alt on Windows and Linux) and drag the orb itself. Moving never starts a recording. It comes back to the same place next launch. If that screen is gone, it goes to the bottom right of the main screen.
- Hold the orb (or the talk key) to talk. Your words show under the orb as you speak. Let go to send.
- The words go to the agent named in the icon's menu under **Orb talks to** (until you pick one: the node's default agent, else its first). They join one Hub conversation, so you can read it in the Hub later.
- While the agent works, the orb turns. It does not show the agent's words until the answer is done ([#2523](https://github.com/anis-marrouchi/agentx/issues/2523)). Then it says the answer in the agent's voice, with its first words under the orb. Tap the orb (or press Escape) to stop it.
- Live words come from the node's own speech to text, one pass at a time, on the first 30 seconds of a recording only. Past 30 seconds the orb shows your voice level, and the whole recording is written down when you let go. A recording stops by itself after two minutes. The last writing-down waits for a live pass that is still running, so the two never run at once. A pass that takes more than 60 seconds is stopped.
- The first time, the system asks for the microphone for AgentX. If you let go before the microphone opens (for example while that question is on screen), the orb goes back to rest and sends nothing. If the recording cannot be read when you let go, the orb says so.
- It shows five states: idle, listening, thinking, speaking, and call-back. Call-back is not fed yet.
- **Global talk key**: on macOS the system asks you to allow AgentX under **Privacy & Security › Accessibility** the first time you turn it on. AgentX looks at that one key only. It does not keep or send any other key. Until you allow it, and on Ubuntu with Wayland, the key works as press once to start and press again to send. The menu says which.
- On Ubuntu with Wayland, the app runs through XWayland so the orb can stay on top.

The orb, the talk key and the last three choices are kept in `settings.json` in the app's data folder and survive a restart.

Links to other websites open in your usual browser, not in the app. The app lets only the dashboard's own pages use the microphone. It never lets any page use the camera.

On macOS, the AgentX Voice app keeps its floating pill and the ⌥Space shortcut until you switch. See the [AgentX Voice guide](/guides/agentx-voice).

### Switch a Mac from AgentX Voice to the orb

```bash
agentx desktop orb --dry-run   # see what changes
agentx desktop orb
```

It builds this app, puts it in `~/Applications/AgentX.app`, sets it to start at login with the orb shown and no window, and turns off the AgentX Voice login item, so only one of them runs. If another copy of this app is already installed (for example `/Applications/AgentX.app`), the switch quits it and renames it to `AgentX.app.disabled-orb-<date>`, so only one copy runs and starts at login; rename it back to use it again. An app with the same name but another bundle id is left alone. The AgentX Voice app and the computer-use helper stay installed. Allow the microphone when macOS asks.

After the switch, Option–Space does nothing until you turn on the talk key in the AgentX menu (macOS then asks for Input Monitoring). Until then, hold the orb to talk. Smart paste (Command–Option–V) was part of AgentX Voice and is off too.

Until the orb can answer calls, an agent's call rings on your phone instead.

To go back:

```bash
agentx desktop orb --undo --dry-run   # see what changes
agentx desktop orb --undo
```

It turns off **Open at login** for the AgentX app and hides its orb, quits it, turns the AgentX Voice login item back on and starts AgentX Voice. Only the app can remove its own login item, so the undo starts it once in the background for a few seconds and quits it again. AgentX.app stays installed, and a copy the switch renamed stays renamed. To check, look under System Settings → General → Login Items.

## Settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| `AGENTX_DASHBOARD_URL` | environment variable, read when the app starts | `http://127.0.0.1:4202` | The dashboard the app opens. Set it if your dashboard uses another port. |
| `AGENTX_DAEMON_URL` | environment variable | `node.bind` of `AGENTX_CONFIG`, else `http://127.0.0.1:18800` | The daemon the menu checks and controls. |
| `AGENTX_CONFIG` | environment variable | none | The daemon's `agentx.json`. Start and Restart use it, and run in its folder. Without it, Start is off and Restart runs in the folder the running daemon was started in, with the config it reports (a relative path such as `-c agentx.json` is read from that folder); it never runs in your home folder. |
| `AGENTX_CLI` | environment variable | `agentx` | The AgentX command. On macOS and Ubuntu it is found through your login shell. A login shell does not read `~/.zshrc` or `~/.bashrc`: if `agentx` or its Node.js comes from there (for example nvm), set the full path here. |
| `AGENTX_SERVICE` | environment variable | none | The launchd label or systemd unit that runs your daemon, if its name does not end in `agentx` (such as `tn.noqta.agentx` or `agentx.service`). While it is loaded, Start is off. |

The window remembers its size and position between launches.

## Build it yourself

1. Install Node.js 22 or newer.
2. In a terminal, go to the `apps/desktop` folder of the AgentX repository and run `npm ci`.
3. Run `npm start` to open the app from the source, or `npm run dist` to build the installer for the system you are on. It is saved in `apps/desktop/release`.

## Check it worked

- The AgentX icon is in the top bar.
- The window shows the Hub with your agents, not a sign-in page.
- The icon's menu shows **Daemon: running**. If launchd or systemd runs your daemon, it says **(kept by launchd)** or **(kept by systemd)**, and **Stop** is off.
- After you allow the microphone, the Hub's microphone button records.
- The orb floats at the bottom right of the screen. Drag it, quit the app and start it again: it is where you left it.

## If something is wrong

- **The window says "AgentX is not answering"**: the daemon is not running, or it uses another port. Run `agentx daemon start` in a terminal, then click **Try again**. If you use another port, set `AGENTX_DASHBOARD_URL` before you start the app.
- **The Hub asks you to sign in**: the app is pointed at a dashboard on another computer. It signs in by itself only for the dashboard on its own computer.
- **The microphone does nothing on macOS**: open **System Settings › Privacy & Security › Microphone** and turn on **AgentX**, then quit and reopen the app.
- **macOS says the app is damaged or cannot be opened**: the build is not signed. Right-click the app, click **Open**, then click **Open** again.
- **Start is off and says "kept by launchd …" or "kept by systemd …"**: the service runs the daemon and starts it again by itself. Wait a minute, or check it with `agentx daemon status` in a terminal.
- **Start is off and says "set AGENTX_CONFIG"**: set `AGENTX_CONFIG` to your `agentx.json` before you start the app, or start the daemon in a terminal.
- **Restart stays on "restarting when idle…"**: tasks are still running. The daemon restarts when they finish. After 30 minutes it gives up and says so.
- **Start or Restart says `agentx: command not found`**: set `AGENTX_CLI` to the full path of `agentx` (run `which agentx` in a terminal).
- **No orb**: choose **Show orb** in the icon's menu.
- **The menu says "Talk: press ⌥Space, press again to send (macOS permission not given)"**: open **System Settings › Privacy & Security › Accessibility**, turn on **AgentX**, then turn **Global talk key** off and on.
- **⌥Space does two things on a Mac**: the AgentX Voice app also uses ⌥Space. Turn off **Global talk key** here, or quit AgentX Voice.
- **The menu says "is taken by another app"**: another app holds Alt+Space. Free it there, then turn **Global talk key** off and on.
- **No icon in the Ubuntu top bar**: some GNOME versions hide notification-area icons. Install the **AppIndicator and KStatusNotifierItem Support** extension.
