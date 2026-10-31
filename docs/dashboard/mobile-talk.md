# Talk to an agent on your watch

**Talk to AgentX** lets you talk to one of your agents through a Bluetooth watch or headset, the way you take a phone call on it. The AgentX Android app rings the watch. You answer on the watch, speak, and hear the agent's answer on the watch. It goes on, turn by turn, until you hang up.

It works with watches that can't run apps but can take calls for the phone they are paired with. No phone number is used, and the call costs nothing: to Android it is an internet call, like a WhatsApp call.

![How you talk to an agent on your watch: you start it on the phone, then the watch rings, you speak after the beep, the computer writes it down and asks the agent, and the answer is spoken on the watch until you hang up](/diagrams/talk-watch.svg)

::: info Starting from the watch itself is not possible yet
Today you start the call on the phone: the watch rings, and the rest happens on the watch. Starting it from a button on the watch is being looked at in [#1664](https://github.com/anis-marrouchi/agentx/issues/1664).
:::

## What you need

- The [AgentX Android app](./mobile-places.md#get-the-android-app), built from this version or newer, installed and paired. It is the same app as for place reminders.
- A watch or headset that can take phone calls through Bluetooth, paired with the phone.
- Voice input on your computer, as for the phone app's Chat: see [What the computer needs for voice](./mobile-chat.md#what-the-computer-needs-for-voice). Without it the agent can't hear you.
- An agent's voice is optional. Without one, the phone reads the answer in its own voice.

## Pair the watch with the phone

1. **Phone:** pair the watch in the phone's **Bluetooth** settings, or in the watch's own phone app, the way its maker describes for calls.
2. **Phone:** in **Bluetooth** settings, tap the watch and check that **Calls** (or **Phone audio**) is on.

If the watch already rings when someone calls the phone, it is ready.

## Choose the agent

You do this once. The phone remembers the agent until you choose another.

1. **Phone:** open **Talk to AgentX** from the app list. It has its own icon next to **AgentX**.
2. **Phone:** under **Choose another agent**, tap the agent you want. Only agents on computers that are online are listed. With more than one computer, each agent shows its computer in brackets.

## Talk

1. **Phone:** open **Talk to AgentX**, or long-press the **AgentX** icon and tap **Talk**. The first time, Android asks for three things:
   1. **Phone:** allow the **microphone**. Without it the agent can't hear you.
   2. **Phone:** allow **Nearby devices**. Without it the call stays on the phone's speaker instead of the watch.
   3. **Phone:** allow **notifications**. They give you a **Hang up** button in the notification shade.
2. **Watch:** the watch rings, showing **AgentX** or the agent's name. Answer it on the watch.
3. **Watch:** you hear "You are talking to …", then a beep. Speak after the beep. Stop speaking for a moment and the phone takes that as the end of what you said.
4. **Watch:** a soft tick every few seconds means the agent is working. Then you hear the answer, in the agent's voice when the computer has one, then a beep: your turn again.
5. **Watch:** hang up on the watch when you are done.

The whole call is one conversation in the phone app's [Chat](./mobile-chat.md), so you can read it there afterwards, with any links or files the agent sent.

Good to know:

- **Hang up whenever you like.** If the agent is still working, it finishes, and the answer appears in Chat with a notification, as when you leave Chat.
- **Silence ends the call.** If you say nothing twice in a row, the phone says goodbye and hangs up.
- **Code and links are not read out.** The phone says "code left out" and "a link" instead. Read them in Chat.
- **Keep it short.** One turn can be up to 45 seconds long.
- **Without a watch** the call still works, on the phone's speaker.

## Check it worked

1. **Phone:** open **Talk to AgentX**. The screen shows **Talk to** and your agent's name.
2. **Watch:** the watch rings. Answer it on the watch, not on the phone.
3. **Watch:** you hear "You are talking to …" and a beep.
4. **Watch:** ask something short, such as "What time is it?". You hear the answer on the watch.
5. **Phone:** while the call is on, the **Talk to AgentX** screen shows each step: **Listening…**, then **You said: …**, then the agent answering. If it says **No watch or headset took the call**, see below.
6. **Watch:** hang up. The screen says **Call ended**.
7. **Phone:** open **AgentX**, then **Chat**. The conversation is there, with what you said and the answer.

## If something is wrong

- **The watch doesn't ring** — it is not connected for calls. Check [Pair the watch with the phone](#pair-the-watch-with-the-phone). The **Talk to AgentX** screen says **The watch did not answer** after 45 seconds. Tap **Answer on the phone** to talk on the phone's speaker instead.
- **"Another call is on, so the watch can't ring now"** — a phone or app call is still on. End it and tap **Start**.
- **"No watch or headset took the call, so it is on the phone's speaker"** — the watch is not connected, or **Nearby devices** is not allowed. Then:
  1. **Phone:** open Android settings, then **Apps**, then **AgentX**, then **Permissions**, and allow **Nearby devices**.
  2. **Phone:** check that the watch is connected in **Bluetooth** settings.
  3. **Phone:** tap **Start** again.
- **"AgentX may not use the microphone"** — open Android settings, then **Apps**, then **AgentX**, then **Permissions**, and allow **Microphone**. Then tap **Start**.
- **You hear "I didn't hear anything" each time you speak** — speak right after the beep, close to the watch. If it keeps happening, the watch's microphone may not reach the phone: send `adb logcat -s AgentXTalk` from a call, which names the microphone used, to whoever set up AgentX.
- **You hear "I could not reach your computer"** — Tailscale is off on the phone or on the computer. Turn it on and start again.
- **You hear an error about voice input, such as "Install ffmpeg"** — the computer can't turn speech into text. Set it up as in [What the computer needs for voice](./mobile-chat.md#what-the-computer-needs-for-voice).
- **You hear "This phone is no longer paired"** — the app's key was removed with `agentx app revoke`. Pair the app again as in [Place reminders › Pair the Android app](./mobile-places.md#pair-the-android-app).
- **"No agent is online"** — AgentX is not running on the computer, or it is offline. Start it, then tap **Choose another agent** again.
