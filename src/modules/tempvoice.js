import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, fail, ok, okPrivate } from '../core/ui.js';
import { noop, render, truncate } from '../core/util.js';

const owners = new Map();
const createCooldown = new Map();

export async function setupHub(guild) {
  const category = await guild.channels.create({ name: 'Voice Rooms', type: ChannelType.GuildCategory, reason: 'Temp voice setup' });
  const hub = await guild.channels.create({ name: '➕ Join to Create', type: ChannelType.GuildVoice, parent: category.id, reason: 'Temp voice setup' });
  await updateSettings(guild.id, (s) => { s.tempvoice.enabled = true; s.tempvoice.hub = hub.id; s.tempvoice.category = category.id; });
  return `Created the "${hub.name}" channel.`;
}

async function createRoom(state, cfg) {
  const { guild, member } = state;
  const key = `${guild.id}:${member.id}`;
  if ((createCooldown.get(key) ?? 0) > Date.now()) return state.disconnect('Creating rooms too quickly').catch(noop);
  createCooldown.set(key, Date.now() + 10_000);
  const channel = await guild.channels.create({
    name: truncate(render(cfg.nameTemplate, { username: member.displayName }), 100), type: ChannelType.GuildVoice,
    parent: cfg.category ?? state.channel.parentId ?? undefined, userLimit: cfg.defaultLimit,
    reason: `Temp voice room for ${member.user.username}`,
  });
  await db.run('INSERT INTO temp_voice(channel_id, guild_id, owner_id) VALUES ($1, $2, $3)', [channel.id, guild.id, member.id]);
  owners.set(channel.id, member.id);
  await state.setChannel(channel, 'Temp voice room').catch(async () => {
    owners.delete(channel.id);
    await db.run('DELETE FROM temp_voice WHERE channel_id = $1', [channel.id]);
    await channel.delete('User left before the move').catch(noop);
  });
}

async function removeRoom(channel) {
  owners.delete(channel.id);
  await db.run('DELETE FROM temp_voice WHERE channel_id = $1', [channel.id]);
  await channel.delete('Temp voice room empty').catch(noop);
}

export default {
  name: 'tempvoice',
  label: '🔊 Temp Voice',
  defaults: { enabled: false, hub: null, category: null, nameTemplate: "{username}'s room", defaultLimit: 0 },
  form: {
    title: 'Temporary voice',
    description: 'Joining the hub creates a private room that disappears when it empties.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable temporary voice' },
      { key: 'hub', type: 'channel', channelKind: 'voice', label: 'Join-to-create channel' },
      { key: 'category', type: 'channel', channelKind: 'category', label: 'Category for rooms' },
      { key: 'nameTemplate', type: 'text', label: 'Room name', max: 90, help: 'Supports {username}' },
      { key: 'defaultLimit', type: 'int', label: 'Default user limit', min: 0, max: 99, help: '0 means no limit.' },
    ],
    actions: [{ id: 'setup', label: 'Create join-to-create channel' }],
  },
  actions: { setup: (guild) => setupHub(guild) },

  commands: [
    {
      data: cmd('tempvoice', 'Set up join-to-create voice rooms', P.ManageGuild)
        .addSubcommand((s) => s.setName('setup').setDescription('Create the join-to-create channel'))
        .addSubcommand((s) => s.setName('off').setDescription('Turn off temporary voice')),
      botPerms: [P.ManageChannels, P.MoveMembers],
      async run(i) {
        if (i.options.getSubcommand() === 'off') {
          await updateSettings(i.guildId, (s) => { s.tempvoice.enabled = false; });
          return ok(i, 'Temporary voice turned off.');
        }
        return ok(i, await setupHub(i.guild));
      },
    },
    {
      data: cmd('voice', 'Control your temporary voice room')
        .addSubcommand((s) => s.setName('lock').setDescription('Stop new people joining'))
        .addSubcommand((s) => s.setName('unlock').setDescription('Let anyone join'))
        .addSubcommand((s) => s.setName('limit').setDescription('Set the user limit')
          .addIntegerOption((o) => o.setName('users').setDescription('0 means no limit').setRequired(true).setMinValue(0).setMaxValue(99)))
        .addSubcommand((s) => s.setName('rename').setDescription('Rename your room')
          .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)))
        .addSubcommand((s) => s.setName('permit').setDescription('Let someone into a locked room')
          .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand((s) => s.setName('kick').setDescription('Remove someone from your room')
          .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand((s) => s.setName('claim').setDescription('Take over a room whose owner left')),
      async run(i) {
        const channel = i.member.voice.channel;
        if (!channel || !owners.has(channel.id)) return fail(i, 'Join your temporary voice room first.');
        const sub = i.options.getSubcommand();
        const owner = owners.get(channel.id);
        if (sub === 'claim') {
          if (channel.members.has(owner)) return fail(i, 'The owner is still in the room.');
          owners.set(channel.id, i.user.id);
          await db.run('UPDATE temp_voice SET owner_id = $1 WHERE channel_id = $2', [i.user.id, channel.id]);
          return okPrivate(i, 'This room is yours now.');
        }
        if (owner !== i.user.id) return fail(i, 'Only the room owner can do that.');
        const everyone = i.guild.roles.everyone;
        if (sub === 'lock') await channel.permissionOverwrites.edit(everyone, { Connect: false });
        if (sub === 'unlock') await channel.permissionOverwrites.edit(everyone, { Connect: null });
        if (sub === 'limit') await channel.setUserLimit(i.options.getInteger('users', true));
        if (sub === 'rename') await channel.setName(i.options.getString('name', true));
        if (sub === 'permit') await channel.permissionOverwrites.edit(i.options.getUser('user', true).id, { Connect: true, ViewChannel: true });
        if (sub === 'kick') {
          const target = i.options.getMember('user');
          if (target?.voice.channelId !== channel.id) return fail(i, 'They are not in your room.');
          if (target.id === i.user.id) return fail(i, 'You cannot kick yourself.');
          await target.voice.disconnect('Removed by room owner');
        }
        return okPrivate(i, 'Done.');
      },
    },
  ],

  async ready(client) {
    for (const row of await db.all('SELECT * FROM temp_voice')) {
      const channel = client.channels.cache.get(row.channel_id);
      if (!channel) await db.run('DELETE FROM temp_voice WHERE channel_id = $1', [row.channel_id]);
      else if (channel.members.size === 0) await removeRoom(channel);
      else owners.set(row.channel_id, row.owner_id);
    }
  },

  events: {
    async voiceStateUpdate(before, after) {
      const cfg = getSettings(after.guild.id).tempvoice;
      if (cfg.enabled && after.channelId && after.channelId === cfg.hub && after.member && !after.member.user.bot) {
        await createRoom(after, cfg).catch((err) => logger.warn(`Temp voice failed: ${err.message}`));
      }
      if (before.channelId && before.channelId !== after.channelId && owners.has(before.channelId) && before.channel?.members.size === 0) {
        await removeRoom(before.channel);
      }
    },
  },
};
