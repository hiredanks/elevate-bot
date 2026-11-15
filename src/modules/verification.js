import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { captchaImage } from '../core/cards.js';
import { withImage } from '../core/images.js';
import { jobs } from '../core/jobs.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, respond, roleError } from '../core/ui.js';
import { noop, pick, rand } from '../core/util.js';

const CHALLENGE_TTL = 5 * 60_000;
const challenges = new Map();
const key = (i) => `${i.guildId}:${i.user.id}`;

function setChallenge(i, answer) {
  challenges.set(key(i), { answer, expires: Date.now() + CHALLENGE_TTL });
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
}

const answerModal = (label) => new ModalBuilder().setCustomId('verify:submit').setTitle('Verification').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('answer').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)),
);

async function grant(i) {
  const cfg = getSettings(i.guildId).verification;
  if (!cfg.role) return fail(i, 'Verification has not been set up yet.');
  if (i.member.roles.cache.has(cfg.role)) return okPrivate(i, 'You are already verified.');
  await i.member.roles.add(cfg.role, 'Passed verification');
  if (cfg.removeRole) await i.member.roles.remove(cfg.removeRole, 'Passed verification').catch(noop);
  await jobs.cancel('verify:kick', i.guildId, i.user.id);
  // The moment someone joins is the natural place to ask whether they want server news by DM.
  return respond(i, {
    embeds: [embed('✅ You are verified. Welcome!', COLOR.ok)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`broadcast:toggle:${i.guildId}`).setLabel('Also get server news by DM').setEmoji('📬').setStyle(ButtonStyle.Secondary),
    )],
    flags: EPHEMERAL,
  });
}

export async function postVerificationPanel(guild) {
  const cfg = getSettings(guild.id).verification;
  const channel = guild.channels.cache.get(cfg.channel);
  if (!channel?.isTextBased() || !cfg.role) throw new Error('Pick a verification channel and role first.');
  await channel.send(await withImage(guild.id, 'verify', {
    embeds: [embed(cfg.message, COLOR.brand).setTitle(`Verify in ${guild.name}`)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success))],
  }));
  return `Verification panel posted in #${channel.name}.`;
}

const HIDE_REASON = 'Hide from unverified members';

