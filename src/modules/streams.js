import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { config } from '../config.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { getSettings } from '../core/settings.js';
import { cmd, fail, ok, okPrivate, sendTo } from '../core/ui.js';
import { render, truncate, ts } from '../core/util.js';

const MAX_ALERTS = 25;
const CHECK_EVERY_MS = 60_000;
const MANUAL_COOLDOWN_MS = 15 * 60_000;
// Without a YouTube key, a video or stream counts as new for this long after it is published.
const FEED_RECENT_MS = 3 * 36e5;
const PLATFORMS = {
  twitch: { label: 'Twitch', color: 0x9146ff, pollMs: 2 * 60_000 },
  kick: { label: 'Kick', color: 0x53fc18, pollMs: 2 * 60_000 },
  youtube: { label: 'YouTube', color: 0xff0000, pollMs: 5 * 60_000 },
  tiktok: { label: 'TikTok', color: 0xfe2c55, pollMs: null },
};
const PINGS = { '@everyone': 'everyone', '@here': 'here', 'No ping': 'none' };
const IMAGES = { 'Profile picture': 'avatar', 'Stream preview': 'preview' };
const DEFAULT_MESSAGE = '{name} is live!';
const HTTPS_IMAGE = /^https:\/\/\S+$/i;
const lastPoll = {};
const tokens = {};

class StreamError extends Error {}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  // Only the host is reported, because YouTube URLs carry the API key.
  if (!res.ok) throw new StreamError(`${new URL(url).hostname} returned ${res.status}`);
  return res.json();
}

async function appToken(name, url, clientId, clientSecret) {
  const cached = tokens[name];
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new StreamError(`${name} rejected the client ID or secret. Check them on Render.`);
  const json = await res.json();
  tokens[name] = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

function parseName(input, re, what) {
  const id = String(input).trim().match(re)?.[1];
  if (!id) throw new StreamError(`Type a ${what} username or link.`);
  return id.toLowerCase();
}

/**
 * Each platform turns the typed account into an ID, and, when it can check by itself, reports who is live.
 * `automatic()` says whether it can check by itself right now. When it cannot, the streamer posts with /live.
 */
const twitch = {
  automatic: () => Boolean(config.twitchClientId && config.twitchClientSecret),
  parse: (input) => parseName(input, /^(?:https?:\/\/)?(?:www\.)?(?:twitch\.tv\/)?@?([a-z0-9_]{3,25})\/?$/i, 'Twitch'),
  url: (id) => `https://twitch.tv/${id}`,
  async headers() {
    return { authorization: `Bearer ${await appToken('Twitch', 'https://id.twitch.tv/oauth2/token', config.twitchClientId, config.twitchClientSecret)}`, 'client-id': config.twitchClientId };
  },
  async profile(login) {
    const { data } = await getJson(`https://api.twitch.tv/helix/users?login=${login}`, await this.headers());
    if (!data?.length) throw new StreamError(`There is no Twitch account named ${login}.`);
    return { platformId: data[0].login.toLowerCase(), displayName: data[0].display_name, avatarUrl: data[0].profile_image_url };
  },
  async check(ids) {
    const live = new Map();
    for (let n = 0; n < ids.length; n += 100) {
      const query = ids.slice(n, n + 100).map((id) => `user_login=${encodeURIComponent(id)}`).join('&');
      const { data = [] } = await getJson(`https://api.twitch.tv/helix/streams?${query}`, await this.headers());
      for (const s of data) {
        live.set(s.user_login.toLowerCase(), {
          streamId: s.id, title: s.title, game: s.game_name, url: `https://twitch.tv/${s.user_login}`,
          thumbnail: s.thumbnail_url?.replace('{width}', '1280').replace('{height}', '720'),
        });
      }
    }
    return live;
  },
};

const kick = {
  automatic: () => Boolean(config.kickClientId && config.kickClientSecret),
  parse: (input) => parseName(input, /^(?:https?:\/\/)?(?:www\.)?(?:kick\.com\/)?@?([a-z0-9_-]{2,25})\/?$/i, 'Kick'),
  url: (id) => `https://kick.com/${id}`,
  async headers() {
    return { authorization: `Bearer ${await appToken('Kick', 'https://id.kick.com/oauth/token', config.kickClientId, config.kickClientSecret)}` };
  },
  async profile(slug) {
    const headers = await this.headers();
    const { data } = await getJson(`https://api.kick.com/public/v1/channels?slug=${slug}`, headers);
    if (!data?.length) throw new StreamError(`There is no Kick channel named ${slug}.`);
    const users = await getJson(`https://api.kick.com/public/v1/users?id=${data[0].broadcaster_user_id}`, headers).catch(() => ({ data: [] }));
    const user = users.data?.[0];
    return { platformId: data[0].slug.toLowerCase(), displayName: user?.name ?? data[0].slug, avatarUrl: user?.profile_picture ?? null };
  },
  async check(ids) {
    const live = new Map();
    for (let n = 0; n < ids.length; n += 50) {
      const query = ids.slice(n, n + 50).map((id) => `slug=${encodeURIComponent(id)}`).join('&');
      const { data = [] } = await getJson(`https://api.kick.com/public/v1/channels?${query}`, await this.headers());
      for (const c of data) {
        if (!c.stream?.is_live) continue;
        live.set(c.slug.toLowerCase(), {
          streamId: c.stream.start_time ?? c.stream_title, title: c.stream_title, game: c.category?.name ?? null,
          url: `https://kick.com/${c.slug}`, thumbnail: c.stream.thumbnail ?? null,
        });
      }
    }
    return live;
  },
};

const decodeXml = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e]);

