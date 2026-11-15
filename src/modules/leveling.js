import { AttachmentBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { rankCard } from '../core/cards.js';
import { db } from '../core/db.js';
import { withImage } from '../core/images.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, fail, ok, okPrivate, respond, roleError, sendTo } from '../core/ui.js';
import { fmt, memberVars, noop, rand, render } from '../core/util.js';

/** Total XP required to reach a level: 100, 300, 600, 1000, ... */
export const xpForLevel = (level) => 50 * level * level + 50 * level;
export const levelFromXp = (xp) => Math.floor((-1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2);

const cooldowns = new Map();
const VOICE_TICK_MS = 60_000;

export async function addXp(guildId, userId, username, amount, column = 'xp') {
  const row = await db.one(
    `INSERT INTO members(guild_id, user_id, username, ${column}) VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET ${column} = members.${column} + $4, username = $3 RETURNING ${column} AS total`,
    [guildId, userId, username, amount],
  );
  return row.total;
}

async function syncRewards(member, level, cfg) {
  const earned = cfg.rewards.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  if (!earned.length) return;
  const keep = cfg.stackRewards ? earned : earned.slice(-1);
  const add = keep.map((r) => r.roleId).filter((id) => member.guild.roles.cache.has(id) && !member.roles.cache.has(id));
  const drop = cfg.stackRewards ? [] : earned.slice(0, -1).map((r) => r.roleId).filter((id) => member.roles.cache.has(id));
  if (add.length) await member.roles.add(add, `Level ${level} reward`).catch((err) => logger.warn(`Level reward failed: ${err.message}`));
  if (drop.length) await member.roles.remove(drop, `Level ${level} reward`).catch(noop);
}

async function onLevelUp(member, level, cfg, fallbackChannel) {
  await syncRewards(member, level, cfg);
  if (cfg.announceMode === 'off') return;
  const content = render(cfg.levelUpMessage, memberVars(member, { level }));
  if (cfg.announceMode === 'dm') return void (await member.send({ content, allowedMentions: { parse: [] } }).catch(noop));
  const channelId = cfg.announceChannel ?? fallbackChannel?.id;
  await sendTo(member.guild, channelId, await withImage(member.guild.id, 'levelup', { content, allowedMentions: { users: [member.id] } }));
}

export async function voiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const cfg = getSettings(guild.id).leveling;
    if (!cfg.enabled || !cfg.voiceEnabled) continue;
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased() || channel.id === guild.afkChannelId || cfg.noXpChannels.includes(channel.id)) continue;
      const eligible = channel.members.filter((m) => !m.user.bot && !m.voice.selfDeaf && !m.voice.serverDeaf);
      if (eligible.size < 2) continue;
      for (const member of eligible.values()) {
        if (cfg.noXpRoles.some((id) => member.roles.cache.has(id))) continue;
        const total = await addXp(guild.id, member.id, member.user.username, cfg.voiceXp, 'voice_xp');
        await db.run('UPDATE members SET voice_minutes = voice_minutes + 1 WHERE guild_id = $1 AND user_id = $2', [guild.id, member.id]);
        if (levelFromXp(total) > levelFromXp(total - cfg.voiceXp)) await syncRewards(member, levelFromXp(total), cfg);
      }
    }
  }
}

export async function rankOf(guildId, userId) {
  return db.one(
    `SELECT m.xp, m.voice_xp, (SELECT COUNT(*) + 1 FROM members o WHERE o.guild_id = $1 AND o.xp > m.xp) AS position
     FROM members m WHERE m.guild_id = $1 AND m.user_id = $2`,
    [guildId, userId],
  );
}

export async function leaderboard(guildId, type, limit = 10, offset = 0) {
  const column = { xp: 'xp', voice: 'voice_xp', credits: 'credits' }[type];
  return db.all(
    `SELECT user_id, username, ${column} AS score FROM members WHERE guild_id = $1 AND ${column} > 0 ORDER BY ${column} DESC, user_id LIMIT $2 OFFSET $3`,
    [guildId, limit, offset],
  );
}

