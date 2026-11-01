# Let agents read data from outside services

Give an agent read-only access to numbers held by another service, such as page views or audience figures. You sign in to the service once. AgentX keeps the sign-in on your own computer and gives the agent the numbers, never the password or token.

![How an agent reads data from a service you connected: once, you create an app with the service, sign in through agentx agent integrations connect, and the token is kept in your keyring or .env; then each time the agent asks for a named read, AgentX checks it, adds a fresh token, and the numbers come back. The agent only reads and never sees the token](/diagrams/outside-apis.svg)

## At a glance

| Question | Answer |
|---|---|
| **The problem** | The numbers you want an agent to report on sit behind another service's sign-in, and handing an agent your password is not safe. |
| **What AgentX does** | Signs in to the service for one agent, keeps the token on your computer, renews it when it runs out, and lets the agent ask only for a fixed list of reads. |
| **What you approve** | The sign-in, in your browser. The agent can only read: no posting, no changes. |
| **What it costs** | No AgentX fee. The service's own limits and prices apply. |
| **First result** | `agentx agent integrations status <agent>` shows **connected**. See [Check it worked](#check-it-worked). |

Words used on this page:

- **Integration**: one service an agent has access to, listed under the agent in `agentx.json`.
- **App**: a registration you create on the service's developer site. It gives you a **client id** and a **client secret** (a password for the app, not for you). Each person who runs AgentX creates their own.
- **Token**: what the service gives back after you sign in. AgentX uses it to ask for data on your behalf. Some tokens run out after an hour; AgentX renews them by itself.
- **Keyring**: your computer's password store (Keychain on a Mac, the Secret Service on Linux).
- **Read**: one named question the agent may ask the service, such as "page totals for a period". The agent picks a read by name; it cannot write its own request.

::: info Which services
This release adds the parts every service shares: sign-in, token renewal, the agent's read tool and the status checks. Facebook and Instagram analytics, then YouTube Analytics, are added next. Until then, `connect` answers `No provider is built in yet`.
:::

You need:

- AgentX installed, with an `agentx.json`. See [Install](./install.md).
- A terminal in the folder with `agentx.json`, on the computer that runs AgentX.
- An account on the service, with access to the pages or channels you want numbers for.

## 1. Create an app with the service

1. **Browser:** on the service's developer site, create an app. Ask only for read permissions.
2. **Browser:** in the app's settings, add this address to the allowed sign-in return addresses (often called "redirect URIs"):

   ```text
   http://localhost:19876/callback
   ```

3. **Browser:** copy the app's client id and client secret.
4. **Terminal:** put both in the `.env` file next to `agentx.json`. Use the service's kind in capitals as the start of the name, for example for a kind called `example`:

   ```bash
   echo 'EXAMPLE_CLIENT_ID=paste-the-client-id-here' >> .env
   echo 'EXAMPLE_CLIENT_SECRET=paste-the-client-secret-here' >> .env
   ```

5. **Terminal:** restart the daemon so it reads them:

   ```bash
   agentx daemon restart
   ```

Keep the secret in `.env` only, never in `agentx.json`: that file is shown in the dashboard and often shared.

## 2. Connect an agent

1. **Terminal:** start the sign-in for the agent. Replace `helper` with your agent and `example` with the service's kind:

   ```bash
   agentx agent integrations connect helper example
   ```

2. **Browser:** a sign-in page opens. Sign in, check the permissions it asks for, and approve every one.
3. **Browser:** the page says **AgentX is connected**. Close the tab.
4. **Terminal:** the command prints `✓ helper: ... connected; token kept in the OS keyring`.

On a computer without a browser (a server you reach over SSH), add `--paste`:

1. **Terminal:** run `agentx agent integrations connect helper example --paste`. It prints a sign-in address.
2. **Browser, on any computer:** open the address and approve. The page then fails to load; that is expected.
3. **Browser:** copy the whole address from the address bar.
4. **Terminal:** paste it at the prompt.

Where the token goes:

- **The keyring** when your computer has one. This is the default.
- **`.env`** otherwise, or with `--store env`. Restart the daemon after connecting so it reads the new value. Some services hand out a new long-lived token now and then. AgentX writes that new token back into `.env` for you, so it still works after a restart.

Options of `connect`:

| Option | What it does |
|---|---|
| `--label <text>` | Which account, when an agent has more than one of the same kind. A new one is created when missing. |
| `--client-id-env <name>`, `--client-secret-env <name>` | Read the app's id and secret from other `.env` names. |
| `--with <names>` | Ask for extra permissions the service offers, such as `revenue`. |
| `--reads <names>` | Allow only these reads for this integration. Default: every read the service offers. |
| `--store keyring` or `--store env` | Where to keep the token. |
| `--port <n>` | Use another return port. Change the address in the app's settings to match. |
| `--paste` | Paste the return address instead of waiting for the browser. |
| `--no-browser` | Print the sign-in address without opening it. |

## 3. Ask the agent

Ask in plain words, for example: `How many views did the page get last month?`

The agent uses the `agentx_integration_read` tool. Without a read name, the tool lists the reads the agent may run and the values each accepts. With one, AgentX checks every value against that list, adds the token, asks the service and returns its answer, cut at 16,000 characters.

The agent can never:

- see or copy the token;
- send anything other than a read;
- ask for a value that is not on the list.

A routine set to read only (`autonomy: "report"`) may use the tool too, so a weekly digest of the numbers works. See [Routine autonomy](./reference/config.md#routine-autonomy).

To allow only some reads for one integration, list them when you connect (an empty list allows every read again):

```bash
agentx agent integrations connect helper example --reads account_report
```

## Disconnect

1. **Terminal:** forget the sign-in:

   ```bash
   agentx agent integrations disconnect helper example
   ```

2. If the token was in `.env`, the command names the line to delete. **Terminal:** delete it, then run `agentx daemon restart`.
3. **Browser:** to end the app's access completely, remove it in the service's account settings.

## Check it worked

1. **Terminal:** run `agentx agent integrations status helper`. The line for the service starts with ✓ and says **connected**.
2. **Terminal:** run `agentx doctor`. It shows no warning for `agents.helper.integrations`.
3. **Browser:** in the dashboard, open **Settings**, select **Agents**, select the agent, then the **Channels** tab. Under **Integrations**, the service shows a green **connected** label. One that needs you shows **not connected** or **needs attention**; open **to fix** to see what to do.

   ![The Integrations list of an agent: the first account shows a green connected label and "renews itself"; the second shows not connected, with "1 to fix" opened to say which connect command to run](/screenshots/integrations/status.png)
4. **Telegram, or the dashboard chat:** ask the agent which reads it has. It lists the service and its reads.

## If something is wrong

| What you see | What to do |
|---|---|
| `No sign-in support for "<kind>"` | That service is not built in yet. See the **Which services** note near the top of this page. |
| `env var EXAMPLE_CLIENT_ID is unset` | Put the app's client id and secret in `.env` (step 1.4) and run the command again. |
| The browser says the return address is not allowed | The address in the app's settings must be exactly `http://localhost:19876/callback`, or the port you passed with `--port`. |
| `no answer from the browser within 5 minutes` | Run `connect` again and approve sooner, or use `--paste`. |
| `the sign-in answer does not match this request` | An old sign-in tab was used. Close it and run `connect` again. |
| `No OS keyring on this machine` | Use `--store env`, then restart the daemon. |
| `status` says **not connected**, or the agent says to connect again | The sign-in was removed or ran out. Run `connect` again. |
| `not granted: ...` | You unticked a permission at sign-in. Run `connect` again and approve every one. |
| `the token expires on ...` | That service does not renew its tokens by itself. Run `connect` again before that date. |
| The agent gets `... said 403` | The account or app lacks a permission for that read, or the account is not the right type. Check the service's own setup steps. |