/** YouTube's official public feed of a channel's latest videos and streams. Needs no key. */
async function youtubeFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new StreamError('I could not find that YouTube channel. Check the channel ID.');
  if (!res.ok) throw new StreamError(`youtube.com returned ${res.status}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1],
    title: decodeXml(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
    published: Date.parse(e.match(/<published>([^<]+)<\/published>/)?.[1] ?? '') || 0,
    thumbnail: e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? null,
  })).filter((e) => e.id).sort((a, b) => b.published - a.published);
  return { name: decodeXml(xml.match(/<title>([^<]*)<\/title>/)?.[1] ?? '') || channelId, entries };
}

const youtube = {
  // The public feed works without a key, so YouTube is always checked. The key adds live-only alerts and the profile picture.
  automatic: () => true,
  parse(input) {
    const text = String(input).trim();
    const id = text.match(/(UC[\w-]{22})/)?.[1];
    if (id) return id;
    const handle = (text.match(/youtube\.com\/@([\w.-]{3,30})/i) ?? text.match(/^@?([\w.-]{3,30})$/))?.[1];
    if (!handle) throw new StreamError('Type a YouTube @handle, channel link or channel ID.');
    if (!config.youtubeApiKey) {
      throw new StreamError('Without YOUTUBE_API_KEY, paste the channel ID (it starts with UC). On YouTube, open the channel, press "more" next to its description, then Share channel > Copy channel ID.');
    }
    return `@${handle}`;
  },
  url: (id) => `https://www.youtube.com/channel/${id}`,
  async profile(id) {
    if (!config.youtubeApiKey) {
      const feed = await youtubeFeed(id);
      return { platformId: id, displayName: feed.name, avatarUrl: null, latestId: feed.entries[0]?.id ?? null };
    }
    const query = id.startsWith('@') ? `forHandle=${encodeURIComponent(id)}` : `id=${id}`;
    const { items } = await getJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&${query}&key=${config.youtubeApiKey}`);
    if (!items?.length) throw new StreamError('I could not find that YouTube channel.');
    const c = items[0];
    return { platformId: c.id, displayName: c.snippet.title, avatarUrl: c.snippet.thumbnails?.high?.url ?? c.snippet.thumbnails?.default?.url ?? null };
  },
  async check(ids) {
    const live = new Map();
    for (const channelId of ids) {
      const feed = await youtubeFeed(channelId).catch(() => null);
      if (!feed?.entries.length) continue;
      if (!config.youtubeApiKey) {
        // No key: the newest video or stream, while it is recent.
        const newest = feed.entries[0];
        if (Date.now() - newest.published < FEED_RECENT_MS) {
          live.set(channelId, { streamId: newest.id, title: newest.title, game: null, url: `https://www.youtube.com/watch?v=${newest.id}`, thumbnail: newest.thumbnail });
        }
        continue;
      }
      const videoIds = feed.entries.slice(0, 5).map((e) => e.id);
      const { items = [] } = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(',')}&key=${config.youtubeApiKey}`);
      const video = items.find((v) => v.snippet?.liveBroadcastContent === 'live');
      if (video) {
        live.set(channelId, {
          streamId: video.id, title: video.snippet.title, game: null, url: `https://www.youtube.com/watch?v=${video.id}`,
          thumbnail: video.snippet.thumbnails?.maxres?.url ?? video.snippet.thumbnails?.high?.url ?? null,
        });
      }
    }
    return live;
  },
};

