import { AttachmentBuilder, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { welcomeCard } from '../core/cards.js';
import { db } from '../core/db.js';
import { getImage, saveFromAttachment, withImage } from '../core/images.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, EPHEMERAL, fail, isDangerousRole, ok, okPrivate, roleError, sendTo } from '../core/ui.js';
import { memberVars, noop, render } from '../core/util.js';
import { consumeJoinInfo, inviteStats } from './invites.js';

const PLACEHOLDERS = 'Placeholders: {user} {username} {name} {server} {membercount} {inviter} {invites}';

async function buildVars(member, info) {
  const inviter = info?.inviterId ? `<@${info.inviterId}>` : 'someone';
  const invites = info?.inviterId ? (await inviteStats(member.guild.id, info.inviterId)).real : 0;
  return memberVars(member, { inviter, invites });
}

async function sendWelcome(member, info) {
  const cfg = getSettings(member.guild.id).welcome;
  const vars = await buildVars(member, info);
  const payload = { content: render(cfg.message, vars), allowedMentions: { users: [member.id] } };
  if (cfg.card) {
    try {
      const background = await getImage(member.guild.id, 'welcome_background');
      const png = await welcomeCard({
        avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
        title: render(cfg.cardTitle, vars), name: member.displayName,
        subtitle: `Member #${member.guild.memberCount} of ${member.guild.name}`,
        background: background?.data ?? null,
      });
      payload.files = [new AttachmentBuilder(png, { name: 'welcome.png' })];
    } catch (err) {
      logger.warn(`Welcome card failed: ${err.message}`);
    }
  }
  return sendTo(member.guild, cfg.channel, await withImage(member.guild.id, 'welcome', payload));
}

async function applyAutoRoles(member) {
  const { autorolesHumans, autorolesBots } = getSettings(member.guild.id).welcome;
  const roles = (member.user.bot ? autorolesBots : autorolesHumans).filter((id) => member.guild.roles.cache.has(id));
  if (roles.length) await member.roles.add(roles, 'Auto role').catch((err) => logger.warn(`Auto role failed: ${err.message}`));
}

async function restoreStickyRoles(member) {
  const row = await db.one('SELECT role_ids FROM sticky_roles WHERE guild_id = $1 AND user_id = $2', [member.guild.id, member.id]);
  if (!row) return;
  const myTop = member.guild.members.me.roles.highest.position;
  const roles = row.role_ids.filter((id) => {
    const role = member.guild.roles.cache.get(id);
    return role && role.position < myTop && !role.managed && !isDangerousRole(role);
  });
  if (roles.length) await member.roles.add(roles, 'Sticky roles').catch(noop);
}

export default {
  name: 'welcome',
  label: '👋 Welcome',
  defaults: {
    enabled: false, channel: null, card: true, cardTitle: 'Welcome', dm: '',
    message: 'Welcome {user} to **{server}**! You are member **#{membercount}**.',
    goodbyeEnabled: false, goodbyeChannel: null, goodbyeMessage: '**{username}** left the server. We are now {membercount}.',
    autorolesHumans: [], autorolesBots: [], stickyRoles: false,
  },
  form: {
    title: 'Welcome',
    description: PLACEHOLDERS,
    fields: [
      { key: 'enabled', type: 'bool', label: 'Send welcome messages' },
      { key: 'channel', type: 'channel', label: 'Welcome channel' },
      { key: 'message', type: 'textarea', label: 'Welcome message', max: 1800 },
      { key: 'card', type: 'bool', label: 'Attach an image card', help: 'Upload a custom background on the Pictures page.' },
      { key: 'cardTitle', type: 'text', label: 'Card title', max: 40 },
      { key: 'dm', type: 'textarea', label: 'Welcome DM', max: 1800, help: 'Leave empty to send no DM.' },
      { key: 'goodbyeEnabled', type: 'bool', label: 'Send goodbye messages', group: 'Goodbye' },
      { key: 'goodbyeChannel', type: 'channel', label: 'Goodbye channel', group: 'Goodbye' },
      { key: 'goodbyeMessage', type: 'textarea', label: 'Goodbye message', max: 1800, group: 'Goodbye' },
      { key: 'autorolesHumans', type: 'roles', label: 'Roles for new members', assignable: true, group: 'Auto roles' },
      { key: 'autorolesBots', type: 'roles', label: 'Roles for new bots', assignable: true, group: 'Auto roles' },
      { key: 'stickyRoles', type: 'bool', label: 'Give roles back when someone rejoins', group: 'Auto roles' },
    ],
  },

  commands: [
    {
      data: cmd('welcome', 'Configure welcome messages', P.ManageGuild)
        .addSubcommand((s) => s.setName('setup').setDescription('Turn on welcome messages')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
          .addStringOption((o) => o.setName('message').setDescription(PLACEHOLDERS.slice(0, 100)).setMaxLength(1800))
          .addBooleanOption((o) => o.setName('card').setDescription('Attach an image card')))
        .addSubcommand((s) => s.setName('off').setDescription('Turn off welcome messages'))
        .addSubcommand((s) => s.setName('dm').setDescription('Set a private welcome DM')
          .addStringOption((o) => o.setName('message').setDescription('Leave empty to turn off').setMaxLength(1800)))
        .addSubcommand((s) => s.setName('background').setDescription('Upload a custom card background')
          .addAttachmentOption((o) => o.setName('image').setDescription('PNG or JPG, up to 5 MB').setRequired(true)))
        .addSubcommand((s) => s.setName('test').setDescription('Preview the welcome message')),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'setup') {
          const channel = i.options.getChannel('channel', true);
          const message = i.options.getString('message');
          const card = i.options.getBoolean('card');
          await updateSettings(i.guildId, (s) => {
            s.welcome.enabled = true;
            s.welcome.channel = channel.id;
            if (message) s.welcome.message = message;
            if (card !== null) s.welcome.card = card;
          });
          return ok(i, `Welcome messages will be posted in ${channel}. Try \`/welcome test\`.`);
        }
        if (sub === 'off') {
          await updateSettings(i.guildId, (s) => { s.welcome.enabled = false; });
          return ok(i, 'Welcome messages turned off.');
        }
        if (sub === 'dm') {
          const message = i.options.getString('message') ?? '';
          await updateSettings(i.guildId, (s) => { s.welcome.dm = message; });
          return ok(i, message ? 'Welcome DM saved.' : 'Welcome DM turned off.');
        }
        if (sub === 'background') {
          await i.deferReply({ flags: EPHEMERAL });
          const problem = await saveFromAttachment(i.guildId, 'welcome_background', i.options.getAttachment('image', true));
          return problem ? fail(i, problem) : ok(i, 'Background saved. Try `/welcome test`.');
        }
        if (!getSettings(i.guildId).welcome.channel) return fail(i, 'Run `/welcome setup` first.');
        await i.deferReply({ flags: EPHEMERAL });
        await sendWelcome(i.member, null);
        return ok(i, 'Test message sent.');
      },
    },
    {
      data: cmd('goodbye', 'Configure goodbye messages', P.ManageGuild)
        .addSubcommand((s) => s.setName('setup').setDescription('Turn on goodbye messages')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addStringOption((o) => o.setName('message').setDescription('Supports {username} {server} {membercount}').setMaxLength(1800)))
        .addSubcommand((s) => s.setName('off').setDescription('Turn off goodbye messages')),
      async run(i) {
        if (i.options.getSubcommand() === 'off') {
          await updateSettings(i.guildId, (s) => { s.welcome.goodbyeEnabled = false; });
          return ok(i, 'Goodbye messages turned off.');
        }
        const channel = i.options.getChannel('channel', true);
        const message = i.options.getString('message');
        await updateSettings(i.guildId, (s) => {
          s.welcome.goodbyeEnabled = true;
          s.welcome.goodbyeChannel = channel.id;
          if (message) s.welcome.goodbyeMessage = message;
        });
        return ok(i, `Goodbye messages will be posted in ${channel}.`);
      },
    },
    {
      data: cmd('autorole', 'Give roles to new members automatically', P.ManageRoles)
        .addSubcommand((s) => s.setName('add').setDescription('Add an auto role')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
          .addBooleanOption((o) => o.setName('bots').setDescription('Apply to bots instead of humans')))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove an auto role')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('List auto roles'))
        .addSubcommand((s) => s.setName('sticky').setDescription('Give roles back to people who rejoin')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const { autorolesHumans: h, autorolesBots: b, stickyRoles } = getSettings(i.guildId).welcome;
          const show = (list) => list.map((id) => `<@&${id}>`).join(' ') || 'None';
          return okPrivate(i, `**Members:** ${show(h)}\n**Bots:** ${show(b)}\n**Sticky roles:** ${stickyRoles ? 'on' : 'off'}`);
        }
        if (sub === 'sticky') {
          const enabled = i.options.getBoolean('enabled', true);
          await updateSettings(i.guildId, (s) => { s.welcome.stickyRoles = enabled; });
          return ok(i, `Sticky roles are **${enabled ? 'on' : 'off'}**.`);
        }
        const role = i.options.getRole('role', true);
        if (sub === 'remove') {
          await updateSettings(i.guildId, (s) => {
            s.welcome.autorolesHumans = s.welcome.autorolesHumans.filter((id) => id !== role.id);
            s.welcome.autorolesBots = s.welcome.autorolesBots.filter((id) => id !== role.id);
          });
          return ok(i, `${role} is no longer an auto role.`, { allowedMentions: { parse: [] } });
        }
        const problem = roleError(i, role);
        if (problem) return fail(i, problem);
        const field = i.options.getBoolean('bots') ? 'autorolesBots' : 'autorolesHumans';
        await updateSettings(i.guildId, (s) => { s.welcome[field] = [...new Set([...s.welcome[field], role.id])]; });
        return ok(i, `${role} will be given to new ${field === 'autorolesBots' ? 'bots' : 'members'}.`, { allowedMentions: { parse: [] } });
      },
    },
  ],

  events: {
    async guildMemberAdd(member) {
      if (member.blocked) return;
      const cfg = getSettings(member.guild.id).welcome;
      const info = member.user.bot ? null : consumeJoinInfo(member.guild.id, member.id);
      if (!member.pending) await applyAutoRoles(member);
      if (cfg.stickyRoles) await restoreStickyRoles(member);
      if (member.user.bot) return;
      if (cfg.enabled && cfg.channel) await sendWelcome(member, info);
      if (cfg.dm) await member.send({ content: render(cfg.dm, await buildVars(member, info)), allowedMentions: { parse: [] } }).catch(noop);
    },
    async guildMemberUpdate(before, after) {
      // Servers using rules screening: members only count as joined once they accept.
      if (before.pending && !after.pending) await applyAutoRoles(after);
    },
    async guildMemberRemove(member) {
      const cfg = getSettings(member.guild.id).welcome;
      if (cfg.stickyRoles && member.roles?.cache.size > 1) {
        const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && !r.managed).map((r) => r.id);
        await db.run(
          'INSERT INTO sticky_roles(guild_id, user_id, role_ids) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET role_ids = excluded.role_ids',
          [member.guild.id, member.id, JSON.stringify(roles)],
        );
      }
      if (member.user.bot || !cfg.goodbyeEnabled) return;
      await sendTo(member.guild, cfg.goodbyeChannel, await withImage(member.guild.id, 'goodbye', { content: render(cfg.goodbyeMessage, memberVars(member)), allowedMentions: { parse: [] } }));
    },
  },
};
