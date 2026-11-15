import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, fail, ok, respond, sendTo } from '../core/ui.js';
import { fmt } from '../core/util.js';

const FAKE_ACCOUNT_DAYS = 7;
const uses = new Map();
const joinInfo = new Map();

async function snapshot(guild) {
  if (!guild.members.me?.permissions.has(P.ManageGuild)) return;
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) uses.set(guild.id, new Map(invites.map((inv) => [inv.code, inv.uses ?? 0])));
}

/** Who invited a member who has just joined, for the welcome message. */
export const consumeJoinInfo = (guildId, userId) => {
  const key = `${guildId}:${userId}`;
  const info = joinInfo.get(key) ?? null;
  joinInfo.delete(key);
  return info;
};

export async function inviteStats(guildId, userId) {
  const row = await db.one(
    `SELECT COUNT(*) FILTER (WHERE NOT fake AND left_at IS NULL) AS real,
            COUNT(*) FILTER (WHERE left_at IS NOT NULL) AS gone, COUNT(*) FILTER (WHERE fake) AS fake
     FROM invite_log WHERE guild_id = $1 AND inviter_id = $2`,
    [guildId, userId],
  );
  return row;
}

function logInvite(guild, color, title, lines) {
  return sendTo(guild, getSettings(guild.id).invites.logChannel, {
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n')).setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

async function inviterLines(guildId, inviterId, code) {
  if (!inviterId) return ['**Invited by:** unknown (a vanity link, or an invite that no longer exists)'];
  const { real } = await inviteStats(guildId, inviterId);
  return [`**Invited by:** <@${inviterId}>`, ...(code ? [`**Invite code:** \`${code}\``] : []), `**Their invites now:** ${fmt(real)}`];
}

export default {
  name: 'invites',
  label: '📨 Invite Tracker',
  defaults: { logChannel: null },
  form: {
    title: 'Invite logs',
    description: 'Posts who joined and who invited them, how many invites that person has, and who left.',
    fields: [{ key: 'logChannel', type: 'channel', label: 'Invite log channel', help: 'Leave empty to turn invite logs off.' }],
  },

  commands: [{
    data: cmd('invites', 'See how many people someone has invited')
      .addSubcommand((s) => s.setName('check').setDescription('Show invite stats')
        .addUserOption((o) => o.setName('user').setDescription('Defaults to you')))
      .addSubcommand((s) => s.setName('leaderboard').setDescription('Top inviters'))
      .addSubcommand((s) => s.setName('log').setDescription('Set the invite log channel (Manage Server)')
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn invite logs off').addChannelTypes(ChannelType.GuildText))),
    async run(i) {
      if (i.options.getSubcommand() === 'log') {
        if (!i.memberPermissions.has(P.ManageGuild)) return fail(i, 'You need Manage Server to do that.');
        const channel = i.options.getChannel('channel');
        await updateSettings(i.guildId, (s) => { s.invites.logChannel = channel?.id ?? null; });
        return ok(i, channel ? `Invite logs will be posted in ${channel}.` : 'Invite logs turned off.');
      }
      if (i.options.getSubcommand() === 'leaderboard') {
        const rows = await db.all(
          `SELECT inviter_id, COUNT(*) AS n FROM invite_log
           WHERE guild_id = $1 AND inviter_id IS NOT NULL AND NOT fake AND left_at IS NULL
           GROUP BY inviter_id ORDER BY n DESC LIMIT 10`,
          [i.guildId],
        );
        const body = rows.map((r, n) => `**${n + 1}.** <@${r.inviter_id}>: ${fmt(r.n)}`).join('\n') || 'No invites tracked yet.';
        return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle('Top inviters').setDescription(body)], allowedMentions: { parse: [] } });
      }
      const user = i.options.getUser('user') ?? i.user;
      const s = await inviteStats(i.guildId, user.id);
      return respond(i, {
        embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle(`Invites: ${user.username}`)
          .setDescription(`**${fmt(s.real)}** current\n${fmt(s.gone)} left\n${fmt(s.fake)} fake (brand-new accounts)`)],
      });
    },
  }],

  async ready(client) {
    for (const guild of client.guilds.cache.values()) await snapshot(guild);
  },

  events: {
    guildCreate: snapshot,
    inviteCreate(invite) {
      if (invite.guild) uses.get(invite.guild.id)?.set(invite.code, invite.uses ?? 0);
    },
    inviteDelete(invite) {
      if (invite.guild) uses.get(invite.guild.id)?.delete(invite.code);
    },
    async guildMemberAdd(member) {
      const { guild, user } = member;
      if (user.bot) return;
      const previous = uses.get(guild.id);
      const current = await guild.invites.fetch().catch(() => null);
      if (!current) return;
      uses.set(guild.id, new Map(current.map((inv) => [inv.code, inv.uses ?? 0])));
      const used = previous && current.find((inv) => (inv.uses ?? 0) > (previous.get(inv.code) ?? 0));
      const inviterId = used?.inviterId ?? null;
      const fake = Date.now() - user.createdTimestamp < FAKE_ACCOUNT_DAYS * 864e5;
      await db.run(
        `INSERT INTO invite_log(guild_id, user_id, inviter_id, code, joined_at, fake) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET inviter_id = $3, code = $4, joined_at = $5, fake = $6, left_at = NULL`,
        [guild.id, user.id, inviterId, used?.code ?? null, Date.now(), fake],
      );
      const key = `${guild.id}:${user.id}`;
      joinInfo.set(key, { inviterId, code: used?.code ?? null });
      setTimeout(() => joinInfo.delete(key), 30_000).unref?.();
      if (!getSettings(guild.id).invites.logChannel) return;
      await logInvite(guild, COLOR.ok, 'Member joined', [
        `<@${user.id}> (\`${user.username}\`)`,
        ...await inviterLines(guild.id, inviterId, used?.code),
        ...(fake ? ['⚠️ Brand-new account, so this is not counted as a real invite'] : []),
      ]);
    },
    async guildMemberRemove(member) {
      const { guild, user } = member;
      await db.run('UPDATE invite_log SET left_at = $1 WHERE guild_id = $2 AND user_id = $3', [Date.now(), guild.id, member.id]);
      if (user.bot || !getSettings(guild.id).invites.logChannel) return;
      const row = await db.one('SELECT inviter_id FROM invite_log WHERE guild_id = $1 AND user_id = $2', [guild.id, member.id]);
      await logInvite(guild, COLOR.err, 'Member left', [`<@${user.id}> (\`${user.username}\`)`, ...await inviterLines(guild.id, row?.inviter_id ?? null)]);
    },
  },
};
