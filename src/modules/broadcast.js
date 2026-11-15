import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { withImage } from '../core/images.js';
import { logger } from '../core/logger.js';
import { getSettings } from '../core/settings.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { fmt, formatDuration, noop, truncate } from '../core/util.js';

const COOLDOWN_MS = 60 * 60_000;
const DRAFT_TTL_MS = 10 * 60_000;
// Spaced out on purpose, and only ever to people who asked for DMs.
const DM_PACE_MS = 1500;
const DM_TOO_FAST = 40003;
const DMS_CLOSED = 50007;
// Marks a send that went only to opted-in members, with no channel post.
const DM_ONLY = 'dm';
const drafts = new Map();
let worker = null;
let stepping = false;

const isTrusted = (guild, userId) => userId === guild.ownerId || getSettings(guild.id).antinuke.trusted.includes(userId);
const subscribers = (guildId) => db.all('SELECT user_id FROM broadcast_subscribers WHERE guild_id = $1', [guildId]);

function subscribeRow(guildId, label = 'Get these by DM too') {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`broadcast:toggle:${guildId}`).setLabel(label).setEmoji('📬').setStyle(ButtonStyle.Secondary));
}

function startWorker(client) {
  if (worker) return;
  worker = setInterval(() => broadcastStep(client).catch((err) => logger.error('Broadcast step failed', err)), DM_PACE_MS);
  worker.unref?.();
}

async function checkCooldown(guildId) {
  const last = await db.one('SELECT MAX(created_at) AS at FROM broadcasts WHERE guild_id = $1', [guildId]);
  const wait = last.at ? last.at + COOLDOWN_MS - Date.now() : 0;
  if (wait > 0) throw new Error(`You can message everyone again in ${formatDuration(wait)}.`);
}

async function queueDms(guild, channelId, authorId, message) {
  // The member cache is filled at startup and kept current, so people who left are skipped without a slow fetch.
  const recipients = (await subscribers(guild.id)).map((s) => s.user_id).filter((id) => guild.members.cache.has(id));
  const row = await db.one(
    'INSERT INTO broadcasts(guild_id, channel_id, author_id, message, total, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [guild.id, channelId, authorId, message, recipients.length, recipients.length ? 'running' : 'done', Date.now()],
  );
  if (recipients.length) {
    await db.run('INSERT INTO broadcast_recipients(broadcast_id, user_id) SELECT $1, unnest($2::text[])', [row.id, recipients]);
    startWorker(guild.client);
  }
  return row;
}

/** Posts to the channel with an @everyone ping, then queues DMs for members who opted in. */
export async function sendBroadcast(guild, channel, authorId, message) {
  await checkCooldown(guild.id);
  await channel.send(await withImage(guild.id, 'broadcast', {
    content: '@everyone',
    embeds: [embed(message).setTitle(`Message from ${guild.name}`)],
    components: [subscribeRow(guild.id)],
    allowedMentions: { parse: ['everyone'] },
  }));
  return queueDms(guild, channel.id, authorId, message);
}

/** DMs members who opted in, with no channel post. Members who did not opt in are never messaged. */
export async function sendDmAll(guild, authorId, message) {
  if (!(await subscribers(guild.id)).some((s) => guild.members.cache.has(s.user_id))) {
    throw new Error('Nobody has signed up for DMs yet. Post the sign-up button with /dm-all panel.');
  }
  await checkCooldown(guild.id);
  return queueDms(guild, DM_ONLY, authorId, message);
}

const historyRows = async (guildId, condition) => {
  const rows = await db.all(`SELECT * FROM broadcasts WHERE guild_id = $1 AND channel_id ${condition} $2 ORDER BY id DESC LIMIT 25`, [guildId, DM_ONLY]);
  return rows.map((r) => ({ id: r.id, message: r.message, channel_id: r.channel_id, dms: `${r.sent} of ${r.total} (${r.status})` }));
};

async function deliver(client, job, userId) {
  await db.run('DELETE FROM broadcast_recipients WHERE broadcast_id = $1 AND user_id = $2', [job.id, userId]);
  const guild = client.guilds.cache.get(job.guild_id);
  const stillOptedIn = await db.one('SELECT 1 AS y FROM broadcast_subscribers WHERE guild_id = $1 AND user_id = $2', [job.guild_id, userId]);
  if (!guild || !stillOptedIn) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send({
      embeds: [embed(job.message).setTitle(`Message from ${guild.name}`).setFooter({ text: 'You chose to get these by DM. The button below stops them.' })],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`broadcast:stop:${job.guild_id}`).setLabel('Stop these DMs').setStyle(ButtonStyle.Secondary))],
      allowedMentions: { parse: [] },
    });
    await db.run('UPDATE broadcasts SET sent = sent + 1 WHERE id = $1', [job.id]);
  } catch (err) {
    // If Discord objects, stop at once instead of pushing on and risking the bot.
    if (err.code === DM_TOO_FAST || /anti-?spam|flagged/i.test(err.message)) {
      await db.run("UPDATE broadcasts SET status = 'stopped' WHERE id = $1", [job.id]);
      await db.run('DELETE FROM broadcast_recipients WHERE broadcast_id = $1', [job.id]);
      logger.warn(`Broadcast ${job.id} stopped: Discord refused DMs (${err.message})`);
      return;
    }
    await db.run('UPDATE broadcasts SET failed = failed + 1 WHERE id = $1', [job.id]);
  }
}

