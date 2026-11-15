import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { logger } from '../core/logger.js';
import { punish } from '../core/punish.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, embed, ok } from '../core/ui.js';
import { noop } from '../core/util.js';

const ACTIONS = { ban: 'Ban', softban: 'Ban then unban (removes their messages)', kick: 'Kick', timeout: 'Timeout for 1 day' };
const WARNING = '⛔ **Do not send messages in this channel.** Anyone who does is removed from the server automatically. This catches spam bots and hacked accounts, which post in every channel they can see.';

export async function postTrapWarning(guild) {
  const channel = guild.channels.cache.get(getSettings(guild.id).trap.channel);
  if (!channel?.isTextBased()) throw new Error('Pick a trap channel first.');
  await channel.send({ embeds: [embed(WARNING, COLOR.err).setTitle('Trap channel')] });
  return `Warning posted in #${channel.name}.`;
}

export default {
  name: 'trap',
  label: '🪤 Trap Channel',
  defaults: { enabled: false, channel: null, action: 'ban' },
  form: {
    title: 'Trap channel',
    description: 'Anyone who sends a message in this channel is punished automatically. Spam bots and hacked accounts post everywhere, so they get caught here. Staff with Manage Messages are never punished.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable the trap channel' },
      { key: 'channel', type: 'channel', label: 'Trap channel', help: 'Use a channel nobody needs to type in, and post the warning so real members stay out.' },
      { key: 'action', type: 'select', label: 'Punishment', options: Object.keys(ACTIONS), help: 'softban removes their recent messages and lets them rejoin, which suits hacked accounts.' },
    ],
    actions: [{ id: 'warn', label: 'Post warning message' }],
  },
  actions: { warn: (guild) => postTrapWarning(guild) },

  commands: [{
    data: cmd('trap', 'Punish anyone who types in a chosen channel', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Turn on the trap channel and post the warning')
        .addChannelOption((o) => o.setName('channel').setDescription('The trap channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('action').setDescription('What happens to people who type there')
          .addChoices(...Object.entries(ACTIONS).map(([value, name]) => ({ name, value })))))
      .addSubcommand((s) => s.setName('off').setDescription('Turn off the trap channel')),
    async run(i) {
      if (i.options.getSubcommand() === 'off') {
        await updateSettings(i.guildId, (s) => { s.trap.enabled = false; });
        return ok(i, 'Trap channel turned off.');
      }
      const channel = i.options.getChannel('channel', true);
      const action = i.options.getString('action') ?? 'ban';
      await updateSettings(i.guildId, (s) => { Object.assign(s.trap, { enabled: true, channel: channel.id, action }); });
      await postTrapWarning(i.guild);
      return ok(i, `Anyone who types in ${channel} now gets: **${ACTIONS[action]}**. A warning was posted there.`);
    },
  }],

  events: {
    async messageCreate(message) {
      if (!message.guild || message.author.bot || message.system || !message.member) return;
      const cfg = getSettings(message.guild.id).trap;
      if (!cfg.enabled || message.channelId !== cfg.channel) return;
      if (message.author.id === message.guild.ownerId || message.member.permissions.has(P.ManageMessages)) return;
      message.blocked = true;
      await message.delete().catch(noop);
      try {
        await punish(message.guild, {
          action: cfg.action, user: message.author, member: message.member, moderator: message.client.user, reason: 'Sent a message in the trap channel',
          durationMs: cfg.action === 'timeout' ? 864e5 : null, deleteSeconds: cfg.action === 'ban' ? 3600 : 0,
        });
      } catch (err) {
        // Usually the member's role is above the bot's, or the bot lacks Ban Members.
        logger.warn(`Trap channel could not ${cfg.action} ${message.author.id}: ${err.message}`);
      }
    },
  },
};
