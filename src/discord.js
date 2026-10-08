// Small helpers for talking to Discord. Also used by scripts/setup.mjs.

const API = 'https://discord.com/api/v10';

let cachedKey; // importing the public key once per worker instance saves CPU time

// Discord signs every interaction it sends us. Anything that doesn't verify must be rejected.
export async function isValidDiscordRequest(request, body, publicKeyHex) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    if (cachedKey?.hex !== publicKeyHex) {
      const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
      cachedKey = { hex: publicKeyHex, key };
    }
    return await crypto.subtle.verify('Ed25519', cachedKey.key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('not a hex string');
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
}

export async function discordApi(token, method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (haxball-replay-bot, 1.0)',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Discord API ${method} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

// Discord IDs ("snowflakes") contain the time they were created.
export function snowflakeTime(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}
