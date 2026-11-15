import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  OverwriteType, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { db, nextCounter } from '../core/db.js';
import { withImage } from '../core/images.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { noop, sleep, truncate } from '../core/util.js';

const ACCESS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const TRANSCRIPT_LIMIT = 1000;

const ticketIn = (channelId) => db.one("SELECT * FROM tickets WHERE channel_id = $1 AND status = 'open'", [channelId]);
const isStaff = (member) => member.permissions.has(P.ManageChannels) || getSettings(member.guild.id).tickets.supportRoles.some((id) => member.roles.cache.has(id));

export async function postTicketPanel(guild) {
  const cfg = getSettings(guild.id).tickets;
  const channel = guild.channels.cache.get(cfg.panelChannel);
  if (!channel?.isTextBased()) throw new Error('Pick a panel channel first.');
  await channel.send(await withImage(guild.id, 'ticket_panel', {
    embeds: [embed(cfg.panelMessage, COLOR.brand).setTitle(cfg.panelTitle)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))],
  }));
  return `Ticket panel posted in #${channel.name}.`;
}

async function buildTranscript(channel) {
  const lines = [];
  let before;
  while (lines.length < TRANSCRIPT_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const m of batch.values()) {
      const files = m.attachments.size ? ` [files: ${m.attachments.map((a) => a.url).join(' ')}]` : '';
      lines.push(`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.username}: ${m.content}${files}`);
    }
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return lines.reverse().join('\n');
}

async function closeTicket(channel, closedBy, reason) {
  const ticket = await ticketIn(channel.id);
  if (!ticket) return false;
  const cfg = getSettings(channel.guild.id).tickets;
  const transcript = await buildTranscript(channel);
  await db.run("UPDATE tickets SET status = 'closed', closed_at = $1 WHERE id = $2", [Date.now(), ticket.id]);
  const summary = new EmbedBuilder().setColor(COLOR.warn).setTitle(`Ticket #${ticket.number} closed`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'Closed by', value: `<@${closedBy.id}>`, inline: true },
      { name: 'Claimed by', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Nobody', inline: true },
      { name: 'Subject', value: truncate(ticket.subject || 'None', 1000) },
      { name: 'Close reason', value: truncate(reason || 'None', 1000) },
    ).setTimestamp();
  await sendTo(channel.guild, cfg.logChannel, {
    embeds: [summary], files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `ticket-${ticket.number}.txt` })], allowedMentions: { parse: [] },
  });
  await channel.send({ embeds: [embed('This ticket will be deleted in a few seconds.', COLOR.err)] }).catch(noop);
  await sleep(channel.client.ticketCloseDelay ?? 4000);
  await channel.delete(`Ticket closed by ${closedBy.username}`).catch(noop);
  return true;
}

