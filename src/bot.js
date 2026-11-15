import { Client, GatewayIntentBits as I, Partials } from 'discord.js';
import { wire } from './core/registry.js';
import { modules } from './modules/index.js';

export function createBot() {
  const client = new Client({
    intents: [
      I.Guilds, I.GuildMembers, I.GuildModeration, I.GuildExpressions, I.GuildInvites, I.GuildVoiceStates, I.GuildPresences,
      I.GuildMessages, I.GuildMessageReactions, I.MessageContent, I.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
    // Global safety net: nothing the bot says can ping @everyone or roles unless a call opts in.
    allowedMentions: { parse: ['users'], repliedUser: false },
  });
  wire(client, modules);
  return client;
}
