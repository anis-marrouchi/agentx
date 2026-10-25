# Open the dashboard through your own web address

Normally you open the dashboard at `http://127.0.0.1:4202` on the machine that runs AgentX. Some teams put it behind a **reverse proxy** instead: a web server, such as Caddy or nginx, that answers on a friendly address like `https://ops.example.com` and passes the traffic on to AgentX.

AgentX protects itself from other websites. It only accepts changes (saving, sending a message to an agent, starting a job) from pages it served itself. A page from any other web address is refused, even when it's open in a browser on the same machine. Otherwise any website you happened to visit could quietly send your agents instructions.

Behind a reverse proxy, the browser shows your proxy's address, not AgentX's. This page shows how to tell AgentX that address is yours.

## Before you start

- The reverse proxy already forwards `https://ops.example.com` (use your own address) to the dashboard's port, `4202`.
- You can edit the `.env` file next to `agentx.json` on the AgentX machine.

## 1. Check whether you need to do anything

Many proxies pass the original address along in a header called `X-Forwarded-Host`, and AgentX accepts that on its own.

1. **Browser:** open the dashboard through your proxy's address.
2. Change something small and save it. For example, open **Settings**, then save a setting without changing it.
3. If it saves, you're done. If you see **Forbidden: request from a page on another origin**, continue with step 2.

## 2. Add your address to the allowed list

1. **Terminal:** on the AgentX machine, open the `.env` file next to `agentx.json`.
2. Add your proxy's address. Include `https://` and leave out any path or trailing slash:
   ```sh
   AGENTX_ALLOWED_ORIGINS=https://ops.example.com
   ```
   For several addresses, separate them with commas: `https://ops.example.com,https://agents.example.org`.
3. **Terminal:** restart the daemon and the dashboard so they read the file.
   ```sh
   agentx daemon restart
   ```
   The dashboard runs as its own service: restart it the way you started it (for example, stop and run `agentx board serve` again).

Only add addresses you control. Anything on the list can send your agents instructions through your browser.

<!-- No screenshot: the fix is a line in a file and a restart; the only screen is the dashboard page you already have open. -->

## Sign in from another device

With a dashboard token (`dashboard.token` in `agentx.json`), a browser that is not on the AgentX machine signs in before it sees the Wall, Settings, Approvals, People or an agent's page. A request through a reverse proxy counts as another device, even when the proxy runs on the AgentX machine.

1. **Browser:** open the dashboard's address. It shows **Sign in to this dashboard**.
2. Paste the dashboard token and select **Sign in**. You land on the page you asked for.

![The sign-in page](/screenshots/dashboard/sign-in.png)

The browser keeps a sign-in cookie for 30 days. The cookie is not the token, and pages opened this way never contain the token. To sign every browser out, change `dashboard.token` and restart the dashboard. On the AgentX machine itself nothing changes: there is no sign-in there.

## Check it worked

1. **Browser:** reload the dashboard through your proxy's address.
2. Save a setting. It saves without an error.
3. **Terminal:** a page on any other address is still refused. The request below pretends to come from another website, and the answer should be `403`:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Origin: https://example.net" http://127.0.0.1:4202/api/draft
   ```
4. **Browser:** with a dashboard token set, open the proxy's address in a private window. It asks you to sign in, and the page source holds no `AX_LOCAL_TOKEN`.

## If something is wrong

- **"That token is not right" when you sign in:** paste the value of `dashboard.token` from the `agentx.json` the dashboard uses, with no spaces around it.
- **Asked to sign in again on every visit:** the browser is dropping the cookie. Allow cookies for the dashboard's address.
- **Still "Forbidden: request from a page on another origin":** the address in `.env` must match what the browser shows exactly, including `https://` and any port such as `:8443`. Then restart both services.
- **It worked, then stopped after a restart:** the service might be started from another folder. The `.env` file must sit next to the `agentx.json` that the service uses.
- **A tool that calls AgentX from its own web page stopped working:** that is the protection working. Call AgentX from a server or the command line instead, or add that tool's address to `AGENTX_ALLOWED_ORIGINS` if you trust it.
- **The dashboard doesn't load at all through the proxy:** this setting isn't involved. Check the proxy forwards to port `4202` and that the dashboard service is running.
