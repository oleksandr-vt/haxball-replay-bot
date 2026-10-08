// Finding HaxBall replays in Discord messages and building the buttons that open them.

const ANALYZER = 'https://haxball-replay-analyzer.github.io/';

// Current HaxBall replays are format version 3. Files tell us their version themselves (see replayVersion).
const THEHAX_REPLAY_VERSION = 3;

const THEHAX_LINK = /replay\.thehax\.pl\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// haxball.com loads the replayer for the given format version and downloads the file after the "#".
// The file's server has to allow that with CORS: thehax does, and so does our /r/ route.
export function haxballReplayerUrl(fileUrl, version) {
  return `https://www.haxball.com/replay?v=${version}#${fileUrl}`;
}

// The message itself plus any messages forwarded inside it.
function messageParts(message) {
  return [message, ...(message.message_snapshots ?? []).map((snapshot) => snapshot.message)];
}

// thehax links anywhere in the message: text, embeds or buttons (the thehax bot may use any of them).
export function findThehaxReplays(message) {
  const text = JSON.stringify(messageParts(message).map((part) => [part.content, part.embeds, part.components]));
  const ids = new Set(Array.from(text.matchAll(THEHAX_LINK), (match) => match[1].toLowerCase()));
  return [...ids].map((id) => ({
    watchUrl: haxballReplayerUrl(`https://replay.thehax.pl/${id}/download`, THEHAX_REPLAY_VERSION),
    // The Analyzer can only open replays hosted on thehax, which it downloads by ID.
    analyzeUrl: `${ANALYZER}?thehax=${id}`,
  }));
}

export function findReplayFiles(message) {
  return messageParts(message)
    .flatMap((part) => part.attachments ?? [])
    .filter((attachment) => /\.hbr2$/i.test(attachment.filename));
}

// .hbr2 files start with "HBR2" followed by the format version as a big-endian 32-bit number.
export function replayVersion(bytes) {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  return magic === 'HBR2' ? view.getUint32(4) : null;
}

// One row of link buttons per replay. Discord allows at most 5 rows per message.
export function replayButtons(replays) {
  const numbered = replays.length > 1;
  return replays.slice(0, 5).map((replay, i) => {
    const suffix = numbered ? ` #${i + 1}` : '';
    const buttons = [linkButton(`Watch in HaxBall${suffix}`, '▶️', replay.watchUrl)];
    if (replay.analyzeUrl) buttons.push(linkButton(`Open in Analyzer${suffix}`, '📊', replay.analyzeUrl));
    return { type: 1, components: buttons };
  });
}

function linkButton(label, emoji, url) {
  return { type: 2, style: 5, label, emoji: { name: emoji }, url };
}
