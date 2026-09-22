# Case study: record a VS Code walkthrough

**Goal:** produce a short recording that shows a real action in VS Code, with a highlight and a short explanation at each step.

The current source records a Screen Studio attempt where the recording picker opened but recording did not begin. The run nevertheless reported success. That incident informed the screen-observation and verification code. The exact recording from the earlier conversation has not yet been attached to this guide; the steps below are a reproducible procedure, not a replay of that session.

## 1. Prepare a clean scene

Open a small demo project in VS Code. Choose one action to teach, such as finding a symbol or opening the command palette. Keep the intended controls visible and move unrelated windows out of the capture area.

Install the [desktop assistant](../dashboard/voice.md). Computer-use commands require the macOS helper and appropriate Accessibility and Screen Recording permissions.

## 2. Start the recording and check it

Open Screen Studio and use its recording controls to select the VS Code window or screen. Complete the recording picker. Confirm recording in the recorder itself before beginning the demonstration.

An open picker or a successfully sent shortcut is not enough. AgentX's source notes show that small menu-bar indicators were unreliable visual evidence. Check the recorder's actual state and, after stopping, the saved clip and its duration.

## 3. Point, then explain

With VS Code visible, you can try:

```sh
agentx point "the search field"
```

This locates and highlights a candidate without clicking. It requires an available `ui-element` seat; see [Jev configuration](../architecture/jev.md). If the control is not present or the decision is unavailable, fix that before proceeding.

For a visible state check:

```sh
agentx look "What panel is open in VS Code?" --json
agentx look "The command palette is open" --verify --json
```

`look` uploads a captured region to the configured vision provider. Use a demo workspace. Verification exits `0` when confirmed, `3` when refuted, and `4` when unknown; operational errors exit `1`.

## 4. Stop, inspect, then annotate

Stop the recording in Screen Studio. Open the saved clip, scrub the beginning and end, and verify that the intended VS Code action is visible. Add annotations to explain the purpose of each step, keeping labels away from the control being demonstrated.

For the documentation, pair each recorded action with:

- **Do:** the click, keystroke, or command.
- **Look for:** the visible result that confirms it worked.
- **Why:** one sentence of explanation.
- **If it fails:** a concrete recovery step.

## How AgentX can automate a lesson

`agentx teach` lists the lessons shipped in this checkout. Lessons can narrate, locate, highlight, click, type, press keys, and verify claims. Inspect a lesson before running it: it can interact with real applications. There is currently no bundled VS Code lesson.

```sh
agentx teach
agentx teach --help
```

The `--record` option uses macOS `screencapture`, not Screen Studio. `--no-speak` only disables narration; it does **not** disable clicks or typing. The current runner stops for a returned non-confirmed required verification, but a verification exception is logged without always stopping the lesson. Check the recording yourself before treating a lesson as successfully completed.

Continue with [the architecture](../architecture/overview.md) to see how perception, typed decisions, and native actions fit together.
