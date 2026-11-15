import { AuditLogEvent as A, ChannelType, EmbedBuilder, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, fail, okPrivate, sendTo } from '../core/ui.js';
import { noop, sleep } from '../core/util.js';

const limit = (count, seconds) => ({ count, seconds });
const KINDS = {
  channelDelete: 'Channels deleted', channelCreate: 'Channels created', roleDelete: 'Roles deleted', roleCreate: 'Roles created',
  ban: 'Members banned', kick: 'Members kicked', prune: 'Member prunes', webhookCreate: 'Webhooks created',
  botAdd: 'Bots added', dangerousRole: 'Admin perms added to a role', dangerousGrant: 'Admin role given to a member',
  guildUpdate: 'Server settings changed', emojiDelete: 'Emoji deleted',
};
const ADMIN_LIKE = new PermissionsBitField([P.Administrator, P.BanMembers, P.KickMembers, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageWebhooks, P.MentionEveryone]).bitfield;
const SNAPSHOT_TTL = 120_000;
const FLAG_MS = 60_000;

const windows = new Map();
const flagged = new Map();
const deletedChannels = new Map();
const deletedRoles = new Map();

const isDangerousBits = (bits) => (BigInt(bits ?? 0) & ADMIN_LIKE) !== 0n;

export function isTrusted(guild, cfg, userId) {
  return userId === guild.ownerId || userId === guild.client.user.id || cfg.whitelist.includes(userId) || cfg.trusted.includes(userId);
}

/** Records an action. Returns every action in the window once the limit is reached. */
export function recordAction(key, item, rule, now = Date.now()) {
  const list = (windows.get(key) ?? []).filter((x) => now - x.at <= rule.seconds * 1000);
  list.push({ at: now, ...item });
  windows.set(key, list);
  if (list.length < rule.count) return null;
  windows.delete(key);
  return list;
}

export function classify(entry, guild) {
  switch (entry.action) {
    case A.ChannelDelete: return 'channelDelete';
    case A.ChannelCreate: return 'channelCreate';
    case A.RoleDelete: return 'roleDelete';
    case A.RoleCreate: return 'roleCreate';
    case A.MemberBanAdd: return 'ban';
    case A.MemberKick: return 'kick';
    case A.MemberPrune: return 'prune';
    case A.WebhookCreate: return 'webhookCreate';
    case A.BotAdd: return 'botAdd';
    case A.GuildUpdate: return 'guildUpdate';
    case A.EmojiDelete: return 'emojiDelete';
    case A.RoleUpdate: {
      const change = entry.changes.find((c) => c.key === 'permissions');
      return change && !isDangerousBits(change.old) && isDangerousBits(change.new) ? 'dangerousRole' : null;
    }
    case A.MemberRoleUpdate: {
      const added = entry.changes.find((c) => c.key === '$add')?.new ?? [];
      return added.some((r) => guild.roles.cache.get(r.id)?.permissions.any(ADMIN_LIKE)) ? 'dangerousGrant' : null;
    }
    default: return null;
  }
}

function stash(map, id, value) {
  map.set(id, { value, expires: Date.now() + SNAPSHOT_TTL });
  for (const [key, item] of map) if (item.expires < Date.now()) map.delete(key);
}

function take(map, id) {
  const item = map.get(id);
  map.delete(id);
  return item?.value ?? null;
}

async function restoreChannel(guild, snap, parents) {
  const created = await guild.channels.create({
    name: snap.name, type: snap.type, topic: snap.topic ?? undefined, nsfw: snap.nsfw, bitrate: snap.bitrate ?? undefined,
    userLimit: snap.userLimit ?? undefined, rateLimitPerUser: snap.rateLimitPerUser ?? undefined,
    parent: parents.get(snap.parentId) ?? (guild.channels.cache.has(snap.parentId) ? snap.parentId : undefined),
    permissionOverwrites: snap.overwrites, position: snap.position, reason: 'Anti-nuke: restoring deleted channel',
  });
  parents.set(snap.id, created.id);
  for (const childId of snap.children) await guild.channels.cache.get(childId)?.setParent(created.id, { lockPermissions: false }).catch(noop);
}

