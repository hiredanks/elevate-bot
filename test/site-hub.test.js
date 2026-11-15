import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { closeDatabase, db } from '../src/core/db.js';
import { updateSettings } from '../src/core/settings.js';
import { modules } from '../src/modules/index.js';
import { clearSiteCache } from '../src/modules/site.js';

const realFetch = globalThis.fetch;
let world;
let server;
let base;
const G = `/api/guilds/${ID.guild}`;

before(async () => {
  world = await createWorld();
  config.siteAdmins = [ID.owner];
  server = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { server.once('listening', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { world.reset(); world.discord.calls.length = 0; clearSiteCache(ID.guild); });
after(async () => { server.close(); await closeDatabase(); });

const sessions = new Map();
async function call(method, path, { as, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (as) {
    if (!sessions.has(as)) sessions.set(as, await createSession({ userId: as, username: 'x', guilds: [] }));
    headers.authorization = `Bearer ${sessions.get(as)}`;
  }
  const res = await realFetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const site = async () => { clearSiteCache(ID.guild); return (await call('GET', '/api/site')).json; };
const add = (name, row) => call('POST', `${G}/collections/${name}`, { as: ID.owner, body: { row } });

test('staff lists from the admin panel appear on the website, and only the website admin can add them', async () => {
  assert.equal((await add('slides', { title: 'Season 2', image_url: 'https://cdn.example/s2.png', link: 'https://discord.gg/x' })).status, 200);
  await add('rankings', { player: 'Nadia', team: 'ELV', points: 120, wins: 2, kills: 30 });
  await add('rankings', { player: 'Omar', points: 340 });
  await add('results', { event: 'ELEVATE Cup 1', date: Date.UTC(2026, 9, 1), first: 'Team Nova', second: 'Drift', third: 'Kairo' });
  await add('teams', { name: 'Team Nova', tag: 'NOVA', captain: 'Nadia', members: 'Nadia\nOmar\n\nLina', region: 'Europe', recruiting: 'Yes' });
  await add('maps', { name: 'Box Fight Arena', code: '1234-5678-9012', kind: 'Box fights' });
  await add('coaches', { name: 'Coach Sam', specialty: 'Zero Build', contact: 'sam#0001' });
  await add('videos', { title: 'Rotation guide', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', creator: 'Sam' });
  await add('downloads', { title: 'Pro settings', version: '1.2', size: '2 MB', link: 'https://cdn.example/settings.zip' });
  assert.equal((await add('maps', { name: 'Bad', code: '12-34' })).status, 400, 'island codes are checked');
  assert.equal((await add('downloads', { title: 'x', link: 'http://insecure.example/a.exe' })).status, 400, 'downloads must be https');
  assert.equal((await call('POST', `${G}/collections/maps`, { as: ID.admin, body: { row: { name: 'x' } } })).status, 403, 'a server admin who is not the website admin');

  const data = await site();
  assert.equal(data.slides[0].title, 'Season 2');
  assert.deepEqual(data.rankings.map((r) => [r.player, r.points]), [['Omar', 340], ['Nadia', 120]], 'highest points first');
  assert.deepEqual(data.results[0].places, ['Team Nova', 'Drift', 'Kairo']);
  assert.deepEqual(data.teams[0].members, ['Nadia', 'Omar', 'Lina']);
  assert.equal(data.teams[0].recruiting, true);
  assert.equal(data.maps[0].code, '1234-5678-9012');
  assert.equal(data.videos[0].thumb, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(data.downloads[0].link, 'https://cdn.example/settings.zip');
  assert.equal(data.coaches[0].name, 'Coach Sam');
});

test('members make, edit and remove their own player profile, with an Epic verified badge when it matches', async () => {
  const profile = { epic: 'NadiaFN', platform: 'PC', region: 'Europe', role: 'IGL', bio: 'Zero Build main', twitch: 'https://twitch.tv/nadia' };
  assert.equal((await call('PUT', '/api/site/player', { body: profile })).status, 401, 'needs a login');
  assert.equal((await call('PUT', '/api/site/player', { as: ID.stranger, body: profile })).json.error, 'Join the Discord server first.');
  assert.match((await call('PUT', '/api/site/player', { as: ID.member, body: { ...profile, platform: 'Toaster' } })).json.error, /platform/i);
  assert.match((await call('PUT', '/api/site/player', { as: ID.member, body: { ...profile, epic: 'ab' } })).json.error, /at least 3/);
  assert.match((await call('PUT', '/api/site/player', { as: ID.member, body: { ...profile, twitch: 'twitch.tv/x' } })).json.error, /https/);
  assert.equal((await call('PUT', '/api/site/player', { as: ID.member, body: profile })).status, 200);
  let players = (await site()).players;
  assert.deepEqual(players.map((p) => [p.name, p.epic, p.verified, p.links.twitch]), [['member', 'NadiaFN', false, 'https://twitch.tv/nadia']]);

  await db.run('INSERT INTO epic_links(user_id, epic_id, epic_name, verified, linked_at) VALUES ($1, $2, $3, TRUE, $4)', [ID.member, 'epic-1', 'nadiafn', Date.now()]);
  assert.equal((await call('PUT', '/api/site/player', { as: ID.member, body: { ...profile, role: 'Fragger' } })).status, 200);
  players = (await site()).players;
  assert.equal(players.length, 1, 'editing keeps one profile');
  assert.deepEqual([players[0].role, players[0].verified], ['Fragger', true]);
  const me = (await call('GET', '/api/site/me', { as: ID.member })).json;
  assert.deepEqual([me.player.epic, me.linkedEpic], ['NadiaFN', 'nadiafn']);

  const list = await call('GET', `${G}/collections/players`, { as: ID.owner });
  assert.equal(list.json.rows[0].epic, 'NadiaFN');
  assert.equal((await call('DELETE', '/api/site/player', { as: ID.member })).status, 200);
  assert.equal((await site()).players.length, 0);
});

test('looking-for-team posts: two at a time, removed by their owner only, gone after 14 days', async () => {
  const post = { mode: 'Trios', role: 'IGL', region: 'Europe', message: 'Need a trio for Friday cups' };
  assert.equal((await call('POST', '/api/site/lft', { as: ID.other, body: post })).status, 200);
  assert.equal((await call('POST', '/api/site/lft', { as: ID.other, body: { ...post, mode: 'Duos' } })).status, 200);
  assert.match((await call('POST', '/api/site/lft', { as: ID.other, body: post })).json.error, /2 posts/);
  assert.match((await call('POST', '/api/site/lft', { as: ID.member, body: { ...post, message: '' } })).json.error, /Message is required/);
  const posts = (await site()).lft;
  assert.equal(posts.length, 2);
  assert.equal((await call('DELETE', `/api/site/lft/${posts[0].id}`, { as: ID.member })).status, 404, 'not their post');
  assert.equal((await call('DELETE', `/api/site/lft/${posts[0].id}`, { as: ID.other })).status, 200);
  await db.run("UPDATE site_items SET created_at = $1 WHERE kind = 'lft'", [Date.now() - 15 * 864e5]);
  assert.equal((await site()).lft.length, 0, 'old posts are hidden');
});

test('tournament sign-ups: team names, a size limit, check-in in its window, and what the website shows', async () => {
  const startsAt = Date.now() + 3 * 3600e3;
  assert.equal((await add('events', { title: 'ELEVATE Cup', starts_at: startsAt, signups: 'Open', team_size: 3, max_entries: 2, checkin_minutes: 30 })).status, 200);
  const event = (await site()).events.find((e) => e.title === 'ELEVATE Cup');
  assert.deepEqual([event.signups, event.teamSize, event.maxEntries, event.entries], [true, 3, 2, 0]);
  const reg = (as, body) => call('POST', `/api/site/events/${event.id}/register`, { as, body });

  assert.match((await reg(ID.member, { players: 'a, b, c' })).json.error, /Team name is required/);
  assert.equal((await reg(ID.member, { team: 'Team Nova', players: 'NadiaFN, Omar, Lina' })).status, 200);
  assert.match((await reg(ID.member, { team: 'Again', players: 'x' })).json.error, /already signed up/);
  assert.equal((await reg(ID.other, { team: 'Drift', players: 'd1, d2, d3' })).status, 200);
  assert.match((await reg(ID.mod, { team: 'Late', players: 'l1' })).json.error, /full/);
  assert.match((await call('POST', `/api/site/events/${event.id}/checkin`, { as: ID.member })).json.error, /not opened yet/);

  await db.run('UPDATE site_events SET starts_at = $1 WHERE id = $2', [Date.now() + 10 * 60e3, event.id]);
  assert.equal((await call('POST', `/api/site/events/${event.id}/checkin`, { as: ID.member })).status, 200);
  assert.match((await call('POST', `/api/site/events/${event.id}/checkin`, { as: ID.mod })).json.error, /Sign up first/);
  const shown = (await site()).events.find((e) => e.id === event.id);
  assert.deepEqual([shown.entries, shown.checkedIn, shown.entrants], [2, 1, ['Team Nova', 'Drift']]);
  assert.deepEqual((await call('GET', '/api/site/me', { as: ID.member })).json.registrations, [{ eventId: String(event.id), team: 'Team Nova', checkedIn: true }]);

  const signups = await call('GET', `${G}/collections/registrations`, { as: ID.owner });
  assert.deepEqual(signups.json.rows.map((r) => [r.event, r.entry, r.checked]), [['ELEVATE Cup', 'Team Nova', 'Yes'], ['ELEVATE Cup', 'Drift', 'No']]);
  assert.equal((await call('DELETE', `/api/site/events/${event.id}/register`, { as: ID.other })).status, 200);
  assert.equal((await reg(ID.mod, { team: 'Late', players: 'l1' })).status, 200, 'a freed place can be taken');

  await db.run('UPDATE site_events SET starts_at = $1 WHERE id = $2', [Date.now() - 60e3, event.id]);
  assert.match((await reg(ID.admin, { team: 'Too late', players: 'x' })).json.error, /already started/);
  assert.match((await call('POST', '/api/site/events/999999/register', { as: ID.member, body: {} })).json.error, /does not exist/);
});

test('contact messages reach staff in the admin panel and in Discord, three a day per member', async () => {
  await updateSettings(ID.guild, (s) => { s.site.contactChannel = ID.logs; });
  const msg = { subject: 'Partnership', message: 'We run a Tunisian Fortnite team and want to scrim with ELEVATE.' };
  assert.equal((await call('POST', '/api/site/contact', { as: ID.member, body: msg })).status, 200);
  const notice = world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith(`/channels/${ID.logs}/messages`));
  assert.match(JSON.stringify(notice.body.embeds), /Website message: Partnership/);
  assert.deepEqual(notice.body.allowed_mentions.parse, []);
  await call('POST', '/api/site/contact', { as: ID.member, body: msg });
  await call('POST', '/api/site/contact', { as: ID.member, body: msg });
  assert.equal((await call('POST', '/api/site/contact', { as: ID.member, body: msg })).status, 429);
  const inbox = await call('GET', `${G}/collections/inbox`, { as: ID.owner });
  assert.equal(inbox.json.rows.length, 3);
  assert.equal((await call('GET', `${G}/collections/inbox`, { as: ID.admin })).status, 403, 'only the website admin reads messages');
  await updateSettings(ID.guild, (s) => { s.site.pages.contact = false; });
  assert.match((await call('POST', '/api/site/contact', { as: ID.other, body: msg })).json.error, /turned off/);
  await updateSettings(ID.guild, (s) => { s.site.pages.contact = true; });
});
