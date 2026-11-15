import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { jobs } from '../core/jobs.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, embed, COLOR, EPHEMERAL, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { dayKey, formatDuration, memberVars, noop, parseDuration, render, sleep, truncate, ts } from '../core/util.js';

const MAX_REMINDER = 365 * 864e5;
const MIN_TIMER_MINUTES = 10;
const BIRTHDAY_CHECK_MS = 60 * 60_000;
const STICKY_DEBOUNCE_MS = 5000;

const afk = new Map();
const stickies = new Map();
const stickyTimers = new Map();
const afkKey = (guildId, userId) => `${guildId}:${userId}`;

function repostSticky(channel) {
  clearTimeout(stickyTimers.get(channel.id));
  stickyTimers.set(channel.id, setTimeout(async () => {
    const sticky = stickies.get(channel.id);
    if (!sticky) return;
    if (sticky.last_message_id) await channel.messages.delete(sticky.last_message_id).catch(noop);
    const sent = await channel.send({ embeds: [embed(sticky.content, COLOR.brand).setFooter({ text: 'Pinned message' })], allowedMentions: { parse: [] } }).catch(() => null);
    if (!sent) return;
    sticky.last_message_id = sent.id;
    await db.run('UPDATE stickies SET last_message_id = $1 WHERE channel_id = $2', [sent.id, channel.id]);
  }, channel.client.stickyDelay ?? STICKY_DEBOUNCE_MS));
}

export async function runBirthdays(client, now = Date.now()) {
  const date = new Date(now);
  const today = dayKey(now);
  for (const guild of client.guilds.cache.values()) {
    const cfg = getSettings(guild.id).birthdays;
    if (!cfg.enabled || !cfg.channel || cfg.lastRun === today) continue;
    await updateSettings(guild.id, (s) => { s.birthdays.lastRun = today; });
    const rows = await db.all('SELECT user_id FROM birthdays WHERE guild_id = $1 AND month = $2 AND day = $3', [guild.id, date.getUTCMonth() + 1, date.getUTCDate()]);
    for (const { user_id: userId } of rows) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      await sendTo(guild, cfg.channel, { content: render(cfg.message, memberVars(member)), allowedMentions: { users: [userId] } });
      if (cfg.role) {
        await member.roles.add(cfg.role, 'Birthday').catch(noop);
        await jobs.schedule('birthday:end', guild.id, now + 864e5, { userId, roleId: cfg.role }, userId);
      }
    }
  }
}

