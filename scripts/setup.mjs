// One-time setup: connects your Discord app to the deployed worker.
//
//   npm run setup -- https://haxball-replay-bot.<your-subdomain>.workers.dev
//
// Safe to run again at any time.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { WATCH_COMMAND } from '../src/command.js';
import { discordApi } from '../src/discord.js';

// What the bot may do in a server (only auto mode needs it): View Channels, Send Messages, Read Message History.
const BOT_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 16));
const MESSAGE_CONTENT_INTENT = 1 << 19; // the "Message Content Intent" switch in the Developer Portal
const CONFIG_FILE = new URL('../wrangler.jsonc', import.meta.url);

try {
  process.loadEnvFile('.dev.vars');
} catch {
  fail('No .dev.vars file found. Copy .dev.vars.example to .dev.vars and paste your bot token into it.');
}
const token = process.env.DISCORD_BOT_TOKEN?.trim();
if (!token || token.startsWith('paste-')) fail('Paste your bot token into .dev.vars first (DISCORD_BOT_TOKEN=...).');
const discord = (method, path, body) => discordApi(token, method, path, body);

const app = await discord('GET', '/applications/@me').catch((err) =>
  fail(`Discord didn't accept the bot token in .dev.vars. Reset it on the Bot page and paste the new one.\n  (${err.message})`),
);
console.log(`Discord app: ${app.name} (${app.id})`);

// The worker needs this app's ID and public key to check that requests really come from Discord.
let config = readFileSync(CONFIG_FILE, 'utf8');
const setting = (name) => config.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1];
if (setting('DISCORD_APP_ID') !== app.id || setting('DISCORD_PUBLIC_KEY') !== app.verify_key) {
  config = config
    .replace(/("DISCORD_APP_ID"\s*:\s*)"[^"]*"/, `$1"${app.id}"`)
    .replace(/("DISCORD_PUBLIC_KEY"\s*:\s*)"[^"]*"/, `$1"${app.verify_key}"`);
  writeFileSync(CONFIG_FILE, config);
  console.log('\n✔ Wrote your app ID and public key into wrangler.jsonc.');
  console.log('  Now run "npm run deploy", then run "npm run setup" again.\n');
  process.exit(0);
}

await discord('PUT', `/applications/${app.id}/commands`, [WATCH_COMMAND]);
console.log(`✔ Registered the "${WATCH_COMMAND.name}" command`);

const workerUrl = (process.argv[2] ?? (await ask('Paste your worker URL (it was printed by "npm run deploy"): ')))
  .trim()
  .replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(workerUrl)) {
  fail(`"${workerUrl}" doesn't look like a worker URL. It looks like https://haxball-replay-bot.yourname.workers.dev`);
}

// Discord tests the URL right away by sending it a signed request, so the worker must already be deployed.
await discord('PATCH', '/applications/@me', {
  interactions_endpoint_url: `${workerUrl}/interactions`,
  integration_types_config: {
    0: { oauth2_install_params: { scopes: ['applications.commands', 'bot'], permissions: BOT_PERMISSIONS } },
    1: { oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' } },
  },
}).catch((err) =>
  fail(
    `Discord couldn't verify ${workerUrl}/interactions.\n` +
      '  Check the URL, make sure "npm run deploy" finished, and that you deployed after wrangler.jsonc got your app ID and public key.\n' +
      `  (${err.message})`,
  ),
);
console.log(`✔ Interactions Endpoint URL set to ${workerUrl}/interactions`);

// Auto mode reads the thehax bot's messages, which Discord only allows with the Message Content intent.
if (!(app.flags & MESSAGE_CONTENT_INTENT)) {
  try {
    await discord('PATCH', '/applications/@me', { flags: app.flags | MESSAGE_CONTENT_INTENT });
    console.log('✔ Turned on the Message Content intent (needed for auto mode)');
  } catch {
    console.warn('! Could not turn on the Message Content intent. For auto mode, switch it on yourself: Developer Portal → Bot → Message Content Intent.');
  }
}

// Older Discord docs required a bot to log in to the gateway once before it can post messages,
// which auto mode does. Logging in once here covers that.
try {
  await logInToGatewayOnce(token);
  console.log('✔ Bot logged in to Discord once');
} catch (err) {
  console.warn(`! Could not log the bot in to Discord (${err.message}). Only matters for auto mode.`);
}

console.log(`
All set! Install links:

  Add to your account (right-click command works in every server and DM):
  https://discord.com/oauth2/authorize?client_id=${app.id}&integration_type=1&scope=applications.commands

  Add to a server (needed for auto mode; you need "Manage Server" there):
  https://discord.com/oauth2/authorize?client_id=${app.id}&integration_type=0&scope=applications.commands+bot&permissions=${BOT_PERMISSIONS}
`);
process.exit(0);

function logInToGatewayOnce(botToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    const timer = setTimeout(() => {
      reject(new Error('timed out'));
      ws.close();
    }, 15_000);
    ws.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.op === 10) {
        // HELLO → IDENTIFY
        const properties = { os: process.platform, browser: 'haxball-replay-bot', device: 'haxball-replay-bot' };
        ws.send(JSON.stringify({ op: 2, d: { token: botToken, intents: 0, properties } }));
      } else if (payload.t === 'READY') {
        clearTimeout(timer);
        resolve();
        ws.close();
      }
    });
    ws.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`connection closed (${event.code})`)); // no effect if READY already resolved it
    });
  });
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
