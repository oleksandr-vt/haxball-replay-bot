import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker from '../src/index.js';

const THEHAX_ID = '5b5b0fda-2560-4bce-8da9-5998afadd74a';
const ORIGIN = 'https://bot.example.workers.dev';
const APP_ID = '1000';

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
  const target = { id: '2000', channel_id: '3000', content: '', embeds: [], attachments: [], components: [], ...message };
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

const buttonUrls = (json) => json.data.components.map((row) => row.components.map((button) => button.url));

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

test('turns a thehax link into HaxBall and Analyzer buttons', async () => {
  const { json } = await runInteraction(watchReplayInteraction({ content: `https://replay.thehax.pl/${THEHAX_ID}` }));
  assert.equal(json.type, 4);
  assert.deepEqual(buttonUrls(json), [
    [
      `https://www.haxball.com/replay?v=3#https://replay.thehax.pl/${THEHAX_ID}/download`,
      `https://haxball-replay-analyzer.github.io/?thehax=${THEHAX_ID}`,
    ],
  ]);
  assert.equal(json.data.components[0].components[0].label, 'Watch in HaxBall');
});

test('finds thehax links in embeds and buttons, once per replay', async () => {
  const link = `https://replay.thehax.pl/${THEHAX_ID.toUpperCase()}`;
  const { json } = await runInteraction(
    watchReplayInteraction({
      embeds: [{ title: 'Replay', url: link }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open', url: link }] }],
    }),
  );
  assert.equal(json.data.components.length, 1);
  assert.match(json.data.components[0].components[0].url, new RegExp(THEHAX_ID));
});

test('finds replays in forwarded messages', async () => {
  const { json } = await runInteraction(
    watchReplayInteraction({ message_snapshots: [{ message: { content: `replay.thehax.pl/${THEHAX_ID}` } }] }),
  );
  assert.equal(json.data.components.length, 1);
});

test('keeps a copy of an attached .hbr2 file and links to it', async () => {
  const fileUrl = 'https://cdn.discordapp.com/attachments/3000/4000/HBReplay.hbr2?ex=1&is=2&hm=3';
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(3)) });
  const attachment = { id: '4000', filename: 'HBReplay.hbr2', size: 64, url: fileUrl };
  const { json, env } = await runInteraction(watchReplayInteraction({ attachments: [attachment] }));

  assert.deepEqual(buttonUrls(json), [[`https://www.haxball.com/replay?v=3#${ORIGIN}/r/4000.hbr2`]]);
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
  const attachment = { id: '4001', filename: 'old.HBR2', size: 64, url: 'https://cdn.discordapp.com/x/old.HBR2' };
  const { json } = await runInteraction(watchReplayInteraction({ attachments: [attachment] }));
  assert.match(buttonUrls(json)[0][0], /^https:\/\/www\.haxball\.com\/replay\?v=2#/);
});

test('numbers the buttons when a message has several replays', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response(replayFile(3)) });
  const attachment = { id: '4002', filename: 'a.hbr2', size: 64, url: 'https://cdn.discordapp.com/x/a.hbr2' };
  const { json } = await runInteraction(
    watchReplayInteraction({ content: `replay.thehax.pl/${THEHAX_ID}`, attachments: [attachment] }),
  );
  const labels = json.data.components.map((row) => row.components.map((button) => button.label));
  assert.deepEqual(labels, [['Watch in HaxBall #1', 'Open in Analyzer #1'], ['Watch in HaxBall #2']]);
});

test('tells only the user when the message has no replay', async () => {
  const { json } = await runInteraction(watchReplayInteraction({ content: 'gg' }));
  assert.equal(json.data.flags, 64);
  assert.match(json.data.content, /No HaxBall replay/);
});

test('tells only the user when the file is not a replay', async () => {
  mockFetch({ 'cdn.discordapp.com': () => new Response('not a replay') });
  const attachment = { id: '4003', filename: 'fake.hbr2', size: 12, url: 'https://cdn.discordapp.com/x/fake.hbr2' };
  const { json, env } = await withoutErrorLogs(() => runInteraction(watchReplayInteraction({ attachments: [attachment] })));
  assert.equal(json.data.flags, 64);
  assert.match(json.data.content, /couldn't read that replay file/);
  assert.equal(env.REPLAYS.entries.size, 0);
});

test('returns 404 for files it does not have', async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/r/999.hbr2`), makeEnv(), makeCtx());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('auto mode answers each new thehax link once', async () => {
  const fresh = { id: snowflake(1), author: { id: '42' }, content: `https://replay.thehax.pl/${THEHAX_ID}` };
  const answered = { id: snowflake(3), author: { id: '42' }, content: `https://replay.thehax.pl/${THEHAX_ID}` };
  const old = { id: snowflake(30), author: { id: '42' }, content: `https://replay.thehax.pl/${THEHAX_ID}` };
  const chat = { id: snowflake(2), author: { id: '43' }, content: 'nice goal' };
  const ourReply = { id: snowflake(2), author: { id: APP_ID }, message_reference: { message_id: answered.id } };
  const calls = mockFetch({
    '/channels/555/messages': (method) =>
      method === 'GET' ? Response.json([fresh, ourReply, chat, answered, old]) : Response.json({ id: '1' }),
  });

  const ctx = makeCtx();
  await worker.scheduled({}, makeEnv({ AUTO_CHANNEL_IDS: '555', DISCORD_BOT_TOKEN: 'token' }), ctx);
  await ctx.settled();

  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.message_reference.message_id, fresh.id);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.equal(posts[0].body.components[0].components[1].url, `https://haxball-replay-analyzer.github.io/?thehax=${THEHAX_ID}`);
});

test('auto mode keeps going when one channel fails', async () => {
  const fresh = { id: snowflake(1), author: { id: '42' }, content: `replay.thehax.pl/${THEHAX_ID}` };
  const calls = mockFetch({
    '/channels/111/messages': () => new Response('Missing Access', { status: 403 }),
    '/channels/222/messages': (method) => (method === 'GET' ? Response.json([fresh]) : Response.json({ id: '1' })),
  });
  const ctx = makeCtx();
  await withoutErrorLogs(async () => {
    await worker.scheduled({}, makeEnv({ AUTO_CHANNEL_IDS: '111, 222', DISCORD_BOT_TOKEN: 'token' }), ctx);
    await ctx.settled();
  });
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.includes('/channels/222/')).length, 1);
});

test('auto mode does nothing when no channels are set', async () => {
  const calls = mockFetch({});
  const ctx = makeCtx();
  await worker.scheduled({}, makeEnv({ DISCORD_BOT_TOKEN: 'token' }), ctx);
  await ctx.settled();
  assert.equal(calls.length, 0);
});