async function openTicket(i, subject) {
  const cfg = getSettings(i.guildId).tickets;
  const open = (await db.one("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open'", [i.guildId, i.user.id])).n;
  if (open >= cfg.maxOpen) return fail(i, 'You already have an open ticket.');
  await i.deferReply({ flags: EPHEMERAL });
  const number = await nextCounter(i.guildId, 'ticket');
  const channel = await i.guild.channels.create({
    name: `ticket-${String(number).padStart(4, '0')}`, type: ChannelType.GuildText,
    parent: i.guild.channels.cache.has(cfg.category) ? cfg.category : undefined,
    topic: truncate(`Ticket by ${i.user.username}: ${subject}`, 1000),
    permissionOverwrites: [
      { id: i.guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: i.user.id, type: OverwriteType.Member, allow: ACCESS },
      { id: i.guild.members.me.id, type: OverwriteType.Member, allow: [...ACCESS, P.ManageChannels] },
      ...cfg.supportRoles.filter((id) => i.guild.roles.cache.has(id)).map((id) => ({ id, type: OverwriteType.Role, allow: ACCESS })),
    ],
    reason: `Ticket for ${i.user.username}`,
  });
  await db.run('INSERT INTO tickets(guild_id, channel_id, user_id, number, subject, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [i.guildId, channel.id, i.user.id, number, subject, Date.now()]);
  const pings = [`<@${i.user.id}>`, ...cfg.supportRoles.map((id) => `<@&${id}>`)].join(' ');
  await channel.send(await withImage(i.guildId, 'ticket_open', {
    content: pings,
    embeds: [embed(cfg.openMessage, COLOR.brand).setTitle(`Ticket #${number}`).addFields({ name: 'Subject', value: truncate(subject, 1000) })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [i.user.id], roles: cfg.supportRoles },
  }));
  return ok(i, `Your ticket is ready: ${channel}`);
}

export default {
  name: 'tickets',
  label: '🎫 Tickets',
  defaults: {
    category: null, supportRoles: [], logChannel: null, panelChannel: null, maxOpen: 1, panelTitle: 'Need help?',
    panelMessage: 'Press the button below to open a private ticket with the staff team.',
    openMessage: 'Thanks for reaching out. Please describe your issue and someone will be with you shortly.',
  },
  form: {
    title: 'Tickets',
    description: 'Private support channels opened with one button.',
    fields: [
      { key: 'panelChannel', type: 'channel', label: 'Panel channel' },
      { key: 'category', type: 'channel', channelKind: 'category', label: 'Category for ticket channels' },
      { key: 'supportRoles', type: 'roles', label: 'Support roles' },
      { key: 'logChannel', type: 'channel', label: 'Transcript channel' },
      { key: 'maxOpen', type: 'int', label: 'Open tickets per member', min: 1, max: 10 },
      { key: 'panelTitle', type: 'text', label: 'Panel title', max: 100 },
      { key: 'panelMessage', type: 'textarea', label: 'Panel message', max: 1500 },
      { key: 'openMessage', type: 'textarea', label: 'First message in a ticket', max: 1500 },
    ],
    actions: [{ id: 'post', label: 'Post ticket panel' }],
  },
  actions: { post: (guild) => postTicketPanel(guild) },

  commands: [{
    data: cmd('ticket', 'Support tickets')
      .addSubcommand((s) => s.setName('setup').setDescription('Post the ticket panel (Manage Server)')
        .addChannelOption((o) => o.setName('channel').setDescription('Panel channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName('category').setDescription('Category for tickets').addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('support_role').setDescription('Staff role that sees tickets'))
        .addChannelOption((o) => o.setName('log_channel').setDescription('Where transcripts go').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('close').setDescription('Close this ticket')
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(500)))
      .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand((s) => s.setName('rename').setDescription('Rename this ticket')
        .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90))),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'setup') {
        if (!i.memberPermissions.has(P.ManageGuild)) return fail(i, 'You need Manage Server to do that.');
        const channel = i.options.getChannel('channel', true);
        const category = i.options.getChannel('category');
        const role = i.options.getRole('support_role');
        const log = i.options.getChannel('log_channel');
        await updateSettings(i.guildId, (s) => {
          s.tickets.panelChannel = channel.id;
          if (category) s.tickets.category = category.id;
          if (role) s.tickets.supportRoles = [...new Set([...s.tickets.supportRoles, role.id])];
          if (log) s.tickets.logChannel = log.id;
        });
        await postTicketPanel(i.guild);
        return okPrivate(i, `Ticket panel posted in ${channel}.`);
      }
      const ticket = await ticketIn(i.channelId);
      if (!ticket) return fail(i, 'This is not a ticket channel.');
      if (sub === 'close') {
        if (ticket.user_id !== i.user.id && !isStaff(i.member)) return fail(i, 'Only staff or the ticket owner can close this.');
        await ok(i, 'Closing...');
        await closeTicket(i.channel, i.user, i.options.getString('reason'));
        return null;
      }
      if (!isStaff(i.member)) return fail(i, 'Only staff can do that.');
      if (sub === 'rename') {
        await i.channel.setName(i.options.getString('name', true));
        return ok(i, 'Ticket renamed.');
      }
      const user = i.options.getUser('user', true);
      if (sub === 'add') {
        await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return ok(i, `${user} was added.`);
      }
      await i.channel.permissionOverwrites.delete(user.id);
      return ok(i, `${user} was removed.`);
    },
  }],

  components: {
    'ticket:open': (i) => i.showModal(new ModalBuilder().setCustomId('ticket:submit').setTitle('Open a ticket').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800)),
    )),
    'ticket:submit': (i) => openTicket(i, i.fields.getTextInputValue('subject')),
    async 'ticket:claim'(i) {
      const ticket = await ticketIn(i.channelId);
      if (!ticket) return fail(i, 'This ticket is closed.');
      if (!isStaff(i.member)) return fail(i, 'Only staff can claim tickets.');
      if (ticket.claimed_by) return fail(i, `Already claimed by <@${ticket.claimed_by}>.`);
      await db.run('UPDATE tickets SET claimed_by = $1 WHERE id = $2', [i.user.id, ticket.id]);
      return ok(i, `${i.user} is handling this ticket.`, { allowedMentions: { parse: [] } });
    },
    async 'ticket:close'(i) {
      const ticket = await ticketIn(i.channelId);
      if (!ticket) return fail(i, 'This ticket is already closed.');
      if (ticket.user_id !== i.user.id && !isStaff(i.member)) return fail(i, 'Only staff or the ticket owner can close this.');
      return i.reply({
        content: 'Close this ticket?',
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:confirm').setLabel('Yes, close it').setStyle(ButtonStyle.Danger))],
        flags: EPHEMERAL,
      });
    },
    async 'ticket:confirm'(i) {
      const ticket = await ticketIn(i.channelId);
      if (!ticket) return fail(i, 'This ticket is already closed.');
      if (ticket.user_id !== i.user.id && !isStaff(i.member)) return fail(i, 'Only staff or the ticket owner can close this.');
      await i.update({ content: 'Closing...', components: [] });
      await closeTicket(i.channel, i.user, null);
      return null;
    },
  },

  events: {
    channelDelete: (channel) => db.run("UPDATE tickets SET status = 'closed', closed_at = $1 WHERE channel_id = $2 AND status = 'open'", [Date.now(), channel.id]),
  },
};
