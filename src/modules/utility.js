import {
  ActionRowBuilder, AttachmentBuilder, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits as P, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, version as djsVersion,
} from 'discord.js';
import { commands } from '../core/registry.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, respond, sendTo } from '../core/ui.js';
import { formatDuration, fmt, pick, rand, truncate, ts } from '../core/util.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const snipes = new Map();
const ANSWERS = ['Yes.', 'No.', 'Absolutely.', 'Not a chance.', 'Ask again later.', 'Probably.', 'Unlikely.', 'Without a doubt.', 'Better not tell you now.'];
const RPS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function helpCategories() {
  const groups = new Map();
  for (const c of commands.values()) {
    if (!c.module.label) continue;
    if (!groups.has(c.module.name)) groups.set(c.module.name, { label: c.module.label, items: [] });
    groups.get(c.module.name).items.push(c);
  }
  return groups;
}

function helpMenu() {
  const options = [...helpCategories()].slice(0, 25).map(([value, g]) => ({ label: g.label, value, description: `${g.items.length} command(s)` }));
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('help:cat').setPlaceholder('Choose a category').addOptions(options));
}

const describe = (c) => {
  const json = c.data.toJSON();
  const subs = (json.options ?? []).filter((o) => o.type === 1).map((o) => o.name);
  return `**/${json.name}**${subs.length ? ` \`${subs.join(' · ')}\`` : ''}\n${json.description}`;
};

const hexColor = (input) => (/^#?[0-9a-f]{6}$/i.test(input ?? '') ? parseInt(input.replace('#', ''), 16) : COLOR.brand);

export default {
  name: 'utility',
  label: '🧰 Utility',

  commands: [
    {
      data: cmd('help', 'See everything the bot can do'),
      run(i) {
        const groups = helpCategories();
        const body = [...groups.values()].map((g) => `${g.label}: **${g.items.length}** commands`).join('\n');
        return respond(i, { embeds: [embed(`${body}\n\nPick a category below.`).setTitle(`${i.client.user.username} commands`)], components: [helpMenu()], flags: EPHEMERAL });
      },
    },
    {
      data: cmd('ping', 'Check the bot\'s response time'),
      run: (i) => ok(i, `Gateway latency: **${Math.round(i.client.ws.ping)} ms**`),
    },
    {
      data: cmd('botinfo', 'About this bot'),
      run(i) {
        const e = new EmbedBuilder().setColor(COLOR.brand).setTitle(i.client.user.username).addFields(
          { name: 'Servers', value: fmt(i.client.guilds.cache.size), inline: true },
          { name: 'Commands', value: fmt(commands.size), inline: true },
          { name: 'Uptime', value: formatDuration(i.client.uptime), inline: true },
          { name: 'Node', value: process.version, inline: true },
          { name: 'discord.js', value: djsVersion, inline: true },
        );
        return respond(i, { embeds: [e] });
      },
    },
    {
      data: cmd('userinfo', 'Information about a user').addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
      run(i) {
        const user = i.options.getUser('user') ?? i.user;
        const member = i.options.getMember('user') ?? (user.id === i.user.id ? i.member : null);
        const e = new EmbedBuilder().setColor(member?.displayColor || COLOR.brand).setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields({ name: 'ID', value: user.id, inline: true }, { name: 'Account created', value: ts(user.createdTimestamp), inline: true });
        if (member) {
          const roles = member.roles.cache.filter((r) => r.id !== i.guildId).sort((a, b) => b.position - a.position).map((r) => `<@&${r.id}>`);
          e.addFields(
            { name: 'Joined server', value: member.joinedTimestamp ? ts(member.joinedTimestamp) : 'Unknown', inline: true },
            { name: `Roles (${roles.length})`, value: truncate(roles.join(' '), 1000) || 'None' },
          );
        }
        return respond(i, { embeds: [e], allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('serverinfo', 'Information about this server'),
      async run(i) {
        const g = i.guild;
        const channels = g.channels.cache;
        const e = new EmbedBuilder().setColor(COLOR.brand).setTitle(g.name).setThumbnail(g.iconURL({ size: 256 })).addFields(
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Members', value: fmt(g.memberCount), inline: true },
          { name: 'Created', value: ts(g.createdTimestamp), inline: true },
          { name: 'Text channels', value: fmt(channels.filter((c) => c.type === ChannelType.GuildText).size), inline: true },
          { name: 'Voice channels', value: fmt(channels.filter((c) => c.type === ChannelType.GuildVoice).size), inline: true },
          { name: 'Roles', value: fmt(g.roles.cache.size), inline: true },
          { name: 'Boosts', value: `${fmt(g.premiumSubscriptionCount ?? 0)} (tier ${g.premiumTier})`, inline: true },
        ).setFooter({ text: `ID: ${g.id}` });
        return respond(i, { embeds: [e], allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('avatar', 'Show someone\'s avatar').addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
      run(i) {
        const user = i.options.getUser('user') ?? i.user;
        const url = user.displayAvatarURL({ size: 1024 });
        return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle(user.username).setURL(url).setImage(url)] });
      },
    },
    {
      data: cmd('roleinfo', 'Information about a role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
      run(i) {
        const role = i.options.getRole('role', true);
        const perms = role.permissions.has(P.Administrator) ? 'Administrator' : role.permissions.toArray().join(', ');
        const e = new EmbedBuilder().setColor(role.color || COLOR.brand).setTitle(role.name).addFields(
          { name: 'ID', value: role.id, inline: true }, { name: 'Members', value: fmt(role.members.size), inline: true },
          { name: 'Color', value: role.hexColor, inline: true }, { name: 'Created', value: ts(role.createdTimestamp), inline: true },
          { name: 'Permissions', value: truncate(perms, 1000) || 'None' },
        );
        return respond(i, { embeds: [e] });
      },
    },
    {
      data: cmd('membercount', 'How many members are here'),
      run: (i) => ok(i, `**${i.guild.name}** has **${fmt(i.guild.memberCount)}** members.`),
    },
    {
      data: cmd('embed', 'Build and post a custom embed', P.ManageMessages)
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(...TEXT_CHANNELS)),
      run(i) {
        const channel = i.options.getChannel('channel') ?? i.channel;
        const input = (id, label, style, required, max) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max));
        return i.showModal(new ModalBuilder().setCustomId(`embed:submit:${channel.id}`).setTitle('Embed builder').addComponents(
          input('title', 'Title', TextInputStyle.Short, false, 256),
          input('description', 'Description', TextInputStyle.Paragraph, true, 4000),
          input('color', 'Color (hex, like #5865F2)', TextInputStyle.Short, false, 7),
          input('image', 'Image URL (https)', TextInputStyle.Short, false, 500),
          input('footer', 'Footer', TextInputStyle.Short, false, 2048),
        ));
      },
    },
    {
      data: cmd('say', 'Make the bot post a message', P.ManageMessages)
        .addStringOption((o) => o.setName('message').setDescription('Text').setRequired(true).setMaxLength(1900))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(...TEXT_CHANNELS)),
      async run(i) {
        const channel = i.options.getChannel('channel') ?? i.channel;
        await channel.send({ content: i.options.getString('message', true).replace(/\\n/g, '\n'), allowedMentions: { parse: [] } });
        return okPrivate(i, 'Sent.');
      },
    },
    {
      data: cmd('announce', 'Post an announcement', P.ManageGuild)
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addStringOption((o) => o.setName('message').setDescription('Text').setRequired(true).setMaxLength(3900))
        .addStringOption((o) => o.setName('title').setDescription('Title').setMaxLength(200))
        .addRoleOption((o) => o.setName('ping').setDescription('Role to ping'))
        .addAttachmentOption((o) => o.setName('image').setDescription('A picture to include')),
      async run(i) {
        const channel = i.options.getChannel('channel', true);
        const role = i.options.getRole('ping');
        if (role && role.id !== i.guildId && !role.mentionable && !i.memberPermissions.has(P.MentionEveryone)) return fail(i, 'You cannot ping that role.');
        const image = i.options.getAttachment('image');
        if (image && !image.contentType?.startsWith('image/')) return fail(i, 'That attachment is not a picture.');
        const e = embed(i.options.getString('message', true).replace(/\\n/g, '\n'));
        const title = i.options.getString('title');
        if (title) e.setTitle(title);
        const files = image ? [new AttachmentBuilder(image.url, { name: `announcement.${image.contentType.split('/')[1]}` })] : [];
        if (image) e.setImage(`attachment://${files[0].name}`);
        const sent = await sendTo(i.guild, channel.id, { content: role ? `<@&${role.id}>` : undefined, embeds: [e], files, allowedMentions: { roles: role ? [role.id] : [] } });
        return sent ? okPrivate(i, `Announcement posted in ${channel}.`) : fail(i, 'I could not post in that channel.');
      },
    },
    {
      data: cmd('poll', 'Create a poll')
        .addStringOption((o) => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(300))
        .addStringOption((o) => o.setName('options').setDescription('Answers separated by | (up to 10)').setRequired(true).setMaxLength(800))
        .addIntegerOption((o) => o.setName('hours').setDescription('How long it runs').setMinValue(1).setMaxValue(336))
        .addBooleanOption((o) => o.setName('multiple').setDescription('Allow several answers')),
      cooldown: 10,
      async run(i) {
        const answers = i.options.getString('options', true).split('|').map((s) => s.trim()).filter(Boolean);
        if (answers.length < 2 || answers.length > 10) return fail(i, 'Give between 2 and 10 answers, separated by `|`.');
        if (answers.some((a) => a.length > 55)) return fail(i, 'Each answer can be 55 characters at most.');
        await i.reply({ poll: {
          question: { text: i.options.getString('question', true) }, answers: answers.map((text) => ({ text })),
          duration: i.options.getInteger('hours') ?? 24, allowMultiselect: i.options.getBoolean('multiple') ?? false,
        } });
        return null;
      },
    },
    {
      data: cmd('snipe', 'Show the last deleted message here', P.ManageMessages),
      run(i) {
        const entry = snipes.get(i.channelId);
        if (!entry) return fail(i, 'Nothing to snipe.');
        const e = new EmbedBuilder().setColor(COLOR.warn).setAuthor({ name: entry.author, iconURL: entry.avatar }).setDescription(truncate(entry.content, 4000) || '(no text)').setTimestamp(entry.at);
        return respond(i, { embeds: [e], allowedMentions: { parse: [] } });
      },
    },
    { data: cmd('8ball', 'Ask the magic ball').addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(300)), run: (i) => respond(i, { content: `🎱 ${pick(ANSWERS)}` }) },
    { data: cmd('coinflip', 'Flip a coin'), run: (i) => respond(i, { content: `🪙 **${pick(['Heads', 'Tails'])}**` }) },
    {
      data: cmd('roll', 'Roll a die').addIntegerOption((o) => o.setName('sides').setDescription('Sides, default 6').setMinValue(2).setMaxValue(1_000_000)),
      run: (i) => respond(i, { content: `🎲 **${fmt(rand(1, i.options.getInteger('sides') ?? 6))}**` }),
    },
    {
      data: cmd('choose', 'Pick one option').addStringOption((o) => o.setName('options').setDescription('Options separated by |').setRequired(true).setMaxLength(800)),
      run(i) {
        const list = i.options.getString('options', true).split('|').map((s) => s.trim()).filter(Boolean);
        if (list.length < 2) return fail(i, 'Give at least two options, separated by `|`.');
        return respond(i, { content: `🤔 I choose **${pick(list)}**`, allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('rps', 'Rock, paper, scissors').addStringOption((o) => o.setName('choice').setDescription('Your move').setRequired(true).addChoices(...Object.keys(RPS).map((v) => ({ name: v, value: v })))),
      run(i) {
        const you = i.options.getString('choice', true);
        const me = pick(Object.keys(RPS));
        const result = you === me ? 'A draw.' : RPS[you] === me ? 'You win!' : 'I win!';
        return respond(i, { content: `You: **${you}**, me: **${me}**. ${result}` });
      },
    },
  ],

  components: {
    'help:cat'(i) {
      const group = helpCategories().get(i.values[0]);
      if (!group) return fail(i, 'That category no longer exists.');
      return i.update({ embeds: [embed(truncate(group.items.map(describe).join('\n\n'), 4000)).setTitle(group.label)], components: [helpMenu()] });
    },
    async 'embed:submit'(i, [channelId]) {
      const value = (id) => i.fields.getTextInputValue(id).trim();
      const image = value('image');
      if (image && !/^https:\/\/\S+$/i.test(image)) return fail(i, 'The image must be an https link.');
      const e = new EmbedBuilder().setColor(hexColor(value('color'))).setDescription(value('description'));
      if (value('title')) e.setTitle(value('title'));
      if (image) e.setImage(image);
      if (value('footer')) e.setFooter({ text: value('footer') });
      const sent = await sendTo(i.guild, channelId, { embeds: [e], allowedMentions: { parse: [] } });
      return sent ? okPrivate(i, 'Embed posted.') : fail(i, 'I could not post in that channel.');
    },
  },

  events: {
    messageDelete(message) {
      if (!message.guild || message.partial || message.author?.bot || (!message.content && !message.attachments.size)) return;
      snipes.set(message.channelId, { author: message.author.username, avatar: message.author.displayAvatarURL(), content: message.content, at: message.createdTimestamp });
    },
  },
};