/** Hides every channel from the unverified role, leaving only the verification channel visible. */
export async function hideChannelsFromUnverified(guild) {
  const cfg = getSettings(guild.id).verification;
  const role = guild.roles.cache.get(cfg.removeRole);
  const verifyChannel = guild.channels.cache.get(cfg.channel);
  if (!role) throw new Error('Pick an unverified role first.');
  if (!verifyChannel) throw new Error('Pick a verification channel first.');
  let hidden = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread() || channel.id === verifyChannel.id) continue;
    if (channel.permissionOverwrites.cache.get(role.id)?.deny.has(P.ViewChannel)) continue;
    await channel.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: HIDE_REASON });
    hidden += 1;
  }
  await verifyChannel.permissionOverwrites.edit(role, { ViewChannel: true, ReadMessageHistory: true }, { reason: HIDE_REASON });
  return `Hid ${hidden} channel(s) from ${role.name}. Unverified members can only see #${verifyChannel.name}.`;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export default {
  name: 'verification',
  label: '✅ Verification',
  defaults: {
    enabled: false, channel: null, role: null, removeRole: null, mode: 'button', kickMinutes: 0,
    message: 'Press the button below to prove you are human and unlock the server.',
  },
  form: {
    title: 'Verification',
    description: 'Members must pass a check before they can see the server. New members get the unverified role, which can only see the verification channel.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable verification' },
      { key: 'channel', type: 'channel', label: 'Verification channel' },
      { key: 'role', type: 'role', label: 'Role given after verifying', assignable: true },
      { key: 'removeRole', type: 'role', label: 'Unverified role', assignable: true, help: 'Given on join and removed after verifying. The bot hides every channel from it, including new channels, except the verification channel.' },
      { key: 'mode', type: 'select', label: 'Challenge', options: ['button', 'math', 'captcha'] },
      { key: 'kickMinutes', type: 'int', label: 'Kick if not verified after (minutes)', min: 0, max: 10080, help: '0 turns this off.' },
      { key: 'message', type: 'textarea', label: 'Panel message', max: 1500 },
    ],
    actions: [{ id: 'post', label: 'Post verification panel' }, { id: 'hide', label: 'Hide all channels from unverified role' }],
  },
  actions: { post: (guild) => postVerificationPanel(guild), hide: (guild) => hideChannelsFromUnverified(guild) },

  /** Picking the role or channel on the website applies straight away, without pressing the button. */
  onSave(guild, changedKeys) {
    const cfg = getSettings(guild.id).verification;
    if (!cfg.enabled || !cfg.removeRole || !cfg.channel) return;
    if (!changedKeys.some((key) => ['enabled', 'removeRole', 'channel'].includes(key))) return;
    hideChannelsFromUnverified(guild).catch((err) => logger.warn(`Hiding channels failed: ${err.message}`));
  },

  commands: [{
    data: cmd('verification', 'Set up member verification', P.ManageGuild)
      .addSubcommand((s) => s.setName('setup').setDescription('Post the verification panel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel for the panel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName('role').setDescription('Role given after verifying').setRequired(true))
        .addStringOption((o) => o.setName('mode').setDescription('Challenge type')
          .addChoices({ name: 'One button', value: 'button' }, { name: 'Math question', value: 'math' }, { name: 'Image captcha', value: 'captcha' }))
        .addRoleOption((o) => o.setName('unverified_role').setDescription('Given on join, can only see the verification channel')))
      .addSubcommand((s) => s.setName('hide-channels').setDescription('Hide every channel from the unverified role'))
      .addSubcommand((s) => s.setName('kick-after').setDescription('Kick members who do not verify in time')
        .addIntegerOption((o) => o.setName('minutes').setDescription('0 to turn off').setRequired(true).setMinValue(0).setMaxValue(10080))),
    async run(i) {
      if (i.options.getSubcommand() === 'hide-channels') {
        const cfg = getSettings(i.guildId).verification;
        if (!cfg.removeRole || !cfg.channel) return fail(i, 'Set a verification channel and an unverified role first.');
        await i.deferReply({ flags: EPHEMERAL });
        return ok(i, await hideChannelsFromUnverified(i.guild));
      }
      if (i.options.getSubcommand() === 'kick-after') {
        const minutes = i.options.getInteger('minutes', true);
        await updateSettings(i.guildId, (s) => { s.verification.kickMinutes = minutes; });
        return ok(i, minutes ? `Unverified members are kicked after **${minutes} minutes**.` : 'Auto-kick turned off.');
      }
      const role = i.options.getRole('role', true);
      const removeRole = i.options.getRole('unverified_role');
      for (const r of [role, removeRole].filter(Boolean)) {
        const problem = roleError(i, r);
        if (problem) return fail(i, problem);
      }
      const channel = i.options.getChannel('channel', true);
      await updateSettings(i.guildId, (s) => {
        Object.assign(s.verification, {
          enabled: true, channel: channel.id, role: role.id, removeRole: removeRole?.id ?? null,
          mode: i.options.getString('mode') ?? s.verification.mode,
        });
      });
      await i.deferReply({ flags: EPHEMERAL });
      await postVerificationPanel(i.guild);
      if (removeRole) return ok(i, `Panel posted in ${channel}. ${await hideChannelsFromUnverified(i.guild)}`);
      return ok(i, `Panel posted in ${channel}. Now hide your other channels from @everyone and allow ${role} to see them.`);
    },
  }],

  components: {
    async 'verify:start'(i) {
      const cfg = getSettings(i.guildId).verification;
      if (!cfg.enabled || !cfg.role) return fail(i, 'Verification is turned off.');
      if (i.member.roles.cache.has(cfg.role)) return okPrivate(i, 'You are already verified.');
      if (cfg.mode === 'math') {
        const a = rand(2, 12);
        const b = rand(2, 12);
        setChallenge(i, String(a + b));
        return i.showModal(answerModal(`What is ${a} + ${b}?`));
      }
      if (cfg.mode === 'captcha') {
        const code = Array.from({ length: 5 }, () => pick([...LETTERS])).join('');
        setChallenge(i, code);
        return i.reply({
          content: 'Type the characters you see in this image:',
          files: [new AttachmentBuilder(await captchaImage(code), { name: 'captcha.png' })],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify:enter').setLabel('Enter code').setStyle(ButtonStyle.Primary))],
          flags: EPHEMERAL,
        });
      }
      return grant(i);
    },
    'verify:enter': (i) => i.showModal(answerModal('Code from the image')),
    async 'verify:submit'(i) {
      const challenge = challenges.get(key(i));
      challenges.delete(key(i));
      if (!challenge || challenge.expires < Date.now()) return fail(i, 'That challenge expired. Press Verify again.');
      if (i.fields.getTextInputValue('answer').trim().toUpperCase() !== challenge.answer) return fail(i, 'That was not right. Press Verify to try again.');
      return grant(i);
    },
  },

  jobs: {
    async 'verify:kick'(client, { userId }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      const cfg = guild && getSettings(guild.id).verification;
      if (!guild || !cfg.enabled) return;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && !member.roles.cache.has(cfg.role) && member.kickable) await member.kick('Did not verify in time');
    },
  },

  events: {
    async guildMemberAdd(member) {
      const cfg = getSettings(member.guild.id).verification;
      if (!cfg.enabled || member.user.bot || member.blocked) return;
      if (cfg.removeRole) await member.roles.add(cfg.removeRole, 'Not verified yet').catch((err) => logger.warn(`Unverified role failed: ${err.message}`));
      if (cfg.kickMinutes) await jobs.schedule('verify:kick', member.guild.id, Date.now() + cfg.kickMinutes * 60_000, { userId: member.id }, member.id);
    },
    async channelCreate(channel) {
      if (!channel.guild) return;
      const cfg = getSettings(channel.guild.id).verification;
      if (!cfg.enabled || !cfg.removeRole || channel.id === cfg.channel || !channel.guild.roles.cache.has(cfg.removeRole)) return;
      await channel.permissionOverwrites.edit(cfg.removeRole, { ViewChannel: false }, { reason: HIDE_REASON });
    },
  },
};
