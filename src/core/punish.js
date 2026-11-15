import { EmbedBuilder } from 'discord.js';
import { db, nextCounter } from './db.js';
import { jobs } from './jobs.js';
import { getSettings } from './settings.js';
import { COLOR, sendTo } from './ui.js';
import { formatDuration, noop } from './util.js';

const MAX_TIMEOUT = 28 * 864e5;
const LABEL = {
  warn: 'Warn', timeout: 'Timeout', untimeout: 'Timeout removed', kick: 'Kick', ban: 'Ban', softban: 'Softban', unban: 'Unban',
};
const CASE_COLOR = { warn: COLOR.warn, timeout: 0xe67e22, kick: 0xe67e22, ban: COLOR.err, softban: COLOR.err };
const DM_VERB = { warn: 'warned in', timeout: 'timed out in', kick: 'kicked from', ban: 'banned from', softban: 'kicked from' };

export async function addCase(guildId, data) {
  const caseId = await nextCounter(guildId, 'case');
  return db.one(
    `INSERT INTO cases(guild_id, case_id, type, user_id, user_tag, mod_id, reason, duration, created_at, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [guildId, caseId, data.type, data.userId, data.userTag ?? null, data.modId, data.reason ?? null, data.duration ?? null, Date.now(), data.type === 'warn'],
  );
}

export const getCase = (guildId, caseId) => db.one('SELECT * FROM cases WHERE guild_id = $1 AND case_id = $2', [guildId, caseId]);
export const activeWarnings = (guildId, userId) =>
  db.all("SELECT * FROM cases WHERE guild_id = $1 AND user_id = $2 AND type = 'warn' AND active ORDER BY case_id DESC", [guildId, userId]);

export function caseEmbed(row) {
  const e = new EmbedBuilder()
    .setColor(CASE_COLOR[row.type] ?? COLOR.ok)
    .setTitle(`Case #${row.case_id} | ${LABEL[row.type] ?? row.type}`)
    .addFields(
      { name: 'User', value: `<@${row.user_id}> (${row.user_tag ?? 'unknown'}, \`${row.user_id}\`)` },
      { name: 'Moderator', value: `<@${row.mod_id}>`, inline: true },
    )
    .setTimestamp(row.created_at);
  if (row.duration) e.addFields({ name: 'Duration', value: formatDuration(row.duration), inline: true });
  e.addFields({ name: 'Reason', value: row.reason || 'No reason provided' });
  return e;
}

async function runAction(guild, { action, user, member, reason, durationMs, deleteSeconds }) {
  switch (action) {
    case 'warn':
      return;
    case 'timeout':
      return member.timeout(Math.min(durationMs, MAX_TIMEOUT), reason);
    case 'untimeout':
      return member.timeout(null, reason);
    case 'kick':
      return member.kick(reason);
    case 'ban':
      await guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteSeconds });
      if (durationMs) await jobs.schedule('mod:unban', guild.id, Date.now() + durationMs, { userId: user.id }, user.id);
      else await jobs.cancel('mod:unban', guild.id, user.id);
      return;
    case 'softban':
      await guild.members.ban(user.id, { reason, deleteMessageSeconds: 86400 });
      return guild.members.unban(user.id, 'Softban release');
    case 'unban':
      await jobs.cancel('mod:unban', guild.id, user.id);
      return guild.members.unban(user.id, reason);
    default:
      throw new Error(`Unknown punishment: ${action}`);
  }
}

/** The single path for every moderation action: DM, act, record a case, log it, escalate. */
export async function punish(guild, opts) {
  const { action, user, moderator, durationMs = null, deleteSeconds = 0 } = opts;
  const reason = opts.reason || 'No reason provided';
  const cfg = getSettings(guild.id).moderation;
  const member = opts.member ?? (await guild.members.fetch(user.id).catch(() => null));
  if (['timeout', 'untimeout', 'kick'].includes(action) && !member) throw new Error('That user is not in this server.');

  // Has to happen before a kick or ban, when the bot and the user stop sharing a server.
  if (cfg.dmUsers && DM_VERB[action]) {
    const lines = [`You were **${DM_VERB[action]}** **${guild.name}**.`, `**Reason:** ${reason}`];
    if (durationMs) lines.push(`**Duration:** ${formatDuration(durationMs)}`);
    await user.send({ embeds: [new EmbedBuilder().setColor(CASE_COLOR[action] ?? COLOR.brand).setDescription(lines.join('\n'))] }).catch(noop);
  }

  await runAction(guild, { action, user, member, durationMs, deleteSeconds, reason: `${moderator.username}: ${reason}`.slice(0, 512) });

  const row = await addCase(guild.id, { type: action, userId: user.id, userTag: user.username, modId: moderator.id, reason, duration: durationMs });
  await sendTo(guild, cfg.logChannel, { embeds: [caseEmbed(row)], allowedMentions: { parse: [] } });

  if (action === 'warn') await escalate(guild, user, member, moderator, cfg);
  return row;
}

async function escalate(guild, user, member, moderator, cfg) {
  const count = (await activeWarnings(guild.id, user.id)).length;
  const rule = cfg.warnActions.find((r) => r.count === count);
  if (!rule || (rule.action !== 'ban' && !member)) return;
  await punish(guild, {
    action: rule.action, user, member, moderator, durationMs: rule.durationMs ?? null,
    reason: `Automatic: reached ${count} warnings`,
  });
}
