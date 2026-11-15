import { EmbedBuilder } from 'discord.js';
import { HttpError } from '../api/validate.js';
import { db } from '../core/db.js';
import { getSettings } from '../core/settings.js';
import { COLOR, sendTo } from '../core/ui.js';
import { truncate } from '../core/util.js';
import { clearSiteCache } from './site-cache.js';

// Community content for the website: things staff add (maps, coaches...) and things members add (profiles, LFT...).
// Everything lives in one table, one row per item, with the item's fields in `data`.

export const HTTPS = '^https://\\S+$';
export const REGIONS = ['Europe', 'NA East', 'NA Central', 'NA West', 'Brazil', 'Asia', 'Oceania', 'Middle East'];
export const PLATFORMS = ['PC', 'PlayStation', 'Xbox', 'Switch', 'Mobile'];
export const ROLES = ['All-rounder', 'Fragger', 'IGL', 'Support', 'Builder'];
export const MODES = ['Solo', 'Duos', 'Trios', 'Squads'];
const LFT_MS = 14 * 864e5;
const CONTACT_PER_DAY = 3;

const ORDER = {
  default: 'created_at DESC',
  rankings: "(data->>'points')::numeric DESC, created_at",
  results: "(data->>'date')::numeric DESC",
  slides: 'created_at',
  registration: 'created_at',
};
const rowsOf = (guildId, kind, limit = 200) =>
  db.all(`SELECT * FROM site_items WHERE guild_id = $1 AND kind = $2 ORDER BY ${ORDER[kind] ?? ORDER.default} LIMIT ${limit}`, [guildId, kind]);
const flat = (r) => ({ id: r.id, ...r.data, created_at: r.created_at });

/** A list staff fill in from the admin panel, stored as site items of one kind. */
function staffList(kind, { max = 200, ...spec }) {
  return {
    ...spec,
    list: async (guildId) => (await rowsOf(guildId, kind)).map(flat),
    async create(guild, row, userId) {
      const count = await db.one('SELECT COUNT(*) AS n FROM site_items WHERE guild_id = $1 AND kind = $2', [guild.id, kind]);
      if (Number(count.n) >= max) throw new Error(`Delete some old entries first. The website keeps up to ${max}.`);
      const data = Object.fromEntries(spec.columns.filter((c) => !c.readOnly && row[c.key] !== undefined).map((c) => [c.key, row[c.key]]));
      await db.run('INSERT INTO site_items(guild_id, kind, owner_id, data, created_at) VALUES ($1, $2, $3, $4, $5)', [guild.id, kind, userId, JSON.stringify(data), Date.now()]);
      clearSiteCache(guild.id);
    },
    async remove(guild, id) {
      const n = await db.run('DELETE FROM site_items WHERE guild_id = $1 AND kind = $2 AND id = $3', [guild.id, kind, id]);
      clearSiteCache(guild.id);
      return n;
    },
  };
}

const optionalLink = (key, label) => ({ key, label, type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true });