export default {
  name: 'leveling',
  label: '📈 Levels',
  defaults: {
    enabled: true, xpMin: 15, xpMax: 25, cooldownSeconds: 60, voiceEnabled: true, voiceXp: 5,
    announceMode: 'channel', announceChannel: null, levelUpMessage: 'GG {user}, you reached level **{level}**! 🎉',
    noXpChannels: [], noXpRoles: [], rewards: [], stackRewards: true,
  },
  form: {
    title: 'Levels',
    description: 'Members earn XP for chatting and talking in voice, and can unlock roles.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable levels' },
      { key: 'xpMin', type: 'int', label: 'Minimum XP per message', min: 1, max: 500 },
      { key: 'xpMax', type: 'int', label: 'Maximum XP per message', min: 1, max: 500 },
      { key: 'cooldownSeconds', type: 'int', label: 'Seconds between XP gains', min: 0, max: 3600 },
      { key: 'voiceEnabled', type: 'bool', label: 'Earn XP in voice channels' },
      { key: 'voiceXp', type: 'int', label: 'Voice XP per minute', min: 1, max: 100 },
      { key: 'announceMode', type: 'select', label: 'Level-up announcements', options: ['channel', 'dm', 'off'] },
      { key: 'announceChannel', type: 'channel', label: 'Announcement channel', help: 'Empty means the channel where they levelled up.' },
      { key: 'levelUpMessage', type: 'textarea', label: 'Level-up message', max: 1000, help: 'Supports {user} {username} {level} {server}' },
      { key: 'noXpChannels', type: 'channels', label: 'Channels with no XP' },
      { key: 'noXpRoles', type: 'roles', label: 'Roles that earn no XP' },
      { key: 'stackRewards', type: 'bool', label: 'Keep earlier reward roles', group: 'Rewards' },
      {
        key: 'rewards', type: 'rows', label: 'Level rewards', group: 'Rewards', max: 50,
        columns: [
          { key: 'level', type: 'int', label: 'Level', min: 1, max: 1000 },
          { key: 'roleId', type: 'role', label: 'Role', assignable: true },
        ],
      },
    ],
  },

  commands: [
    {
      data: cmd('rank', 'Show a rank card')
        .addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
      cooldown: 3,
      async run(i) {
        const user = i.options.getUser('user') ?? i.user;
        if (user.bot) return fail(i, 'Bots do not earn XP.');
        await i.deferReply();
        const row = (await rankOf(i.guildId, user.id)) ?? { xp: 0, voice_xp: 0, position: '?' };
        const level = levelFromXp(row.xp);
        const member = i.options.getMember('user') ?? (user.id === i.user.id ? i.member : null);
        const png = await rankCard({
          avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }), name: member?.displayName ?? user.username,
          rank: row.position, level, voiceLevel: levelFromXp(row.voice_xp),
          current: row.xp - xpForLevel(level), needed: xpForLevel(level + 1) - xpForLevel(level),
        });
        return i.editReply({ files: [new AttachmentBuilder(png, { name: 'rank.png' })] });
      },
    },
    {
      data: cmd('leaderboard', 'Show the top members')
        .addStringOption((o) => o.setName('type').setDescription('What to rank by')
          .addChoices({ name: 'Text XP', value: 'xp' }, { name: 'Voice XP', value: 'voice' }, { name: 'Credits', value: 'credits' }))
        .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
      async run(i) {
        const type = i.options.getString('type') ?? 'xp';
        const page = i.options.getInteger('page') ?? 1;
        const rows = await leaderboard(i.guildId, type, 10, (page - 1) * 10);
        if (!rows.length) return fail(i, 'Nobody on this page yet.');
        const unit = type === 'credits' ? getSettings(i.guildId).economy.currency : 'XP';
        const lines = rows.map((r, n) => {
          const place = (page - 1) * 10 + n + 1;
          const extra = type === 'credits' ? '' : ` · Lv ${levelFromXp(r.score)}`;
          return `**${place}.** <@${r.user_id}> · ${fmt(r.score)} ${unit}${extra}`;
        });
        return respond(i, {
          embeds: [new EmbedBuilder().setColor(COLOR.gold).setTitle(`${i.guild.name} leaderboard`).setDescription(lines.join('\n')).setFooter({ text: `Page ${page}` })],
          allowedMentions: { parse: [] },
        });
      },
    },
    {
      data: cmd('levels', 'Configure the level system', P.ManageGuild)
        .addSubcommand((s) => s.setName('power').setDescription('Turn levels on or off')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((s) => s.setName('announce').setDescription('Where level-ups are announced')
          .addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true)
            .addChoices({ name: 'In a channel', value: 'channel' }, { name: 'By DM', value: 'dm' }, { name: 'Off', value: 'off' }))
          .addChannelOption((o) => o.setName('channel').setDescription('Fixed channel').addChannelTypes(ChannelType.GuildText))
          .addStringOption((o) => o.setName('message').setDescription('Supports {user} {level}').setMaxLength(1000)))
        .addSubcommand((s) => s.setName('reward').setDescription('Give a role at a level')
          .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(1000))
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand((s) => s.setName('unreward').setDescription('Remove a level reward')
          .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('rewards').setDescription('List level rewards'))
        .addSubcommand((s) => s.setName('ignore').setDescription('Toggle a channel earning no XP')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true))),
      async run(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'rewards') {
          const list = getSettings(i.guildId).leveling.rewards;
          return okPrivate(i, list.map((r) => `Level **${r.level}**: <@&${r.roleId}>`).join('\n') || 'No rewards yet.');
        }
        if (sub === 'reward') {
          const role = i.options.getRole('role', true);
          const level = i.options.getInteger('level', true);
          const problem = roleError(i, role);
          if (problem) return fail(i, problem);
          await updateSettings(i.guildId, (s) => {
            s.leveling.rewards = [...s.leveling.rewards.filter((r) => r.level !== level), { level, roleId: role.id }].sort((a, b) => a.level - b.level);
          });
          return ok(i, `${role} will be given at level **${level}**.`, { allowedMentions: { parse: [] } });
        }
        if (sub === 'unreward') {
          const level = i.options.getInteger('level', true);
          await updateSettings(i.guildId, (s) => { s.leveling.rewards = s.leveling.rewards.filter((r) => r.level !== level); });
          return ok(i, `Removed the reward for level ${level}.`);
        }
        if (sub === 'ignore') {
          const channel = i.options.getChannel('channel', true);
          const { leveling } = await updateSettings(i.guildId, (s) => {
            const list = s.leveling.noXpChannels;
            s.leveling.noXpChannels = list.includes(channel.id) ? list.filter((c) => c !== channel.id) : [...list, channel.id];
          });
          return ok(i, `${channel} ${leveling.noXpChannels.includes(channel.id) ? 'earns no XP now' : 'earns XP again'}.`);
        }
        await updateSettings(i.guildId, (s) => {
          if (sub === 'power') s.leveling.enabled = i.options.getBoolean('enabled', true);
          if (sub === 'announce') {
            s.leveling.announceMode = i.options.getString('mode', true);
            s.leveling.announceChannel = i.options.getChannel('channel')?.id ?? null;
            s.leveling.levelUpMessage = i.options.getString('message') ?? s.leveling.levelUpMessage;
          }
        });
        return ok(i, 'Level settings updated.');
      },
    },
    {
      data: cmd('xp', 'Adjust a member\'s XP', P.ManageGuild)
        .addSubcommand((s) => s.setName('add').setDescription('Add XP')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(10_000_000)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove XP')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(10_000_000)))
        .addSubcommand((s) => s.setName('reset').setDescription('Reset someone\'s XP to zero')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
      async run(i) {
        const sub = i.options.getSubcommand();
        const user = i.options.getUser('user', true);
        if (sub === 'reset') {
          await db.run('UPDATE members SET xp = 0, voice_xp = 0 WHERE guild_id = $1 AND user_id = $2', [i.guildId, user.id]);
          return ok(i, `Reset XP for **${user.username}**.`);
        }
        const amount = i.options.getInteger('amount', true);
        if (sub === 'remove') {
          await db.run('UPDATE members SET xp = GREATEST(0, xp - $1) WHERE guild_id = $2 AND user_id = $3', [amount, i.guildId, user.id]);
          return ok(i, `Removed **${fmt(amount)}** XP from **${user.username}**.`);
        }
        const total = await addXp(i.guildId, user.id, user.username, amount);
        const member = i.options.getMember('user');
        if (member) await syncRewards(member, levelFromXp(total), getSettings(i.guildId).leveling);
        return ok(i, `**${user.username}** is now level **${levelFromXp(total)}** with ${fmt(total)} XP.`);
      },
    },
  ],

  ready(client) {
    setInterval(() => voiceTick(client).catch((err) => logger.error('Voice XP failed', err)), VOICE_TICK_MS).unref?.();
  },

  events: {
    async messageCreate(message) {
      if (!message.guild || message.author.bot || message.blocked || !message.member) return;
      const cfg = getSettings(message.guild.id).leveling;
      if (!cfg.enabled) return;
      const { channel, member, author, guild } = message;
      if (cfg.noXpChannels.includes(channel.id) || cfg.noXpChannels.includes(channel.parentId)) return;
      if (cfg.noXpRoles.some((id) => member.roles.cache.has(id))) return;
      // Checked in memory so the database is only touched when XP is actually awarded.
      const key = `${guild.id}:${author.id}`;
      const now = Date.now();
      if ((cooldowns.get(key) ?? 0) > now) return;
      cooldowns.set(key, now + cfg.cooldownSeconds * 1000);
      const gain = rand(Math.min(cfg.xpMin, cfg.xpMax), Math.max(cfg.xpMin, cfg.xpMax));
      const total = await addXp(guild.id, author.id, author.username, gain);
      const level = levelFromXp(total);
      if (level > levelFromXp(total - gain)) await onLevelUp(member, level, cfg, channel);
    },
  },
};
