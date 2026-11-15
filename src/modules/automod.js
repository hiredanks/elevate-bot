import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { logger } from '../core/logger.js';
import { punish } from '../core/punish.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, COLOR, embed, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { noop, sleep, truncate } from '../core/util.js';

const FILTERS = {
  scam: ['Scam and phishing links', 'Fake Nitro or Steam gifts and lookalike domains.'],
  invites: ['Discord invites', 'Invite links to other servers.'],
  links: ['All links', 'Anything that is not on the allowed domain list.'],
  badwords: ['Blocked words', 'Your own word list. Catches common letter swaps such as b4d.'],
  mentions: ['Mass mentions', 'Too many people or roles pinged in one message.'],
  caps: ['Excessive caps', 'Messages that are mostly capital letters.'],
  emoji: ['Emoji spam', 'Too many emoji in one message.'],
  newlines: ['Wall of text', 'Too many line breaks in one message.'],
  zalgo: ['Zalgo text', 'Corrupted-looking stacked characters.'],
  spam: ['Message spam', 'Too many messages in a short time.'],
  duplicates: ['Repeated messages', 'The same text sent over and over.'],
};
const ACTIONS = ['delete', 'warn', 'timeout', 'kick', 'ban'];
const LIMIT_FIELDS = {
  spam: ['count', 'seconds'], duplicates: ['count', 'seconds'], caps: ['percent'],
  mentions: ['max'], emoji: ['max'], newlines: ['max'],
};
const filter = (action, extra = {}) => ({ enabled: false, action, ...extra });

