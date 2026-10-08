// The right-click command. `npm run setup` registers it with Discord.
export const WATCH_COMMAND = {
  name: 'Watch replay',
  type: 3, // message command: right-click a message → Apps → Watch replay
  integration_types: [0, 1], // can be added to servers and to your own account
  contexts: [0, 1, 2], // works in servers, in DMs with the bot and in other DMs / group DMs
};
