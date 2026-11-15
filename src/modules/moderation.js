import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { activeWarnings, caseEmbed, getCase, punish } from '../core/punish.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate, respond, roleError } from '../core/ui.js';
import { formatDuration, parseDuration, truncate, ts } from '../core/util.js';

const withReason = (o) => o.setName('reason').setDescription('Reason for this action').setMaxLength(400);
const MAX_TIMEOUT = 28 * 864e5;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function targetError(i, user, member) {
  if (user.id === i.user.id) return 'You cannot do that to yourself.';
  if (user.id === i.client.user.id) return 'I cannot do that to myself.';
  if (user.id === i.guild.ownerId) return 'You cannot do that to the server owner.';
  if (!member) return null;
  if (i.user.id !== i.guild.ownerId && member.roles.highest.position >= i.member.roles.highest.position) {
    return 'That member has a role equal to or above yours.';
  }
  if (member.roles.highest.position >= i.guild.members.me.roles.highest.position) {
    return 'That member has a role equal to or above mine. Move my role higher.';
  }
  return null;
}

/** Shared flow for ban/kick/timeout/warn style commands. */
async function act(i, action, { durationMs = null, deleteSeconds = 0, verb }) {
  const user = i.options.getUser('user', true);
  const member = i.options.getMember('user');
  const problem = targetError(i, user, member);
  if (problem) return fail(i, problem);
  if (['kick', 'timeout', 'untimeout'].includes(action) && !member) return fail(i, 'That user is not in this server.');
  await i.deferReply();
  const row = await punish(i.guild, {
    action, user, member, durationMs, deleteSeconds, moderator: i.user,
    reason: i.options.getString('reason') ?? undefined,
  });
  const extra = durationMs ? ` for **${formatDuration(durationMs)}**` : '';
  return ok(i, `**${user.username}** was ${verb}${extra}. (Case #${row.case_id})`);
}

const caseLine = (c) => `**#${c.case_id}** ${c.type} ${ts(c.created_at)} by <@${c.mod_id}>\n> ${truncate(c.reason || 'No reason', 120)}`;

