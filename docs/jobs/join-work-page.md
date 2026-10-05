# Join your work page

**This page is for you, the teammate.** Someone whose agents you use on GitLab, Telegram or WhatsApp has invited you to **My work**: a page that shows which of their agents is working on what you asked, and where it stands. The person who invited you is called **the owner** below. Their side of the setup is on [Invite a teammate to their work page](./members.md); you do not need it. If you were shown a QR code and asked to install an app on your phone instead, that is the owner's own [phone app](../dashboard/mobile-app.md), which opens everything of theirs: ask them for a pairing code for My work instead.

The owner's computer is not on the public internet. You reach it through **Tailscale**, a free program that links computers in a private network. The owner shares their computer with you in Tailscale; nothing else of theirs becomes reachable.

The whole path, from the owner's message to the page on your desktop:

![How you join: get three things from the owner, accept the share and wait for Connected, open the address, name this machine and type the code, wait for the owner to say yes, and the page becomes My work](/diagrams/teammate-pair.svg)

## What you need

The owner sends you three things. Ask for any that is missing.

- A **share link** from Tailscale. It says the owner shared a machine with you, and it usually arrives by email from Tailscale.
- An **address** that ends in `/member`, for example `https://their-computer.tailnet-name.ts.net/member`.
- A **pairing code** such as `7KQ4-M2XH`. It works once, for 10 minutes, so pair soon after you get it. If it has run out, ask for another one.

You also need a Windows or Mac machine with Edge or Chrome, and the owner needs to be reachable: they have to say yes to your machine before the page opens.

## Pair this machine

1. **Your machine:** install Tailscale from [tailscale.com/download](https://tailscale.com/download) and sign in. Any login works, unless the owner asked you to use a particular one.
2. **Your browser:** open the share link and accept the share. The owner's computer joins the list of machines you can reach.
3. **Your machine:** open the Tailscale menu and wait until it says **Connected**. Opening the address before that gives a "site can't be reached" error.

   ![The Tailscale menu on a Mac, saying Connected, with the other machines under Network Devices](/screenshots/tailscale/menu.png)
4. **Your browser (Edge or Chrome):** open the address the owner sent.
5. **Your browser:** type a name for this machine, for example "Work laptop", and the pairing code, then press **Pair this machine**. You don't need capitals or the dash: the field adds them as you type.

   ![The "Pair this machine" page with a field for the machine's name and one for the code](/screenshots/members/pair.png)
6. **Your browser:** the page says **Waiting for the owner**. Leave it open. It moves on by itself when the owner says yes, and asks for a new code if they say no.

   ![The "Waiting for the owner" page](/screenshots/members/waiting.png)
7. Tell the owner you have paired. They see a card with your machine's name and the login Tailscale reported, and answer it.

## My work

Once the owner says yes, the page shows your own work and nothing else:

- **One sentence** at the top: which of your agents is working on your task, and which is free.
- **Needs a person**: present only when one of your requests waits on the owner's answer or is stuck, with the question that was asked.
- **Your agents**: one card per agent you use. Each says **Working**, **Free** or **Blocked** in words, with a colour and a shape. A card on your own task shows what you asked, when and where; **Show this request** opens it in place. A card busy with someone else's task says only that. **Tell me when an agent is free**, under the cards, lets the browser show a notification each time one of your agents becomes free while the page is open.
- **What you sent** in the last 7 days: every message you sent, with its agent, where you asked it, and its state (running, finished, waiting on the owner, stopped). A finished request links to what was delivered.

![The My work page: the summary sentence, a question waiting on the owner, four agent cards, and the list of what was sent](/screenshots/members/my-work.png)

The page refreshes every 30 seconds. Without a connection it shows what was last loaded and says it is offline. When you are connected but the owner's computer does not answer, it says it can't reach the server, tries again every 20 seconds, and shows a **Try now** button.

What you never see: the owner's own work, their other people, or what another person asked an agent for. A card busy with someone else's task says only that an agent is busy, and whether the owner or someone else started it.

### Keep it on the desktop

1. **Your browser (Edge or Chrome, Windows or Mac):** open the browser menu, then **Apps**, then **Install this site as an app**.
2. It opens in its own window, like a small program, and stays in the Start menu or Dock.

Your machine stays paired for 90 days. After that, or if the owner ends your access, the page asks for a code again: ask the owner for a new one.

## Check it worked

1. **Your browser:** **My work** shows your name and this machine's name under the title.
2. **Your channel:** send a short message to one of the agents you use, where you usually write to it. Within a minute, that agent's card says **Working** and your message appears under **What you sent**.
3. **Your browser:** open the address without `/member` at the end. It says "not found": only your page is shared, so this is right.

## If something is wrong

- **The address does not open** ("site can't be reached" or `DNS_PROBE_FINISHED_NXDOMAIN`): Tailscale is not connected, or the share is not accepted yet. Open the Tailscale menu, wait for **Connected**, then close the browser completely and open the address again.
- **"That code didn't work":** the code was mistyped, is older than 10 minutes, or was already used. Ask the owner for a new one.
- **"Too many attempts. Wait 5 minutes, then try again":** too many wrong codes were typed. Wait the time shown, then try again. If the code has run out meanwhile, ask the owner for a new one.
- **"The private network says someone else is connecting from this machine":** you are signed in to Tailscale with a login other than the one the owner has for you. Tell the owner which login you use, and ask for a new code.
- **"You're offline. Pairing needs a connection to the private network":** turn on your network and Tailscale, then press **Pair this machine** again.
- **"Waiting for the owner" does not end:** the owner has not answered yet. Tell them you have paired. If nobody answers for three days, the pairing lapses: ask for a new code.
- **"The owner did not approve this machine":** the owner said no. If that was a mistake, ask them for a new code.
- **The page is empty, although you sent messages:** the owner's side is not set up for you yet. Tell them; they need request tracking turned on and your identity on the channel you write from.
- **"Can't reach the server":** the owner's computer is off, or Tailscale dropped on one side. The page tries again by itself; press **Try now** to try at once.
- **The page asks for a code again after it worked:** your access ended, after 90 days or because the owner ended it. Ask the owner for a new code.