// TikTok has no public way to check who is live, so TikTok alerts are always posted with /live.
const tiktok = {
  automatic: () => false,
  parse: (input) => parseName(input, /^(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com\/)?@?([\w.]{2,24})(?:\/live)?\/?$/i, 'TikTok'),
  url: (id) => `https://www.tiktok.com/@${id}/live`,
};

const PROVIDERS = { twitch, kick, youtube, tiktok };
const isAutomatic = (platform) => Boolean(PROVIDERS[platform].check && PROVIDERS[platform].automatic());
const liveUrl = (row) => (row.platform === 'youtube' ? `${youtube.url(row.platform_id)}/live` : PROVIDERS[row.platform].url(row.platform_id));
// A /live post counts as live on the website for this long, since nothing can check when the stream ends.
const MANUAL_LIVE_MS = 2 * 36e5;

/** What the community website shows for one streamer. */
export const publicStreamer = (row, now = Date.now()) => ({
  name: row.display_name,
  platform: PLATFORMS[row.platform].label,
  avatar: row.picture_url || row.avatar_url || null,
  url: liveUrl(row),
  live: Boolean(row.live) || Boolean(row.manual_at && now - Number(row.manual_at) < MANUAL_LIVE_MS),
});

/** The alert: message and ping, then the streamer's name and picture, the stream title, and a Watch button. */
export function alertMessage(row, info, { test = false } = {}) {
  const platform = PLATFORMS[row.platform];
  const ping = test ? '' : { everyone: '@everyone', here: '@here' }[row.ping] ?? '';
  const content = [render(row.message || DEFAULT_MESSAGE, { name: row.display_name, title: info.title, game: info.game ?? '', platform: platform.label }), ping].filter(Boolean).join(' ');
  const avatar = row.picture_url || row.avatar_url || null;
  const e = new EmbedBuilder().setColor(platform.color)
    .setAuthor({ name: row.display_name, iconURL: avatar ?? undefined, url: info.url })
    .setTitle(truncate(info.title || `${row.display_name} is live`, 256)).setURL(info.url)
    .setFooter({ text: platform.label }).setTimestamp();
  if (info.game) e.setDescription(`Playing **${info.game}**`);
  const preview = info.thumbnail ? `${info.thumbnail}${info.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : null;
  // The profile picture is the default. Without one, the stream picture is better than nothing.
  const picture = row.image === 'preview' ? preview ?? avatar : avatar ?? preview;
  if (picture) e.setImage(picture);
  return {
    content, embeds: [e],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Watch Stream').setURL(info.url))],
    allowedMentions: { parse: ping ? ['everyone'] : [] },
  };
}

async function announce(client, row, info) {
  const guild = client.guilds.cache.get(row.guild_id);
  if (!guild) return;
  // Profile pictures change, so they are refreshed each time someone goes live.
  const fresh = await PROVIDERS[row.platform].profile(row.platform_id).catch(() => null);
  if (fresh) {
    Object.assign(row, { display_name: fresh.displayName, avatar_url: fresh.avatarUrl ?? row.avatar_url });
    await db.run('UPDATE stream_alerts SET display_name = $1, avatar_url = $2 WHERE id = $3', [row.display_name, row.avatar_url, row.id]);
  }
  await sendTo(guild, row.channel_id, alertMessage(row, info));
}

export async function pollStreams(client, { force = false } = {}) {
  const now = Date.now();
  for (const [platform, provider] of Object.entries(PROVIDERS)) {
    if (!isAutomatic(platform) || (!force && now - (lastPoll[platform] ?? 0) < PLATFORMS[platform].pollMs)) continue;
    lastPoll[platform] = now;
    const rows = (await db.all('SELECT * FROM stream_alerts WHERE platform = $1', [platform])).filter((r) => client.guilds.cache.has(r.guild_id));
    if (!rows.length) continue;
    let live;
    try {
      live = await provider.check([...new Set(rows.map((r) => r.platform_id))]);
    } catch (err) {
      logger.warn(`${PLATFORMS[platform].label} live check failed: ${err.message}`);
      continue;
    }
    for (const row of rows) {
      const info = live.get(row.platform_id);
      // Stream IDs are unique per stream, so the same stream is never announced twice.
      if (info && row.last_stream_id !== String(info.streamId)) {
        await db.run('UPDATE stream_alerts SET live = TRUE, last_stream_id = $1 WHERE id = $2', [String(info.streamId), row.id]);
        await announce(client, row, info);
      } else if (Boolean(info) !== row.live) {
        await db.run('UPDATE stream_alerts SET live = $1 WHERE id = $2', [Boolean(info), row.id]);
      }
    }
  }
}

export async function addAlert(guild, member, { platform, account, channelId, message, ping, image, pictureUrl = null }) {
  const provider = PROVIDERS[platform];
  if (!provider) throw new StreamError('Pick Twitch, Kick, YouTube or TikTok.');
  if (ping !== 'none' && !member?.permissions.has(P.MentionEveryone)) throw new StreamError('You need the Mention @everyone permission to ping everyone.');
  if (pictureUrl && !HTTPS_IMAGE.test(pictureUrl)) throw new StreamError('The picture link must start with https://');
  const count = await db.one('SELECT COUNT(*) AS n FROM stream_alerts WHERE guild_id = $1', [guild.id]);
  if (Number(count.n) >= MAX_ALERTS) throw new StreamError(`A server can have up to ${MAX_ALERTS} stream alerts.`);
  const id = provider.parse(account);
  // With keys the account is looked up, which proves it exists and fetches the profile picture.
  const profile = provider.profile && provider.automatic()
    ? await provider.profile(id)
    : { platformId: id, displayName: id, avatarUrl: null };
  const duplicate = await db.one('SELECT 1 AS y FROM stream_alerts WHERE guild_id = $1 AND platform = $2 AND platform_id = $3 AND channel_id = $4', [guild.id, platform, profile.platformId, channelId]);
  if (duplicate) throw new StreamError(`${profile.displayName} already has an alert in that channel.`);
  return db.one(
    `INSERT INTO stream_alerts(guild_id, platform, account, platform_id, display_name, avatar_url, channel_id, message, ping, image, picture_url, last_stream_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [guild.id, platform, account, profile.platformId, profile.displayName, profile.avatarUrl, channelId, message || null, ping, image, pictureUrl || null, profile.latestId ?? null],
  );
}

