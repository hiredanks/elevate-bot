import { ChannelType, EmbedBuilder, GuildVerificationLevel, PermissionFlagsBits as P } from 'discord.js';
import { jobs } from '../core/jobs.js';
import { logger } from '../core/logger.js';
import { punish } from '../core/punish.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { noop } from '../core/util.js';

const RAID_TIMEOUT = 60 * 60_000;
const joins = new Map();
const raidActive = new Map();

/** Returns the joiners inside the window once the threshold is crossed. */
export function recordJoin(guildId, memberId, cfg, now = Date.now()) {
  const list = (joins.get(guildId) ?? []).filter((j) => now - j.at <= cfg.joinSeconds * 1000);
  list.push({ at: now, id: memberId });
  joins.set(guildId, list);
  return list.length >= cfg.joinCount ? list : null;
}

export async function startLockdown(guild, reason) {
  const everyone = guild.roles.everyone;
  const state = {};
  for (const channel of guild.channels.cache.values()) {
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) continue;
    if (!channel.permissionsFor(everyone).has(P.ViewChannel)) continue;
    const overwrite = channel.permissionOverwrites.cache.get(everyone.id);
    const current = overwrite?.deny.has(P.SendMessages) ? 'deny' : overwrite?.allow.has(P.SendMessages) ? 'allow' : 'neutral';
    if (current === 'deny') continue;
    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason });
      state[channel.id] = current;
    } catch (err) {
      logger.warn(`Lockdown skipped #${channel.name}: ${err.message}`);
    }
  }
  await updateSettings(guild.id, (s) => { s.antiraid.lockState = { ...s.antiraid.lockState, ...state }; });
  return Object.keys(state).length;
}

export async function endLockdown(guild, reason) {
  const { lockState } = getSettings(guild.id).antiraid;
  let restored = 0;
  for (const [channelId, previous] of Object.entries(lockState)) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;
    const value = previous === 'allow' ? true : previous === 'deny' ? false : null;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: value }, { reason }).catch(noop);
    restored += 1;
  }
  await updateSettings(guild.id, (s) => { s.antiraid.lockState = {}; });
  return restored;
}

async function act(member, action, reason) {
  if (action === 'none') return;
  if (action === 'kick' && !member.kickable) return;
  await punish(member.guild, {
    action, user: member.user, member, moderator: member.client.user, reason,
    durationMs: action === 'timeout' ? RAID_TIMEOUT : null,
  }).catch((err) => logger.warn(`Anti-raid ${action} failed: ${err.message}`));
}

async function alert(guild, cfg, text) {
  const log = cfg.logChannel ?? getSettings(guild.id).moderation.logChannel;
  await sendTo(guild, log, { embeds: [new EmbedBuilder().setColor(COLOR.err).setTitle('🌊 Anti-raid').setDescription(text).setTimestamp()] });
}

async function beginRaid(guild, cfg, joiners) {
  raidActive.set(guild.id, Date.now() + cfg.raidMinutes * 60_000);
  const previousLevel = guild.verificationLevel;
  if (cfg.raiseVerification && previousLevel < GuildVerificationLevel.High) {
    await guild.setVerificationLevel(GuildVerificationLevel.High, 'Anti-raid').catch(noop);
    await updateSettings(guild.id, (s) => { s.antiraid.previousLevel = previousLevel; });
  }
  const locked = cfg.lockdown ? await startLockdown(guild, 'Anti-raid: join spike') : 0;
  await jobs.schedule('antiraid:end', guild.id, Date.now() + cfg.raidMinutes * 60_000, {}, 'raid');
  for (const { id } of joiners) {
    const member = guild.members.cache.get(id);
    if (member) await act(member, cfg.action, 'Anti-raid: joined during a raid');
  }
  await alert(guild, cfg, `**Raid detected:** ${joiners.length} joins in ${cfg.joinSeconds}s.\nAction on joiners: **${cfg.action}**\nChannels locked: **${locked}**\nEnds automatically in **${cfg.raidMinutes} minutes**, or run \`/lockdown off\`.`);
}

async function finishRaid(guild) {
  raidActive.delete(guild.id);
  await jobs.cancel('antiraid:end', guild.id, 'raid');
  const cfg = getSettings(guild.id).antiraid;
  if (cfg.previousLevel !== null) {
    await guild.setVerificationLevel(cfg.previousLevel, 'Raid over').catch(noop);
    await updateSettings(guild.id, (s) => { s.antiraid.previousLevel = null; });
  }
  return endLockdown(guild, 'Raid over');
}