export default {
  name: 'moderation',
  label: '🔨 Moderation',
  defaults: { logChannel: null, dmUsers: true, warnActions: [] },
  form: {
    title: 'Moderation',
    description: 'Where cases are logged and how members are told about them.',
    fields: [
      { key: 'logChannel', type: 'channel', label: 'Case log channel', help: 'Every ban, kick, timeout and warning is posted here.' },
      { key: 'dmUsers', type: 'bool', label: 'DM members when they are punished' },
    ],
  },

  commands: [
    {
      data: cmd('ban', 'Ban a user, optionally for a limited time', P.BanMembers)
        .addUserOption((o) => o.setName('user').setDescription('User to ban (mention or ID)').setRequired(true))
        .addStringOption(withReason)
        .addStringOption((o) => o.setName('duration').setDescription('Temporary ban length, e.g. 7d or 12h'))
        .addIntegerOption((o) => o.setName('delete_messages').setDescription('Delete their recent messages')
          .addChoices({ name: 'Last hour', value: 3600 }, { name: 'Last day', value: 86400 }, { name: 'Last week', value: 604800 })),
      botPerms: [P.BanMembers],
      run(i) {
        const raw = i.options.getString('duration');
        const durationMs = raw ? parseDuration(raw) : null;
        if (raw && !durationMs) return fail(i, 'Invalid duration. Try `30m`, `12h` or `7d`.');
        return act(i, 'ban', { durationMs, deleteSeconds: i.options.getInteger('delete_messages') ?? 0, verb: 'banned' });
      },
    },
    {
      data: cmd('unban', 'Unban a user by ID', P.BanMembers)
        .addStringOption((o) => o.setName('user_id').setDescription('The user ID').setRequired(true))
        .addStringOption(withReason),
      botPerms: [P.BanMembers],
      async run(i) {
        const id = i.options.getString('user_id', true).trim();
        if (!/^\d{15,25}$/.test(id)) return fail(i, 'That is not a valid user ID.');
        const ban = await i.guild.bans.fetch(id).catch(() => null);
        if (!ban) return fail(i, 'That user is not banned.');
        await i.deferReply();
        const row = await punish(i.guild, { action: 'unban', user: ban.user, moderator: i.user, reason: i.options.getString('reason') ?? undefined });
        return ok(i, `**${ban.user.username}** was unbanned. (Case #${row.case_id})`);
      },
    },
    {
      data: cmd('softban', 'Ban then instantly unban to wipe a user\'s recent messages', P.BanMembers)
        .addUserOption((o) => o.setName('user').setDescription('User to softban').setRequired(true))
        .addStringOption(withReason),
      botPerms: [P.BanMembers],
      run: (i) => act(i, 'softban', { verb: 'softbanned' }),
    },
    {
      data: cmd('kick', 'Kick a member', P.KickMembers)
        .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
        .addStringOption(withReason),
      botPerms: [P.KickMembers],
      run: (i) => act(i, 'kick', { verb: 'kicked' }),
    },
    {
      data: cmd('timeout', 'Mute a member for a period of time', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('How long, e.g. 10m, 2h, 7d (max 28d)').setRequired(true))
        .addStringOption(withReason),
      botPerms: [P.ModerateMembers],
      run(i) {
        const durationMs = parseDuration(i.options.getString('duration', true));
        if (!durationMs || durationMs > MAX_TIMEOUT) return fail(i, 'Duration must look like `10m` or `2h` and be at most 28 days.');
        return act(i, 'timeout', { durationMs, verb: 'timed out' });
      },
    },
    {
      data: cmd('untimeout', 'Remove a member\'s timeout', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption(withReason),
      botPerms: [P.ModerateMembers],
      run: (i) => act(i, 'untimeout', { verb: 'released from timeout' }),
    },
    {
      data: cmd('warn', 'Warn a member', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
        .addStringOption((o) => withReason(o).setRequired(true)),
      run: (i) => act(i, 'warn', { verb: 'warned' }),
    },
    {
      data: cmd('warnings', 'List a user\'s active warnings', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
      async run(i) {
        const user = i.options.getUser('user', true);
        const list = await activeWarnings(i.guildId, user.id);
        if (!list.length) return ok(i, `**${user.username}** has no active warnings.`);
        const e = new EmbedBuilder().setColor(COLOR.warn).setTitle(`${list.length} warning(s) for ${user.username}`)
          .setDescription(truncate(list.slice(0, 15).map(caseLine).join('\n'), 4000));
        return respond(i, { embeds: [e], allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('unwarn', 'Remove one warning by case number', P.ModerateMembers)
        .addIntegerOption((o) => o.setName('case').setDescription('Case number').setRequired(true).setMinValue(1)),
      async run(i) {
        const id = i.options.getInteger('case', true);
        const changed = await db.run("UPDATE cases SET active = FALSE WHERE guild_id = $1 AND case_id = $2 AND type = 'warn' AND active", [i.guildId, id]);
        return changed ? ok(i, `Warning #${id} removed.`) : fail(i, 'No active warning with that case number.');
      },
    },
    {
      data: cmd('clearwarnings', 'Remove all of a user\'s warnings', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
      async run(i) {
        const user = i.options.getUser('user', true);
        const changed = await db.run("UPDATE cases SET active = FALSE WHERE guild_id = $1 AND user_id = $2 AND type = 'warn' AND active", [i.guildId, user.id]);
        return ok(i, `Cleared **${changed}** warning(s) for **${user.username}**.`);
      },
    },
    {
      data: cmd('case', 'View or edit a moderation case', P.ModerateMembers)
        .addSubcommand((s) => s.setName('view').setDescription('Show a case')
          .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('reason').setDescription('Change a case\'s reason')
          .addIntegerOption((o) => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1))
          .addStringOption((o) => withReason(o).setRequired(true))),
      async run(i) {
        const id = i.options.getInteger('id', true);
        const row = await getCase(i.guildId, id);
        if (!row) return fail(i, 'No case with that number.');
        if (i.options.getSubcommand() === 'reason') {
          await db.run('UPDATE cases SET reason = $1 WHERE guild_id = $2 AND case_id = $3', [i.options.getString('reason', true), i.guildId, id]);
          return ok(i, `Case #${id} reason updated.`);
        }
        return respond(i, { embeds: [caseEmbed(row)], allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('history', 'Show a user\'s full moderation history', P.ModerateMembers)
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
      async run(i) {
        const user = i.options.getUser('user', true);
        const rows = await db.all('SELECT * FROM cases WHERE guild_id = $1 AND user_id = $2 ORDER BY case_id DESC LIMIT 20', [i.guildId, user.id]);
        if (!rows.length) return ok(i, `**${user.username}** has a clean record.`);
        const e = new EmbedBuilder().setColor(COLOR.brand).setTitle(`History for ${user.username}`)
          .setDescription(truncate(rows.map(caseLine).join('\n'), 4000));
        return respond(i, { embeds: [e], allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('purge', 'Bulk delete recent messages', P.ManageMessages)
        .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption((o) => o.setName('user').setDescription('Only messages from this user'))
        .addStringOption((o) => o.setName('contains').setDescription('Only messages containing this text'))
        .addStringOption((o) => o.setName('type').setDescription('Only this kind of message')
          .addChoices({ name: 'Bots', value: 'bots' }, { name: 'Humans', value: 'humans' }, { name: 'With links', value: 'links' }, { name: 'With attachments', value: 'files' })),
      botPerms: [P.ManageMessages, P.ReadMessageHistory],
      async run(i) {
        const user = i.options.getUser('user');
        const contains = i.options.getString('contains')?.toLowerCase();
        const type = i.options.getString('type');
        await i.deferReply({ flags: EPHEMERAL });
        const fetched = await i.channel.messages.fetch({ limit: 100 });
        const chosen = fetched.filter((m) => {
          if (m.pinned || m.interactionMetadata?.id === i.id) return false;
          if (user && m.author.id !== user.id) return false;
          if (contains && !m.content.toLowerCase().includes(contains)) return false;
          if (type === 'bots' && !m.author.bot) return false;
          if (type === 'humans' && m.author.bot) return false;
          if (type === 'links' && !/https?:\/\//i.test(m.content)) return false;
          if (type === 'files' && !m.attachments.size) return false;
          return true;
        }).first(i.options.getInteger('amount', true));
        const deleted = await i.channel.bulkDelete(chosen, true);
        return ok(i, `Deleted **${deleted.size}** message(s). Messages older than 14 days cannot be bulk deleted.`);
      },
    },
    {
      data: cmd('lock', 'Stop @everyone from talking in a channel', P.ManageChannels)
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(...TEXT_CHANNELS))
        .addStringOption(withReason),
      botPerms: [P.ManageChannels, P.ManageRoles],
      async run(i) {
        const channel = i.options.getChannel('channel') ?? i.channel;
        await channel.permissionOverwrites.edit(i.guild.members.me.id, { SendMessages: true });
        await channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false }, { reason: `${i.user.username}: ${i.options.getString('reason') ?? 'locked'}` });
        return ok(i, `🔒 ${channel} is locked.`);
      },
    },
    {
      data: cmd('unlock', 'Let @everyone talk in a channel again', P.ManageChannels)
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(...TEXT_CHANNELS)),
      botPerms: [P.ManageChannels, P.ManageRoles],
      async run(i) {
        const channel = i.options.getChannel('channel') ?? i.channel;
        await channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null }, { reason: `${i.user.username}: unlocked` });
        return ok(i, `🔓 ${channel} is unlocked.`);
      },
    },
    {
      data: cmd('slowmode', 'Set the slowmode of a channel', P.ManageChannels)
        .addIntegerOption((o) => o.setName('seconds').setDescription('0 to turn off, up to 21600').setRequired(true).setMinValue(0).setMaxValue(21600))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(...TEXT_CHANNELS)),
      botPerms: [P.ManageChannels],
      async run(i) {
        const channel = i.options.getChannel('channel') ?? i.channel;
        const seconds = i.options.getInteger('seconds', true);
        await channel.setRateLimitPerUser(seconds, `Set by ${i.user.username}`);
        return ok(i, seconds ? `Slowmode in ${channel} set to **${seconds}s**.` : `Slowmode in ${channel} turned off.`);
      },
    },
    {
      data: cmd('nick', 'Change a member\'s nickname', P.ManageNicknames)
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('nickname').setDescription('Leave empty to reset').setMaxLength(32)),
      botPerms: [P.ManageNicknames],
      async run(i) {
        const member = i.options.getMember('user');
        if (!member) return fail(i, 'That user is not in this server.');
        if (member.id !== i.user.id) {
          const problem = targetError(i, member.user, member);
          if (problem) return fail(i, problem);
        }
        const nickname = i.options.getString('nickname');
        await member.setNickname(nickname, `Changed by ${i.user.username}`);
        return ok(i, nickname ? `Nickname set to **${nickname}**.` : 'Nickname reset.');
      },
    },
    {
      data: cmd('role', 'Give or take a role', P.ManageRoles)
        .addSubcommand((s) => s.setName('add').setDescription('Give a member a role')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Take a role from a member')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),
      botPerms: [P.ManageRoles],
      async run(i) {
        const member = i.options.getMember('user');
        const role = i.options.getRole('role', true);
        if (!member) return fail(i, 'That user is not in this server.');
        const problem = roleError(i, role, { allowDangerous: i.user.id === i.guild.ownerId });
        if (problem) return fail(i, problem);
        const reason = `By ${i.user.username}`;
        if (i.options.getSubcommand() === 'add') {
          await member.roles.add(role, reason);
          return ok(i, `Gave ${role} to ${member}.`, { allowedMentions: { parse: [] } });
        }
        await member.roles.remove(role, reason);
        return ok(i, `Removed ${role} from ${member}.`, { allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('modconfig', 'Configure moderation', P.ManageGuild)
        .addSubcommand((s) => s.setName('log').setDescription('Set the moderation log channel')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
        .addSubcommand((s) => s.setName('dm').setDescription('DM users when they are punished')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((s) => s.setName('escalate').setDescription('Punish automatically at a number of warnings')
          .addIntegerOption((o) => o.setName('warnings').setDescription('Warning count').setRequired(true).setMinValue(1).setMaxValue(50))
          .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true)
            .addChoices({ name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
          .addStringOption((o) => o.setName('duration').setDescription('Length for timeout or temporary ban, e.g. 1h')))
        .addSubcommand((s) => s.setName('unescalate').setDescription('Remove an automatic punishment')
          .addIntegerOption((o) => o.setName('warnings').setDescription('Warning count').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('show').setDescription('Show moderation settings')),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'log') {
          const channel = i.options.getChannel('channel', true);
          await updateSettings(i.guildId, (s) => { s.moderation.logChannel = channel.id; });
          return ok(i, `Moderation cases will be logged in ${channel}.`);
        }
        if (sub === 'dm') {
          const enabled = i.options.getBoolean('enabled', true);
          await updateSettings(i.guildId, (s) => { s.moderation.dmUsers = enabled; });
          return ok(i, `Punishment DMs are **${enabled ? 'on' : 'off'}**.`);
        }
        if (sub === 'escalate') {
          const count = i.options.getInteger('warnings', true);
          const action = i.options.getString('action', true);
          const raw = i.options.getString('duration');
          const durationMs = raw ? parseDuration(raw) : null;
          if (raw && !durationMs) return fail(i, 'Invalid duration. Try `1h` or `7d`.');
          if (action === 'timeout' && !durationMs) return fail(i, 'A timeout needs a duration.');
          await updateSettings(i.guildId, (s) => {
            s.moderation.warnActions = s.moderation.warnActions.filter((r) => r.count !== count);
            s.moderation.warnActions.push({ count, action, durationMs });
            s.moderation.warnActions.sort((a, b) => a.count - b.count);
          });
          return ok(i, `At **${count}** warnings: **${action}**${durationMs ? ` for ${formatDuration(durationMs)}` : ''}.`);
        }
        if (sub === 'unescalate') {
          const count = i.options.getInteger('warnings', true);
          await updateSettings(i.guildId, (s) => { s.moderation.warnActions = s.moderation.warnActions.filter((r) => r.count !== count); });
          return ok(i, `Removed the rule for ${count} warnings.`);
        }
        const cfg = getSettings(i.guildId).moderation;
        const rules = cfg.warnActions.map((r) => `${r.count} warnings: ${r.action}${r.durationMs ? ` (${formatDuration(r.durationMs)})` : ''}`).join('\n') || 'None';
        return okPrivate(i, `**Log channel:** ${cfg.logChannel ? `<#${cfg.logChannel}>` : 'not set'}\n**DM users:** ${cfg.dmUsers ? 'on' : 'off'}\n**Escalation:**\n${rules}`);
      },
    },
  ],

  jobs: {
    async 'mod:unban'(client, { userId }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const ban = await guild.bans.fetch(userId).catch(() => null);
      if (ban) await punish(guild, { action: 'unban', user: ban.user, moderator: client.user, reason: 'Temporary ban expired' });
    },
  },
};
