import { AttachmentBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { lineChart } from '../core/cards.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate, respond } from '../core/ui.js';
import { dayKey, fmt, noop, render, truncate } from '../core/util.js';

const FLUSH_MS = 30_000;
// Discord allows two renames per channel per ten minutes.
const COUNTER_MS = 10 * 60_000;
const TYPES = {
  members: 'Members: {count}', humans: 'Humans: {count}', bots: 'Bots: {count}', online: 'Online: {count}', boosts: 'Boosts: {count}',
  channels: 'Channels: {count}', roles: 'Roles: {count}', voice: 'In voice: {count}', goal: 'Goal: {count}',
};
const METRICS = { members: 'Member count', joins: 'Joins', leaves: 'Leaves', messages: 'Messages', voice_minutes: 'Voice minutes' };
const pending = new Map();

/** Counts are buffered in memory and written in batches, so chat volume never hammers the database. */
export function bump(guildId, field, amount = 1) {
  const key = `${guildId}|${dayKey()}`;
  const entry = pending.get(key) ?? { joins: 0, leaves: 0, messages: 0, voice_minutes: 0 };
  entry[field] += amount;
  pending.set(key, entry);
}

export async function flushStats(client) {
  const batch = [...pending];
  pending.clear();
  for (const [key, e] of batch) {
    const [guildId, day] = key.split('|');
    const members = client?.guilds.cache.get(guildId)?.memberCount ?? null;
    await db.run(
      `INSERT INTO stats_daily(guild_id, day, joins, leaves, messages, voice_minutes, member_count) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id, day) DO UPDATE SET joins = stats_daily.joins + $3, leaves = stats_daily.leaves + $4, messages = stats_daily.messages + $5,
         voice_minutes = stats_daily.voice_minutes + $6, member_count = COALESCE($7, stats_daily.member_count)`,
      [guildId, day, e.joins, e.leaves, e.messages, e.voice_minutes, members],
    );
  }
}

export function counterValue(guild, type, goal = 0) {
  const members = guild.members.cache;
  switch (type) {
    case 'members': return guild.memberCount;
    case 'humans': return members.filter((m) => !m.user.bot).size;
    case 'bots': return members.filter((m) => m.user.bot).size;
    case 'online': return guild.presences.cache.filter((p) => p.status !== 'offline').size;
    case 'boosts': return guild.premiumSubscriptionCount ?? 0;
    case 'channels': return guild.channels.cache.size;
    case 'roles': return guild.roles.cache.size - 1;
    case 'voice': return guild.voiceStates.cache.filter((v) => v.channelId).size;
    case 'goal': return `${fmt(guild.memberCount)}/${fmt(goal)}`;
    default: return 0;
  }
}

async function updateCounters(guild) {
  const { counters, goal } = getSettings(guild.id).stats;
  for (const counter of counters) {
    const channel = guild.channels.cache.get(counter.channelId);
    if (!channel) continue;
    const value = counterValue(guild, counter.type, goal);
    const name = truncate(render(counter.template || TYPES[counter.type], { count: typeof value === 'number' ? fmt(value) : value }), 100);
    if (channel.name !== name) await channel.setName(name, 'Stat counter').catch((err) => logger.warn(`Counter update failed: ${err.message}`));
  }
}

async function createCounter(guild, type, template, parent) {
  const everyone = guild.roles.everyone;
  const value = counterValue(guild, type, getSettings(guild.id).stats.goal);
  const name = truncate(render(template || TYPES[type], { count: typeof value === 'number' ? fmt(value) : value }), 100);
  const channel = await guild.channels.create({
    name, type: ChannelType.GuildVoice, parent,
    permissionOverwrites: [
      { id: everyone.id, deny: [P.Connect] },
      { id: guild.members.me.id, allow: [P.Connect, P.ManageChannels, P.ViewChannel] },
    ],
    reason: 'Stat counter',
  });
  return { channelId: channel.id, type, template: template ?? null };
}

export async function setupDefaultCounters(guild) {
  const category = await guild.channels.create({ name: '📊 Server Stats', type: ChannelType.GuildCategory, reason: 'Stat counters' });
  const counters = [];
  for (const type of ['members', 'humans', 'bots']) counters.push(await createCounter(guild, type, null, category.id));
  await updateSettings(guild.id, (s) => { s.stats.counters.push(...counters); });
  return `Created ${counters.length} stat counters.`;
}

export async function dailyStats(guildId, days) {
  const since = dayKey(Date.now() - days * 864e5);
  return db.all('SELECT * FROM stats_daily WHERE guild_id = $1 AND day >= $2 ORDER BY day', [guildId, since]);
}

export default {
  name: 'stats',
  label: '📊 Server Stats',
  defaults: { counters: [], goal: 1000 },
  form: {
    title: 'Server stats',
    description: 'Voice channels whose names show live numbers. Discord limits renames, so they refresh every 10 minutes.',
    fields: [
      { key: 'goal', type: 'int', label: 'Member goal', min: 1, max: 100000000 },
      {
        key: 'counters', type: 'rows', label: 'Counters', max: 15,
        columns: [
          { key: 'channelId', type: 'channel', label: 'Voice channel', channelKind: 'voice' },
          { key: 'type', type: 'select', label: 'Shows', options: Object.keys(TYPES) },
          { key: 'template', type: 'text', label: 'Name template', max: 90, placeholder: 'Members: {count}', optional: true },
        ],
      },
    ],
    actions: [{ id: 'setup', label: 'Create default counters' }],
  },
  actions: { setup: (guild) => setupDefaultCounters(guild) },

  commands: [{
    data: cmd('stats', 'Server statistics')
      .addSubcommand((s) => s.setName('overview').setDescription('Last 7 days at a glance'))
      .addSubcommand((s) => s.setName('graph').setDescription('Draw a chart')
        .addStringOption((o) => o.setName('metric').setDescription('What to chart').setRequired(true).addChoices(...Object.entries(METRICS).map(([value, name]) => ({ name, value }))))
        .addIntegerOption((o) => o.setName('days').setDescription('How far back').setMinValue(2).setMaxValue(90)))
      .addSubcommand((s) => s.setName('setup').setDescription('Create default counter channels (Manage Server)'))
      .addSubcommand((s) => s.setName('add').setDescription('Add a counter channel (Manage Server)')
        .addStringOption((o) => o.setName('type').setDescription('What it shows').setRequired(true).addChoices(...Object.keys(TYPES).map((v) => ({ name: v, value: v }))))
        .addStringOption((o) => o.setName('template').setDescription('Name, using {count}').setMaxLength(90)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a counter channel (Manage Server)')
        .addChannelOption((o) => o.setName('channel').setDescription('Counter channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice)))
      .addSubcommand((s) => s.setName('goal').setDescription('Set the member goal (Manage Server)')
        .addIntegerOption((o) => o.setName('members').setDescription('Goal').setRequired(true).setMinValue(1).setMaxValue(100_000_000)))
      .addSubcommand((s) => s.setName('list').setDescription('List counters')),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'overview') {
        const rows = await dailyStats(i.guildId, 7);
        const sum = (k) => rows.reduce((total, r) => total + r[k], 0);
        return respond(i, {
          embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle(`${i.guild.name}: last 7 days`).addFields(
            { name: 'Members', value: fmt(i.guild.memberCount), inline: true }, { name: 'Joins', value: fmt(sum('joins')), inline: true },
            { name: 'Leaves', value: fmt(sum('leaves')), inline: true }, { name: 'Messages', value: fmt(sum('messages')), inline: true },
            { name: 'Voice minutes', value: fmt(sum('voice_minutes')), inline: true },
          )],
        });
      }
      if (sub === 'graph') {
        const metric = i.options.getString('metric', true);
        await i.deferReply();
        await flushStats(i.client);
        const rows = await dailyStats(i.guildId, i.options.getInteger('days') ?? 30);
        const usable = metric === 'members' ? rows.filter((r) => r.member_count !== null) : rows;
        if (!usable.length) return fail(i, 'No data yet. Check back after the bot has been running for a while.');
        const png = await lineChart({
          title: METRICS[metric], labels: usable.map((r) => r.day.slice(5)),
          values: usable.map((r) => (metric === 'members' ? r.member_count : r[metric])),
        });
        return i.editReply({ files: [new AttachmentBuilder(png, { name: 'stats.png' })] });
      }
      if (sub === 'list') {
        const { counters } = getSettings(i.guildId).stats;
        return okPrivate(i, counters.map((c) => `<#${c.channelId}>: ${c.type}`).join('\n') || 'No counters yet. Try `/stats setup`.');
      }
      if (!i.memberPermissions.has(P.ManageGuild)) return fail(i, 'You need Manage Server to do that.');
      if (sub === 'goal') {
        const goal = i.options.getInteger('members', true);
        await updateSettings(i.guildId, (s) => { s.stats.goal = goal; });
        return ok(i, `Member goal set to **${fmt(goal)}**.`);
      }
      if (!i.guild.members.me.permissions.has(P.ManageChannels)) return fail(i, 'I need Manage Channels to do that.');
      await i.deferReply({ flags: EPHEMERAL });
      if (sub === 'setup') return ok(i, await setupDefaultCounters(i.guild));
      if (sub === 'add') {
        const counter = await createCounter(i.guild, i.options.getString('type', true), i.options.getString('template'), undefined);
        await updateSettings(i.guildId, (s) => { s.stats.counters.push(counter); });
        return ok(i, `Counter <#${counter.channelId}> created.`);
      }
      const channel = i.options.getChannel('channel', true);
      const isCounter = getSettings(i.guildId).stats.counters.some((c) => c.channelId === channel.id);
      if (!isCounter) return fail(i, 'That channel is not a counter.');
      await updateSettings(i.guildId, (s) => { s.stats.counters = s.stats.counters.filter((c) => c.channelId !== channel.id); });
      await channel.delete('Counter removed').catch(noop);
      return ok(i, 'Counter removed.');
    },
  }],

  async ready(client) {
    setInterval(() => flushStats(client).catch((err) => logger.error('Stats flush failed', err)), FLUSH_MS).unref?.();
    // Fetched once so human/bot counts are right; gateway events keep the cache current afterwards.
    for (const guild of client.guilds.cache.values()) await guild.members.fetch().catch((err) => logger.warn(`Member fetch failed: ${err.message}`));
    const refresh = async () => {
      for (const guild of client.guilds.cache.values()) await updateCounters(guild).catch((err) => logger.warn(`Counters failed: ${err.message}`));
    };
    await refresh();
    setInterval(refresh, COUNTER_MS).unref?.();
  },

  shutdown: (client) => flushStats(client),

  events: {
    messageCreate(message) {
      if (message.guild && !message.author.bot) bump(message.guild.id, 'messages');
    },
    guildMemberAdd: (member) => bump(member.guild.id, 'joins'),
    guildMemberRemove: (member) => bump(member.guild.id, 'leaves'),
  },
};
