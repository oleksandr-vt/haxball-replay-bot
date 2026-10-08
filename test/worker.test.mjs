import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker from '../src/index.js';

const ORIGIN = 'https://bot.example.workers.dev';
const APP_ID = '1000';
const LINK_TEXT = 'Пряме посилання для перегляду повтору';

const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

class FakeKV {
  entries = new Map();
  async put(key, value, options) {
    this.entries.set(key, { bytes: new Uint8Array(value), options });
  }
  async getWithMetadata(key, { type } = {}) {
    const entry = this.entries.get(key);
    if (!entry) return { value: null, metadata: null };
    return { value: type === 'stream' ? new Response(entry.bytes).body : entry.bytes, metadata: entry.options.metadata };
  }
}

function makeEnv(vars = {}) {
  return { DISCORD_APP_ID: APP_ID, DISCORD_PUBLIC_KEY: publicKeyHex, AUTO_CHANNEL_IDS: '', REPLAYS: new FakeKV(), ...vars };
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (promise) => pending.push(promise), settled: () => Promise.all(pending) };
}

// Routes fetch() calls to handlers by URL substring and records them.
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const route = Object.keys(routes).find((part) => url.includes(part));
    if (!route) throw new Error(`unexpected fetch: ${method} ${url}`);
    return routes[route](method, url);
  };
  return calls;
}

function replayFile(version = 3) {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode('HBR2'));
  new DataView(bytes.buffer).setUint32(4, version);
  return bytes;
}

function attachment(id, filename = 'HBReplay.hbr2') {
  return { id, filename, size: 64, url: `https://cdn.discordapp.com/attachments/3000/${id}/${filename}?ex=1&is=2&hm=3` };
}

async function signedRequest(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request(`${ORIGIN}/interactions`, {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': Buffer.from(signature).toString('hex'), 'X-Signature-Timestamp': timestamp },
    body: tamper ? body.replace('"type":', '"type": ') : body,
  });
}

function watchReplayInteraction(message) {
  const target = { id: '2000', channel_id: '3000', content: '', embeds: [], attachments: [], ...message };
  return {
    type: 2,
    data: { type: 3, name: 'Watch replay', target_id: target.id, resolved: { messages: { [target.id]: target } } },
  };
}

async function runInteraction(payload, env = makeEnv()) {
  const ctx = makeCtx();
  const response = await worker.fetch(await signedRequest(payload), env, ctx);
  await ctx.settled();
  return { response, json: await response.json(), env };
}

// For tests where the worker is expected to log an error.
async function withoutErrorLogs(fn) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = originalError;
  }
}

// A message ID created `minutesAgo` minutes ago.
function snowflake(minutesAgo) {
  return String(BigInt(Date.now() - minutesAgo * 60_000 - 1420070400000) << 22n);
}

// A cron run that was scheduled 54 s ago, so it has time for just one check before its minute is used up.
const oneCheck = () => ({ scheduledTime: Date.now() - 54_000 });

test('answers Discord PING', async () => {
  const { response, json } = await runInteraction({ type: 1 });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { type: 1 });
});

test('rejects requests with a bad signature', async () => {
  const response = await worker.fetch(await signedRequest({ type: 1 }, { tamper: true }), makeEnv(), makeCtx());
  assert.equal(response.status, 401);
});

test('rejects requests without a signature', async () => {
  const request = new Request(`${ORIGIN}/interactions`, { method: 'POST', body: '{"type":1}' });
  const response = await worker.fetch(request, makeEnv(), makeCtx());
  assert.equal(response.status, 401);
});

test('replies with a haxball.com link for an attached .hbr2 file and keeps a copy', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(3)) });
  const { json, env } = await runInteraction(watchReplayInteraction({ attachments: [attachment('4000')] }));

  assert.equal(json.type, 4);
  assert.deepEqual(json.data.embeds, [
    { title: LINK_TEXT, url: `https://www.haxball.com/replay?v=3#${ORIGIN}/r/4000.hbr2`, color: 0x00cbf4 },
  ]);
  const stored = env.REPLAYS.entries.get('4000');
  assert.deepEqual(stored.bytes, replayFile(3));
  assert.equal(stored.options.metadata.filename, 'HBReplay.hbr2');

  const fileResponse = await worker.fetch(new Request(`${ORIGIN}/r/4000.hbr2`), env, makeCtx());
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(fileResponse.headers.get('Content-Disposition'), /filename="HBReplay.hbr2"/);
  assert.deepEqual(new Uint8Array(await fileResponse.arrayBuffer()), replayFile(3));
});

test('uses the format version written in the file', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(2)) });
  const { json } = await runInteraction(watchReplayInteraction({ attachments: [attachment('4001', 'old.HBR2')] }));
  assert.match(json.data.embeds[0].url, /^https:\/\/www\.haxball\.com\/replay\?v=2#/);
});

test('shows file names when a message has several replays', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(3)) });
  const { json } = await runInteraction(
    watchReplayInteraction({ attachments: [attachment('4002', 'first.hbr2'), attachment('4003', 'second.hbr2')] }),
  );
  assert.deepEqual(
    json.data.embeds.map((embed) => [embed.title, embed.description]),
    [
      [LINK_TEXT, 'first.hbr2'],
      [LINK_TEXT, 'second.hbr2'],
    ],
  );
});

test('finds replays in forwarded messages', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(3)) });
  const { json } = await runInteraction(
    watchReplayInteraction({ message_snapshots: [{ message: { attachments: [attachment('4004')] } }] }),
  );
  assert.equal(json.data.embeds.length, 1);
});

