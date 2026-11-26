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
| **Daemon: running** / **stopped** | Whether the daemon answers. Checked every 5 seconds. |
| **Start** | Runs `agentx daemon start --detach`. |
| **Stop** | Stops the daemon. It finishes its running tasks first. Only for a daemon you started from a terminal: a daemon kept running by launchd or systemd would start again at once, so the menu says so and leaves Stop off. Use **Restart** for it. |
| **Restart** | Runs `agentx daemon restart`. It works for both kinds. |
| **Open at login** | Starts the app when you log in. macOS and Windows only. |
| **Show the window at launch** | Off: the app starts in the top bar only. |
| **Closing the window** | **Hide to the tray** (the default) or **Quit the app**. |
| **Quit AgentX** | Closes the app. The daemon keeps running. |

The last three choices are kept in `settings.json` in the app's data folder and survive a restart.

Links to other websites open in your usual browser, not in the app. The app lets only the dashboard's own pages use the microphone. It never lets any page use the camera.

On macOS, the AgentX Voice app keeps its floating pill and the ⌥Space shortcut for now. See the [AgentX Voice guide](/guides/agentx-voice).

## Settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| `AGENTX_DASHBOARD_URL` | environment variable, read when the app starts | `http://127.0.0.1:4202` | The dashboard the app opens. Set it if your dashboard uses another port. |
| `AGENTX_DAEMON_URL` | environment variable | `node.bind` of `AGENTX_CONFIG`, else `http://127.0.0.1:18800` | The daemon the menu checks and controls. |
| `AGENTX_CONFIG` | environment variable | none | The daemon's `agentx.json`. Start and Restart use it, and run in its folder. |
| `AGENTX_CLI` | environment variable | `agentx` | The AgentX command. On macOS and Ubuntu it is found through your login shell, as in a terminal. |

The window remembers its size and position between launches.

## Build it yourself

1. Install Node.js 22 or newer.
2. In a terminal, go to the `apps/desktop` folder of the AgentX repository and run `npm ci`.
3. Run `npm start` to open the app from the source, or `npm run dist` to build the installer for the system you are on. It is saved in `apps/desktop/release`.

## Check it worked

- The AgentX icon is in the top bar.
- The window shows the Hub with your agents, not a sign-in page.
- After you allow the microphone, the Hub's microphone button records.

## If something is wrong

- **The window says "AgentX is not answering"**: the daemon is not running, or it uses another port. Run `agentx daemon start` in a terminal, then click **Try again**. If you use another port, set `AGENTX_DASHBOARD_URL` before you start the app.
- **The Hub asks you to sign in**: the app is pointed at a dashboard on another computer. It signs in by itself only for the dashboard on its own computer.
- **The microphone does nothing on macOS**: open **System Settings › Privacy & Security › Microphone** and turn on **AgentX**, then quit and reopen the app.
- **macOS says the app is damaged or cannot be opened**: the build is not signed. Right-click the app, click **Open**, then click **Open** again.
- **No icon in the Ubuntu top bar**: some GNOME versions hide notification-area icons. Install the **AppIndicator and KStatusNotifierItem Support** extension.
