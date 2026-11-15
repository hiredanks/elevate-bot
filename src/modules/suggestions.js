import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate } from '../core/ui.js';
import { noop, truncate } from '../core/util.js';

const STATUS = {
  pending: ['Pending', COLOR.brand], approved: ['Approved', COLOR.ok], denied: ['Denied', COLOR.err], considering: ['Under consideration', COLOR.warn],
};

async function tally(id) {
  const row = await db.one('SELECT COUNT(*) FILTER (WHERE vote = 1) AS up, COUNT(*) FILTER (WHERE vote = -1) AS down FROM suggestion_votes WHERE suggestion_id = $1', [id]);
  return row;
}

function suggestionMessage(s, votes, authorName) {
  const [label, color] = STATUS[s.status];
  const e = new EmbedBuilder().setColor(color).setTitle(`Suggestion #${s.id}`).setDescription(truncate(s.content, 3500))
    .addFields({ name: 'Status', value: label, inline: true }, { name: 'From', value: authorName, inline: true });
  if (s.note) e.addFields({ name: 'Staff note', value: truncate(s.note, 1000) });
  const open = s.status === 'pending' || s.status === 'considering';
  return {
    embeds: [e], allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suggest:vote:${s.id}:1`).setLabel(String(votes.up)).setEmoji('👍').setStyle(ButtonStyle.Success).setDisabled(!open),
      new ButtonBuilder().setCustomId(`suggest:vote:${s.id}:-1`).setLabel(String(votes.down)).setEmoji('👎').setStyle(ButtonStyle.Danger).setDisabled(!open),
    )],
  };
}

const authorLabel = (s, cfg) => (cfg.anonymous ? 'Anonymous' : `<@${s.user_id}>`);

export default {
  name: 'suggestions',
  label: '💡 Suggestions',
  defaults: { channel: null, anonymous: false },
  form: {
    title: 'Suggestions',
    description: 'Members post ideas with /suggest and everyone votes on them.',
    fields: [
      { key: 'channel', type: 'channel', label: 'Suggestions channel' },
      { key: 'anonymous', type: 'bool', label: 'Hide who suggested it' },
    ],
  },

  commands: [
    {
      data: cmd('suggest', 'Share an idea with the server')
        .addStringOption((o) => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1500)),
      cooldown: 30,
      async run(i) {
        const cfg = getSettings(i.guildId).suggestions;
        const channel = i.guild.channels.cache.get(cfg.channel);
        if (!channel) return fail(i, 'Suggestions are not set up yet. Ask an admin to run `/suggestion channel`.');
        const row = await db.one('INSERT INTO suggestions(guild_id, channel_id, user_id, content, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *', [i.guildId, channel.id, i.user.id, i.options.getString('idea', true), Date.now()]);
        const message = await channel.send(suggestionMessage(row, { up: 0, down: 0 }, authorLabel(row, cfg)));
        await db.run('UPDATE suggestions SET message_id = $1 WHERE id = $2', [message.id, row.id]);
        return okPrivate(i, `Suggestion **#${row.id}** posted in ${channel}.`);
      },
    },
    {
      data: cmd('suggestion', 'Manage suggestions', P.ManageGuild)
        .addSubcommand((s) => s.setName('channel').setDescription('Set the suggestions channel')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
        .addSubcommand((s) => s.setName('respond').setDescription('Approve, deny or consider a suggestion')
          .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setRequired(true).setMinValue(1))
          .addStringOption((o) => o.setName('status').setDescription('Decision').setRequired(true)
            .addChoices({ name: 'Approve', value: 'approved' }, { name: 'Deny', value: 'denied' }, { name: 'Under consideration', value: 'considering' }))
          .addStringOption((o) => o.setName('note').setDescription('Explain the decision').setMaxLength(800))),
      async run(i) {
        if (i.options.getSubcommand() === 'channel') {
          const channel = i.options.getChannel('channel', true);
          await updateSettings(i.guildId, (s) => { s.suggestions.channel = channel.id; });
          return ok(i, `Suggestions will be posted in ${channel}.`);
        }
        const id = i.options.getInteger('id', true);
        const row = await db.one('UPDATE suggestions SET status = $1, note = $2 WHERE guild_id = $3 AND id = $4 RETURNING *', [i.options.getString('status', true), i.options.getString('note'), i.guildId, id]);
        if (!row) return fail(i, 'No suggestion with that number.');
        await i.deferReply({ flags: EPHEMERAL });
        const channel = i.guild.channels.cache.get(row.channel_id);
        const message = await channel?.messages.fetch(row.message_id).catch(() => null);
        await message?.edit(suggestionMessage(row, await tally(id), authorLabel(row, getSettings(i.guildId).suggestions))).catch(noop);
        const author = await i.client.users.fetch(row.user_id).catch(() => null);
        await author?.send(`Your suggestion in **${i.guild.name}** is now **${STATUS[row.status][0]}**.${row.note ? `\nNote: ${row.note}` : ''}`).catch(noop);
        return ok(i, `Suggestion #${id} updated.`);
      },
    },
  ],

  components: {
    async 'suggest:vote'(i, [id, value]) {
      const s = await db.one('SELECT * FROM suggestions WHERE id = $1 AND guild_id = $2', [id, i.guildId]);
      if (!s || !['pending', 'considering'].includes(s.status)) return fail(i, 'Voting has closed.');
      const vote = value === '1' ? 1 : -1;
      const existing = await db.one('SELECT vote FROM suggestion_votes WHERE suggestion_id = $1 AND user_id = $2', [id, i.user.id]);
      if (existing?.vote === vote) await db.run('DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND user_id = $2', [id, i.user.id]);
      else await db.run('INSERT INTO suggestion_votes(suggestion_id, user_id, vote) VALUES ($1, $2, $3) ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = excluded.vote', [id, i.user.id, vote]);
      return i.update(suggestionMessage(s, await tally(id), authorLabel(s, getSettings(i.guildId).suggestions)));
    },
  },
};
