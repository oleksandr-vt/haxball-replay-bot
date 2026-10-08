import { WATCH_COMMAND } from './command.js';
import { discordApi, isValidDiscordRequest, snowflakeTime } from './discord.js';
import { findReplayFiles, findThehaxReplays, haxballReplayerUrl, replayButtons, replayVersion } from './replays.js';

const KEEP_FILES_FOR_SECONDS = 365 * 24 * 60 * 60;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const AUTO_REPLY_WINDOW_MS = 10 * 60 * 1000; // auto mode only answers messages from the last 10 minutes

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

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(autoReply(env));
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
  return Response.json(textReply('Unknown command.', EPHEMERAL));
}

// "Watch replay" was used on a message: reply with buttons for every replay in it.
async function watchReplay(interaction, env, ctx, origin) {
  const message = interaction.data.resolved?.messages?.[interaction.data.target_id];
  if (!message) return textReply("I couldn't read that message.", EPHEMERAL);

  const files = findReplayFiles(message).slice(0, 5);
  const fileReplays = await Promise.all(
    files.map((file) =>
      storeReplayFile(file, env, ctx, origin).catch((err) => {
        console.error(`Could not store ${file.filename}:`, err);
        return null;
      }),
    ),
  );
  const replays = [...findThehaxReplays(message), ...fileReplays.filter(Boolean)];

  if (replays.length === 0) {
    return textReply(
      files.length > 0
        ? "I couldn't read that replay file. Is it a valid .hbr2 replay?"
        : 'No HaxBall replay in that message. I look for .hbr2 files and replay.thehax.pl links.',
      EPHEMERAL,
    );
  }
  return { type: 4, data: { components: replayButtons(replays), allowed_mentions: { parse: [] } } };
}

// Discord's links to attached files expire after about a day, so we keep our own copy
// and serve it from /r/<attachment id>.hbr2.
async function storeReplayFile(attachment, env, ctx, origin) {
  if (attachment.size > MAX_FILE_BYTES) throw new Error(`file is too big (${attachment.size} bytes)`);
  // Discord gives up on us after 3 seconds, so don't wait long for the download.
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  const bytes = await response.arrayBuffer();
  const version = replayVersion(bytes);
  if (!version) throw new Error('not an HBR2 replay');

  // Saving finishes in the background, after we've answered Discord.
  ctx.waitUntil(
    env.REPLAYS.put(attachment.id, bytes, {
      expirationTtl: KEEP_FILES_FOR_SECONDS,
      metadata: { filename: attachment.filename },
    }),
  );
  return { watchUrl: haxballReplayerUrl(`${origin}/r/${attachment.id}.hbr2`, version) };
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

// Auto mode, run once a minute by the cron trigger in wrangler.jsonc: answer new thehax links
// in the configured channels. Already-answered messages are skipped, so if a run fails,
// the next one simply picks up what it missed.
async function autoReply(env) {
  const channelIds = (env.AUTO_CHANNEL_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  if (channelIds.length === 0) return;
  if (!env.DISCORD_BOT_TOKEN) {
    console.error('AUTO_CHANNEL_IDS is set, but the DISCORD_BOT_TOKEN secret is missing (see README, step 7).');
    return;
  }
  for (const channelId of channelIds) {
    try {
      await autoReplyInChannel(env, channelId);
    } catch (err) {
      console.error(`Auto mode failed in channel ${channelId}:`, err);
    }
  }
}

async function autoReplyInChannel(env, channelId) {
  const messages = await discordApi(env.DISCORD_BOT_TOKEN, 'GET', `/channels/${channelId}/messages?limit=50`);
  const isOurs = (message) => message.author.id === env.DISCORD_APP_ID;
  const answered = new Set(messages.filter(isOurs).map((message) => message.message_reference?.message_id));
  const cutoff = Date.now() - AUTO_REPLY_WINDOW_MS;

  for (const message of messages.toReversed()) { // oldest first
    if (isOurs(message) || answered.has(message.id) || snowflakeTime(message.id) < cutoff) continue;
    const replays = findThehaxReplays(message);
    if (replays.length === 0) continue;
    await discordApi(env.DISCORD_BOT_TOKEN, 'POST', `/channels/${channelId}/messages`, {
      components: replayButtons(replays),
      message_reference: { message_id: message.id, fail_if_not_exists: false },
      allowed_mentions: { parse: [] },
    });
  }
}

function textReply(content, flags = 0) {
  return { type: 4, data: { content, flags } };
}
