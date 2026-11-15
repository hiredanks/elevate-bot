import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits as P, StringSelectMenuBuilder,
} from 'discord.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, roleError } from '../core/ui.js';
import { emojiKey, noop, parseEmoji, parseMessageLink, truncate } from '../core/util.js';

const MODES = { normal: 'Toggle', unique: 'Only one at a time', verify: 'Add only', drop: 'Remove only' };
const MAX_PANEL_ROLES = 25;
const reactionMessages = new Set();

async function onReaction(reaction, user, added) {
  if (user.bot || !reactionMessages.has(reaction.message.id)) return;
  const message = reaction.message;
  const row = await db.one('SELECT * FROM reaction_roles WHERE message_id = $1 AND emoji = $2', [message.id, emojiKey(reaction.emoji)]);
  if (!row) return;
  const guild = user.client.guilds.cache.get(row.guild_id);
  const member = await guild?.members.fetch(user.id).catch(() => null);
  if (!member) return;
  const reason = 'Reaction role';
  try {
    if (row.mode === 'drop') {
      if (added) await member.roles.remove(row.role_id, reason);
    } else if (row.mode === 'verify') {
      if (added) await member.roles.add(row.role_id, reason);
    } else if (added) {
      if (row.mode === 'unique') {
        const others = await db.all('SELECT * FROM reaction_roles WHERE message_id = $1 AND emoji <> $2', [message.id, row.emoji]);
        const toRemove = others.map((o) => o.role_id).filter((id) => member.roles.cache.has(id));
        if (toRemove.length) await member.roles.remove(toRemove, reason);
        const full = message.partial ? await message.fetch() : message;
        for (const other of others) await full.reactions.cache.get(other.emoji)?.users.remove(user.id).catch(noop);
      }
      await member.roles.add(row.role_id, reason);
    } else {
      await member.roles.remove(row.role_id, reason);
    }
  } catch (err) {
    logger.warn(`Reaction role failed: ${err.message}`);
  }
}

function panelMessage(panel) {
  const roles = panel.roles;
  const e = embed(panel.description || 'Choose your roles below.', COLOR.brand).setTitle(panel.title);
  if (!roles.length) return { embeds: [e], components: [] };
  if (panel.style === 'select') {
    const menu = new StringSelectMenuBuilder().setCustomId(`panel:select:${panel.id}`).setPlaceholder('Pick your roles')
      .setMinValues(0).setMaxValues(panel.mode === 'unique' ? 1 : roles.length)
      .addOptions(roles.map((r) => ({ label: truncate(r.label, 100), value: r.roleId, ...(r.emoji ? { emoji: r.emoji } : {}) })));
    return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu)] };
  }
  const rows = [];
  for (let n = 0; n < roles.length; n += 5) {
    rows.push(new ActionRowBuilder().addComponents(roles.slice(n, n + 5).map((r) => {
      const button = new ButtonBuilder().setCustomId(`panel:btn:${panel.id}:${r.roleId}`).setLabel(truncate(r.label, 80)).setStyle(ButtonStyle.Secondary);
      return r.emoji ? button.setEmoji(r.emoji) : button;
    })));
  }
  return { embeds: [e], components: rows };
}

async function getPanel(guildId, id) {
  return db.one('SELECT * FROM role_panels WHERE id = $1 AND guild_id = $2', [id, guildId]);
}

async function refreshPanel(guild, panel) {
  const channel = guild.channels.cache.get(panel.channel_id);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  if (!message) throw new Error('The panel message no longer exists.');
  await message.edit(panelMessage(panel));
}

const STYLES = { Buttons: 'buttons', Dropdown: 'select' };
const PICK_MODES = { 'Any number': 'multi', 'Only one': 'unique' };

export async function createPanel(guild, channel, { title, description = null, style = 'buttons', mode = 'multi', roles = [] }) {
  const panel = await db.one(
    'INSERT INTO role_panels(guild_id, channel_id, title, description, style, mode, roles) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [guild.id, channel.id, title, description, style, mode, JSON.stringify(roles)],
  );
  const message = await channel.send(panelMessage(panel));
  await db.run('UPDATE role_panels SET message_id = $1 WHERE id = $2', [message.id, panel.id]);
  return panel;
}

async function deletePanel(guild, id) {
  const panel = await getPanel(guild.id, id);
  if (!panel) return 0;
  await guild.channels.cache.get(panel.channel_id)?.messages.delete(panel.message_id).catch(noop);
  return db.run('DELETE FROM role_panels WHERE id = $1', [panel.id]);
}

