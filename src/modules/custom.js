import { EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, fail, ok, okPrivate, respond } from '../core/ui.js';
import { memberVars, noop, render, truncate } from '../core/util.js';

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const NO_PINGS = { parse: ['users'] };
const MATCHES = { contains: 'Contains', exact: 'Exact match', startswith: 'Starts with' };
const responders = new Map();
const responderCooldown = new Map();

async function loadResponders() {
  responders.clear();
  for (const row of await db.all('SELECT * FROM autoresponders ORDER BY id')) {
    if (!responders.has(row.guild_id)) responders.set(row.guild_id, []);
    responders.get(row.guild_id).push(row);
  }
}

export async function addResponder(guildId, trigger, response, match) {
  const count = responders.get(guildId)?.length ?? 0;
  if (count >= 100) throw new Error('A server can have 100 auto-responders at most.');
  const row = await db.one('INSERT INTO autoresponders(guild_id, trigger_text, response, match_type) VALUES ($1, $2, $3, $4) RETURNING *', [guildId, trigger.toLowerCase(), response, match]);
  if (!responders.has(guildId)) responders.set(guildId, []);
  responders.get(guildId).push(row);
  return row;
}

export async function removeResponder(guildId, id) {
  const changed = await db.run('DELETE FROM autoresponders WHERE guild_id = $1 AND id = $2', [guildId, id]);
  if (changed) responders.set(guildId, (responders.get(guildId) ?? []).filter((r) => r.id !== Number(id)));
  return changed;
}

export function matchResponder(list, content) {
  const text = content.toLowerCase().trim();
  return list.find((r) => (r.match_type === 'exact' ? text === r.trigger_text
    : r.match_type === 'startswith' ? text.startsWith(r.trigger_text) : text.includes(r.trigger_text))) ?? null;
}

export async function saveCustomCommand(guildId, name, response, deleteTrigger = false, roleId = null) {
  await db.run(
    `INSERT INTO custom_commands(guild_id, name, response, delete_trigger, role_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, name) DO UPDATE SET response = excluded.response, delete_trigger = excluded.delete_trigger, role_id = excluded.role_id`,
    [guildId, name.toLowerCase(), response, deleteTrigger, roleId],
  );
}

export async function saveTag(guildId, name, content, ownerId) {
  await db.run(
    `INSERT INTO tags(guild_id, name, content, owner_id, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, name) DO UPDATE SET content = excluded.content`,
    [guildId, name.toLowerCase(), content, ownerId, Date.now()],
  );
}

const canEditTag = (i, tag) => tag.owner_id === i.user.id || i.memberPermissions.has(P.ManageGuild);
const tagNameOption = (o) => o.setName('name').setDescription('Tag name').setRequired(true).setMaxLength(32).setAutocomplete(true);