/** Sends one DM. Runs on a slow timer, one message at a time across the whole bot. */
export async function broadcastStep(client) {
  if (stepping) return;
  stepping = true;
  try {
    const job = await db.one("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1");
    if (!job) {
      clearInterval(worker);
      worker = null;
      return;
    }
    const next = await db.one('SELECT user_id FROM broadcast_recipients WHERE broadcast_id = $1 LIMIT 1', [job.id]);
    if (next) await deliver(client, job, next.user_id);
    else await db.run("UPDATE broadcasts SET status = 'done' WHERE id = $1", [job.id]);
  } finally {
    stepping = false;
  }
}

async function removeBroadcast(guildId, id) {
  await db.run('DELETE FROM broadcast_recipients WHERE broadcast_id IN (SELECT id FROM broadcasts WHERE guild_id = $1 AND id = $2)', [guildId, id]);
  return db.run('DELETE FROM broadcasts WHERE guild_id = $1 AND id = $2', [guildId, id]);
}

export default {
  name: 'broadcast',
  label: '📣 Messaging',

  collections: {
    broadcasts: {
      title: 'Message everyone',
      description: 'Posts in a channel and pings @everyone, so every member gets notified. Members who pressed "Get these by DM too" also get a DM. You can send one per hour.',
      ownerOnly: true,
      submitLabel: 'Send to everyone',
      confirmLabel: 'Confirm: ping everyone',
      removeLabel: 'Remove',
      columns: [
        { key: 'message', label: 'Message', type: 'textarea', max: 1800, required: true },
        { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
        { key: 'dms', label: 'DMs sent', type: 'text', readOnly: true },
      ],
      list: (guildId) => historyRows(guildId, '<>'),
      create(guild, row, userId) {
        return sendBroadcast(guild, guild.channels.cache.get(row.channel_id), userId, row.message);
      },
      remove: (guild, id) => removeBroadcast(guild.id, id),
    },
    dmall: {
      title: 'DM signed-up members',
      description: 'DMs every member who signed up. Post the sign-up button in Discord with /dm-all panel. You can send one message per hour.',
      ownerOnly: true,
      submitLabel: 'Send DMs',
      confirmLabel: 'Confirm: send DMs',
      removeLabel: 'Remove',
      columns: [
        { key: 'message', label: 'Message', type: 'textarea', max: 1800, required: true },
        { key: 'dms', label: 'DMs sent', type: 'text', readOnly: true },
      ],
      list: (guildId) => historyRows(guildId, '='),
      create: (guild, row, userId) => sendDmAll(guild, userId, row.message),
      remove: (guild, id) => removeBroadcast(guild.id, id),
    },
  },

  commands: [{
    data: cmd('dm', 'Send a private message to one member', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Who to message').setRequired(true))
      .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(1800)),
    cooldown: 10,
    async run(i) {
      const user = i.options.getUser('user', true);
      if (user.bot) return fail(i, 'Bots cannot receive DMs.');
      if (!i.options.getMember('user')) return fail(i, 'That user is not in this server.');
      const message = i.options.getString('message', true).replace(/\\n/g, '\n');
      await i.deferReply({ flags: EPHEMERAL });
      try {
        await user.send({ embeds: [embed(message).setTitle(`Message from the staff of ${i.guild.name}`)], allowedMentions: { parse: [] } });
      } catch (err) {
        if (err.code === DMS_CLOSED) return fail(i, `**${user.username}** does not accept DMs, so the message was not delivered.`);
        throw err;
      }
      // Staff can write anything here, so every DM is recorded with who sent it.
      await sendTo(i.guild, getSettings(i.guildId).moderation.logChannel, {
        embeds: [embed(truncate(message, 1500), COLOR.brand).setTitle('DM sent by staff').addFields(
          { name: 'From', value: `<@${i.user.id}>`, inline: true },
          { name: 'To', value: `<@${user.id}>`, inline: true },
        ).setTimestamp()],
        allowedMentions: { parse: [] },
      });
      return ok(i, `Message sent to **${user.username}**.`);
    },
  }, {
    data: cmd('dm-all', 'DM every member who signed up (server owner only)', P.Administrator)
      .addSubcommand((s) => s.setName('send').setDescription('DM every member who signed up')
        .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(1800)))
      .addSubcommand((s) => s.setName('panel').setDescription('Post a button members can press to sign up for DMs')
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName('count').setDescription('See how many members signed up')),
    async run(i) {
      if (!isTrusted(i.guild, i.user.id)) return fail(i, 'Only the server owner or trusted users can use this.');
      const sub = i.options.getSubcommand();
      const opted = (await subscribers(i.guildId)).filter((s) => i.guild.members.cache.has(s.user_id)).length;
      if (sub === 'count') return okPrivate(i, `**${fmt(opted)}** of ${fmt(i.guild.memberCount)} members have signed up for DMs.`);
      if (sub === 'panel') {
        const channel = i.options.getChannel('channel') ?? i.channel;
        await channel.send({
          embeds: [embed('Press the button to get messages from this server by DM. Press it again whenever you want to stop.').setTitle('Get server news by DM')],
          components: [subscribeRow(i.guildId, 'Get DMs from this server')],
          allowedMentions: { parse: [] },
        });
        return okPrivate(i, `Sign-up button posted in ${channel}.`);
      }
      if (!opted) return fail(i, 'Nobody has signed up for DMs yet. Post the sign-up button with `/dm-all panel`.');
      const message = i.options.getString('message', true).replace(/\\n/g, '\n');
      const draftId = randomUUID();
      drafts.set(draftId, { message, dmOnly: true, userId: i.user.id, expires: Date.now() + DRAFT_TTL_MS });
      return i.reply({
        embeds: [embed(`This DMs the **${fmt(opted)}** members who signed up.\n\n${truncate(message, 1500)}`, COLOR.warn).setTitle('Send these DMs?')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`broadcast:confirm:${draftId}`).setLabel('Send DMs').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`broadcast:cancel:${draftId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
        flags: EPHEMERAL,
      });
    },
  }, {
    data: cmd('broadcast', 'Send a message to every member (server owner only)', P.Administrator)
      .addSubcommand((s) => s.setName('send').setDescription('Ping @everyone in a channel, and DM members who opted in')
        .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(1800))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName('status').setDescription('See how the last message is going')),
    async run(i) {
      if (!isTrusted(i.guild, i.user.id)) return fail(i, 'Only the server owner or trusted users can message everyone.');
      if (i.options.getSubcommand() === 'status') {
        const last = await db.one('SELECT * FROM broadcasts WHERE guild_id = $1 ORDER BY id DESC LIMIT 1', [i.guildId]);
        if (!last) return okPrivate(i, 'Nothing has been sent yet.');
        return okPrivate(i, `**Status:** ${last.status}\n**DMs sent:** ${fmt(last.sent)} of ${fmt(last.total)}\n**Failed:** ${fmt(last.failed)}`);
      }
      const message = i.options.getString('message', true).replace(/\\n/g, '\n');
      const channel = i.options.getChannel('channel') ?? i.channel;
      const opted = (await subscribers(i.guildId)).length;
      const draftId = randomUUID();
      drafts.set(draftId, { message, channelId: channel.id, userId: i.user.id, expires: Date.now() + DRAFT_TTL_MS });
      return i.reply({
        embeds: [embed(`This posts in ${channel} and pings **@everyone** (${fmt(i.guild.memberCount)} members). **${fmt(opted)}** members who opted in also get a DM.\n\n${truncate(message, 1500)}`, COLOR.warn).setTitle('Send to everyone?')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`broadcast:confirm:${draftId}`).setLabel('Send to everyone').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`broadcast:cancel:${draftId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
        flags: EPHEMERAL,
      });
    },
  }],

  components: {
    async 'broadcast:confirm'(i, [draftId]) {
      const draft = drafts.get(draftId);
      drafts.delete(draftId);
      if (!draft || draft.expires < Date.now() || draft.userId !== i.user.id) return fail(i, 'That draft expired. Run the command again.');
      await i.deferUpdate();
      try {
        if (draft.dmOnly) await sendDmAll(i.guild, i.user.id, draft.message);
        else await sendBroadcast(i.guild, i.guild.channels.cache.get(draft.channelId), i.user.id, draft.message);
        return i.editReply({ content: '✅ Sent.', embeds: [], components: [] });
      } catch (err) {
        if (err.code) throw err;
        return i.editReply({ content: `❌ ${err.message}`, embeds: [], components: [] });
      }
    },
    'broadcast:cancel': (i, [draftId]) => {
      drafts.delete(draftId);
      return i.update({ content: 'Cancelled.', embeds: [], components: [] });
    },
    async 'broadcast:toggle'(i, [guildId]) {
      const removed = await db.run('DELETE FROM broadcast_subscribers WHERE guild_id = $1 AND user_id = $2', [guildId, i.user.id]);
      if (removed) return okPrivate(i, 'You will no longer get these by DM.');
      await db.run('INSERT INTO broadcast_subscribers(guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [guildId, i.user.id]);
      return okPrivate(i, 'You will get these by DM from now on. Press the button again to stop.');
    },
    async 'broadcast:stop'(i, [guildId]) {
      await db.run('DELETE FROM broadcast_subscribers WHERE guild_id = $1 AND user_id = $2', [guildId, i.user.id]);
      await i.update({ components: [] }).catch(noop);
      return i.followUp({ content: 'You will no longer get these by DM.', flags: EPHEMERAL });
    },
  },

  async ready(client) {
    const active = await db.one("SELECT 1 AS y FROM broadcasts WHERE status = 'running' LIMIT 1");
    if (active) startWorker(client);
  },
};