async function restoreRole(guild, snap) {
  const role = await guild.roles.create({
    name: snap.name, color: snap.color, hoist: snap.hoist, mentionable: snap.mentionable,
    permissions: snap.permissions, reason: 'Anti-nuke: restoring deleted role',
  });
  await role.setPosition(snap.position).catch(noop);
  for (const memberId of snap.members) await guild.members.cache.get(memberId)?.roles.add(role, 'Anti-nuke: restoring role').catch(noop);
}

async function undo(guild, kind, { targetId, entry }, parents) {
  const reason = 'Anti-nuke: undoing malicious action';
  switch (kind) {
    case 'channelDelete': {
      const snap = take(deletedChannels, targetId);
      return snap && restoreChannel(guild, snap, parents);
    }
    case 'roleDelete': {
      const snap = take(deletedRoles, targetId);
      return snap && restoreRole(guild, snap);
    }
    case 'channelCreate': return guild.channels.cache.get(targetId)?.delete(reason);
    case 'roleCreate': return guild.roles.cache.get(targetId)?.delete(reason);
    case 'ban': return guild.members.unban(targetId, reason);
    case 'botAdd': return guild.members.kick(targetId, reason);
    case 'webhookCreate': return guild.client.deleteWebhook(targetId, { reason });
    case 'dangerousRole': {
      const change = entry.changes.find((c) => c.key === 'permissions');
      return guild.roles.cache.get(targetId)?.setPermissions(BigInt(change.old), reason);
    }
    case 'dangerousGrant': {
      const added = entry.changes.find((c) => c.key === '$add')?.new ?? [];
      return guild.members.cache.get(targetId)?.roles.remove(added.map((r) => r.id), reason);
    }
    default: return undefined;
  }
}

async function recover(guild, kind, items) {
  // The audit entry can arrive before the matching delete event, which is what fills the snapshots.
  await sleep(guild.client.antinukeRecoveryDelay ?? 1200);
  const parents = new Map();
  const isCategory = (item) => deletedChannels.get(item.targetId)?.value.type === ChannelType.GuildCategory;
  const ordered = [...items].sort((a, b) => Number(isCategory(b)) - Number(isCategory(a)));
  let done = 0;
  for (const item of ordered) {
    try {
      await undo(guild, kind, item, parents);
      done += 1;
    } catch (err) {
      logger.warn(`Anti-nuke could not undo ${kind} on ${item.targetId}: ${err.message}`);
    }
  }
  return done;
}

async function punishExecutor(guild, cfg, userId, kind) {
  const reason = `Anti-nuke: exceeded limit for ${KINDS[kind]}`;
  const member = await guild.members.fetch(userId).catch(() => null);
  const mode = cfg.punishment === 'strip' && member?.user.bot ? 'kick' : cfg.punishment;
  try {
    if (mode === 'ban') await guild.members.ban(userId, { reason });
    else if (!member) return 'already gone';
    else if (mode === 'kick') await member.kick(reason);
    else await member.roles.set(member.roles.cache.filter((r) => r.managed).map((r) => r.id), reason);
    return mode === 'strip' ? 'all roles removed' : `${mode === 'ban' ? 'banned' : 'kicked'}`;
  } catch {
    return 'FAILED. Move my role above theirs';
  }
}

async function alert(guild, cfg, e) {
  await sendTo(guild, cfg.logChannel, { embeds: [e], allowedMentions: { parse: [] } });
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ embeds: [e] }).catch(noop);
}

async function respondToNuke(guild, cfg, userId, kind, items) {
  flagged.set(`${guild.id}:${userId}`, Date.now() + FLAG_MS);
  const outcome = await punishExecutor(guild, cfg, userId, kind);
  const restored = cfg.recovery ? await recover(guild, kind, items) : 0;
  await alert(guild, cfg, new EmbedBuilder().setColor(COLOR.err).setTitle('🚨 Anti-nuke triggered')
    .setDescription(`<@${userId}> (\`${userId}\`) tripped the limit for **${KINDS[kind]}**.`)
    .addFields(
      { name: 'Actions detected', value: String(items.length), inline: true },
      { name: 'Punishment', value: outcome, inline: true },
      { name: 'Undone', value: cfg.recovery ? `${restored}/${items.length}` : 'recovery off', inline: true },
    ).setTimestamp());
}

