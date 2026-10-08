import { WATCH_COMMAND } from './command.js';
import { discordApi, isValidDiscordRequest, snowflakeTime } from './discord.js';
import { findReplayFiles, haxballReplayerUrl, replayEmbeds, replayVersion } from './replays.js';

const KEEP_FILES_FOR_SECONDS = 365 * 24 * 60 * 60;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REPLAYS_PER_MESSAGE = 10; // a Discord message can have at most 10 embeds
const AUTO_REPLY_WINDOW_MS = 10 * 60 * 1000; // auto mode only answers messages from the last 10 minutes
const POLL_EVERY_MS = 5000; // how often auto mode checks a channel for new replays
const POLL_FOR_MS = 55_000; // a run checks for most of its minute; the next run starts 60 s after this one

const EPHEMERAL = 64; // message flag: only the person who used the command sees it

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/interactions') {
      return handleInteraction(request, env, ctx, url.origin);
    }
    const file = url.pathname.match(/^\/r\/(\d+)\.hbr2$/);
    if (file && request.method === 'GET') return serveReplayFile(file[1], env);
    if (url.pathname === '/') return new Response('HaxBall replay bot is running.');
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env) {
    await autoReply(env, controller.scheduledTime ?? Date.now());
  },
};

async function handleInteraction(request, env, ctx, origin) {
  const body = await request.text();
  if (!(await isValidDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) {
    return new Response('Invalid request signature', { status: 401 });
  }
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return Response.json({ type: 1 }); // PING: Discord checking that we're up
  if (interaction.type === 2 && interaction.data.name === WATCH_COMMAND.name) {
    return Response.json(await watchReplay(interaction, env, ctx, origin));
  }
  return Response.json(textReply('Невідома команда.', EPHEMERAL));
}

// "Watch replay" was used on a message: reply with a link for every replay file in it.
async function watchReplay(interaction, env, ctx, origin) {
  const message = interaction.data.resolved?.messages?.[interaction.data.target_id];
  if (!message) return textReply('Не вдалося прочитати це повідомлення.', EPHEMERAL);
  const files = findReplayFiles(message);
  if (files.length === 0) return textReply('У цьому повідомленні немає повтору HaxBall (файлу .hbr2).', EPHEMERAL);

  // Discord gives up on us after 3 seconds, so don't wait long for the downloads,
  // and finish saving the copies after we've answered.
  const replays = await downloadReplays(files, origin, 2000);
  ctx.waitUntil(saveReplays(replays, env));
  if (replays.length === 0) return textReply('Не вдалося прочитати файл. Це точно повтор HaxBall (.hbr2)?', EPHEMERAL);
  return { type: 4, data: { embeds: replayEmbeds(replays), allowed_mentions: { parse: [] } } };
}

// Discord's links to attached files expire after about a day, so we download each replay,
// keep a copy (see saveReplays) and link to that copy at <origin>/r/<attachment id>.hbr2.
async function downloadReplays(files, origin, timeoutMs) {
  const downloads = files.slice(0, MAX_REPLAYS_PER_MESSAGE).map(async (file) => {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`file is too big (${file.size} bytes)`);
      const response = await fetch(file.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`download failed with ${response.status}`);
      const bytes = await response.arrayBuffer();
      const version = replayVersion(bytes);
      if (!version) throw new Error('not an HBR2 replay');
      const watchUrl = haxballReplayerUrl(`${origin}/r/${file.id}.hbr2`, version);
      return { id: file.id, filename: file.filename, bytes, watchUrl };
    } catch (err) {
      console.error(`Could not download ${file.filename}:`, err);
      return null;
    }
  });
  return (await Promise.all(downloads)).filter(Boolean);
}

function saveReplays(replays, env) {
  return Promise.all(
    replays.map((replay) =>
      env.REPLAYS.put(replay.id, replay.bytes, {
        expirationTtl: KEEP_FILES_FOR_SECONDS,
        metadata: { filename: replay.filename },
      }),
    ),
  );
}

async function serveReplayFile(id, env) {
  // haxball.com downloads the file from its own page, which browsers only allow with this header.
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const { value, metadata } = await env.REPLAYS.getWithMetadata(id, { type: 'stream' });
  if (!value) return new Response('Replay not found. It may have expired.', { status: 404, headers: cors });

  const filename = (metadata?.filename ?? `${id}.hbr2`).replace(/[^\w.-]/g, '_');
  return new Response(value, {
    headers: {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// Auto mode: reply to new .hbr2 files in the configured channels. Cloudflare starts it at most once
// a minute (the cron trigger in wrangler.jsonc), so each run keeps checking every few seconds
// for most of that minute. A run's first check also catches up on anything an earlier run missed.
async function autoReply(env, scheduledTime) {
  const channelIds = (env.AUTO_CHANNEL_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  if (channelIds.length === 0) return;
  // There's no incoming request to learn our own address from, so auto mode needs PUBLIC_URL.
  const origin = env.PUBLIC_URL?.replace(/\/+$/, '');
  if (!env.DISCORD_BOT_TOKEN || !origin) {
    console.error('Auto mode needs the DISCORD_BOT_TOKEN secret and PUBLIC_URL in wrangler.jsonc (see README, step 7).');
    return;
  }
  const channels = channelIds.map((id) => ({ id, newestId: null, answered: new Set() }));
  // With several channels each one is checked less often, which keeps a run within
  // Cloudflare's free limit of 50 outgoing requests.
  const pause = POLL_EVERY_MS * channels.length;
  for (let pollAt = Date.now(); pollAt < scheduledTime + POLL_FOR_MS; pollAt += pause) {
    await sleep(pollAt - Date.now());
    for (const channel of channels) {
      try {
        await autoReplyInChannel(env, channel, origin);
      } catch (err) {
        console.error(`Auto mode failed in channel ${channel.id}:`, err);
      }
    }
  }
}

async function autoReplyInChannel(env, channel, origin) {
  // The first check reads the recent history. Later checks only ask for messages newer than the
  // newest one seen, so they're tiny and stay well within the free plan's CPU limit.
  const query = channel.newestId ? `after=${channel.newestId}&limit=50` : 'limit=50';
  const messages = await discordApi(env.DISCORD_BOT_TOKEN, 'GET', `/channels/${channel.id}/messages?${query}`);
  messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // oldest first
  if (messages.length > 0) channel.newestId = messages.at(-1).id;

  const isOurs = (message) => message.author.id === env.DISCORD_APP_ID;
  for (const message of messages.filter(isOurs)) channel.answered.add(message.message_reference?.message_id);
  const cutoff = Date.now() - AUTO_REPLY_WINDOW_MS;

  for (const message of messages) {
    if (isOurs(message) || channel.answered.has(message.id) || snowflakeTime(message.id) < cutoff) continue;
    const files = findReplayFiles(message);
    if (files.length === 0) continue;
    const replays = await downloadReplays(files, origin, 10_000);
    if (replays.length === 0) continue;
    await saveReplays(replays, env); // the copies must exist before anyone can click the link
    await discordApi(env.DISCORD_BOT_TOKEN, 'POST', `/channels/${channel.id}/messages`, {
      embeds: replayEmbeds(replays),
      message_reference: { message_id: message.id, fail_if_not_exists: false },
      allowed_mentions: { parse: [] },
    });
    channel.answered.add(message.id);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function textReply(content, flags = 0) {
  return { type: 4, data: { content, flags } };
}
