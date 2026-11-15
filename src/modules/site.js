import { ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { HttpError } from '../api/validate.js';
import { config } from '../config.js';
import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { COLOR, sendTo } from '../core/ui.js';
import { truncate } from '../core/util.js';
import { leaderboard, levelFromXp } from './leveling.js';
import { publicStreamer } from './streams.js';

const HTTPS = '^https://\\S+$';
const INVITE = '^https://(discord\\.gg|discord\\.com/invite)/[\\w-]+/?$';
const APPLY_PLATFORMS = ['Twitch', 'Kick', 'YouTube', 'TikTok'];
const CACHE_MS = 20_000;
const cache = new Map();

export const clearSiteCache = (guildId) => cache.delete(guildId);

const RULES_EN = `## Respect everyone
- No hate speech, harassment, threats or bullying.
- No spam, flooding or advertising without staff approval.
- Keep names, pictures and messages suitable for everyone.

## Scrims and events
- Register before the scrim starts. The custom key is only for you: never share it.
- No teaming, cheating or stream sniping.
- Follow the host's instructions. The host's decision is final.

## Getting help
- Open a ticket to talk to staff or to report someone.`;

const RULES_AR = `## احترم الجميع
- يُمنع خطاب الكراهية والتحرش والتهديد والتنمر.
- يُمنع السبام والإغراق والإعلانات دون موافقة الإدارة.
- اجعل اسمك وصورتك ورسائلك مناسبة للجميع.

## السكريمات والفعاليات
- سجّل قبل بدء السكريم. المفتاح المخصص لك وحدك، فلا تشاركه مع أحد.
- يُمنع التعاون مع الخصوم والغش وتتبّع البث.
- اتبع تعليمات المنظم، فقراره نهائي.

## طلب المساعدة
- افتح تذكرة للتواصل مع الإدارة أو للإبلاغ عن أحد الأعضاء.`;

/** The server the public website is about: SITE_GUILD_ID, or else the biggest server the bot is in. */
export function siteGuild(client) {
  if (config.siteGuildId) return client.guilds.cache.get(config.siteGuildId) ?? null;
  return [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount)[0] ?? null;
}

const discordLink = (s) => (s.message_id ? `https://discord.com/channels/${s.guild_id}/${s.channel_id}/${s.message_id}` : null);

/** Everything the public website shows. Read-only and safe to show anyone: no keys, no private channels. */
export async function publicSite(client) {
  const guild = siteGuild(client);
  if (!guild) throw new HttpError(404, 'The bot is not in a server yet.');
  const cached = cache.get(guild.id);
  if (cached && cached.at > Date.now() - CACHE_MS) return cached.data;

  const s = getSettings(guild.id).site;
  const now = Date.now();
  const [posts, events, alerts, scrims, top] = await Promise.all([
    db.all('SELECT * FROM site_posts WHERE guild_id = $1 ORDER BY pinned DESC, created_at DESC LIMIT 12', [guild.id]),
    db.all('SELECT * FROM site_events WHERE guild_id = $1 AND starts_at > $2 ORDER BY starts_at LIMIT 12', [guild.id, now - 6 * 36e5]),
    db.all('SELECT * FROM stream_alerts WHERE guild_id = $1 ORDER BY id', [guild.id]),
    db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM scrim_players p WHERE p.scrim_id = s.id) AS players FROM scrims s
       WHERE s.guild_id = $1 AND s.status IN ('scheduled', 'live') ORDER BY s.starts_at LIMIT 12`,
      [guild.id],
    ),
    leaderboard(guild.id, 'xp', 10),
  ]);

  const member = (id) => guild.members.cache.get(id);
  const face = (m) => m?.displayAvatarURL({ size: 128, extension: 'png' }) ?? null;
  // One card per streamer, even when they have alerts in several channels.
  const streamers = [...new Map(alerts.map((r) => [`${r.platform}:${r.platform_id}`, publicStreamer(r, now)])).values()]
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
  const staff = s.staffRoles.map((id) => guild.roles.cache.get(id)).filter(Boolean)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      name: role.name,
      color: role.color ? role.hexColor : null,
      members: [...role.members.values()].filter((m) => !m.user.bot).slice(0, 40).map((m) => ({ name: m.displayName, avatar: face(m) })),
    }));

  const data = {
    guild: {
      id: guild.id, name: guild.name, icon: guild.iconURL({ size: 256, extension: 'png' }),
      members: guild.memberCount,
      online: guild.presences.cache.filter((p) => p.status && p.status !== 'offline').size,
    },
    text: { headline: s.headline, headlineAr: s.headlineAr, intro: s.intro, introAr: s.introAr, about: s.about, aboutAr: s.aboutAr, rules: s.rules, rulesAr: s.rulesAr },
    links: { invite: s.inviteUrl || null, socials: Object.fromEntries(Object.entries(s.socials).filter(([, url]) => url)) },
    pages: s.pages,
    applications: s.applications,
    posts: posts.map((p) => ({ id: p.id, title: p.title, body: p.body, image: p.image_url, pinned: p.pinned, at: Number(p.created_at) })),
    events: events.map((e) => ({ id: e.id, title: e.title, game: e.game, at: Number(e.starts_at), prize: e.prize, description: e.description, link: e.link, image: e.image_url })),
    scrims: scrims.map((x) => ({
      id: x.id, title: x.title, mode: x.mode, build: x.build, region: x.region, at: Number(x.starts_at), live: x.status === 'live',
      players: Number(x.players), maxPlayers: x.max_players, link: discordLink(x),
    })),
    streamers,
    leaderboard: top.map((r) => {
      const m = member(r.user_id);
      return { name: m?.displayName ?? r.username ?? 'Member', avatar: face(m), level: levelFromXp(r.score), xp: Number(r.score) };
    }),
    staff,
  };
  cache.set(guild.id, { at: Date.now(), data });
  return data;
}

/** A member asks to join the streamer team from the website. Staff see it on the dashboard and in Discord. */
export async function submitApplication(client, userId, body) {
  const guild = siteGuild(client);
  if (!guild) throw new HttpError(404, 'The bot is not in a server yet.');
  const s = getSettings(guild.id).site;
  if (!s.applications) throw new HttpError(403, 'Streamer applications are closed right now.');
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new HttpError(403, 'Join the Discord server first, then apply.');
  const platform = APPLY_PLATFORMS.includes(body.platform) ? body.platform : null;
  const link = String(body.link ?? '').trim();
  const message = String(body.message ?? '').trim();
  if (!platform) throw new HttpError(400, 'Pick the platform you stream on.');
  if (!/^https:\/\/\S+$/i.test(link) || link.length > 300) throw new HttpError(400, 'Paste the link to your channel. It starts with https://');
  if (message.length > 600) throw new HttpError(400, 'Keep your message under 600 characters.');
  const row = await db.one(
    `INSERT INTO site_applications(guild_id, user_id, username, platform, link, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (guild_id, user_id) DO NOTHING RETURNING id`,
    [guild.id, userId, member.user.username, platform, link, message || null, Date.now()],
  );
  if (!row) throw new HttpError(409, 'You already applied. Staff will answer you in Discord.');
  await sendTo(guild, s.applicationChannel, {
    embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle('New streamer application')
      .setDescription([`**Member:** <@${userId}> (${member.user.username})`, `**Platform:** ${platform}`, `**Channel:** ${link}`, message && `**Message:** ${truncate(message, 1000)}`].filter(Boolean).join('\n'))
      .setFooter({ text: 'Review it on the website dashboard under Streamer applications' }).setTimestamp()],
    allowedMentions: { parse: [] },
  });
  return { ok: true };
}

async function createInvite(guild) {
  const me = guild.members.me;
  const canInvite = (c) => c?.type === ChannelType.GuildText && c.permissionsFor(me)?.has(P.CreateInstantInvite);
  const channel = canInvite(guild.systemChannel) ? guild.systemChannel : guild.channels.cache.find(canInvite);
  if (!channel) throw new Error('I need a text channel where I can create invites.');
  const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Join button on the community website' });
  await updateSettings(guild.id, (s) => { s.site.inviteUrl = invite.url; });
  clearSiteCache(guild.id);
  return `Invite link saved: ${invite.url}`;
}

const bySite = (fn) => async (guild, ...args) => {
  const result = await fn(guild, ...args);
  clearSiteCache(guild.id);
  return result;
};

export default {
  name: 'site',
  label: '🌐 Website',
  defaults: {
    headline: 'Where players level up together',
    headlineAr: 'المكان الذي يرتقي فيه اللاعبون معًا',
    intro: 'ELEVATE is a gaming community for scrims, streams and good company. Join the Discord and play with us.',
    introAr: 'ELEVATE مجتمع ألعاب للسكريمات والبث المباشر والصحبة الطيبة. انضم إلى سيرفر الديسكورد والعب معنا.',
    about: '', aboutAr: '', rules: RULES_EN, rulesAr: RULES_AR,
    inviteUrl: '',
    socials: { youtube: '', tiktok: '', twitch: '', kick: '', instagram: '', x: '' },
    pages: { streamers: true, events: true, leaderboard: true, staff: true, rules: true },
    staffRoles: [],
    applications: true,
    applicationChannel: null,
  },
  form: {
    title: 'Website',
    description: 'What visitors see on the public website. Text has an English and an Arabic version; the Arabic one shows when a visitor switches language. Changes appear within 20 seconds.',
    fields: [
      { key: 'headline', type: 'text', label: 'Headline', max: 120, group: 'Front page' },
      { key: 'headlineAr', type: 'text', label: 'Headline (Arabic)', max: 120, group: 'Front page' },
      { key: 'intro', type: 'textarea', label: 'Introduction', max: 400, group: 'Front page' },
      { key: 'introAr', type: 'textarea', label: 'Introduction (Arabic)', max: 400, group: 'Front page' },
      { key: 'about', type: 'textarea', label: 'About the community', max: 3000, group: 'About and rules', help: 'Shown at the bottom of the front page. Leave empty to hide it.' },
      { key: 'aboutAr', type: 'textarea', label: 'About the community (Arabic)', max: 3000, group: 'About and rules' },
      { key: 'rules', type: 'textarea', label: 'Rules', max: 6000, group: 'About and rules', help: 'Start a line with ## for a heading and - for a list item.' },
      { key: 'rulesAr', type: 'textarea', label: 'Rules (Arabic)', max: 6000, group: 'About and rules' },
      { key: 'inviteUrl', type: 'text', label: 'Discord invite link', max: 200, pattern: INVITE, placeholder: 'https://discord.gg/...', group: 'Links', help: 'Used by every "Join the Discord" button. Press "Create invite link" below to make one.' },
      { key: 'socials.youtube', type: 'text', label: 'YouTube', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'socials.tiktok', type: 'text', label: 'TikTok', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'socials.twitch', type: 'text', label: 'Twitch', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'socials.kick', type: 'text', label: 'Kick', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'socials.instagram', type: 'text', label: 'Instagram', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'socials.x', type: 'text', label: 'X (Twitter)', max: 200, pattern: HTTPS, placeholder: 'https://...', group: 'Links' },
      { key: 'pages.streamers', type: 'bool', label: 'Streamers page', group: 'Pages' },
      { key: 'pages.events', type: 'bool', label: 'Events page', group: 'Pages' },
      { key: 'pages.leaderboard', type: 'bool', label: 'Leaderboard page', group: 'Pages' },
      { key: 'pages.staff', type: 'bool', label: 'Staff page', group: 'Pages' },
      { key: 'pages.rules', type: 'bool', label: 'Rules page', group: 'Pages' },
      { key: 'staffRoles', type: 'roles', label: 'Roles shown on the Staff page', group: 'Pages', help: 'Highest role first.' },
      { key: 'applications', type: 'bool', label: 'Accept streamer applications', group: 'Streamer applications' },
      { key: 'applicationChannel', type: 'channel', label: 'Post new applications in', group: 'Streamer applications', help: 'Use a staff-only channel.' },
    ],
    actions: [{ id: 'invite', label: 'Create invite link' }],
  },
  actions: { invite: (guild) => createInvite(guild) },
  onSave: (guild) => clearSiteCache(guild.id),

  collections: {
    posts: {
      title: 'News posts',
      description: 'Announcements on the front page of the website, newest first. Pinned posts stay on top.',
      submitLabel: 'Publish post',
      columns: [
        { key: 'title', label: 'Title', type: 'text', max: 120, required: true },
        { key: 'body', label: 'Text', type: 'textarea', max: 2000, required: true, hideInList: true },
        { key: 'image_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
        { key: 'pinned', label: 'Position', type: 'select', options: ['Normal', 'Pinned'] },
        { key: 'created_at', label: 'Published', type: 'text', readOnly: true, format: 'time' },
      ],
      async list(guildId) {
        const rows = await db.all('SELECT * FROM site_posts WHERE guild_id = $1 ORDER BY pinned DESC, created_at DESC', [guildId]);
        return rows.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned ? 'Pinned' : 'Normal', created_at: r.created_at }));
      },
      create: bySite(async (guild, row, userId) => {
        const count = await db.one('SELECT COUNT(*) AS n FROM site_posts WHERE guild_id = $1', [guild.id]);
        if (Number(count.n) >= 100) throw new Error('Delete some old posts first. The website keeps up to 100.');
        await db.run(
          'INSERT INTO site_posts(guild_id, title, body, image_url, pinned, created_at, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [guild.id, row.title, row.body, row.image_url ?? null, row.pinned === 'Pinned', Date.now(), userId],
        );
      }),
      remove: bySite((guild, id) => db.run('DELETE FROM site_posts WHERE guild_id = $1 AND id = $2', [guild.id, id])),
    },
    events: {
      title: 'Events',
      description: 'Tournaments and events on the website. Scrims made with /scrim appear on the Events page by themselves. Events disappear 6 hours after they start.',
      submitLabel: 'Add event',
      columns: [
        { key: 'title', label: 'Title', type: 'text', max: 120, required: true, placeholder: 'ELEVATE Cup' },
        { key: 'game', label: 'Game and mode', type: 'text', max: 80, placeholder: 'Fortnite Zero Build Trios' },
        { key: 'starts_at', label: 'Starts', type: 'datetime', required: true, format: 'time' },
        { key: 'prize', label: 'Prize', type: 'text', max: 80, placeholder: 'Optional' },
        { key: 'description', label: 'Details', type: 'textarea', max: 1500, hideInList: true },
        { key: 'link', label: 'Sign-up or info link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
        { key: 'image_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
      ],
      list: (guildId) => db.all('SELECT id, title, game, starts_at, prize FROM site_events WHERE guild_id = $1 ORDER BY starts_at', [guildId]),
      create: bySite(async (guild, row) => {
        const count = await db.one('SELECT COUNT(*) AS n FROM site_events WHERE guild_id = $1', [guild.id]);
        if (Number(count.n) >= 100) throw new Error('Delete some old events first. The website keeps up to 100.');
        await db.run(
          'INSERT INTO site_events(guild_id, title, game, starts_at, prize, description, link, image_url, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [guild.id, row.title, row.game ?? null, row.starts_at, row.prize ?? null, row.description ?? null, row.link ?? null, row.image_url ?? null, Date.now()],
        );
      }),
      remove: bySite((guild, id) => db.run('DELETE FROM site_events WHERE guild_id = $1 AND id = $2', [guild.id, id])),
    },
    applications: {
      title: 'Streamer applications',
      description: 'Members who applied on the website to join the streamer team. To accept someone, add them on the Stream alerts page and tell them in Discord. Mark an application done to remove it; that member can then apply again.',
      removeLabel: 'Mark done',
      columns: [
        { key: 'member', label: 'Member', type: 'text', readOnly: true },
        { key: 'platform', label: 'Platform', type: 'text', readOnly: true },
        { key: 'link', label: 'Channel', type: 'text', readOnly: true },
        { key: 'message', label: 'Message', type: 'text', readOnly: true },
        { key: 'created_at', label: 'Sent', type: 'text', readOnly: true, format: 'time' },
      ],
      async list(guildId, guild) {
        const rows = await db.all('SELECT * FROM site_applications WHERE guild_id = $1 ORDER BY created_at DESC', [guildId]);
        return rows.map((r) => ({
          id: r.id, member: guild?.members.cache.get(r.user_id)?.displayName ?? r.username, platform: r.platform, link: r.link, message: r.message ?? '', created_at: r.created_at,
        }));
      },
      remove: (guild, id) => db.run('DELETE FROM site_applications WHERE guild_id = $1 AND id = $2', [guild.id, id]),
    },
  },
};