export default {
  name: 'community',
  label: '🌟 Community',
  defaults: {},

  commands: [
    {
      data: cmd('remind', 'Reminders')
        .addSubcommand((s) => s.setName('me').setDescription('Set a reminder')
          .addStringOption((o) => o.setName('in').setDescription('For example 10m, 2h, 3d').setRequired(true))
          .addStringOption((o) => o.setName('what').setDescription('What to remind you about').setRequired(true).setMaxLength(800))
          .addBooleanOption((o) => o.setName('dm').setDescription('Send by DM instead of in this channel')))
        .addSubcommand((s) => s.setName('list').setDescription('See your reminders'))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete a reminder')
          .addIntegerOption((o) => o.setName('id').setDescription('ID from the list').setRequired(true).setMinValue(1))),
      async run(i) {
        const sub = i.options.getSubcommand();
        const prefix = `${i.user.id}:`;
        if (sub === 'list') {
          const rows = await jobs.list('remind', i.guildId, prefix);
          return okPrivate(i, rows.map((r) => `**${r.id}.** ${ts(r.run_at)}: ${truncate(r.payload.text, 80)}`).join('\n') || 'No reminders set.');
        }
        if (sub === 'delete') {
          const removed = await db.run("DELETE FROM jobs WHERE id = $1 AND type = 'remind' AND guild_id = $2 AND job_key LIKE $3", [i.options.getInteger('id', true), i.guildId, `${prefix}%`]);
          return removed ? okPrivate(i, 'Reminder deleted.') : fail(i, 'No reminder of yours with that ID.');
        }
        const ms = parseDuration(i.options.getString('in', true));
        if (!ms || ms > MAX_REMINDER) return fail(i, 'Try something like `10m`, `2h` or `3d`, up to a year.');
        const runAt = Date.now() + ms;
        await jobs.schedule('remind', i.guildId, runAt, {
          userId: i.user.id, channelId: i.channelId, text: i.options.getString('what', true), dm: i.options.getBoolean('dm') ?? false,
        }, `${prefix}${randomUUID()}`);
        return okPrivate(i, `I will remind you ${ts(runAt)}.`);
      },
    },
    {
      data: cmd('afk', 'Tell people you are away')
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)),
      async run(i) {
        const reason = i.options.getString('reason') ?? 'AFK';
        const row = { guild_id: i.guildId, user_id: i.user.id, reason, since: Date.now() };
        await db.run('INSERT INTO afk(guild_id, user_id, reason, since) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = $3, since = $4', [row.guild_id, row.user_id, reason, row.since]);
        afk.set(afkKey(i.guildId, i.user.id), row);
        return ok(i, `You are now AFK: ${reason}`, { allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('sticky', 'Keep a message at the bottom of a channel', P.ManageMessages)
        .addSubcommand((s) => s.setName('set').setDescription('Set this channel\'s sticky message')
          .addStringOption((o) => o.setName('message').setDescription('Text').setRequired(true).setMaxLength(1800)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove this channel\'s sticky message')),
      async run(i) {
        const sticky = stickies.get(i.channelId);
        if (i.options.getSubcommand() === 'remove') {
          if (!sticky) return fail(i, 'This channel has no sticky message.');
          stickies.delete(i.channelId);
          await db.run('DELETE FROM stickies WHERE channel_id = $1', [i.channelId]);
          if (sticky.last_message_id) await i.channel.messages.delete(sticky.last_message_id).catch(noop);
          return okPrivate(i, 'Sticky message removed.');
        }
        const content = i.options.getString('message', true).replace(/\\n/g, '\n');
        await db.run(
          'INSERT INTO stickies(channel_id, guild_id, content) VALUES ($1, $2, $3) ON CONFLICT (channel_id) DO UPDATE SET content = excluded.content',
          [i.channelId, i.guildId, content],
        );
        stickies.set(i.channelId, { channel_id: i.channelId, guild_id: i.guildId, content, last_message_id: sticky?.last_message_id ?? null });
        repostSticky(i.channel);
        return okPrivate(i, 'Sticky message set.');
      },
    },
    {
      data: cmd('timer', 'Post a message on a repeating schedule', P.ManageGuild)
        .addSubcommand((s) => s.setName('add').setDescription('Create a repeating message')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
          .addStringOption((o) => o.setName('every').setDescription('For example 6h or 1d').setRequired(true))
          .addStringOption((o) => o.setName('message').setDescription('Text').setRequired(true).setMaxLength(1800)))
        .addSubcommand((s) => s.setName('list').setDescription('List repeating messages'))
        .addSubcommand((s) => s.setName('remove').setDescription('Delete a repeating message')
          .addIntegerOption((o) => o.setName('id').setDescription('ID from the list').setRequired(true).setMinValue(1))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = await jobs.list('timer', i.guildId);
          return okPrivate(i, rows.map((r) => `**${r.id}.** <#${r.payload.channelId}> every ${formatDuration(r.payload.intervalMs)}: ${truncate(r.payload.content, 60)}`).join('\n') || 'No timers yet.');
        }
        if (sub === 'remove') {
          const removed = await db.run("DELETE FROM jobs WHERE id = $1 AND type = 'timer' AND guild_id = $2", [i.options.getInteger('id', true), i.guildId]);
          return removed ? ok(i, 'Timer removed.') : fail(i, 'No timer with that ID.');
        }
        const intervalMs = parseDuration(i.options.getString('every', true));
        if (!intervalMs || intervalMs < MIN_TIMER_MINUTES * 60_000) return fail(i, `The interval must be at least ${MIN_TIMER_MINUTES} minutes, like \`6h\`.`);
        const channel = i.options.getChannel('channel', true);
        await jobs.schedule('timer', i.guildId, Date.now() + intervalMs, { channelId: channel.id, content: i.options.getString('message', true), intervalMs });
        return ok(i, `Posting in ${channel} every **${formatDuration(intervalMs)}**.`);
      },
    },
    {
      data: cmd('birthday', 'Birthday announcements')
        .addSubcommand((s) => s.setName('set').setDescription('Save your birthday')
          .addIntegerOption((o) => o.setName('month').setDescription('1-12').setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption((o) => o.setName('day').setDescription('1-31').setRequired(true).setMinValue(1).setMaxValue(31)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove your birthday'))
        .addSubcommand((s) => s.setName('setup').setDescription('Configure announcements (Manage Server)')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addRoleOption((o) => o.setName('role').setDescription('Role given for the day'))
          .addStringOption((o) => o.setName('message').setDescription('Supports {user} {username} {server}').setMaxLength(1000))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'set') {
          const month = i.options.getInteger('month', true);
          const day = i.options.getInteger('day', true);
          if (day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return fail(i, 'That date does not exist.');
          await db.run('INSERT INTO birthdays(guild_id, user_id, month, day) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id) DO UPDATE SET month = $3, day = $4', [i.guildId, i.user.id, month, day]);
          return okPrivate(i, 'Birthday saved. 🎂');
        }
        if (sub === 'remove') {
          await db.run('DELETE FROM birthdays WHERE guild_id = $1 AND user_id = $2', [i.guildId, i.user.id]);
          return okPrivate(i, 'Birthday removed.');
        }
        if (!i.memberPermissions.has(P.ManageGuild)) return fail(i, 'You need Manage Server to do that.');
        const channel = i.options.getChannel('channel', true);
        const role = i.options.getRole('role');
        const message = i.options.getString('message');
        await updateSettings(i.guildId, (s) => {
          s.birthdays.enabled = true;
          s.birthdays.channel = channel.id;
          s.birthdays.role = role?.id ?? null;
          if (message) s.birthdays.message = message;
        });
        return ok(i, `Birthdays will be announced in ${channel}.`, { flags: EPHEMERAL });
      },
    },
  ],

  jobs: {
    async remind(client, { userId, channelId, text, dm }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return;
      const message = { content: `⏰ <@${userId}> reminder: ${text}`, allowedMentions: { users: [userId] } };
      const sent = dm ? await user.send(message).catch(() => null) : await sendTo(guild ?? { channels: { cache: new Map() } }, channelId, message);
      if (!sent) await user.send(message).catch(noop);
    },
    async timer(client, payload, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (!guild?.channels.cache.has(payload.channelId)) return null;
      await sendTo(guild, payload.channelId, { content: payload.content, allowedMentions: { parse: [] } });
      return { rescheduleAt: Date.now() + payload.intervalMs };
    },
    async 'birthday:end'(client, { userId, roleId }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      const member = await guild?.members.fetch(userId).catch(() => null);
      await member?.roles.remove(roleId, 'Birthday over').catch(noop);
    },
  },

  async ready(client) {
    for (const row of await db.all('SELECT * FROM afk')) afk.set(afkKey(row.guild_id, row.user_id), row);
    for (const row of await db.all('SELECT * FROM stickies')) stickies.set(row.channel_id, row);
    await runBirthdays(client).catch((err) => logger.error('Birthdays failed', err));
    setInterval(() => runBirthdays(client).catch((err) => logger.error('Birthdays failed', err)), BIRTHDAY_CHECK_MS).unref?.();
  },

  events: {
    async messageCreate(message) {
      if (!message.guild) return;
      if (stickies.has(message.channelId) && message.author.id !== message.client.user.id) repostSticky(message.channel);
      if (message.author.bot || message.blocked) return;

      const mine = afkKey(message.guild.id, message.author.id);
      if (afk.has(mine)) {
        afk.delete(mine);
        await db.run('DELETE FROM afk WHERE guild_id = $1 AND user_id = $2', [message.guild.id, message.author.id]);
        const note = await message.reply({ content: 'Welcome back, I removed your AFK.', allowedMentions: { repliedUser: false } }).catch(() => null);
        if (note) sleep(6000).then(() => note.delete().catch(noop));
      }
      const notes = [];
      for (const user of message.mentions.users.values()) {
        const entry = afk.get(afkKey(message.guild.id, user.id));
        if (entry) notes.push(`**${user.username}** is AFK: ${entry.reason} (${ts(Number(entry.since))})`);
      }
      if (notes.length) await message.reply({ content: truncate(notes.slice(0, 5).join('\n'), 1500), allowedMentions: { parse: [] } }).catch(noop);
    },
  },
};

export const birthdaysModule = {
  name: 'birthdays',
  defaults: { enabled: false, channel: null, role: null, message: 'Happy birthday {user}! 🎂', lastRun: null },
  form: {
    title: 'Birthdays',
    description: 'Members save their date with /birthday set.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Announce birthdays' },
      { key: 'channel', type: 'channel', label: 'Announcement channel' },
      { key: 'role', type: 'role', label: 'Role for the day', assignable: true },
      { key: 'message', type: 'textarea', label: 'Message', max: 1000 },
    ],
  },
};