export const hubCollections = {
  slides: staffList('slides', {
    title: 'Featured slides', max: 12, submitLabel: 'Add slide',
    description: 'Big banners at the top of the front page, in the order you add them. Use wide pictures (16:9).',
    columns: [
      { key: 'title', label: 'Title', type: 'text', max: 80, required: true },
      { key: 'text', label: 'Text', type: 'textarea', max: 240, hideInList: true },
      { key: 'image_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS, required: true, placeholder: 'https://...' },
      optionalLink('link', 'Button link'),
    ],
  }),
  rankings: staffList('rankings', {
    title: 'Points ranking', submitLabel: 'Add player',
    description: 'The tournament points table on the Leaderboard page, highest points first.',
    columns: [
      { key: 'player', label: 'Player', type: 'text', max: 40, required: true },
      { key: 'team', label: 'Team', type: 'text', max: 40 },
      { key: 'points', label: 'Points', type: 'int', min: 0, max: 1000000, required: true },
      { key: 'wins', label: 'Wins', type: 'int', min: 0, max: 100000, default: 0 },
      { key: 'kills', label: 'Eliminations', type: 'int', min: 0, max: 1000000, default: 0 },
    ],
  }),
  results: staffList('results', {
    title: 'Results', submitLabel: 'Add result',
    description: 'Past tournament winners, newest first, on the Tournaments page.',
    columns: [
      { key: 'event', label: 'Tournament', type: 'text', max: 100, required: true },
      { key: 'date', label: 'Date', type: 'datetime', required: true, format: 'time' },
      { key: 'first', label: '1st place', type: 'text', max: 80, required: true },
      { key: 'second', label: '2nd place', type: 'text', max: 80 },
      { key: 'third', label: '3rd place', type: 'text', max: 80 },
      { key: 'notes', label: 'Notes', type: 'textarea', max: 600, hideInList: true },
    ],
  }),
  teams: staffList('teams', {
    title: 'Teams', submitLabel: 'Add team',
    description: 'Community teams on the Players page.',
    columns: [
      { key: 'name', label: 'Team name', type: 'text', max: 40, required: true },
      { key: 'tag', label: 'Tag', type: 'text', max: 6, placeholder: 'ELV' },
      { key: 'captain', label: 'Captain', type: 'text', max: 40 },
      { key: 'members', label: 'Players, one per line', type: 'textarea', max: 400, hideInList: true },
      { key: 'region', label: 'Region', type: 'select', options: REGIONS },
      { key: 'recruiting', label: 'Recruiting', type: 'select', options: ['No', 'Yes'] },
      { key: 'logo_url', label: 'Logo link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
    ],
  }),
  maps: staffList('maps', {
    title: 'Maps', submitLabel: 'Add map',
    description: 'Fortnite Creative maps for practice, in the Hub.',
    columns: [
      { key: 'name', label: 'Map name', type: 'text', max: 80, required: true },
      { key: 'code', label: 'Island code', type: 'text', max: 14, pattern: '^\\d{4}-\\d{4}-\\d{4}$', placeholder: '1234-5678-9012' },
      { key: 'kind', label: 'Type', type: 'text', max: 40, placeholder: 'Box fights, edit course...' },
      { key: 'creator', label: 'Creator', type: 'text', max: 40, hideInList: true },
      { key: 'image_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
    ],
  }),
  coaches: staffList('coaches', {
    title: 'Coaches', submitLabel: 'Add coach',
    description: 'Coaches members can contact, in the Hub.',
    columns: [
      { key: 'name', label: 'Name', type: 'text', max: 60, required: true },
      { key: 'specialty', label: 'Specialty', type: 'text', max: 80, placeholder: 'Zero Build, aim, game sense...' },
      { key: 'bio', label: 'About', type: 'textarea', max: 600, hideInList: true },
      { key: 'contact', label: 'How to contact', type: 'text', max: 120, placeholder: 'Discord name or link' },
      { key: 'image_url', label: 'Picture link', type: 'text', max: 500, pattern: HTTPS, placeholder: 'Optional. https://...', hideInList: true },
    ],
  }),
  videos: staffList('videos', {
    title: 'Videos', submitLabel: 'Add video',
    description: 'Clips, guides and highlights, in the Hub. YouTube links show their thumbnail.',
    columns: [
      { key: 'title', label: 'Title', type: 'text', max: 100, required: true },
      { key: 'url', label: 'Video link', type: 'text', max: 500, pattern: HTTPS, required: true, placeholder: 'https://youtube.com/...' },
      { key: 'creator', label: 'Creator', type: 'text', max: 40 },
    ],
  }),
  downloads: staffList('downloads', {
    title: 'Downloads', submitLabel: 'Add download',
    description: 'Files members can download, in the Hub: settings packs, wallpapers, apps. Link to where the file is hosted.',
    columns: [
      { key: 'title', label: 'Title', type: 'text', max: 80, required: true },
      { key: 'description', label: 'Description', type: 'textarea', max: 400, hideInList: true },
      { key: 'version', label: 'Version', type: 'text', max: 20 },
      { key: 'size', label: 'Size', type: 'text', max: 20, placeholder: '25 MB' },
      { key: 'link', label: 'Download link', type: 'text', max: 500, pattern: HTTPS, required: true, placeholder: 'https://...' },
    ],
  }),

  // Lists that members fill in; staff can read and remove entries.
  players: {
    title: 'Player profiles', removeLabel: 'Remove',
    description: 'Members who made a player profile on the website. "Epic verified" means it matches their linked Epic account.',
    columns: [
      { key: 'member', label: 'Member', type: 'text', readOnly: true },
      { key: 'epic', label: 'Epic name', type: 'text', readOnly: true },
      { key: 'platform', label: 'Platform', type: 'text', readOnly: true },
      { key: 'region', label: 'Region', type: 'text', readOnly: true },
      { key: 'created_at', label: 'Joined', type: 'text', readOnly: true, format: 'time' },
    ],
    async list(guildId, guild) {
      return (await rowsOf(guildId, 'player', 1000)).map((r) => ({ ...flat(r), member: guild?.members.cache.get(r.owner_id)?.displayName ?? r.data.username }));
    },
    remove: (guild, id) => removeItem(guild, 'player', id),
  },
  lft: {
    title: 'Looking for team', removeLabel: 'Remove',
    description: 'Posts from members looking for a team. They disappear after 14 days.',
    columns: [
      { key: 'member', label: 'Member', type: 'text', readOnly: true },
      { key: 'mode', label: 'Mode', type: 'text', readOnly: true },
      { key: 'message', label: 'Message', type: 'text', readOnly: true },
      { key: 'created_at', label: 'Posted', type: 'text', readOnly: true, format: 'time' },
    ],
    async list(guildId, guild) {
      return (await rowsOf(guildId, 'lft')).map((r) => ({ ...flat(r), member: guild?.members.cache.get(r.owner_id)?.displayName ?? r.data.username }));
    },
    remove: (guild, id) => removeItem(guild, 'lft', id),
  },
  registrations: {
    title: 'Tournament sign-ups', removeLabel: 'Remove',
    description: 'Who signed up for each tournament on the website, and who checked in.',
    columns: [
      { key: 'event', label: 'Tournament', type: 'text', readOnly: true },
      { key: 'entry', label: 'Player or team', type: 'text', readOnly: true },
      { key: 'players', label: 'Epic names', type: 'text', readOnly: true },
      { key: 'checked', label: 'Checked in', type: 'text', readOnly: true },
      { key: 'created_at', label: 'Signed up', type: 'text', readOnly: true, format: 'time' },
    ],
    async list(guildId, guild) {
      const rows = await db.all(
        `SELECT i.*, e.title FROM site_items i JOIN site_events e ON e.id::text = i.ref_id
         WHERE i.guild_id = $1 AND i.kind = 'registration' ORDER BY e.starts_at, i.created_at`,
        [guildId],
      );
      return rows.map((r) => ({
        id: r.id, event: r.title, entry: r.data.team || guild?.members.cache.get(r.owner_id)?.displayName || r.data.username,
        players: r.data.players ?? '', checked: r.data.checkedIn ? 'Yes' : 'No', created_at: r.created_at,
      }));
    },
    remove: (guild, id) => removeItem(guild, 'registration', id),
  },
  inbox: {
    title: 'Contact messages', removeLabel: 'Mark done',
    description: 'Messages sent from the Contact page. Reply to the member in Discord, then mark it done.',
    columns: [
      { key: 'member', label: 'Member', type: 'text', readOnly: true },
      { key: 'subject', label: 'Subject', type: 'text', readOnly: true },
      { key: 'message', label: 'Message', type: 'text', readOnly: true },
      { key: 'created_at', label: 'Sent', type: 'text', readOnly: true, format: 'time' },
    ],
    async list(guildId, guild) {
      return (await rowsOf(guildId, 'contact')).map((r) => ({ ...flat(r), member: guild?.members.cache.get(r.owner_id)?.displayName ?? r.data.username }));
    },
    remove: (guild, id) => removeItem(guild, 'contact', id),
  },
};

async function removeItem(guild, kind, id) {
  const n = await db.run('DELETE FROM site_items WHERE guild_id = $1 AND kind = $2 AND id = $3', [guild.id, kind, id]);
  clearSiteCache(guild.id);
  return n;
}

/* ---------- What the public website shows ---------- */

const youtubeId = (url) => String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{11})/)?.[1] ?? null;

export async function hubData(guild, now = Date.now()) {
  const kinds = ['slides', 'rankings', 'results', 'teams', 'maps', 'coaches', 'videos', 'downloads', 'player', 'lft', 'registration'];
  const [rows, links] = await Promise.all([
    Promise.all(kinds.map((k) => rowsOf(guild.id, k, k === 'player' ? 500 : 200))),
    db.all('SELECT user_id, epic_name FROM epic_links'),
  ]);
  const byKind = Object.fromEntries(kinds.map((k, i) => [k, rows[i]]));
  const epicOf = new Map(links.map((l) => [l.user_id, l.epic_name.toLowerCase()]));
  const member = (id) => guild.members.cache.get(id);
  const face = (id) => member(id)?.displayAvatarURL({ size: 128, extension: 'png' }) ?? null;
  const nameOf = (r) => member(r.owner_id)?.displayName ?? r.data.username ?? 'Member';

  const entries = {};
  for (const r of byKind.registration) {
    const e = (entries[r.ref_id] ??= { count: 0, checkedIn: 0, names: [] });
    e.count += 1;
    if (r.data.checkedIn) e.checkedIn += 1;
    e.names.push(r.data.team || nameOf(r));
  }

  return {
    slides: byKind.slides.map((r) => ({ id: r.id, title: r.data.title, text: r.data.text, image: r.data.image_url, link: r.data.link })),
    rankings: byKind.rankings.map((r) => ({ player: r.data.player, team: r.data.team, points: r.data.points, wins: r.data.wins ?? 0, kills: r.data.kills ?? 0 })),
    results: byKind.results.map((r) => ({ id: r.id, event: r.data.event, at: Number(r.data.date), places: [r.data.first, r.data.second, r.data.third].filter(Boolean), notes: r.data.notes })),
    teams: byKind.teams.map((r) => ({
      id: r.id, name: r.data.name, tag: r.data.tag, captain: r.data.captain, region: r.data.region, logo: r.data.logo_url,
      recruiting: r.data.recruiting === 'Yes', members: String(r.data.members ?? '').split(/\r?\n/).map((m) => m.trim()).filter(Boolean),
    })),
    maps: byKind.maps.map((r) => ({ id: r.id, name: r.data.name, code: r.data.code, kind: r.data.kind, creator: r.data.creator, image: r.data.image_url })),
    coaches: byKind.coaches.map((r) => ({ id: r.id, name: r.data.name, specialty: r.data.specialty, bio: r.data.bio, contact: r.data.contact, image: r.data.image_url })),
    videos: byKind.videos.map((r) => {
      const yt = youtubeId(r.data.url);
      return { id: r.id, title: r.data.title, url: r.data.url, creator: r.data.creator, thumb: yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null };
    }),
    downloads: byKind.downloads.map((r) => ({ id: r.id, title: r.data.title, description: r.data.description, version: r.data.version, size: r.data.size, link: r.data.link })),
    players: byKind.player.map((r) => ({
      id: r.id, name: nameOf(r), avatar: face(r.owner_id), epic: r.data.epic, platform: r.data.platform, region: r.data.region, role: r.data.role,
      bio: r.data.bio, verified: epicOf.get(r.owner_id) === String(r.data.epic).toLowerCase(),
      links: Object.fromEntries(['twitch', 'youtube', 'tiktok'].filter((k) => r.data[k]).map((k) => [k, r.data[k]])),
    })),
    lft: byKind.lft.filter((r) => now - Number(r.created_at) < LFT_MS).map((r) => ({
      id: r.id, name: nameOf(r), avatar: face(r.owner_id), mode: r.data.mode, role: r.data.role, region: r.data.region, message: r.data.message, at: Number(r.created_at),
    })),
    entries,
  };
}

/* ---------- What a logged-in member can do ---------- */

function text(value, label, { max, required = false } = {}) {
  const v = String(value ?? '').trim();
  if (required && !v) throw new HttpError(400, `${label} is required.`);
  if (v.length > max) throw new HttpError(400, `${label} can be at most ${max} characters.`);
  return v;
}
const choice = (value, options, label) => {
  if (!options.includes(value)) throw new HttpError(400, `Pick a ${label.toLowerCase()} from the list.`);
  return value;
};
const link = (value, label) => {
  const v = String(value ?? '').trim();
  if (v && (!/^https:\/\/\S+$/i.test(v) || v.length > 300)) throw new HttpError(400, `${label} must be a link starting with https://`);
  return v || null;
};

export async function mine(guild, userId) {
  const rows = await db.all("SELECT * FROM site_items WHERE guild_id = $1 AND owner_id = $2 AND kind IN ('player', 'lft', 'registration')", [guild.id, userId]);
  const epic = await db.one('SELECT epic_name, verified FROM epic_links WHERE user_id = $1', [userId]);
  const player = rows.find((r) => r.kind === 'player');
  return {
    player: player ? { ...player.data } : null,
    linkedEpic: epic?.epic_name ?? null,
    lft: rows.filter((r) => r.kind === 'lft').map((r) => ({ id: r.id, ...r.data, at: Number(r.created_at) })),
    registrations: rows.filter((r) => r.kind === 'registration').map((r) => ({ eventId: r.ref_id, team: r.data.team, checkedIn: Boolean(r.data.checkedIn) })),
  };
}

export async function savePlayer(guild, member, body) {
  const data = {
    username: member.user.username,
    epic: text(body.epic, 'Epic name', { max: 16, required: true }),
    platform: choice(body.platform, PLATFORMS, 'Platform'),
    region: choice(body.region, REGIONS, 'Region'),
    role: choice(body.role, ROLES, 'Role'),
    bio: text(body.bio, 'About you', { max: 300 }),
    twitch: link(body.twitch, 'Twitch'), youtube: link(body.youtube, 'YouTube'), tiktok: link(body.tiktok, 'TikTok'),
  };
  if (data.epic.length < 3) throw new HttpError(400, 'Epic names are at least 3 characters.');
  await db.run(
    `INSERT INTO site_items(guild_id, kind, owner_id, data, created_at) VALUES ($1, 'player', $2, $3, $4)
     ON CONFLICT (guild_id, owner_id) WHERE kind = 'player' DO UPDATE SET data = excluded.data, updated_at = $4`,
    [guild.id, member.id, JSON.stringify(data), Date.now()],
  );
  clearSiteCache(guild.id);
  return { ok: true };
}

export async function deleteMine(guild, userId, kind, id = null) {
  const n = id
    ? await db.run('DELETE FROM site_items WHERE guild_id = $1 AND kind = $2 AND owner_id = $3 AND id = $4', [guild.id, kind, userId, id])
    : await db.run('DELETE FROM site_items WHERE guild_id = $1 AND kind = $2 AND owner_id = $3', [guild.id, kind, userId]);
  if (!n) throw new HttpError(404, 'Nothing to remove.');
  clearSiteCache(guild.id);
  return { ok: true };
}

export async function postLft(guild, member, body) {
  const live = await db.one("SELECT COUNT(*) AS n FROM site_items WHERE guild_id = $1 AND kind = 'lft' AND owner_id = $2 AND created_at > $3", [guild.id, member.id, Date.now() - LFT_MS]);
  if (Number(live.n) >= 2) throw new HttpError(409, 'You already have 2 posts up. Remove one first.');
  const data = {
    username: member.user.username,
    mode: choice(body.mode, MODES, 'Mode'),
    role: choice(body.role, ROLES, 'Role'),
    region: choice(body.region, REGIONS, 'Region'),
    message: text(body.message, 'Message', { max: 300, required: true }),
  };
  await db.run("INSERT INTO site_items(guild_id, kind, owner_id, data, created_at) VALUES ($1, 'lft', $2, $3, $4)", [guild.id, member.id, JSON.stringify(data), Date.now()]);
  clearSiteCache(guild.id);
  return { ok: true };
}

async function openEvent(guild, eventId) {
  const event = /^\d+$/.test(String(eventId)) ? await db.one('SELECT * FROM site_events WHERE guild_id = $1 AND id = $2', [guild.id, eventId]) : null;
  if (!event) throw new HttpError(404, 'That tournament does not exist.');
  return event;
}

export async function register(guild, member, eventId, body) {
  const event = await openEvent(guild, eventId);
  if (!event.registration) throw new HttpError(403, 'Sign-ups are closed for this tournament.');
  if (Date.now() >= Number(event.starts_at)) throw new HttpError(403, 'This tournament has already started.');
  const team = event.team_size > 1 ? text(body.team, 'Team name', { max: 40, required: true }) : '';
  const players = text(body.players, 'Epic names', { max: 200, required: true });
  const data = { username: member.user.username, team, players, checkedIn: false };
  const added = await db.one(
    `INSERT INTO site_items(guild_id, kind, owner_id, ref_id, data, created_at)
     SELECT $1::text, 'registration', $2::text, $3::text, $4::jsonb, $5::bigint
     WHERE (SELECT COUNT(*) FROM site_items WHERE guild_id = $1::text AND kind = 'registration' AND ref_id = $3::text) < $6::int
     ON CONFLICT DO NOTHING RETURNING id`,
    [guild.id, member.id, String(event.id), JSON.stringify(data), Date.now(), event.max_entries],
  );
  if (!added) {
    const already = await db.one("SELECT 1 AS y FROM site_items WHERE guild_id = $1 AND kind = 'registration' AND ref_id = $2 AND owner_id = $3", [guild.id, String(event.id), member.id]);
    throw new HttpError(409, already ? 'You are already signed up.' : 'This tournament is full.');
  }
  clearSiteCache(guild.id);
  return { ok: true };
}

export async function unregister(guild, userId, eventId) {
  const event = await openEvent(guild, eventId);
  const n = await db.run("DELETE FROM site_items WHERE guild_id = $1 AND kind = 'registration' AND ref_id = $2 AND owner_id = $3", [guild.id, String(event.id), userId]);
  if (!n) throw new HttpError(404, 'You were not signed up.');
  clearSiteCache(guild.id);
  return { ok: true };
}

/** Check-in opens a set number of minutes before the start and closes when it starts. */
export async function checkIn(guild, userId, eventId) {
  const event = await openEvent(guild, eventId);
  const start = Number(event.starts_at);
  const opens = start - event.checkin_minutes * 60_000;
  if (Date.now() < opens) throw new HttpError(403, 'Check-in has not opened yet.');
  if (Date.now() >= start) throw new HttpError(403, 'Check-in is closed: the tournament has started.');
  const row = await db.one(
    `UPDATE site_items SET data = data || $4::jsonb WHERE guild_id = $1 AND kind = 'registration' AND ref_id = $2 AND owner_id = $3 RETURNING id`,
    [guild.id, String(event.id), userId, JSON.stringify({ checkedIn: true, checkedAt: Date.now() })],
  );
  if (!row) throw new HttpError(404, 'Sign up first, then check in.');
  clearSiteCache(guild.id);
  return { ok: true };
}

export async function sendContact(guild, member, body) {
  const recent = await db.one("SELECT COUNT(*) AS n FROM site_items WHERE guild_id = $1 AND kind = 'contact' AND owner_id = $2 AND created_at > $3", [guild.id, member.id, Date.now() - 864e5]);
  if (Number(recent.n) >= CONTACT_PER_DAY) throw new HttpError(429, `You can send ${CONTACT_PER_DAY} messages a day. Staff will answer the ones you sent.`);
  const data = {
    username: member.user.username,
    subject: text(body.subject, 'Subject', { max: 100, required: true }),
    message: text(body.message, 'Message', { max: 1500, required: true }),
  };
  await db.run("INSERT INTO site_items(guild_id, kind, owner_id, data, created_at) VALUES ($1, 'contact', $2, $3, $4)", [guild.id, member.id, JSON.stringify(data), Date.now()]);
  await sendTo(guild, getSettings(guild.id).site.contactChannel, {
    embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle(`Website message: ${data.subject}`)
      .setDescription(`From <@${member.id}> (${member.user.username})\n\n${truncate(data.message, 3500)}`)
      .setFooter({ text: 'Mark it done on the website admin panel under Contact messages' }).setTimestamp()],
    allowedMentions: { parse: [] },
  });
  return { ok: true };
}