const kindChoices = Object.entries(KINDS).map(([value, name]) => ({ name, value }));

export default {
  name: 'antinuke',
  label: '🚨 Anti-Nuke',
  defaults: {
    enabled: false, punishment: 'ban', recovery: true, logChannel: null, whitelist: [], trusted: [],
    limits: {
      channelDelete: limit(3, 30), channelCreate: limit(6, 30), roleDelete: limit(3, 30), roleCreate: limit(6, 30),
      ban: limit(4, 30), kick: limit(5, 30), prune: limit(1, 60), webhookCreate: limit(3, 30), botAdd: limit(1, 60),
      dangerousRole: limit(1, 60), dangerousGrant: limit(1, 60), guildUpdate: limit(4, 60), emojiDelete: limit(5, 30),
    },
  },
  form: {
    title: 'Anti-nuke',
    description: 'Stops a hacked admin or rogue bot from wrecking the server, then undoes the damage. Only the server owner and trusted users can change this.',
    ownerOnly: true,
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable Anti-Nuke' },
      { key: 'punishment', type: 'select', label: 'Punishment', options: ['ban', 'kick', 'strip'], help: '"strip" removes all of their roles.' },
      { key: 'recovery', type: 'bool', label: 'Undo the damage automatically', help: 'Recreates deleted channels and roles, unbans victims, removes what was added.' },
      { key: 'logChannel', type: 'channel', label: 'Alert channel', help: 'The server owner is always sent a DM as well.' },
      { key: 'whitelist', type: 'list', label: 'Whitelisted user or bot IDs', pattern: '^\\d{15,25}$', max: 100, help: 'These accounts never trigger Anti-Nuke.' },
      ...Object.entries(KINDS).flatMap(([kind, label]) => [
        { key: `limits.${kind}.count`, type: 'int', label: `${label}: limit`, min: 0, max: 100, group: 'Limits', help: '0 turns this check off.' },
        { key: `limits.${kind}.seconds`, type: 'int', label: 'within seconds', min: 1, max: 3600, group: 'Limits' },
      ]),
    ],
  },

  commands: [{
    data: cmd('antinuke', 'Protect the server from hacked admins (server owner only)', P.Administrator)
      .addSubcommand((s) => s.setName('status').setDescription('Show the current setup'))
      .addSubcommand((s) => s.setName('power').setDescription('Turn Anti-Nuke on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('limit').setDescription('Set how many actions are allowed in a time window')
        .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(...kindChoices.slice(0, 25)))
        .addIntegerOption((o) => o.setName('count').setDescription('Trigger at this many. 0 turns the check off').setRequired(true).setMinValue(0).setMaxValue(100))
        .addIntegerOption((o) => o.setName('seconds').setDescription('Time window').setRequired(true).setMinValue(1).setMaxValue(3600)))
      .addSubcommand((s) => s.setName('punishment').setDescription('What happens to the attacker')
        .addStringOption((o) => o.setName('type').setDescription('Punishment').setRequired(true)
          .addChoices({ name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Remove all roles', value: 'strip' })))
      .addSubcommand((s) => s.setName('recovery').setDescription('Automatically undo the damage')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('log').setDescription('Set the alert channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('whitelist').setDescription('Toggle a user or bot being ignored')
        .addUserOption((o) => o.setName('user').setDescription('User or bot').setRequired(true)))
      .addSubcommand((s) => s.setName('trust').setDescription('Toggle who may configure Anti-Nuke (owner only)')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))),
    async run(i) {
      const current = getSettings(i.guildId).antinuke;
      const isOwner = i.user.id === i.guild.ownerId;
      if (!isOwner && !current.trusted.includes(i.user.id)) return fail(i, 'Only the server owner or trusted users can configure Anti-Nuke.');
      const sub = i.options.getSubcommand();
      const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

      if (sub === 'status') {
        const rows = Object.entries(KINDS).map(([k, label]) => `**${label}:** ${current.limits[k].count ? `${current.limits[k].count} in ${current.limits[k].seconds}s` : 'off'}`);
        return okPrivate(i, `Anti-Nuke is **${current.enabled ? 'ON' : 'OFF'}**\n**Punishment:** ${current.punishment}\n**Recovery:** ${current.recovery ? 'on' : 'off'}\n**Whitelisted:** ${current.whitelist.length}\n\n${rows.join('\n')}`);
      }
      if (sub === 'power') {
        const enabled = i.options.getBoolean('enabled', true);
        await updateSettings(i.guildId, (s) => { s.antinuke.enabled = enabled; });
        const me = i.guild.members.me;
        const warning = enabled && me.roles.highest.position < i.guild.roles.highest.position ? ' Move my role to the very top, otherwise I cannot punish higher roles.' : '';
        return okPrivate(i, `Anti-Nuke is **${enabled ? 'on' : 'off'}**.${warning}`);
      }
      if (sub === 'limit') {
        const action = i.options.getString('action', true);
        const count = i.options.getInteger('count', true);
        const seconds = i.options.getInteger('seconds', true);
        await updateSettings(i.guildId, (s) => { s.antinuke.limits[action] = { count, seconds }; });
        return okPrivate(i, `**${KINDS[action]}:** ${count ? `trigger at ${count} in ${seconds}s` : 'check off'}.`);
      }
      if (sub === 'punishment') {
        const type = i.options.getString('type', true);
        await updateSettings(i.guildId, (s) => { s.antinuke.punishment = type; });
        return okPrivate(i, `Punishment set to **${type}**.`);
      }
      if (sub === 'recovery') {
        const enabled = i.options.getBoolean('enabled', true);
        await updateSettings(i.guildId, (s) => { s.antinuke.recovery = enabled; });
        return okPrivate(i, `Recovery is **${enabled ? 'on' : 'off'}**.`);
      }
      if (sub === 'log') {
        const channel = i.options.getChannel('channel', true);
        await updateSettings(i.guildId, (s) => { s.antinuke.logChannel = channel.id; });
        return okPrivate(i, `Alerts will go to ${channel}.`);
      }
      const user = i.options.getUser('user', true);
      if (sub === 'whitelist') {
        const { antinuke } = await updateSettings(i.guildId, (s) => { s.antinuke.whitelist = toggle(s.antinuke.whitelist, user.id); });
        return okPrivate(i, `**${user.username}** is ${antinuke.whitelist.includes(user.id) ? 'now whitelisted' : 'no longer whitelisted'}.`);
      }
      if (!isOwner) return fail(i, 'Only the server owner can change who is trusted.');
      const { antinuke } = await updateSettings(i.guildId, (s) => { s.antinuke.trusted = toggle(s.antinuke.trusted, user.id); });
      return okPrivate(i, `**${user.username}** is ${antinuke.trusted.includes(user.id) ? 'now trusted' : 'no longer trusted'}.`);
    },
  }],

  events: {
    channelDelete(channel) {
      if (!channel.guild) return;
      stash(deletedChannels, channel.id, {
        id: channel.id, name: channel.name, type: channel.type, topic: channel.topic, nsfw: channel.nsfw, bitrate: channel.bitrate,
        userLimit: channel.userLimit, rateLimitPerUser: channel.rateLimitPerUser, parentId: channel.parentId, position: channel.rawPosition,
        overwrites: channel.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
        children: channel.guild.channels.cache.filter((c) => c.parentId === channel.id).map((c) => c.id),
      });
    },
    roleDelete(role) {
      stash(deletedRoles, role.id, {
        name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield,
        position: role.position, members: role.guild.members.cache.filter((m) => m._roles.includes(role.id)).map((m) => m.id),
      });
    },
    async guildAuditLogEntryCreate(entry, guild) {
      const cfg = getSettings(guild.id).antinuke;
      if (!cfg.enabled || !entry.executorId || isTrusted(guild, cfg, entry.executorId)) return;
      const kind = classify(entry, guild);
      const rule = kind && cfg.limits[kind];
      if (!rule?.count) return;
      const item = { targetId: entry.targetId, entry };
      const flagKey = `${guild.id}:${entry.executorId}`;
      // Already caught: keep undoing anything still in flight, but do not punish or alert again.
      if ((flagged.get(flagKey) ?? 0) > Date.now()) return void (cfg.recovery && (await recover(guild, kind, [item])));
      const items = recordAction(`${flagKey}:${kind}`, item, rule);
      if (items) await respondToNuke(guild, cfg, entry.executorId, kind, items);
    },
  },
};