const INVITE_RE = /(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite|dsc\.gg)\/[\w-]+/i;
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|xyz|ru|tk|ml|ga|cf|me|co|info|biz|link|click|top|site|online|shop|app|dev|ly))\b/gi;
const OFFICIAL_RE = /(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.media|discordstatus\.com|steamcommunity\.com|steampowered\.com)$/;
const LOOKALIKE_RE = /d[i1l!]+s[ck]+[o0]+r[dcl]|steam-?c[o0]mmun|stea[mr]n?c[o0]m|free-?nitro|nitro-?(gift|drop)/;
const SCAM_PHRASE_RE = /free\s+(discord\s+)?nitro|nitro\s+for\s+free|steam\s+gift|claim\s+(your\s+)?(free\s+)?(nitro|gift)|i('?m| am)\s+leaving\s+cs/i;

export function extractHosts(content) {
  const hosts = [];
  for (const m of content.matchAll(/https?:\/\/([^\s/<>:?#]+)/gi)) hosts.push(m[1].toLowerCase());
  for (const m of content.replace(/https?:\/\/\S+/gi, ' ').matchAll(BARE_DOMAIN_RE)) hosts.push(m[1].toLowerCase());
  return hosts;
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const clean = (s) => s.normalize('NFKC').toLowerCase().replace(/[​-‏﻿­]/g, '');
const unleet = (s) => s.replace(/[013457@$!]/g, (c) => LEET[c]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCache = new Map();

function wordRegex(words) {
  const key = words.join('\0');
  let re = wordCache.get(key);
  if (!re) {
    if (wordCache.size > 500) wordCache.clear();
    // Unicode-aware edges: \b only understands ASCII, which would break Arabic and other scripts.
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRe(clean(w))).join('|')})(?![\\p{L}\\p{N}])`, 'u');
    wordCache.set(key, re);
  }
  return re;
}

/** Pure content check. Returns { filter, reason } or null. */
export function inspectContent(cfg, content, { mentions = 0 } = {}) {
  const f = cfg.filters;
  const hit = (name, reason) => ({ filter: name, reason, action: f[name].action });
  const hosts = extractHosts(content);

  if (f.scam.enabled && hosts.length) {
    const fakeHost = hosts.some((h) => !OFFICIAL_RE.test(h) && LOOKALIKE_RE.test(h));
    if (fakeHost || (SCAM_PHRASE_RE.test(content) && hosts.some((h) => !OFFICIAL_RE.test(h)))) return hit('scam', 'Likely scam link');
  }
  if (f.invites.enabled && INVITE_RE.test(content)) return hit('invites', 'Posted a Discord invite');
  if (f.links.enabled && hosts.some((h) => !f.links.allow.some((d) => h === d || h.endsWith(`.${d}`)))) return hit('links', 'Posted a link');
  if (f.badwords.enabled && f.badwords.words.length) {
    const re = wordRegex(f.badwords.words);
    const text = clean(content);
    if (re.test(text) || re.test(unleet(text))) return hit('badwords', 'Used a blocked word');
  }
  if (f.mentions.enabled && mentions > f.mentions.max) return hit('mentions', `Mass mention (${mentions})`);
  if (f.caps.enabled) {
    const letters = content.replace(/<a?:\w+:\d+>|<[@#&!]+\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
    if (letters.length >= f.caps.min) {
      const upper = letters.filter((c) => c !== c.toLowerCase()).length;
      if ((upper / letters.length) * 100 >= f.caps.percent) return hit('caps', 'Excessive caps');
    }
  }
  if (f.emoji.enabled) {
    const count = (content.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}/gu) ?? []).length;
    if (count > f.emoji.max) return hit('emoji', `Emoji spam (${count})`);
  }
  if (f.newlines.enabled && content.split('\n').length - 1 > f.newlines.max) return hit('newlines', 'Too many line breaks');
  if (f.zalgo.enabled && (content.match(/\p{Mn}{3,}/gu) ?? []).length >= 3) return hit('zalgo', 'Zalgo text');
  return null;
}

const recent = new Map();
const punishedUntil = new Map();

/** Tracks message rate per user. Returns a hit plus the message ids to clean up. */
export function inspectRate(cfg, key, msg, now = Date.now()) {
  const f = cfg.filters;
  const list = (recent.get(key) ?? []).filter((m) => now - m.at < 120_000);
  list.push({ at: now, id: msg.id, channelId: msg.channelId, text: msg.content });
  recent.set(key, list);
  if (f.spam.enabled) {
    const inWindow = list.filter((m) => now - m.at <= f.spam.seconds * 1000);
    if (inWindow.length >= f.spam.count) {
      recent.delete(key);
      return { filter: 'spam', reason: 'Message spam', action: f.spam.action, purge: inWindow.map((m) => m.id) };
    }
  }
  if (f.duplicates.enabled && msg.content) {
    const same = list.filter((m) => m.text === msg.content && now - m.at <= f.duplicates.seconds * 1000);
    if (same.length >= f.duplicates.count) {
      recent.delete(key);
      return { filter: 'duplicates', reason: 'Repeated messages', action: f.duplicates.action, purge: same.map((m) => m.id) };
    }
  }
  return null;
}

function isExempt(message, cfg) {
  const { member, channel } = message;
  if (!member) return true;
  if (member.permissions.has(P.ManageMessages)) return true;
  if (cfg.exemptChannels.includes(channel.id) || cfg.exemptChannels.includes(channel.parentId)) return true;
  return cfg.exemptRoles.some((id) => member.roles.cache.has(id));
}

async function enforce(message, cfg, hit) {
  const { guild, author, member, channel } = message;
  message.blocked = true;
  await message.delete().catch(noop);
  const others = hit.purge?.filter((id) => id !== message.id);
  if (others?.length) await channel.bulkDelete(others, true).catch(noop);

  const key = `${guild.id}:${author.id}`;
  const cooling = (punishedUntil.get(key) ?? 0) > Date.now();
  if (cooling) return;
  punishedUntil.set(key, Date.now() + 10_000);

  if (hit.action !== 'delete') {
    try {
      await punish(guild, {
        action: hit.action, user: author, member, moderator: message.client.user, reason: `AutoMod: ${hit.reason}`,
        durationMs: hit.action === 'timeout' ? cfg.timeoutMinutes * 60_000 : null,
      });
    } catch (err) {
      logger.warn(`AutoMod could not ${hit.action} ${author.id}: ${err.message}`);
    }
  }

  const log = new EmbedBuilder().setColor(COLOR.warn).setTitle(`AutoMod: ${hit.reason}`)
    .addFields(
      { name: 'User', value: `<@${author.id}> (\`${author.id}\`)`, inline: true },
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Action', value: hit.action, inline: true },
      { name: 'Message', value: truncate(message.content || '(no text)', 1000) },
    ).setTimestamp();
  await sendTo(guild, cfg.logChannel ?? getSettings(guild.id).moderation.logChannel, { embeds: [log], allowedMentions: { parse: [] } });

  const notice = await channel.send({ embeds: [embed(`🛡️ <@${author.id}>, your message was removed: **${hit.reason}**.`, COLOR.warn)] }).catch(() => null);
  if (notice) sleep(6000).then(() => notice.delete().catch(noop));
}

const filterChoices = Object.entries(FILTERS).map(([value, [name]]) => ({ name, value }));
const textChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory];

export default {
  name: 'automod',
  label: '🤖 AutoMod',
  defaults: {
    enabled: false, logChannel: null, timeoutMinutes: 10, exemptRoles: [], exemptChannels: [],
    filters: {
      scam: filter('timeout'), invites: filter('delete'), links: filter('delete', { allow: [] }),
      badwords: filter('delete', { words: [] }), mentions: filter('timeout', { max: 5 }),
      caps: filter('delete', { percent: 70, min: 10 }), emoji: filter('delete', { max: 10 }),
      newlines: filter('delete', { max: 15 }), zalgo: filter('delete'),
      spam: filter('timeout', { count: 6, seconds: 5 }), duplicates: filter('delete', { count: 3, seconds: 20 }),
    },
  },
  form: {
    title: 'AutoMod',
    description: 'Removes unwanted messages before anyone has to report them. Staff with Manage Messages are never filtered.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Enable AutoMod' },
      { key: 'logChannel', type: 'channel', label: 'Log channel', help: 'Falls back to the moderation log.' },
      { key: 'timeoutMinutes', type: 'int', label: 'Timeout length (minutes)', min: 1, max: 40320 },
      { key: 'exemptRoles', type: 'roles', label: 'Roles that bypass AutoMod' },
      { key: 'exemptChannels', type: 'channels', label: 'Channels AutoMod ignores' },
      ...Object.entries(FILTERS).flatMap(([name, [label, help]]) => [
        { key: `filters.${name}.enabled`, type: 'bool', label, help, group: 'Filters' },
        { key: `filters.${name}.action`, type: 'select', label: 'Action', options: ACTIONS, group: 'Filters', showIf: `filters.${name}.enabled` },
      ]),
      { key: 'filters.badwords.words', type: 'list', label: 'Blocked words', group: 'Filter details', max: 500 },
      { key: 'filters.links.allow', type: 'list', label: 'Allowed domains', group: 'Filter details', help: 'For example youtube.com', max: 200 },
      { key: 'filters.mentions.max', type: 'int', label: 'Max mentions per message', min: 1, max: 50, group: 'Filter details' },
      { key: 'filters.emoji.max', type: 'int', label: 'Max emoji per message', min: 1, max: 100, group: 'Filter details' },
      { key: 'filters.caps.percent', type: 'int', label: 'Caps limit (%)', min: 30, max: 100, group: 'Filter details' },
      { key: 'filters.newlines.max', type: 'int', label: 'Max line breaks', min: 1, max: 100, group: 'Filter details' },
      { key: 'filters.spam.count', type: 'int', label: 'Spam: messages', min: 2, max: 50, group: 'Filter details' },
      { key: 'filters.spam.seconds', type: 'int', label: 'Spam: within seconds', min: 1, max: 120, group: 'Filter details' },
      { key: 'filters.duplicates.count', type: 'int', label: 'Repeats: messages', min: 2, max: 50, group: 'Filter details' },
      { key: 'filters.duplicates.seconds', type: 'int', label: 'Repeats: within seconds', min: 1, max: 120, group: 'Filter details' },
    ],
  },

  commands: [{
    data: cmd('automod', 'Configure automatic moderation', P.ManageGuild)
      .addSubcommand((s) => s.setName('status').setDescription('Show AutoMod settings'))
      .addSubcommand((s) => s.setName('power').setDescription('Turn AutoMod on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('filter').setDescription('Configure one filter')
        .addStringOption((o) => o.setName('name').setDescription('Filter').setRequired(true).addChoices(...filterChoices))
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addStringOption((o) => o.setName('action').setDescription('What happens on a match').addChoices(...ACTIONS.map((a) => ({ name: a, value: a })))))
      .addSubcommand((s) => s.setName('limit').setDescription('Change how sensitive a filter is')
        .addStringOption((o) => o.setName('name').setDescription('Filter').setRequired(true)
          .addChoices(...Object.keys(LIMIT_FIELDS).map((v) => ({ name: FILTERS[v][0], value: v }))))
        .addIntegerOption((o) => o.setName('value').setDescription('Count, percent or maximum').setRequired(true).setMinValue(1).setMaxValue(100))
        .addIntegerOption((o) => o.setName('seconds').setDescription('Time window, for spam and repeats').setMinValue(1).setMaxValue(120)))
      .addSubcommand((s) => s.setName('word').setDescription('Add or remove a blocked word')
        .addStringOption((o) => o.setName('word').setDescription('Word or phrase').setRequired(true).setMaxLength(60))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove instead of add')))
      .addSubcommand((s) => s.setName('domain').setDescription('Add or remove an allowed domain')
        .addStringOption((o) => o.setName('domain').setDescription('For example youtube.com').setRequired(true).setMaxLength(100))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove instead of add')))
      .addSubcommand((s) => s.setName('exempt-role').setDescription('Toggle a role bypassing AutoMod')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
      .addSubcommand((s) => s.setName('exempt-channel').setDescription('Toggle a channel being ignored by AutoMod')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').setRequired(true).addChannelTypes(...textChannels))),
    async run(i) {
      const sub = i.options.getSubcommand();
      const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

      if (sub === 'status') {
        const cfg = getSettings(i.guildId).automod;
        const lines = Object.entries(FILTERS).map(([k, [label]]) => `${cfg.filters[k].enabled ? '🟢' : '⚫'} **${label}**: ${cfg.filters[k].action}`);
        return okPrivate(i, `AutoMod is **${cfg.enabled ? 'ON' : 'OFF'}**\n\n${lines.join('\n')}\n\n**Blocked words:** ${cfg.filters.badwords.words.length}\n**Allowed domains:** ${cfg.filters.links.allow.join(', ') || 'none'}`);
      }
      if (sub === 'power') {
        const enabled = i.options.getBoolean('enabled', true);
        await updateSettings(i.guildId, (s) => { s.automod.enabled = enabled; });
        return ok(i, `AutoMod is now **${enabled ? 'on' : 'off'}**.`);
      }
      if (sub === 'filter') {
        const name = i.options.getString('name', true);
        const enabled = i.options.getBoolean('enabled', true);
        const action = i.options.getString('action');
        await updateSettings(i.guildId, (s) => {
          s.automod.filters[name].enabled = enabled;
          if (action) s.automod.filters[name].action = action;
          if (enabled) s.automod.enabled = true;
        });
        return ok(i, `**${FILTERS[name][0]}** is ${enabled ? 'on' : 'off'}${action ? `, action: **${action}**` : ''}.`);
      }
      if (sub === 'limit') {
        const name = i.options.getString('name', true);
        const value = i.options.getInteger('value', true);
        const seconds = i.options.getInteger('seconds');
        const [first, second] = LIMIT_FIELDS[name];
        await updateSettings(i.guildId, (s) => {
          s.automod.filters[name][first] = value;
          if (second && seconds) s.automod.filters[name][second] = seconds;
        });
        return ok(i, `**${FILTERS[name][0]}**: ${first} = ${value}${second && seconds ? `, ${second} = ${seconds}` : ''}.`);
      }
      if (sub === 'word') {
        const word = i.options.getString('word', true).trim().toLowerCase();
        const remove = i.options.getBoolean('remove') ?? false;
        await updateSettings(i.guildId, (s) => {
          const list = s.automod.filters.badwords.words.filter((w) => w !== word);
          s.automod.filters.badwords.words = remove ? list : [...list, word];
        });
        return okPrivate(i, remove ? 'Word removed.' : 'Word added. Remember to enable the Blocked words filter.');
      }
      if (sub === 'domain') {
        const domain = i.options.getString('domain', true).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const remove = i.options.getBoolean('remove') ?? false;
        await updateSettings(i.guildId, (s) => {
          const list = s.automod.filters.links.allow.filter((d) => d !== domain);
          s.automod.filters.links.allow = remove ? list : [...list, domain];
        });
        return ok(i, `\`${domain}\` ${remove ? 'removed from' : 'added to'} allowed domains.`);
      }
      if (sub === 'exempt-role') {
        const role = i.options.getRole('role', true);
        const { automod } = await updateSettings(i.guildId, (s) => { s.automod.exemptRoles = toggle(s.automod.exemptRoles, role.id); });
        return ok(i, `${role} ${automod.exemptRoles.includes(role.id) ? 'now bypasses' : 'no longer bypasses'} AutoMod.`, { allowedMentions: { parse: [] } });
      }
      if (sub === 'exempt-channel') {
        const channel = i.options.getChannel('channel', true);
        const { automod } = await updateSettings(i.guildId, (s) => { s.automod.exemptChannels = toggle(s.automod.exemptChannels, channel.id); });
        return ok(i, `${channel} is ${automod.exemptChannels.includes(channel.id) ? 'now ignored' : 'no longer ignored'} by AutoMod.`);
      }
      return fail(i, 'Unknown option.');
    },
  }],

  events: {
    async messageCreate(message) {
      if (!message.guild || message.author.bot || message.system || message.blocked) return;
      const cfg = getSettings(message.guild.id).automod;
      if (!cfg.enabled || isExempt(message, cfg)) return;
      const mentions = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0);
      const hit = inspectContent(cfg, message.content, { mentions }) ?? inspectRate(cfg, `${message.guild.id}:${message.author.id}`, message);
      if (hit) await enforce(message, cfg, hit);
    },
    async messageUpdate(oldMessage, message) {
      if (!message.guild || message.partial || message.author.bot || oldMessage.content === message.content) return;
      const cfg = getSettings(message.guild.id).automod;
      if (!cfg.enabled || isExempt(message, cfg)) return;
      const hit = inspectContent(cfg, message.content, { mentions: message.mentions.users.size + message.mentions.roles.size });
      if (hit) await enforce(message, cfg, hit);
    },
  },
};
