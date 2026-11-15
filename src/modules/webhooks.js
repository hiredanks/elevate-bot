import { AttachmentBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { getSettings } from '../core/settings.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, sendTo } from '../core/ui.js';
import { noop, truncate } from '../core/util.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const HOOK_NAME = 'Message sender';
const HTTPS_LINK = /^https:\/\/\S+$/i;
// Discord refuses webhook names containing these words.
const RESERVED_NAME = /discord|clyde/i;
const PING_CHOICES = ['No pings', 'Ping everyone'];

/** One webhook per channel, created on first use and reused after that. */
async function hookFor(channel) {
  const hooks = await channel.fetchWebhooks();
  return hooks.find((h) => h.owner?.id === channel.client.user.id && h.token) ?? channel.createWebhook({ name: HOOK_NAME, reason: 'Custom messages' });
}

/** Posts a message under any name and picture, like a webhook, and records who really sent it. */
export async function sendAs(guild, senderId, msg) {
  const channel = guild.channels.cache.get(msg.channelId);
  if (!channel || !TEXT_CHANNELS.includes(channel.type)) throw new Error('Pick a text channel.');
  const name = (msg.username?.trim() || guild.name).slice(0, 80);
  if (RESERVED_NAME.test(name)) throw new Error('Discord does not allow "discord" or "clyde" in the name.');
  for (const link of [msg.avatarUrl, msg.imageUrl]) if (link && !HTTPS_LINK.test(link)) throw new Error('Picture links must start with https://');
  if (msg.color && !/^#?[0-9a-f]{6}$/i.test(msg.color)) throw new Error('Colors look like #8F7EFF.');
  const hasEmbed = Boolean(msg.title || msg.description || msg.imageUrl || msg.imageFile);
  if (!msg.content && !hasEmbed) throw new Error('Write a message or fill in the embed first.');

  const files = [];
  const embeds = [];
  if (hasEmbed) {
    const e = new EmbedBuilder().setColor(msg.color ? parseInt(msg.color.replace('#', ''), 16) : COLOR.brand);
    if (msg.title) e.setTitle(msg.title);
    if (msg.description) e.setDescription(msg.description);
    if (msg.imageUrl) e.setImage(msg.imageUrl);
    if (msg.imageFile) {
      files.push(msg.imageFile);
      e.setImage(`attachment://${msg.imageFile.name}`);
    }
    embeds.push(e);
  }

  const hook = await hookFor(channel);
  const sent = await hook.send({
    content: msg.content || undefined, username: name, avatarURL: msg.avatarUrl || guild.iconURL({ size: 256 }) || undefined, embeds, files,
    allowedMentions: msg.pingEveryone ? { parse: ['everyone', 'roles'] } : { parse: [] },
  });
  await db.run(
    'INSERT INTO webhook_messages(guild_id, channel_id, message_id, webhook_id, username, content, author_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [guild.id, channel.id, sent.id, hook.id, name, msg.content || msg.title || null, senderId, Date.now()],
  );
  // Anyone can type any name here, so the real sender is always written to the moderation log.
  await sendTo(guild, getSettings(guild.id).moderation.logChannel, {
    embeds: [embed(`<@${senderId}> sent a message as **${name}** in <#${channel.id}>.`, COLOR.brand).setTitle('Webhook message sent').setTimestamp()],
    allowedMentions: { parse: [] },
  });
  return sent;
}

async function removeSent(guild, id) {
  const row = await db.one('SELECT * FROM webhook_messages WHERE guild_id = $1 AND id = $2', [guild.id, id]);
  if (!row) return 0;
  const hook = await guild.client.fetchWebhook(row.webhook_id).catch(() => null);
  await hook?.deleteMessage(row.message_id).catch(noop);
  return db.run('DELETE FROM webhook_messages WHERE id = $1', [row.id]);
}

export default {
  name: 'webhooks',
  label: '🪝 Webhook Messages',

  collections: {
    webhooks: {
      title: 'Webhook messages',
      description: 'Post a message under any name and picture. To ping everyone, choose "Ping everyone" and write @everyone in the message. Removing a row deletes the message from Discord.',
      submitLabel: 'Send message',
      columns: [
        { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
        { key: 'username', label: 'Name shown', type: 'text', max: 80, placeholder: 'ELEVATE' },
        { key: 'avatar_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS_LINK.source, patternFlags: 'i', placeholder: 'https://...', hideInList: true },
        { key: 'content', label: 'Message', type: 'textarea', max: 2000 },
        { key: 'title', label: 'Embed title', type: 'text', max: 256, hideInList: true },
        { key: 'description', label: 'Embed text', type: 'textarea', max: 4000, hideInList: true },
        { key: 'color', label: 'Embed color', type: 'text', max: 7, pattern: '^#?[0-9a-fA-F]{6}$', placeholder: '#8F7EFF', hideInList: true },
        { key: 'image_url', label: 'Embed image link', type: 'text', max: 500, pattern: HTTPS_LINK.source, patternFlags: 'i', placeholder: 'https://...', hideInList: true },
        { key: 'pings', label: 'Pings', type: 'select', options: PING_CHOICES, hideInList: true },
        { key: 'sent', label: 'Sent', type: 'text', readOnly: true },
      ],
      async list(guildId) {
        const rows = await db.all('SELECT * FROM webhook_messages WHERE guild_id = $1 ORDER BY id DESC LIMIT 25', [guildId]);
        return rows.map((r) => ({
          id: r.id, channel_id: r.channel_id, username: r.username, content: truncate(r.content || '(embed only)', 120),
          sent: `${new Date(Number(r.created_at)).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        }));
      },
      create(guild, row, userId) {
        const pingEveryone = row.pings === 'Ping everyone';
        if (pingEveryone && !guild.members.cache.get(userId)?.permissions.has(P.MentionEveryone)) {
          throw new Error('You need the Mention @everyone permission to ping everyone.');
        }
        return sendAs(guild, userId, {
          channelId: row.channel_id, username: row.username, avatarUrl: row.avatar_url, content: row.content,
          title: row.title, description: row.description, color: row.color, imageUrl: row.image_url, pingEveryone,
        });
      },
      remove: (guild, id) => removeSent(guild, id),
    },
  },

  commands: [{
    data: cmd('webhook', 'Send a message with a custom name and picture', P.ManageWebhooks)
      .addChannelOption((o) => o.setName('channel').setDescription('Where to send it').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
      .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(2000))
      .addStringOption((o) => o.setName('name').setDescription('Name shown on the message').setMaxLength(80))
      .addStringOption((o) => o.setName('avatar_url').setDescription('Link to the picture shown beside the name').setMaxLength(500))
      .addStringOption((o) => o.setName('title').setDescription('Embed title').setMaxLength(256))
      .addAttachmentOption((o) => o.setName('image').setDescription('A picture to include'))
      .addStringOption((o) => o.setName('color').setDescription('Embed color, like #8F7EFF').setMaxLength(7))
      .addBooleanOption((o) => o.setName('ping_everyone').setDescription('Allow @everyone in the message to ping')),
    botPerms: [P.ManageWebhooks],
    async run(i) {
      const image = i.options.getAttachment('image');
      if (image && !image.contentType?.startsWith('image/')) return fail(i, 'That attachment is not a picture.');
      const pingEveryone = i.options.getBoolean('ping_everyone') ?? false;
      if (pingEveryone && !i.memberPermissions.has(P.MentionEveryone)) return fail(i, 'You need the Mention @everyone permission to ping everyone.');
      const channel = i.options.getChannel('channel', true);
      await i.deferReply({ flags: EPHEMERAL });
      try {
        await sendAs(i.guild, i.user.id, {
          channelId: channel.id, username: i.options.getString('name'), avatarUrl: i.options.getString('avatar_url'),
          content: i.options.getString('message', true).replace(/\\n/g, '\n'), title: i.options.getString('title'), color: i.options.getString('color'),
          imageFile: image ? new AttachmentBuilder(image.url, { name: `image.${image.contentType.split('/')[1]}` }) : null, pingEveryone,
        });
      } catch (err) {
        if (err.code) throw err;
        return fail(i, err.message);
      }
      return ok(i, `Message sent in ${channel}.`);
    },
  }],
};
