import { randomInt } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { withImage } from '../core/images.js';
import { jobs } from '../core/jobs.js';
import { logger } from '../core/logger.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate, respond } from '../core/ui.js';
import { fmt, noop, parseDuration, ts } from '../core/util.js';
import { levelFromXp } from './leveling.js';

const MAX_DURATION = 60 * 864e5;
const BONUS_WEIGHT = 2;
const refreshing = new Set();

export const getGiveaway = (guildId, id) => db.one('SELECT * FROM giveaways WHERE guild_id = $1 AND id = $2', [guildId, id]);
const entryCount = async (id) => (await db.one('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = $1', [id])).n;

/** Removes and returns one weighted random entry. */
export function drawOne(pool) {
  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  let roll = randomInt(total);
  for (let n = 0; n < pool.length; n += 1) {
    roll -= pool[n].weight;
    if (roll < 0) return pool.splice(n, 1)[0];
  }
  return pool.pop();
}

function requirementLines(req) {
  const lines = [];
  if (req.roleId) lines.push(`Must have <@&${req.roleId}>`);
  if (req.minLevel) lines.push(`Must be level ${req.minLevel}+`);
  if (req.minAccountDays) lines.push(`Account at least ${req.minAccountDays} days old`);
  if (req.bonusRoleId) lines.push(`<@&${req.bonusRoleId}> gets double entries`);
  return lines;
}

