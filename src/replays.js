// Finding HaxBall replay files in Discord messages and building the reply that opens them.

// Same look as the UHL league bot's replay links.
const WATCH_LINK_TEXT = 'Пряме посилання для перегляду повтору';
const EMBED_COLOR = 0x00cbf4;

// haxball.com loads the replayer for the given format version and downloads the file after the "#".
// The file's server has to allow that with CORS, which our /r/ route does.
export function haxballReplayerUrl(fileUrl, version) {
  return `https://www.haxball.com/replay?v=${version}#${fileUrl}`;
}

// .hbr2 files in the message itself and in any messages forwarded inside it.
export function findReplayFiles(message) {
  return [message, ...(message.message_snapshots ?? []).map((snapshot) => snapshot.message)]
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

// One link per replay. When a message has several, each link also shows its file name.
export function replayEmbeds(replays) {
  return replays.map((replay) => ({
    title: WATCH_LINK_TEXT,
    url: replay.watchUrl,
    color: EMBED_COLOR,
    description: replays.length > 1 ? replay.filename : undefined,
  }));
}

// The IDs of the replay files a message from replayEmbeds links to (their links end in /r/<id>.hbr2).
export function linkedReplayIds(message) {
  return (message.embeds ?? []).flatMap((embed) => embed.url?.match(/\/r\/(\d+)\.hbr2/)?.[1] ?? []);
}
