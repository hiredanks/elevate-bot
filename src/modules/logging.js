import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, ok, okPrivate, sendTo } from '../core/ui.js';
import { truncate, ts } from '../core/util.js';

const CATEGORIES = { messages: 'Messages', members: 'Members', server: 'Server', voice: 'Voice' };
const BLUE = 0x3498db;

function log(guild, category, color, title, description, fields = []) {
  const { channels } = getSettings(guild.id).logging;
  if (!channels[category]) return null;
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) e.setDescription(truncate(description, 4000));
  if (fields.length) e.addFields(fields);
  return sendTo(guild, channels[category], { embeds: [e], allowedMentions: { parse: [] } });
}

const skipMessage = (m) => {
  if (!m.guild || m.author?.bot) return true;
  const cfg = getSettings(m.guild.id).logging;
  return cfg.ignored.includes(m.channelId) || Object.values(cfg.channels).includes(m.channelId);
};
const who = (user) => `<@${user.id}> (${user.username}, \`${user.id}\`)`;
const field = (name, value) => ({ name, value: truncate(value || '(empty)', 1024) });

export default {
  name: 'logging',
  label: '📜 Server Logs',
  defaults: { channels: { messages: null, members: null, server: null, voice: null }, ignored: [] },
  form: {
    title: 'Server logs',
    description: 'Choose a channel for each kind of event. Leave one empty to turn it off.',
    fields: [
      { key: 'channels.messages', type: 'channel', label: 'Message edits and deletes' },
      { key: 'channels.members', type: 'channel', label: 'Joins, leaves, roles and nicknames' },
      { key: 'channels.server', type: 'channel', label: 'Channels, roles, bans, invites' },
      { key: 'channels.voice', type: 'channel', label: 'Voice activity' },
      { key: 'ignored', type: 'channels', label: 'Channels to ignore' },
    ],
  },

  commands: [{
    data: cmd('logs', 'Configure server logs', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Send one category of logs to a channel')
        .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true)
          .addChoices(...Object.entries(CATEGORIES).map(([value, name]) => ({ name, value }))))
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn this category off').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('all').setDescription('Send every category to one channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('ignore').setDescription('Toggle ignoring a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
      .addSubcommand((s) => s.setName('show').setDescription('Show log settings')),
    async run(i) {
      const sub = i.options.getSubcommand();
      const channel = i.options.getChannel('channel');
      if (sub === 'show') {
        const cfg = getSettings(i.guildId).logging;
        return okPrivate(i, Object.entries(CATEGORIES).map(([k, label]) => `**${label}:** ${cfg.channels[k] ? `<#${cfg.channels[k]}>` : 'off'}`).join('\n'));
      }
      if (sub === 'set') {
        const category = i.options.getString('category', true);
        await updateSettings(i.guildId, (s) => { s.logging.channels[category] = channel?.id ?? null; });
        return ok(i, channel ? `${CATEGORIES[category]} logs go to ${channel}.` : `${CATEGORIES[category]} logs turned off.`);
      }
      if (sub === 'all') {
        await updateSettings(i.guildId, (s) => { for (const k of Object.keys(CATEGORIES)) s.logging.channels[k] = channel.id; });
        return ok(i, `All logs go to ${channel}.`);
      }
      const { logging } = await updateSettings(i.guildId, (s) => {
        s.logging.ignored = s.logging.ignored.includes(channel.id) ? s.logging.ignored.filter((c) => c !== channel.id) : [...s.logging.ignored, channel.id];
      });
      return ok(i, `${channel} is ${logging.ignored.includes(channel.id) ? 'now ignored' : 'no longer ignored'}.`);
    },
  }],

  events: {
    messageDelete(m) {
      if (skipMessage(m)) return null;
      const author = m.author ? who(m.author) : 'Unknown (message was not cached)';
      return log(m.guild, 'messages', COLOR.err, 'Message deleted', null, [
        field('Author', author), field('Channel', `<#${m.channelId}>`), field('Content', m.content),
        ...(m.attachments?.size ? [field('Attachments', m.attachments.map((a) => a.name).join(', '))] : []),
      ]);
    },
    messageDeleteBulk(messages, channel) {
      if (!channel.guild) return null;
      return log(channel.guild, 'messages', COLOR.err, 'Messages bulk deleted', `**${messages.size}** messages removed in <#${channel.id}>.`);
    },
    messageUpdate(before, after) {
      if (skipMessage(after) || after.partial || before.content === after.content) return null;
      return log(after.guild, 'messages', COLOR.warn, 'Message edited', `${who(after.author)} in <#${after.channelId}> [Jump](${after.url})`, [
        field('Before', before.content ?? '(not cached)'), field('After', after.content),
      ]);
    },
    guildMemberAdd(member) {
      return log(member.guild, 'members', COLOR.ok, 'Member joined', who(member.user), [field('Account created', ts(member.user.createdTimestamp))]);
    },
    guildMemberRemove(member) {
      const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => r.name).join(', ');
      return log(member.guild, 'members', COLOR.err, 'Member left', who(member.user), [field('Roles', roles || 'None')]);
    },
    async guildMemberUpdate(before, after) {
      if (before.partial) return;
      if (before.nickname !== after.nickname) {
        await log(after.guild, 'members', BLUE, 'Nickname changed', who(after.user), [field('Before', before.nickname ?? 'None'), field('After', after.nickname ?? 'None')]);
      }
      const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
      const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
      if (added.size || removed.size) {
        const lines = [...added.map((r) => `➕ ${r.name}`), ...removed.map((r) => `➖ ${r.name}`)];
        await log(after.guild, 'members', BLUE, 'Roles changed', `${who(after.user)}\n${lines.join('\n')}`);
      }
    },
    guildBanAdd: (ban) => log(ban.guild, 'server', COLOR.err, 'Member banned', who(ban.user)),
    guildBanRemove: (ban) => log(ban.guild, 'server', COLOR.ok, 'Member unbanned', who(ban.user)),
    channelCreate: (c) => log(c.guild, 'server', COLOR.ok, 'Channel created', `<#${c.id}> (${c.name})`),
    channelDelete: (c) => (c.guild ? log(c.guild, 'server', COLOR.err, 'Channel deleted', `#${c.name}`) : null),
    channelUpdate(before, after) {
      if (!after.guild) return null;
      const changes = [];
      if (before.name !== after.name) changes.push(`**Name:** ${before.name} → ${after.name}`);
      if (before.topic !== after.topic) changes.push('**Topic changed**');
      if (before.rateLimitPerUser !== after.rateLimitPerUser) changes.push(`**Slowmode:** ${before.rateLimitPerUser ?? 0}s → ${after.rateLimitPerUser ?? 0}s`);
      return changes.length ? log(after.guild, 'server', BLUE, 'Channel updated', `<#${after.id}>\n${changes.join('\n')}`) : null;
    },
    roleCreate: (r) => log(r.guild, 'server', COLOR.ok, 'Role created', r.name),
    roleDelete: (r) => log(r.guild, 'server', COLOR.err, 'Role deleted', r.name),
    roleUpdate(before, after) {
      const changes = [];
      if (before.name !== after.name) changes.push(`**Name:** ${before.name} → ${after.name}`);
      if (before.color !== after.color) changes.push('**Color changed**');
      if (!before.permissions.equals(after.permissions)) {
        const gained = after.permissions.remove(before.permissions).toArray();
        const lost = before.permissions.remove(after.permissions).toArray();
        if (gained.length) changes.push(`**Gained:** ${gained.join(', ')}`);
        if (lost.length) changes.push(`**Lost:** ${lost.join(', ')}`);
      }
      return changes.length ? log(after.guild, 'server', BLUE, 'Role updated', `**${after.name}**\n${changes.join('\n')}`) : null;
    },
    inviteCreate: (inv) => (inv.guild ? log(inv.guild, 'server', COLOR.ok, 'Invite created', `\`${inv.code}\` by ${inv.inviter ? who(inv.inviter) : 'unknown'}`) : null),
    voiceStateUpdate(before, after) {
      if (before.channelId === after.channelId || after.member?.user.bot) return null;
      const member = after.member;
      if (!member) return null;
      if (!before.channelId) return log(after.guild, 'voice', COLOR.ok, 'Joined voice', `${who(member.user)} → <#${after.channelId}>`);
      if (!after.channelId) return log(after.guild, 'voice', COLOR.err, 'Left voice', `${who(member.user)} ← <#${before.channelId}>`);
      return log(after.guild, 'voice', BLUE, 'Moved voice', `${who(member.user)}: <#${before.channelId}> → <#${after.channelId}>`);
    },
  },
};