export default {
  name: 'antiraid',
  label: '🌊 Anti-Raid',
  defaults: {
    enabled: false, joinCount: 10, joinSeconds: 10, action: 'kick', raidMinutes: 15, lockdown: true, raiseVerification: true,
    minAccountDays: 0, ageAction: 'kick', logChannel: null, lockState: {}, previousLevel: null,
  },
  form: {
    title: 'Anti-raid',
    description: 'Detects waves of joining accounts and shuts the door until they stop.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable Anti-Raid' },
      { key: 'joinCount', type: 'int', label: 'Raid threshold: joins', min: 3, max: 200 },
      { key: 'joinSeconds', type: 'int', label: 'within seconds', min: 1, max: 600 },
      { key: 'action', type: 'select', label: 'Action on raid joiners', options: ['none', 'timeout', 'kick', 'ban'] },
      { key: 'raidMinutes', type: 'int', label: 'Raid mode length (minutes)', min: 1, max: 1440 },
      { key: 'lockdown', type: 'bool', label: 'Lock all channels during a raid' },
      { key: 'raiseVerification', type: 'bool', label: 'Raise server verification level during a raid' },
      { key: 'minAccountDays', type: 'int', label: 'Minimum account age (days)', min: 0, max: 365, help: '0 turns the alt-account filter off.' },
      { key: 'ageAction', type: 'select', label: 'Action on too-new accounts', options: ['kick', 'ban', 'timeout'] },
      { key: 'logChannel', type: 'channel', label: 'Alert channel', help: 'Falls back to the moderation log.' },
    ],
  },

  commands: [
    {
      data: cmd('antiraid', 'Configure raid protection', P.ManageGuild)
        .addSubcommand((s) => s.setName('status').setDescription('Show raid protection settings'))
        .addSubcommand((s) => s.setName('power').setDescription('Turn raid protection on or off')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((s) => s.setName('threshold').setDescription('How many joins count as a raid')
          .addIntegerOption((o) => o.setName('joins').setDescription('Joins').setRequired(true).setMinValue(3).setMaxValue(200))
          .addIntegerOption((o) => o.setName('seconds').setDescription('Within seconds').setRequired(true).setMinValue(1).setMaxValue(600)))
        .addSubcommand((s) => s.setName('action').setDescription('What happens to raid joiners')
          .addStringOption((o) => o.setName('type').setDescription('Action').setRequired(true)
            .addChoices(...['none', 'timeout', 'kick', 'ban'].map((v) => ({ name: v, value: v })))))
        .addSubcommand((s) => s.setName('min-age').setDescription('Reject accounts younger than this (anti-alt)')
          .addIntegerOption((o) => o.setName('days').setDescription('0 to turn off').setRequired(true).setMinValue(0).setMaxValue(365))
          .addStringOption((o) => o.setName('action').setDescription('What happens to them')
            .addChoices(...['kick', 'ban', 'timeout'].map((v) => ({ name: v, value: v }))))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'status') {
          const c = getSettings(i.guildId).antiraid;
          return okPrivate(i, `Anti-raid is **${c.enabled ? 'ON' : 'OFF'}**\n**Raid:** ${c.joinCount} joins in ${c.joinSeconds}s\n**Action:** ${c.action}\n**Lock channels:** ${c.lockdown ? 'yes' : 'no'}\n**Minimum account age:** ${c.minAccountDays || 'off'} (${c.ageAction})`);
        }
        await updateSettings(i.guildId, (s) => {
          const c = s.antiraid;
          if (sub === 'power') c.enabled = i.options.getBoolean('enabled', true);
          if (sub === 'threshold') { c.joinCount = i.options.getInteger('joins', true); c.joinSeconds = i.options.getInteger('seconds', true); }
          if (sub === 'action') c.action = i.options.getString('type', true);
          if (sub === 'min-age') { c.minAccountDays = i.options.getInteger('days', true); c.ageAction = i.options.getString('action') ?? c.ageAction; }
        });
        return ok(i, 'Anti-raid settings updated.');
      },
    },
    {
      data: cmd('lockdown', 'Lock or unlock every text channel', P.ManageGuild)
        .addSubcommand((s) => s.setName('on').setDescription('Lock all channels')
          .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(200)))
        .addSubcommand((s) => s.setName('off').setDescription('Restore all channels and end raid mode')),
      botPerms: [P.ManageChannels, P.ManageRoles],
      async run(i) {
        await i.deferReply({ flags: EPHEMERAL });
        if (i.options.getSubcommand() === 'on') {
          const count = await startLockdown(i.guild, `Lockdown by ${i.user.username}: ${i.options.getString('reason') ?? 'no reason'}`);
          return count ? ok(i, `🔒 Locked **${count}** channel(s). Use \`/lockdown off\` to restore them.`) : fail(i, 'No channels needed locking.');
        }
        const restored = await finishRaid(i.guild);
        return ok(i, `🔓 Restored **${restored}** channel(s).`);
      },
    },
  ],

  jobs: {
    async 'antiraid:end'(client, payload, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (guild) await finishRaid(guild);
    },
  },

  events: {
    async guildMemberAdd(member) {
      if (member.user.bot) return;
      const cfg = getSettings(member.guild.id).antiraid;
      if (!cfg.enabled) return;

      const ageDays = (Date.now() - member.user.createdTimestamp) / 864e5;
      if (cfg.minAccountDays > 0 && ageDays < cfg.minAccountDays) {
        member.blocked = true;
        return act(member, cfg.ageAction, `Account younger than ${cfg.minAccountDays} days`);
      }
      if ((raidActive.get(member.guild.id) ?? 0) > Date.now()) {
        member.blocked = true;
        return act(member, cfg.action, 'Joined during a raid');
      }
      const joiners = recordJoin(member.guild.id, member.id, cfg);
      if (joiners) {
        member.blocked = true;
        await beginRaid(member.guild, cfg, joiners);
      }
    },
  },
};