export default {
  name: 'roles',
  label: '🎭 Self Roles',

  collections: {
    panels: {
      title: 'Self roles',
      description: 'Post a menu where members pick their own roles. Roles with admin-level permissions, or above the bot, cannot be added.',
      submitLabel: 'Post menu',
      columns: [
        { key: 'title', label: 'Title', type: 'text', max: 100, required: true, placeholder: 'Pick your roles' },
        { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
        { key: 'roles', label: 'Roles', type: 'roles', assignable: true, required: true, max: MAX_PANEL_ROLES },
        { key: 'description', label: 'Text above the menu', type: 'textarea', max: 1500, hideInList: true },
        { key: 'style', label: 'Show as', type: 'select', options: Object.keys(STYLES) },
        { key: 'mode', label: 'Members can pick', type: 'select', options: Object.keys(PICK_MODES) },
      ],
      async list(guildId) {
        const rows = await db.all('SELECT * FROM role_panels WHERE guild_id = $1 ORDER BY id DESC', [guildId]);
        return rows.map((p) => ({
          id: p.id, title: p.title, channel_id: p.channel_id, roles: p.roles.map((r) => r.roleId), description: p.description,
          style: p.style === 'select' ? 'Dropdown' : 'Buttons', mode: p.mode === 'unique' ? 'Only one' : 'Any number',
        }));
      },
      async create(guild, row) {
        if (!row.roles?.length) throw new Error('Pick at least one role.');
        return createPanel(guild, guild.channels.cache.get(row.channel_id), {
          title: row.title, description: row.description || null, style: STYLES[row.style] ?? 'buttons', mode: PICK_MODES[row.mode] ?? 'multi',
          roles: row.roles.map((id) => ({ roleId: id, label: guild.roles.cache.get(id)?.name ?? 'Role', emoji: null })),
        });
      },
      remove: (guild, id) => deletePanel(guild, id),
    },
  },

  commands: [
    {
      data: cmd('reactionrole', 'Give roles when people react to a message', P.ManageRoles)
        .addSubcommand((s) => s.setName('add').setDescription('Link an emoji on a message to a role')
          .addStringOption((o) => o.setName('message').setDescription('Message link (right click, Copy Message Link)').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((o) => o.setName('mode').setDescription('Behaviour').addChoices(...Object.entries(MODES).map(([value, name]) => ({ name, value })))))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a reaction role')
          .addStringOption((o) => o.setName('message').setDescription('Message link').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('List reaction roles')),
      botPerms: [P.ManageRoles, P.AddReactions],
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = await db.all('SELECT * FROM reaction_roles WHERE guild_id = $1 LIMIT 40', [i.guildId]);
          return okPrivate(i, truncate(rows.map((r) => `${r.emoji_display} → <@&${r.role_id}> (${r.mode}) [message](https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id})`).join('\n') || 'None yet.', 3900));
        }
        const link = parseMessageLink(i.options.getString('message', true));
        if (!link || link.guildId !== i.guildId) return fail(i, 'That is not a message link from this server.');
        const emoji = parseEmoji(i.options.getString('emoji', true));
        if (!emoji) return fail(i, 'That does not look like an emoji.');

        if (sub === 'remove') {
          const removed = await db.run('DELETE FROM reaction_roles WHERE message_id = $1 AND emoji = $2', [link.messageId, emoji.key]);
          return removed ? ok(i, 'Reaction role removed.') : fail(i, 'No reaction role for that emoji on that message.');
        }
        const role = i.options.getRole('role', true);
        const problem = roleError(i, role);
        if (problem) return fail(i, problem);
        const channel = i.guild.channels.cache.get(link.channelId);
        const message = await channel?.messages.fetch(link.messageId).catch(() => null);
        if (!message) return fail(i, 'I cannot find that message.');
        await i.deferReply({ flags: EPHEMERAL });
        await message.react(emoji.react);
        await db.run(
          `INSERT INTO reaction_roles(guild_id, channel_id, message_id, emoji, emoji_display, role_id, mode) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = excluded.role_id, mode = excluded.mode`,
          [i.guildId, channel.id, message.id, emoji.key, emoji.display, role.id, i.options.getString('mode') ?? 'normal'],
        );
        reactionMessages.add(message.id);
        return ok(i, `Reacting with ${emoji.display} now gives ${role}.`);
      },
    },
    {
      data: cmd('rolepanel', 'Create a menu of buttons or a dropdown for self-assigned roles', P.ManageRoles)
        .addSubcommand((s) => s.setName('create').setDescription('Post a new role panel')
          .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('description').setDescription('Panel text').setMaxLength(1500))
          .addStringOption((o) => o.setName('style').setDescription('Display').addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Dropdown', value: 'select' }))
          .addStringOption((o) => o.setName('mode').setDescription('How many can be picked').addChoices({ name: 'Any number', value: 'multi' }, { name: 'Only one', value: 'unique' }))
          .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand((s) => s.setName('add').setDescription('Add a role to a panel')
          .addIntegerOption((o) => o.setName('panel').setDescription('Panel ID').setRequired(true).setMinValue(1))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((o) => o.setName('label').setDescription('Text shown (defaults to the role name)').setMaxLength(80))
          .addStringOption((o) => o.setName('emoji').setDescription('Optional emoji')))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a role from a panel')
          .addIntegerOption((o) => o.setName('panel').setDescription('Panel ID').setRequired(true).setMinValue(1))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel')
          .addIntegerOption((o) => o.setName('panel').setDescription('Panel ID').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('list').setDescription('List panels')),
      botPerms: [P.ManageRoles],
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = await db.all('SELECT * FROM role_panels WHERE guild_id = $1 ORDER BY id', [i.guildId]);
          return okPrivate(i, rows.map((p) => `**#${p.id}** ${p.title} in <#${p.channel_id}> (${p.roles.length} roles)`).join('\n') || 'No panels yet.');
        }
        if (sub === 'create') {
          const channel = i.options.getChannel('channel') ?? i.channel;
          const panel = await createPanel(i.guild, channel, {
            title: i.options.getString('title', true), description: i.options.getString('description'),
            style: i.options.getString('style') ?? 'buttons', mode: i.options.getString('mode') ?? 'multi',
          });
          return ok(i, `Panel **#${panel.id}** posted in ${channel}. Add roles with \`/rolepanel add panel:${panel.id}\`.`, { flags: EPHEMERAL });
        }
        const id = i.options.getInteger('panel', true);
        const panel = await getPanel(i.guildId, id);
        if (!panel) return fail(i, 'No panel with that ID.');
        if (sub === 'delete') {
          await deletePanel(i.guild, id);
          return ok(i, `Panel #${id} deleted.`);
        }
        const role = i.options.getRole('role', true);
        let roles = panel.roles.filter((r) => r.roleId !== role.id);
        if (sub === 'add') {
          const problem = roleError(i, role);
          if (problem) return fail(i, problem);
          if (roles.length >= MAX_PANEL_ROLES) return fail(i, `A panel can hold ${MAX_PANEL_ROLES} roles at most.`);
          const rawEmoji = i.options.getString('emoji');
          const emoji = rawEmoji ? parseEmoji(rawEmoji) : null;
          if (rawEmoji && !emoji) return fail(i, 'That does not look like an emoji.');
          roles = [...roles, { roleId: role.id, label: i.options.getString('label') ?? role.name, emoji: emoji?.display ?? null }];
        }
        await db.run('UPDATE role_panels SET roles = $1 WHERE id = $2', [JSON.stringify(roles), id]);
        await refreshPanel(i.guild, { ...panel, roles });
        return ok(i, `Panel #${id} updated.`, { flags: EPHEMERAL });
      },
    },
  ],

  components: {
    async 'panel:btn'(i, [panelId, roleId]) {
      const panel = await getPanel(i.guildId, panelId);
      if (!panel?.roles.some((r) => r.roleId === roleId)) return fail(i, 'That option no longer exists.');
      await i.deferReply({ flags: EPHEMERAL });
      if (i.member.roles.cache.has(roleId)) {
        await i.member.roles.remove(roleId, 'Role panel');
        return ok(i, `Removed <@&${roleId}>.`);
      }
      if (panel.mode === 'unique') {
        const others = panel.roles.map((r) => r.roleId).filter((id) => id !== roleId && i.member.roles.cache.has(id));
        if (others.length) await i.member.roles.remove(others, 'Role panel');
      }
      await i.member.roles.add(roleId, 'Role panel');
      return ok(i, `Added <@&${roleId}>.`);
    },
    async 'panel:select'(i, [panelId]) {
      const panel = await getPanel(i.guildId, panelId);
      if (!panel) return fail(i, 'That panel no longer exists.');
      await i.deferReply({ flags: EPHEMERAL });
      const allowed = panel.roles.map((r) => r.roleId);
      const chosen = i.values.filter((id) => allowed.includes(id));
      const add = chosen.filter((id) => !i.member.roles.cache.has(id));
      const remove = allowed.filter((id) => !chosen.includes(id) && i.member.roles.cache.has(id));
      if (remove.length) await i.member.roles.remove(remove, 'Role panel');
      if (add.length) await i.member.roles.add(add, 'Role panel');
      return ok(i, 'Your roles were updated.');
    },
  },

  async ready() {
    const rows = await db.all('SELECT DISTINCT message_id FROM reaction_roles');
    for (const row of rows) reactionMessages.add(row.message_id);
  },

  events: {
    messageReactionAdd: (reaction, user) => onReaction(reaction, user, true),
    messageReactionRemove: (reaction, user) => onReaction(reaction, user, false),
  },
};
