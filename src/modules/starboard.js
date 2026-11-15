import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, fail, ok } from '../core/ui.js';
import { emojiKey, keyedQueue, noop, parseEmoji, truncate } from '../core/util.js';

const perMessage = keyedQueue();

function starEmbed(message) {
  const e = new EmbedBuilder().setColor(COLOR.gold)
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL() })
    .setDescription(truncate(message.content, 3500) || null)
    .addFields({ name: 'Source', value: `[Jump to message](${message.url})` })
    .setTimestamp(message.createdTimestamp);
  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (image) e.setImage(image.url);
  return e;
}

async function update(reaction) {
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  const { guild } = message;
  const cfg = getSettings(guild.id).starboard;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  const board = guild.channels.cache.get(cfg.channel);
  if (!board?.isTextBased() || message.channelId === board.id || cfg.ignored.includes(message.channelId) || message.author.bot) return;

  let count = full?.count ?? 0;
  if (count && !cfg.selfStar) {
    const users = await full.users.fetch({ limit: 100 });
    if (users.has(message.author.id)) count -= 1;
  }

  const existing = await db.one('SELECT star_message_id FROM starboard WHERE message_id = $1', [message.id]);
  const posted = existing && (await board.messages.fetch(existing.star_message_id).catch(() => null));
  if (count < cfg.threshold) {
    if (posted) await posted.delete().catch(noop);
    if (existing) await db.run('DELETE FROM starboard WHERE message_id = $1', [message.id]);
    return;
  }
  const content = `${cfg.emoji} **${count}** <#${message.channelId}>`;
  if (posted) return void (await posted.edit({ content }));
  const sent = await board.send({ content, embeds: [starEmbed(message)], allowedMentions: { parse: [] } });
  await db.run(
    'INSERT INTO starboard(message_id, guild_id, star_message_id) VALUES ($1, $2, $3) ON CONFLICT (message_id) DO UPDATE SET star_message_id = excluded.star_message_id',
    [message.id, guild.id, sent.id],
  );
}

function onReaction(reaction, user) {
  const guild = reaction.message.guild;
  if (!guild || user.bot) return null;
  const cfg = getSettings(guild.id).starboard;
  if (!cfg.enabled || !cfg.channel || emojiKey(reaction.emoji) !== parseEmoji(cfg.emoji)?.key) return null;
  return perMessage(reaction.message.id, () => update(reaction));
}

export default {
  name: 'starboard',
  label: '⭐ Starboard',
  defaults: { enabled: false, channel: null, emoji: '⭐', threshold: 3, selfStar: false, ignored: [] },
  form: {
    title: 'Starboard',
    description: 'Messages that get enough reactions are saved in a hall-of-fame channel.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable starboard' },
      { key: 'channel', type: 'channel', label: 'Starboard channel' },
      { key: 'emoji', type: 'text', label: 'Emoji', max: 40, required: true, format: 'emoji' },
      { key: 'threshold', type: 'int', label: 'Reactions needed', min: 1, max: 100 },
      { key: 'selfStar', type: 'bool', label: 'Count people starring themselves' },
      { key: 'ignored', type: 'channels', label: 'Channels to ignore' },
    ],
  },

  commands: [{
    data: cmd('starboard', 'Save popular messages in a channel', P.ManageGuild)
      .addSubcommand((s) => s.setName('setup').setDescription('Turn on the starboard')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('threshold').setDescription('Reactions needed').setMinValue(1).setMaxValue(100))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji to count, default ⭐')))
      .addSubcommand((s) => s.setName('off').setDescription('Turn off the starboard')),
    async run(i) {
      if (i.options.getSubcommand() === 'off') {
        await updateSettings(i.guildId, (s) => { s.starboard.enabled = false; });
        return ok(i, 'Starboard turned off.');
      }
      const rawEmoji = i.options.getString('emoji');
      const emoji = rawEmoji ? parseEmoji(rawEmoji) : null;
      if (rawEmoji && !emoji) return fail(i, 'That does not look like an emoji.');
      const channel = i.options.getChannel('channel', true);
      const threshold = i.options.getInteger('threshold');
      await updateSettings(i.guildId, (s) => {
        s.starboard.enabled = true;
        s.starboard.channel = channel.id;
        if (threshold) s.starboard.threshold = threshold;
        if (emoji) s.starboard.emoji = emoji.display;
      });
      return ok(i, `Starboard is live in ${channel}.`);
    },
  }],

  events: { messageReactionAdd: onReaction, messageReactionRemove: onReaction },
};