function giveawayMessage(g, entries) {
  const req = requirementLines(g.requirements);
  const e = new EmbedBuilder().setColor(g.ended ? 0x747f8d : COLOR.gold).setTitle(`🎉 ${g.prize}`);
  const lines = [];
  if (g.description) lines.push(g.description, '');
  if (g.drop_mode) lines.push(g.ended ? 'This drop has been claimed.' : '**First person to click wins!**');
  else if (g.ended) lines.push(g.winner_ids.length ? `**Winners:** ${g.winner_ids.map((id) => `<@${id}>`).join(', ')}` : 'No valid entries.');
  else lines.push(`**Ends:** ${ts(g.ends_at)}`, `**Winners:** ${g.winners}`);
  lines.push(`**Hosted by:** <@${g.host_id}>`);
  if (!g.drop_mode) lines.push(`**Entries:** ${fmt(entries)}`);
  if (req.length && !g.ended) lines.push('', '**Requirements**', ...req.map((r) => `• ${r}`));
  e.setDescription(lines.join('\n')).setFooter({ text: `Giveaway #${g.id}` });
  const button = new ButtonBuilder().setCustomId(g.drop_mode ? `gw:claim:${g.id}` : `gw:enter:${g.id}`)
    .setLabel(g.drop_mode ? 'Claim' : 'Enter').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(Boolean(g.ended));
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

async function editMessage(guild, g) {
  const channel = guild.channels.cache.get(g.channel_id);
  const message = await channel?.messages.fetch(g.message_id).catch(() => null);
  if (message) await message.edit(giveawayMessage(g, await entryCount(g.id)));
  return message;
}

function scheduleRefresh(guild, id) {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  // Batches rapid clicks into one edit so a popular giveaway does not hit rate limits.
  setTimeout(async () => {
    refreshing.delete(id);
    const g = await getGiveaway(guild.id, id).catch(() => null);
    if (g && !g.ended) await editMessage(guild, g).catch(noop);
  }, 4000).unref?.();
}

export async function startGiveaway(guild, channel, { hostId, prize, description = null, winners = 1, durationMs = null, drop = false, requirements = {} }) {
  const endsAt = drop ? null : Date.now() + durationMs;
  const g = await db.one(
    `INSERT INTO giveaways(guild_id, channel_id, host_id, prize, description, winners, ends_at, drop_mode, requirements)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [guild.id, channel.id, hostId, prize, description, winners, endsAt, drop, JSON.stringify(requirements)],
  );
  const message = await channel.send(await withImage(guild.id, 'giveaway', giveawayMessage(g, 0), { inEmbed: false }));
  await db.run('UPDATE giveaways SET message_id = $1 WHERE id = $2', [message.id, g.id]);
  if (!drop) await jobs.schedule('giveaway:end', guild.id, endsAt, { id: g.id }, String(g.id));
  return { ...g, message_id: message.id };
}

async function pickWinners(guild, id, count, exclude = []) {
  const pool = (await db.all('SELECT user_id, weight FROM giveaway_entries WHERE giveaway_id = $1', [id])).filter((e) => !exclude.includes(e.user_id));
  const winners = [];
  while (winners.length < count && pool.length) {
    const entry = drawOne(pool);
    if (await guild.members.fetch(entry.user_id).catch(() => null)) winners.push(entry.user_id);
  }
  return winners;
}

async function announce(guild, g, winners, reroll = false) {
  const channel = guild.channels.cache.get(g.channel_id);
  if (!channel) return;
  const mentions = winners.map((id) => `<@${id}>`).join(', ');
  const content = winners.length
    ? `🎉 ${reroll ? 'New winner' : 'Congratulations'} ${mentions}! You won **${g.prize}**.`
    : `Nobody entered the giveaway for **${g.prize}**.`;
  await channel.send({ content, allowedMentions: { users: winners }, reply: g.message_id ? { messageReference: g.message_id, failIfNotExists: false } : undefined });
}

export async function endGiveaway(guild, id) {
  // Flipping `ended` atomically means a manual /end and the timer cannot both draw winners.
  const claimed = await db.one('UPDATE giveaways SET ended = TRUE WHERE guild_id = $1 AND id = $2 AND NOT ended RETURNING *', [guild.id, id]);
  if (!claimed) return null;
  await jobs.cancel('giveaway:end', guild.id, String(id));
  const winners = await pickWinners(guild, id, claimed.winners);
  await db.run('UPDATE giveaways SET winner_ids = $1 WHERE id = $2', [JSON.stringify(winners), id]);
  const g = { ...claimed, winner_ids: winners };
  await editMessage(guild, g);
  await announce(guild, g, winners);
  return g;
}

export async function cancelGiveaway(guild, id) {
  const g = await getGiveaway(guild.id, id);
  if (!g) return 0;
  await jobs.cancel('giveaway:end', guild.id, String(id));
  await guild.channels.cache.get(g.channel_id)?.messages.delete(g.message_id).catch(noop);
  await db.run('DELETE FROM giveaway_entries WHERE giveaway_id = $1', [id]);
  return db.run('DELETE FROM giveaways WHERE id = $1', [id]);
}

async function requirementError(i, req) {
  if (req.roleId && !i.member.roles.cache.has(req.roleId)) return `You need <@&${req.roleId}> to enter.`;
  if (req.minAccountDays && Date.now() - i.user.createdTimestamp < req.minAccountDays * 864e5) return `Your account must be at least ${req.minAccountDays} days old.`;
  if (req.minLevel) {
    const row = await db.one('SELECT xp FROM members WHERE guild_id = $1 AND user_id = $2', [i.guildId, i.user.id]);
    if (levelFromXp(row?.xp ?? 0) < req.minLevel) return `You need to be level ${req.minLevel} to enter.`;
  }
  return null;
}

const idOption = (o) => o.setName('id').setDescription('Giveaway number (in the footer)').setRequired(true).setMinValue(1);

export default {
  name: 'giveaways',
  label: '🎉 Giveaways',

  collections: {
    giveaways: {
      title: 'Giveaways',
      description: 'Running giveaways. Removing one cancels it without drawing a winner.',
      columns: [
        { key: 'prize', label: 'Prize', type: 'text', max: 200, required: true },
        { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
        { key: 'winners', label: 'Winners', type: 'int', min: 1, max: 20, required: true },
        { key: 'duration', label: 'Duration', type: 'text', max: 10, required: true, placeholder: '1d', createOnly: true },
      ],
      list: async (guildId) => {
        const rows = await db.all('SELECT id, prize, channel_id, winners, ends_at FROM giveaways WHERE guild_id = $1 AND NOT ended ORDER BY ends_at', [guildId]);
        return rows.map((r) => ({ ...r, duration: r.ends_at ? new Date(r.ends_at).toISOString() : 'drop' }));
      },
      async create(guild, row, userId) {
        const durationMs = parseDuration(row.duration);
        if (!durationMs || durationMs > MAX_DURATION) throw new Error('Duration must look like 30m, 12h or 7d, and be at most 60 days.');
        const channel = guild.channels.cache.get(row.channel_id);
        return startGiveaway(guild, channel, { hostId: userId, prize: row.prize, winners: row.winners, durationMs });
      },
      remove: (guild, id) => cancelGiveaway(guild, id),
    },
  },

  commands: [{
    data: cmd('giveaway', 'Run giveaways', P.ManageGuild)
      .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('duration').setDescription('For example 30m, 12h, 7d').setRequired(true))
        .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
        .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('description').setDescription('Extra text').setMaxLength(1000))
        .addRoleOption((o) => o.setName('required_role').setDescription('Only this role may enter'))
        .addRoleOption((o) => o.setName('bonus_role').setDescription('This role gets double entries'))
        .addIntegerOption((o) => o.setName('min_level').setDescription('Minimum level').setMinValue(1).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('min_account_days').setDescription('Minimum account age in days').setMinValue(1).setMaxValue(3650)))
      .addSubcommand((s) => s.setName('drop').setDescription('First person to click wins')
        .addStringOption((o) => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('reroll').setDescription('Pick new winners').addIntegerOption(idOption)
        .addIntegerOption((o) => o.setName('winners').setDescription('How many to draw').setMinValue(1).setMaxValue(20)))
      .addSubcommand((s) => s.setName('cancel').setDescription('Delete a giveaway without a winner').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('list').setDescription('List running giveaways')),
    botPerms: [P.SendMessages, P.EmbedLinks],
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const rows = await db.all('SELECT * FROM giveaways WHERE guild_id = $1 AND NOT ended ORDER BY id', [i.guildId]);
        return okPrivate(i, rows.map((g) => `**#${g.id}** ${g.prize} in <#${g.channel_id}>${g.ends_at ? `, ends ${ts(g.ends_at)}` : ' (drop)'}`).join('\n') || 'No giveaways running.');
      }
      if (sub === 'start' || sub === 'drop') {
        const channel = i.options.getChannel('channel') ?? i.channel;
        const prize = i.options.getString('prize', true);
        if (sub === 'drop') {
          await startGiveaway(i.guild, channel, { hostId: i.user.id, prize, drop: true });
          return ok(i, `Drop posted in ${channel}.`, { flags: EPHEMERAL });
        }
        const durationMs = parseDuration(i.options.getString('duration', true));
        if (!durationMs || durationMs > MAX_DURATION) return fail(i, 'Duration must look like `30m`, `12h` or `7d`, and be at most 60 days.');
        const requirements = {
          roleId: i.options.getRole('required_role')?.id, bonusRoleId: i.options.getRole('bonus_role')?.id,
          minLevel: i.options.getInteger('min_level') ?? undefined, minAccountDays: i.options.getInteger('min_account_days') ?? undefined,
        };
        const g = await startGiveaway(i.guild, channel, {
          hostId: i.user.id, prize, durationMs, requirements, winners: i.options.getInteger('winners') ?? 1, description: i.options.getString('description'),
        });
        return ok(i, `Giveaway **#${g.id}** started in ${channel}.`, { flags: EPHEMERAL });
      }
      const id = i.options.getInteger('id', true);
      const g = await getGiveaway(i.guildId, id);
      if (!g) return fail(i, 'No giveaway with that number.');
      if (sub === 'cancel') {
        await cancelGiveaway(i.guild, id);
        return ok(i, `Giveaway #${id} cancelled.`);
      }
      await i.deferReply({ flags: EPHEMERAL });
      if (sub === 'end') {
        if (g.ended) return fail(i, 'That giveaway already ended.');
        await endGiveaway(i.guild, id);
        return ok(i, `Giveaway #${id} ended.`);
      }
      if (!g.ended || g.drop_mode) return fail(i, 'You can only reroll a finished giveaway.');
      const winners = await pickWinners(i.guild, id, i.options.getInteger('winners') ?? 1, g.winner_ids);
      if (!winners.length) return fail(i, 'There are no other entries to draw from.');
      const updated = { ...g, winner_ids: [...g.winner_ids, ...winners] };
      await db.run('UPDATE giveaways SET winner_ids = $1 WHERE id = $2', [JSON.stringify(updated.winner_ids), id]);
      await announce(i.guild, updated, winners, true);
      return respond(i, { content: 'Rerolled.' });
    },
  }],

  components: {
    async 'gw:enter'(i, [id]) {
      const g = await getGiveaway(i.guildId, id);
      if (!g || g.ended) return fail(i, 'This giveaway has ended.');
      const already = await db.one('SELECT 1 AS yes FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2', [id, i.user.id]);
      if (already) {
        return i.reply({
          content: 'You are already entered.',
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gw:leave:${id}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger))],
          flags: EPHEMERAL,
        });
      }
      const problem = await requirementError(i, g.requirements);
      if (problem) return fail(i, problem);
      const weight = g.requirements.bonusRoleId && i.member.roles.cache.has(g.requirements.bonusRoleId) ? BONUS_WEIGHT : 1;
      await db.run('INSERT INTO giveaway_entries(giveaway_id, user_id, weight) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, i.user.id, weight]);
      scheduleRefresh(i.guild, g.id);
      return okPrivate(i, weight > 1 ? 'You are in, with double entries. Good luck!' : 'You are in. Good luck!');
    },
    async 'gw:leave'(i, [id]) {
      await db.run('DELETE FROM giveaway_entries WHERE giveaway_id = $1 AND user_id = $2', [id, i.user.id]);
      scheduleRefresh(i.guild, Number(id));
      return i.update({ content: 'You left the giveaway.', components: [] });
    },
    async 'gw:claim'(i, [id]) {
      const g = await db.one('UPDATE giveaways SET ended = TRUE, winner_ids = $1 WHERE guild_id = $2 AND id = $3 AND NOT ended AND drop_mode RETURNING *', [JSON.stringify([i.user.id]), i.guildId, id]);
      if (!g) return fail(i, 'Too late, someone already claimed it.');
      await i.update(giveawayMessage(g, 1));
      return i.followUp({ content: `🎉 ${i.user} claimed **${g.prize}**!`, allowedMentions: { users: [i.user.id] } });
    },
  },

  jobs: {
    async 'giveaway:end'(client, { id }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (guild) await endGiveaway(guild, id).catch((err) => { logger.error(`Giveaway ${id} end failed`, err); throw err; });
    },
  },
};