function statusOf(row) {
  if (!isAutomatic(row.platform)) return 'Manual: /live';
  if (row.platform === 'youtube' && !config.youtubeApiKey) return 'Watching for new videos';
  return row.live ? 'Live now' : 'Offline';
}

/** Posts an alert by hand. Used for TikTok, and for Twitch or Kick while their keys are not set. */
export async function postManualAlert(guild, row, title = null) {
  const now = Date.now();
  // Claimed in one statement, so two quick /live commands cannot both post.
  const claimed = await db.one(
    'UPDATE stream_alerts SET manual_at = $1 WHERE id = $2 AND (manual_at IS NULL OR manual_at < $3) RETURNING *',
    [now, row.id, now - MANUAL_COOLDOWN_MS],
  );
  if (!claimed) return null;
  await sendTo(guild, row.channel_id, alertMessage(claimed, { title: title || `Live on ${PLATFORMS[row.platform].label} now`, game: null, url: liveUrl(row), thumbnail: null }));
  return claimed;
}

const platformKey = (label) => Object.keys(PLATFORMS).find((key) => PLATFORMS[key].label === label);
const alertLabel = (r) => `${PLATFORMS[r.platform].label}: ${r.display_name} (#${r.id})`;

export default {
  name: 'streamalerts',
  label: '📡 Stream Alerts',
  defaults: { streamerRole: null },
  form: {
    title: 'Stream alert settings',
    description: 'TikTok has no way to check who is live, so streamers post their TikTok alert with /live. The same goes for Twitch and Kick until their free keys are added on Render.',
    fields: [
      { key: 'streamerRole', type: 'role', label: 'Streamer role', help: 'Members with this role can post live alerts with /live. Staff with Manage Server always can.' },
    ],
  },

  collections: {
    streams: {
      title: 'Stream alerts',
      description: 'Posts an alert when a streamer goes live. YouTube is checked without a key. Twitch and Kick are checked once their free keys are on Render; until then, and always for TikTok, the streamer posts it with /live. The message supports {name}, {title} and {game}.',
      submitLabel: 'Add alert',
      columns: [
        { key: 'platform', label: 'Platform', type: 'select', options: Object.values(PLATFORMS).map((p) => p.label) },
        { key: 'account', label: 'Account', type: 'text', max: 120, required: true, placeholder: 'Username, channel link or YouTube channel ID' },
        { key: 'channel_id', label: 'Post in', type: 'channel', required: true },
        { key: 'message', label: 'Message', type: 'text', max: 300, placeholder: DEFAULT_MESSAGE, hideInList: true },
        { key: 'ping', label: 'Ping', type: 'select', options: Object.keys(PINGS), hideInList: true },
        { key: 'image', label: 'Big picture', type: 'select', options: Object.keys(IMAGES), hideInList: true },
        { key: 'picture_url', label: 'Profile picture link', type: 'text', max: 500, pattern: HTTPS_IMAGE.source, patternFlags: 'i', placeholder: 'Optional. Needed for TikTok', hideInList: true },
        { key: 'status', label: 'Status', type: 'text', readOnly: true },
      ],
      async list(guildId) {
        const rows = await db.all('SELECT * FROM stream_alerts WHERE guild_id = $1 ORDER BY id', [guildId]);
        return rows.map((r) => ({ id: r.id, platform: PLATFORMS[r.platform].label, account: r.display_name, channel_id: r.channel_id, status: statusOf(r) }));
      },
      async create(guild, row, userId) {
        await addAlert(guild, guild.members.cache.get(userId), {
          platform: platformKey(row.platform) ?? 'twitch', account: row.account, channelId: row.channel_id, message: row.message,
          ping: PINGS[row.ping] ?? 'everyone', image: IMAGES[row.image] ?? 'avatar', pictureUrl: row.picture_url,
        });
      },
      remove: (guild, id) => db.run('DELETE FROM stream_alerts WHERE guild_id = $1 AND id = $2', [guild.id, id]),
    },
  },

  commands: [{
    data: cmd('stream', 'Post an alert when a streamer goes live', P.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Add a stream alert')
        .addStringOption((o) => o.setName('platform').setDescription('Where they stream').setRequired(true)
          .addChoices(...Object.entries(PLATFORMS).map(([value, p]) => ({ name: p.label, value }))))
        .addStringOption((o) => o.setName('account').setDescription('Username or channel link').setRequired(true).setMaxLength(120))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('message').setDescription('Supports {name} {title} {game}').setMaxLength(300))
        .addStringOption((o) => o.setName('ping').setDescription('Who to ping').addChoices(...Object.entries(PINGS).map(([name, value]) => ({ name, value }))))
        .addStringOption((o) => o.setName('picture').setDescription('Big picture in the alert').addChoices(...Object.entries(IMAGES).map(([name, value]) => ({ name, value }))))
        .addStringOption((o) => o.setName('picture_link').setDescription('Link to their profile picture. Needed for TikTok').setMaxLength(500)))
      .addSubcommand((s) => s.setName('list').setDescription('List stream alerts'))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a stream alert')
        .addIntegerOption((o) => o.setName('id').setDescription('ID from the list').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('test').setDescription('Post a sample alert so you can see how it looks')
        .addIntegerOption((o) => o.setName('id').setDescription('ID from the list').setRequired(true).setMinValue(1))),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const rows = await db.all('SELECT * FROM stream_alerts WHERE guild_id = $1 ORDER BY id', [i.guildId]);
        return okPrivate(i, rows.map((r) => `**${r.id}.** ${PLATFORMS[r.platform].label}: ${r.display_name} in <#${r.channel_id}> (${statusOf(r).toLowerCase()})`).join('\n') || 'No stream alerts yet.');
      }
      if (sub === 'add') {
        await i.deferReply({ flags: 64 });
        try {
          const row = await addAlert(i.guild, i.member, {
            platform: i.options.getString('platform', true), account: i.options.getString('account', true), channelId: i.options.getChannel('channel', true).id,
            message: i.options.getString('message'), ping: i.options.getString('ping') ?? 'everyone', image: i.options.getString('picture') ?? 'avatar',
            pictureUrl: i.options.getString('picture_link')?.trim(),
          });
          const how = isAutomatic(row.platform) ? 'It posts by itself when they go live.' : `Post it with \`/live alert:${row.id}\` when they go live.`;
          return ok(i, `Alert **${row.id}** added for **${row.display_name}**. ${how} Try \`/stream test id:${row.id}\` to see how it looks.`);
        } catch (err) {
          if (!(err instanceof StreamError)) throw err;
          return fail(i, err.message);
        }
      }
      const row = await db.one('SELECT * FROM stream_alerts WHERE guild_id = $1 AND id = $2', [i.guildId, i.options.getInteger('id', true)]);
      if (!row) return fail(i, 'No stream alert with that ID.');
      if (sub === 'remove') {
        await db.run('DELETE FROM stream_alerts WHERE id = $1', [row.id]);
        return ok(i, `Alert for **${row.display_name}** removed.`);
      }
      await sendTo(i.guild, row.channel_id, alertMessage(row, { title: 'Test alert: this is how it will look', game: null, url: liveUrl(row), thumbnail: null }, { test: true }));
      return okPrivate(i, `Sample posted in <#${row.channel_id}>, without the ping.`);
    },
  }, {
    data: cmd('live', 'Post your live alert now (TikTok, or Twitch and Kick without keys)')
      .addIntegerOption((o) => o.setName('alert').setDescription('Which alert').setRequired(true).setMinValue(1).setAutocomplete(true))
      .addStringOption((o) => o.setName('title').setDescription('What you are streaming').setMaxLength(200)),
    async run(i) {
      const row = await db.one('SELECT * FROM stream_alerts WHERE guild_id = $1 AND id = $2', [i.guildId, i.options.getInteger('alert', true)]);
      if (!row) return fail(i, 'No stream alert with that number.');
      const role = getSettings(i.guildId).streamalerts.streamerRole;
      if (!i.memberPermissions.has(P.ManageGuild) && !(role && i.member.roles.cache.has(role))) {
        return fail(i, role ? `You need <@&${role}> to post live alerts.` : 'Only staff can post live alerts. Staff can choose a streamer role on the website.');
      }
      if (isAutomatic(row.platform)) return fail(i, `${PLATFORMS[row.platform].label} alerts are posted automatically when ${row.display_name} goes live.`);
      const posted = await postManualAlert(i.guild, row, i.options.getString('title'));
      if (!posted) return fail(i, `This alert was posted ${ts(Number(row.manual_at))}. It can be posted again ${ts(Number(row.manual_at) + MANUAL_COOLDOWN_MS)}.`);
      return okPrivate(i, `Live alert posted in <#${row.channel_id}>.`);
    },
    async autocomplete(i) {
      const typed = String(i.options.getFocused()).toLowerCase();
      const rows = await db.all('SELECT * FROM stream_alerts WHERE guild_id = $1 ORDER BY id', [i.guildId]);
      const manual = rows.filter((r) => !isAutomatic(r.platform) && alertLabel(r).toLowerCase().includes(typed)).slice(0, 25);
      return i.respond(manual.map((r) => ({ name: alertLabel(r), value: Number(r.id) })));
    },
  }],

  ready(client) {
    setInterval(() => pollStreams(client).catch((err) => logger.error('Stream check failed', err)), CHECK_EVERY_MS).unref?.();
  },
};
