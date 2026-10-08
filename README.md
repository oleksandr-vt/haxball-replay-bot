# HaxBall Replay Bot

A Discord bot that opens HaxBall replays in the official **haxball.com replayer** and the
**[Haxball Replay Analyzer](https://haxball-replay-analyzer.github.io/)** instead of the replay.thehax.pl page.

- **Right-click any message → Apps → Watch replay.** Works on thehax links (from the thehax bot)
  and on `.hbr2` files posted straight to Discord. The bot answers with buttons:
  **▶️ Watch in HaxBall** and **📊 Open in Analyzer**.
- **Auto mode (optional):** the bot answers every new thehax link in your replay channel by itself,
  within about a minute.

**No server needed.** The bot runs on Cloudflare Workers' free plan. Nothing has to stay on, your PC included.
You don't need a credit card, and you won't pay anything.

---

## Setup (about 15 minutes)

You need Node.js 22+ (`node --version`), a Discord account and a free Cloudflare account
(you can create it during step 3).

Run all commands in this folder (VS Code → Terminal → New Terminal).

### 1. Create the Discord app

1. Open <https://discord.com/developers/applications> → **New Application** → give it a name
   (for example *Replay Links*) → **Create**.
2. In the left menu open **Bot** → **Reset Token** → confirm → **Copy**.
   This token is the bot's password. Don't share it with anyone.

### 2. Put the token into the project

```powershell
copy .dev.vars.example .dev.vars
```

Open `.dev.vars` and replace `paste-your-bot-token-here` with the token:

```
DISCORD_BOT_TOKEN=MTQy...your token...
```

`.dev.vars` stays on your computer only.

### 3. Install and log in to Cloudflare

```powershell
npm install
npx wrangler login
```

A browser window opens. Sign up or log in to Cloudflare (free), then click **Allow**.

> `npm install` may report "high severity vulnerabilities". They come from an image tool wrangler
> uses on your PC only, not from the bot. Don't run `npm audit fix --force`: it would downgrade wrangler
> to a very old version.

### 4. Fill in the app details

```powershell
npm run setup
```

This reads your app's ID and public key from Discord and writes them into `wrangler.jsonc`.

### 5. Deploy

```powershell
npm run deploy
```

- The first time, wrangler may ask you to pick a **workers.dev subdomain**. Any free name works.
- If it asks about the `REPLAYS` KV namespace, let it **create a new one**. That's where copies of
  `.hbr2` files are stored. Wrangler adds its ID to `wrangler.jsonc`, which is expected.

At the end it prints your bot's address. Copy it:

```
https://haxball-replay-bot.<your-subdomain>.workers.dev
```

### 6. Connect Discord to the bot

```powershell
npm run setup -- https://haxball-replay-bot.<your-subdomain>.workers.dev
```

This registers the **Watch replay** command, points Discord at your bot, and prints two install links.

Open the first link, **Add to your account**, and click **Authorize**. Done!

**Try it:** in any server or DM, right-click a message that has a thehax link or an `.hbr2` file
(long-press on the phone) → **Apps** → **Watch replay**.

Adding the bot to your account means you can use it everywhere, even in servers where you're not an admin.

### 7. (Optional) Auto mode

The bot answers new thehax links in chosen channels without anyone clicking anything.
It needs the thehax bot to be in that server, because it reacts to thehax's links.

1. Open the second link printed in step 6, **Add to a server**, and pick your server.
   You need the *Manage Server* permission there. If the replay channel is private,
   also allow the bot to see that channel.
2. Get the channel ID: in Discord go to **User Settings → Advanced → Developer Mode** (turn it on),
   then right-click the replay channel → **Copy Channel ID**.
3. Paste it into `wrangler.jsonc`. For several channels, separate the IDs with commas:
   ```jsonc
   "AUTO_CHANNEL_IDS": "123456789012345678"
   ```
4. Give the bot its token on Cloudflare. Paste the token when asked:
   ```powershell
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```
5. Deploy again:
   ```powershell
   npm run deploy
   ```

Now upload a replay. Within a minute of the thehax bot posting its link, your bot replies to it with the buttons.

---

## How it works

| Replay | ▶️ Watch in HaxBall | 📊 Open in Analyzer |
|---|---|---|
| thehax link `replay.thehax.pl/<id>` | `https://www.haxball.com/replay?v=3#https://replay.thehax.pl/<id>/download` | `https://haxball-replay-analyzer.github.io/?thehax=<id>` |
| `.hbr2` file posted to Discord | `https://www.haxball.com/replay?v=<version>#https://<your-bot>/r/<file-id>.hbr2` | not possible, see below |

- **thehax links:** thehax lets other sites download its replay files, so the HaxBall replayer and the
  Analyzer both load the replay straight from thehax. The bot stores nothing for these.
- **`.hbr2` files:** Discord's links to files expire after about a day. So the bot keeps a copy for a year
  (Cloudflare KV storage) and serves it to the HaxBall replayer from `/r/<file-id>.hbr2`.
- **Analyzer button only for thehax replays:** the Analyzer can only open replays hosted on thehax.
  That's one good reason to keep the thehax bot around.
- **Auto mode:** Cloudflare runs the bot once a minute. It reads the last 50 messages of each auto-mode
  channel and replies to thehax links from the last 10 minutes that it hasn't answered yet.
  If one run fails, the next one catches up.
- **The bot shows as offline in the member list.** That's normal: it only wakes up when needed.

**Tip, no bot needed:** you can turn any thehax link into these links by hand using the patterns in the table.

## Costs and limits

Everything fits in Cloudflare's free plan: 100,000 requests per day, plus 1 GB of KV storage with
1,000 writes and 100,000 reads per day. A replay file is about 100 KB. Auto mode uses 1,440 runs a day,
one per minute.

## Troubleshooting

See what the bot is doing: run `npm run logs` and try again. You can also check the Cloudflare dashboard
→ Workers & Pages → haxball-replay-bot → Logs.

- **"Watch replay" isn't in the Apps menu:** make sure you finished step 6 and authorized the first link.
  Then restart Discord (Ctrl+R).
- **"The application did not respond":** check `npm run logs`. If you changed `wrangler.jsonc`, run `npm run deploy`.
- **Only you can see the bot's reply in some server:** that server doesn't let external apps post publicly
  (the *Use External Apps* permission). Adding the bot to the server (step 7.1) fixes it.
- **`npm run setup -- <url>` says Discord couldn't verify the URL:** check the URL. Then run `npm run deploy`
  once more, because the deployed bot must have the app ID and public key from step 4.
- **Auto mode doesn't reply:**
  - Check `npm run logs` for a minute.
  - `Missing Access`: the bot can't see the channel.
  - `DISCORD_BOT_TOKEN secret is missing`: redo step 7.4.
  - The bot replies to nothing although it runs: turn on **Developer Portal → Bot → Message Content Intent**.
    Setup tries to do this for you.
- **`429` or `1015` errors in the logs:** Discord sometimes rate-limits Cloudflare's shared servers for a moment.
  Auto mode simply retries on the next run.
- **Wrangler couldn't create the KV namespace:** run `npx wrangler kv namespace create REPLAYS`.
  Then put the printed `id` into `wrangler.jsonc` like this: `"kv_namespaces": [{ "binding": "REPLAYS", "id": "<id>" }]`.

## Changing the bot

Edit the code in `src/`, run `npm test`, then `npm run deploy`.

| File | What's in it |
|---|---|
| `src/index.js` | Handles Discord requests, serves stored files, runs auto mode |
| `src/replays.js` | Finds replays in messages and builds the links and buttons |
| `src/discord.js` | Checks Discord's signatures and calls Discord's API |
| `src/command.js` | The "Watch replay" command definition |
| `scripts/setup.mjs` | One-time Discord setup (`npm run setup`) |
| `wrangler.jsonc` | Cloudflare settings: app details, auto-mode channels, storage, schedule |