export default {
  name: 'custom',
  label: '🏷️ Tags & Custom Commands',
  defaults: { prefix: '!' },
  form: {
    title: 'Command prefix',
    description: 'The characters members type before custom commands and tags.',
    fields: [{ key: 'prefix', type: 'text', label: 'Prefix', max: 5, required: true }],
  },

  collections: {
    autoresponders: {
      title: 'Auto-responders',
      description: 'The bot replies whenever a message matches. Supports {user} {username} {server}.',
      columns: [
        { key: 'trigger_text', label: 'When a message', type: 'text', max: 100, required: true },
        { key: 'match_type', label: 'Match', type: 'select', options: Object.keys(MATCHES) },
        { key: 'response', label: 'Reply with', type: 'textarea', max: 1800, required: true },
      ],
      list: (guildId) => db.all('SELECT id, trigger_text, match_type, response FROM autoresponders WHERE guild_id = $1 ORDER BY id', [guildId]),
      create: (guild, row) => addResponder(guild.id, row.trigger_text, row.response, row.match_type ?? 'contains'),
      remove: (guild, id) => removeResponder(guild.id, id),
    },
    commands: {
      title: 'Custom commands',
      description: 'Typed with your prefix. Supports {user} {username} {server} {args}.',
      columns: [
        { key: 'name', label: 'Name', type: 'text', max: 32, required: true, pattern: NAME_RE.source, patternFlags: 'u' },
        { key: 'response', label: 'Response', type: 'textarea', max: 1800, required: true },
      ],
      idKey: 'name',
      list: (guildId) => db.all('SELECT name, response FROM custom_commands WHERE guild_id = $1 ORDER BY name LIMIT 200', [guildId]),
      create: (guild, row) => saveCustomCommand(guild.id, row.name, row.response),
      remove: (guild, name) => db.run('DELETE FROM custom_commands WHERE guild_id = $1 AND name = $2', [guild.id, name]),
    },
    tags: {
      title: 'Tags',
      description: 'Saved text members can recall with your prefix or /tag show.',
      columns: [
        { key: 'name', label: 'Name', type: 'text', max: 32, required: true, pattern: NAME_RE.source, patternFlags: 'u' },
        { key: 'content', label: 'Content', type: 'textarea', max: 1800, required: true },
      ],
      idKey: 'name',
      list: (guildId) => db.all('SELECT name, content FROM tags WHERE guild_id = $1 ORDER BY name LIMIT 200', [guildId]),
      create: (guild, row, userId) => saveTag(guild.id, row.name, row.content, userId),
      remove: (guild, name) => db.run('DELETE FROM tags WHERE guild_id = $1 AND name = $2', [guild.id, name]),
    },
  },

  commands: [
    {
      data: cmd('tag', 'Saved text snippets')
        .addSubcommand((s) => s.setName('show').setDescription('Post a tag').addStringOption(tagNameOption))
        .addSubcommand((s) => s.setName('create').setDescription('Create a tag (needs Manage Messages)')
          .addStringOption((o) => o.setName('name').setDescription('Tag name').setRequired(true).setMaxLength(32))
          .addStringOption((o) => o.setName('content').setDescription('Content').setRequired(true).setMaxLength(1800)))
        .addSubcommand((s) => s.setName('edit').setDescription('Edit your tag').addStringOption(tagNameOption)
          .addStringOption((o) => o.setName('content').setDescription('New content').setRequired(true).setMaxLength(1800)))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete your tag').addStringOption(tagNameOption))
        .addSubcommand((s) => s.setName('list').setDescription('List all tags')),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = await db.all('SELECT name FROM tags WHERE guild_id = $1 ORDER BY name LIMIT 200', [i.guildId]);
          return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle('Tags').setDescription(truncate(rows.map((r) => `\`${r.name}\``).join(' ') || 'No tags yet.', 4000))] });
        }
        const name = i.options.getString('name', true).toLowerCase();
        if (sub === 'create') {
          if (!i.memberPermissions.has(P.ManageMessages)) return fail(i, 'You need Manage Messages to create tags.');
          if (!NAME_RE.test(name)) return fail(i, 'Names can use letters, numbers, dashes and underscores.');
          const taken = await db.one('SELECT 1 AS yes FROM tags WHERE guild_id = $1 AND name = $2', [i.guildId, name]);
          if (taken) return fail(i, 'That tag already exists.');
          await saveTag(i.guildId, name, i.options.getString('content', true), i.user.id);
          return ok(i, `Tag \`${name}\` created.`);
        }
        const tag = await db.one('SELECT * FROM tags WHERE guild_id = $1 AND name = $2', [i.guildId, name]);
        if (!tag) return fail(i, 'No tag with that name.');
        if (sub === 'show') {
          await db.run('UPDATE tags SET uses = uses + 1 WHERE guild_id = $1 AND name = $2', [i.guildId, name]);
          return respond(i, { content: tag.content, allowedMentions: { parse: [] } });
        }
        if (!canEditTag(i, tag)) return fail(i, 'Only the tag owner or someone with Manage Server can change this tag.');
        if (sub === 'edit') {
          await db.run('UPDATE tags SET content = $1 WHERE guild_id = $2 AND name = $3', [i.options.getString('content', true), i.guildId, name]);
          return ok(i, `Tag \`${name}\` updated.`);
        }
        await db.run('DELETE FROM tags WHERE guild_id = $1 AND name = $2', [i.guildId, name]);
        return ok(i, `Tag \`${name}\` deleted.`);
      },
      async autocomplete(i) {
        const typed = i.options.getFocused().toLowerCase();
        const rows = await db.all('SELECT name FROM tags WHERE guild_id = $1 AND name LIKE $2 ORDER BY name LIMIT 25', [i.guildId, `${typed.replace(/[%_]/g, '')}%`]);
        return i.respond(rows.map((r) => ({ name: r.name, value: r.name })));
      },
    },
    {
      data: cmd('customcommand', 'Create your own text commands', P.ManageGuild)
        .addSubcommand((s) => s.setName('add').setDescription('Create or replace a command')
          .addStringOption((o) => o.setName('name').setDescription('Without the prefix').setRequired(true).setMaxLength(32))
          .addStringOption((o) => o.setName('response').setDescription('Supports {user} {username} {server} {args}').setRequired(true).setMaxLength(1800))
          .addBooleanOption((o) => o.setName('delete_trigger').setDescription('Delete the message that triggered it'))
          .addRoleOption((o) => o.setName('required_role').setDescription('Only this role can use it')))
        .addSubcommand((s) => s.setName('remove').setDescription('Delete a command')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('List commands'))
        .addSubcommand((s) => s.setName('prefix').setDescription('Set the prefix')
          .addStringOption((o) => o.setName('prefix').setDescription('For example ! or ?').setRequired(true).setMaxLength(5))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'prefix') {
          const prefix = i.options.getString('prefix', true).trim();
          if (!prefix) return fail(i, 'The prefix cannot be empty.');
          await updateSettings(i.guildId, (s) => { s.custom.prefix = prefix; });
          return ok(i, `Prefix set to \`${prefix}\`.`);
        }
        if (sub === 'list') {
          const rows = await db.all('SELECT name FROM custom_commands WHERE guild_id = $1 ORDER BY name LIMIT 200', [i.guildId]);
          const { prefix } = getSettings(i.guildId).custom;
          return okPrivate(i, truncate(rows.map((r) => `\`${prefix}${r.name}\``).join(' ') || 'None yet.', 3900));
        }
        const name = i.options.getString('name', true).toLowerCase();
        if (sub === 'remove') {
          const removed = await db.run('DELETE FROM custom_commands WHERE guild_id = $1 AND name = $2', [i.guildId, name]);
          return removed ? ok(i, `Removed \`${name}\`.`) : fail(i, 'No command with that name.');
        }
        if (!NAME_RE.test(name)) return fail(i, 'Names can use letters, numbers, dashes and underscores.');
        await saveCustomCommand(i.guildId, name, i.options.getString('response', true), i.options.getBoolean('delete_trigger') ?? false, i.options.getRole('required_role')?.id ?? null);
        return ok(i, `Command \`${getSettings(i.guildId).custom.prefix}${name}\` saved.`);
      },
    },
    {
      data: cmd('autoresponder', 'Reply automatically to certain messages', P.ManageGuild)
        .addSubcommand((s) => s.setName('add').setDescription('Add an auto-responder')
          .addStringOption((o) => o.setName('trigger').setDescription('Text to look for').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('response').setDescription('Reply. Supports {user} {username} {server}').setRequired(true).setMaxLength(1800))
          .addStringOption((o) => o.setName('match').setDescription('How to match').addChoices(...Object.entries(MATCHES).map(([value, name]) => ({ name, value })))))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove an auto-responder')
          .addIntegerOption((o) => o.setName('id').setDescription('ID from the list').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('list').setDescription('List auto-responders')),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const list = responders.get(i.guildId) ?? [];
          return okPrivate(i, truncate(list.map((r) => `**${r.id}.** ${r.match_type}: \`${r.trigger_text}\``).join('\n') || 'None yet.', 3900));
        }
        if (sub === 'remove') {
          return (await removeResponder(i.guildId, i.options.getInteger('id', true))) ? ok(i, 'Auto-responder removed.') : fail(i, 'No auto-responder with that ID.');
        }
        const row = await addResponder(i.guildId, i.options.getString('trigger', true), i.options.getString('response', true), i.options.getString('match') ?? 'contains');
        return ok(i, `Auto-responder **#${row.id}** added.`);
      },
    },
  ],

  ready: loadResponders,

  events: {
    async messageCreate(message) {
      if (!message.guild || message.author.bot || message.blocked || !message.member) return;
      const { prefix } = getSettings(message.guild.id).custom;

      if (message.content.startsWith(prefix) && message.content.length > prefix.length) {
        const [rawName, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
        const name = rawName.toLowerCase();
        const custom = await db.one('SELECT * FROM custom_commands WHERE guild_id = $1 AND name = $2', [message.guild.id, name]);
        if (custom) {
          if (custom.role_id && !message.member.roles.cache.has(custom.role_id)) return;
          await message.channel.send({
            content: render(custom.response, memberVars(message.member, { args: args.join(' '), channel: `<#${message.channelId}>` })),
            allowedMentions: NO_PINGS,
          });
          if (custom.delete_trigger) await message.delete().catch(noop);
          return;
        }
        const tag = await db.one('UPDATE tags SET uses = uses + 1 WHERE guild_id = $1 AND name = $2 RETURNING content', [message.guild.id, name]);
        if (tag) return void (await message.channel.send({ content: tag.content, allowedMentions: { parse: [] } }));
      }

      const list = responders.get(message.guild.id);
      if (!list?.length || !message.content) return;
      const hit = matchResponder(list, message.content);
      if (!hit) return;
      const key = `${message.channelId}:${hit.id}`;
      if ((responderCooldown.get(key) ?? 0) > Date.now()) return;
      responderCooldown.set(key, Date.now() + 3000);
      await message.reply({ content: render(hit.response, memberVars(message.member)), allowedMentions: NO_PINGS });
    },
  },
};
