# HaxBall Replay Bot

A Discord bot that answers HaxBall replays (`.hbr2` files) posted in Discord with a direct link to the
official **haxball.com replayer**. The reply is an embed whose title is the link:

> **Пряме посилання для перегляду повтору**

- **Right-click a message with an `.hbr2` file → Apps → Watch replay.** Works in any server or DM.
- **Auto mode (optional):** the bot posts a link for every new `.hbr2` file in your replay channels by itself,
  usually within a few seconds.

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
- If it asks about the `REPLAYS` KV namespace, let it **create a new one**. That's where the copies of
  replay files are stored. Wrangler adds its ID to `wrangler.jsonc`, which is expected.

At the end it prints your bot's address. Copy it:

```
https://haxball-replay-bot.<your-subdomain>.workers.dev
```

### 6. Connect Discord to the bot

```powershell
npm run setup -- https://haxball-replay-bot.<your-subdomain>.workers.dev
```

This registers the **Watch replay** command, points Discord at your bot, saves the bot's address into
`wrangler.jsonc` (auto mode needs it), and prints two install links.

Open the first link, **Add to your account**, and click **Authorize**. Done!

**Try it:** in any server or DM, right-click a message that has an `.hbr2` file (long-press on the phone)
→ **Apps** → **Watch replay**.

Adding the bot to your account means you can use it everywhere, even in servers where you're not an admin.

### 7. (Optional) Auto mode

The bot posts a link for every new `.hbr2` file in chosen channels without anyone clicking anything.
It sends a normal message right after the upload, not a reply.

1. Open the second link printed in step 6, **Add to a server**, and pick your server.
   You need the *Manage Server* permission there. If the replay channel is private,
   also allow the bot to see that channel.
2. Get the channel ID: in Discord go to **User Settings → Advanced → Developer Mode** (turn it on),
   then right-click the replay channel → **Copy Channel ID**.
3. Paste it into `wrangler.jsonc`. For several channels, separate the IDs with commas:
   ```jsonc
   "AUTO_CHANNEL_IDS": "123456789012345678"
   ```
4. Give the bot its token on Cloudflare. This uploads it straight from `.dev.vars`, so there's nothing to paste:
   ```powershell
   npm run upload-token
   ```
5. Deploy again:
   ```powershell
   npm run deploy
   ```

Now post a replay in that channel. Within a few seconds the bot posts the link.

---

## How it works

The bot replies with a link like this:

```
https://www.haxball.com/replay?v=3#https://haxball-replay-bot.<your-subdomain>.workers.dev/r/<file-id>.hbr2
```

haxball.com opens its replayer and downloads the replay from the address after the `#`.

- **Why the bot keeps a copy of each replay:** Discord's links to files expire after about a day,
  and haxball.com may only download files from servers that allow it. So the bot downloads the replay,
  keeps a copy for a year (Cloudflare KV storage), and serves it from `/r/<file-id>.hbr2`.
- **`v=3`** is the replay format version. The bot reads it from the file, so old replays open in the right replayer.
- **Several replays in one message:** the bot sends one link per replay, each labeled with its file name.
- **Auto mode:** Cloudflare can start the bot at most once a minute, so each run keeps checking the
  auto-mode channels every 5 seconds for 55 seconds. Replies usually take under 5 seconds, and up to
  about 10 seconds around the moment one run hands over to the next. A run's first check reads the last
  50 messages and posts links for `.hbr2` files from the last 10 minutes that it hasn't linked yet.
  It recognizes those by the links in its own messages. If a run fails, the next one catches up. With several auto-mode channels, each one is checked less often
  (every 10 seconds for two channels, every 15 for three) to stay within the free plan.
  To change the speed, edit `POLL_EVERY_MS` in `src/index.js`.
- **The bot shows as offline in the member list.** That's normal: it only wakes up when needed.

**Changing the texts:** the link text and color are at the top of `src/replays.js`.
The messages that only the person using the command sees are in `src/index.js`.
After changing them, run `npm run deploy`.

## Costs and limits

Everything fits in Cloudflare's free plan: 100,000 requests per day, plus 1 GB of KV storage with
1,000 writes and 100,000 reads per day. A replay file is about 100 KB, so 1 GB holds about 10,000 replays,
and each copy is deleted after a year. Auto mode uses 1,440 runs a day, one per minute. While they wait
between checks, runs use almost no CPU.

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
- **Auto mode doesn't post links:**
  - Check `npm run logs` for a minute.
  - `Missing Access`: the bot can't see the channel.
  - `Missing Permissions`: the bot needs *Send Messages* and *Embed Links* in that channel.
  - `needs the DISCORD_BOT_TOKEN secret and PUBLIC_URL`: run `npx wrangler secret list`. It must show a secret
    named exactly `DISCORD_BOT_TOKEN`; if not, redo step 7.4. If `PUBLIC_URL` in `wrangler.jsonc` is empty,
    run step 6 again and then `npm run deploy`.
  - The bot posts nothing although it runs: turn on **Developer Portal → Bot → Message Content Intent**.
    Setup tries to do this for you.
- **`429` or `1015` errors in the logs:** Discord sometimes rate-limits Cloudflare's shared servers for a moment.
  Auto mode simply retries on the next run.
- **Wrangler couldn't create the KV namespace:** run `npx wrangler kv namespace create REPLAYS`.
  Then put the printed `id` into `wrangler.jsonc` like this: `"kv_namespaces": [{ "binding": "REPLAYS", "id": "<id>" }]`.

## Changing the bot

Edit the code in `src/`, run `npm test`, then `npm run deploy`.

| File | What's in it |
|---|---|
| `src/index.js` | Handles Discord requests, keeps and serves replay copies, runs auto mode |
| `src/replays.js` | Finds replay files in messages and builds the link |
| `src/discord.js` | Checks Discord's signatures and calls Discord's API |
| `src/command.js` | The "Watch replay" command definition |
| `scripts/setup.mjs` | One-time Discord setup (`npm run setup`) |
| `wrangler.jsonc` | Cloudflare settings: app details, bot address, auto-mode channels, storage, schedule |