test('tells only the user when the message has no replay', async () => {
  const { json } = await runInteraction(
    watchReplayInteraction({ content: 'gg', attachments: [{ id: '1', filename: 'goal.png', url: 'https://cdn.discordapp.com/x' }] }),
  );
  assert.equal(json.data.flags, 64);
  assert.match(json.data.content, /\.hbr2/);
});

test('tells only the user when the file is not a replay', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response('not a replay') });
  const { json, env } = await withoutErrorLogs(() =>
    runInteraction(watchReplayInteraction({ attachments: [attachment('4005', 'fake.hbr2')] })),
  );
  assert.equal(json.data.flags, 64);
  assert.equal(env.REPLAYS.entries.size, 0);
});

test('returns 404 for files it does not have', async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/r/999.hbr2`), makeEnv(), makeCtx());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('auto mode replies to each new replay file once, after saving it', async () => {
  const env = makeEnv({ AUTO_CHANNEL_IDS: '555', DISCORD_BOT_TOKEN: 'token', PUBLIC_URL: `${ORIGIN}/` });
  const fresh = { id: snowflake(1), author: { id: '42' }, attachments: [attachment('5000')] };
  const answered = { id: snowflake(3), author: { id: '42' }, attachments: [attachment('5001')] };
  const old = { id: snowflake(30), author: { id: '42' }, attachments: [attachment('5002')] };
  const chat = { id: snowflake(2), author: { id: '43' }, content: 'nice goal', attachments: [] };
  const ourReply = { id: snowflake(2), author: { id: APP_ID }, message_reference: { message_id: answered.id } };
  let savedBeforePosting = false;
  const calls = mockFetch({
    'cdn.discordapp.com': () => new Response(replayFile(3)),
    '/channels/555/messages': (method) => {
      if (method === 'GET') return Response.json([fresh, ourReply, chat, answered, old]);
      savedBeforePosting = env.REPLAYS.entries.has('5000');
      return Response.json({ id: '1' });
    },
  });

  await worker.scheduled(oneCheck(), env);

  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.message_reference.message_id, fresh.id);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.deepEqual(posts[0].body.embeds, [
    { title: LINK_TEXT, url: `https://www.haxball.com/replay?v=3#${ORIGIN}/r/5000.hbr2`, color: 0x00cbf4 },
  ]);
  assert.ok(savedBeforePosting);
});

test('auto mode keeps checking during its minute and only asks for newer messages', async () => {
  const env = makeEnv({ AUTO_CHANNEL_IDS: '555', DISCORD_BOT_TOKEN: 'token', PUBLIC_URL: ORIGIN });
  const answered = { id: snowflake(3), author: { id: '42' }, attachments: [attachment('5010')] };
  const ourReply = { id: snowflake(2), author: { id: APP_ID }, message_reference: { message_id: answered.id } };
  const posted = { id: snowflake(0), author: { id: '42' }, attachments: [attachment('5011')] };
  const calls = mockFetch({
    'cdn.discordapp.com': () => new Response(replayFile(3)),
    '/channels/555/messages': (method, url) => {
      if (method === 'POST') return Response.json({ id: '1' });
      return Response.json(url.includes('after=') ? [posted] : [ourReply, answered]);
    },
  });

  // Scheduled 49 s ago: time for a check now and one more 5 s later.
  await worker.scheduled({ scheduledTime: Date.now() - 49_000 }, env);

  const gets = calls.filter((call) => call.method === 'GET' && call.url.includes('/channels/555/'));
  assert.equal(gets.length, 2);
  assert.match(gets[1].url, new RegExp(`after=${ourReply.id}`));
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.message_reference.message_id, posted.id);
});

test('auto mode skips files that are not replays', async () => {
  const fake = { id: snowflake(1), author: { id: '42' }, attachments: [attachment('5003', 'fake.hbr2')] };
  const calls = mockFetch({
    'cdn.discordapp.com': () => new Response('not a replay'),
    '/channels/555/messages': () => Response.json([fake]),
  });
  await withoutErrorLogs(() =>
    worker.scheduled(oneCheck(), makeEnv({ AUTO_CHANNEL_IDS: '555', DISCORD_BOT_TOKEN: 'token', PUBLIC_URL: ORIGIN })),
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('auto mode keeps going when one channel fails', async () => {
  const fresh = { id: snowflake(1), author: { id: '42' }, attachments: [attachment('5004')] };
  const calls = mockFetch({
    'cdn.discordapp.com': () => new Response(replayFile(3)),
    '/channels/111/messages': () => new Response('Missing Access', { status: 403 }),
    '/channels/222/messages': (method) => (method === 'GET' ? Response.json([fresh]) : Response.json({ id: '1' })),
  });
  await withoutErrorLogs(() =>
    worker.scheduled(oneCheck(), makeEnv({ AUTO_CHANNEL_IDS: '111, 222', DISCORD_BOT_TOKEN: 'token', PUBLIC_URL: ORIGIN })),
  );
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.includes('/channels/222/')).length, 1);
});

test('auto mode does nothing when no channels are set', async () => {
  const calls = mockFetch({});
  await worker.scheduled(oneCheck(), makeEnv({ DISCORD_BOT_TOKEN: 'token', PUBLIC_URL: ORIGIN }));
  assert.equal(calls.length, 0);
});

test('auto mode does nothing without PUBLIC_URL', async () => {
  const calls = mockFetch({});
  await withoutErrorLogs(() => worker.scheduled(oneCheck(), makeEnv({ AUTO_CHANNEL_IDS: '555', DISCORD_BOT_TOKEN: 'token' })));
  assert.equal(calls.length, 0);
});
