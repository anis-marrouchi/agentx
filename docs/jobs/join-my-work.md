# Join My work

**This page is for you, the teammate.** Someone whose AI agents you write to on GitLab, Telegram or WhatsApp has invited you to **My work**: a page that shows what you asked those agents for and where it stands. That person is called **the owner** below. Their side of the setup is on [Invite a teammate to their work page](./members.md); you do not need it.

The owner sends you three things: a **share link** from Tailscale (the program that connects your machine to theirs, privately), an **address** that ends in `/member`, and a **pairing code** such as `7KQ4-M2XH`. The code works once, for 10 minutes, so pair soon after you get it.

## Pair this machine

1. **Your machine:** install Tailscale, sign in, and accept the owner's share. Wait until the Tailscale menu says **Connected**.
2. **Your browser (Edge or Chrome):** open the address the owner sent.
3. **Your browser:** type a name for this machine, such as "Work laptop", and the pairing code, then press **Pair this machine**.

   ![The "Pair this machine" page with a field for the machine's name and one for the code](/screenshots/members/pair.png)
4. **Your browser:** the page says **Waiting for the owner**. Leave it open and tell the owner you have paired. It moves on by itself when they say yes.

   ![The "Waiting for the owner" page](/screenshots/members/waiting.png)

## What My work shows

- **One sentence** at the top: which of your agents is working on your task, and which is free. Under it, **Needs a person** appears only when one of your requests waits on the owner, with the question that was asked.
- **Your agents**: one card per agent you use, saying **Working**, **Free** or **Blocked**. A card on your task shows what you asked, when and where. A card busy with someone else's task says only that: nothing of the owner's or of anyone else's work is shown. **Tell me when an agent is free** shows a notification each time one of them becomes free while the page is open.
- **What you sent** in the last 7 days: each request, with its agent, where you asked it, and its state. A finished one links to what was delivered.

![The My work page: the summary sentence, a question waiting on the owner, four agent cards, and the list of what was sent](/screenshots/members/my-work.png)

To keep it on your desktop, open the browser menu, then **Apps**, then **Install this site as an app**. Your machine stays paired for 90 days; after that, ask the owner for a new code.

## Check it worked

1. **Your browser:** **My work** is open, with your name and this machine's name under the title.
2. **Your channel:** write to one of your agents where you usually do. Within a minute its card says **Working** and your message is listed under **What you sent**.

## If something is wrong

- **The address does not open** ("site can't be reached"): Tailscale is not connected yet, or the share is not accepted. Wait for **Connected** in the Tailscale menu, then close the browser and try the address again.
- **"That code didn't work":** the code was mistyped, is older than 10 minutes, or was already used. Ask the owner for a new one. After **"Too many attempts"**, wait the minutes shown first.
- **"The private network says someone else is connecting":** you are signed in to Tailscale with a login other than the one the owner has for you. Tell the owner which login you use, and ask for a new code.
- **"Waiting for the owner" does not end:** the owner has not answered yet. Tell them you paired. If they say no, or nobody answers for three days, the page asks for a code again: ask the owner for a new one.
- **The page is empty although you sent messages:** the owner's side is not set up for you yet. Tell them.
