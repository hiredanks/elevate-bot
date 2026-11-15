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
const SITE = 'https://site.example';
const DASH = 'https://dash.example';
let world;
let server;
let base;

function fakeDiscord(url) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/oauth2/token')) return json({ access_token: 'discord-token', expires_in: 604800 });
  if (url.endsWith('/users/@me')) return json({ id: ID.member, username: 'member', global_name: 'Member' });
  if (url.endsWith('/users/@me/guilds')) return json([]);
  return json({});
}

before(async () => {
  world = await createWorld();
  config.siteUrl = SITE;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://discord.com/') ? fakeDiscord(String(url)) : realFetch(url, init));
  server = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { server.once('listening', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { world.reset(); world.discord.calls.length = 0; clearSiteCache(ID.guild); });
after(async () => { server.close(); await closeDatabase(); });

async function call(method, path, { as, body, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (as) headers.authorization = `Bearer ${await createSession({ userId: as, username: 'x', guilds: [] })}`;
  if (origin) headers.origin = origin;
  const res = await realFetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}
const G = `/api/guilds/${ID.guild}`;

test('the community website may read site data, other sites may not', async () => {
  const fromSite = await call('GET', '/api/site', { origin: SITE });
  assert.equal(fromSite.status, 200);
  assert.equal(fromSite.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await call('GET', '/api/site', { origin: DASH })).headers.get('access-control-allow-origin'), DASH);
  assert.equal((await call('GET', '/api/site', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
  const data = fromSite.json;
  assert.equal(data.guild.id, ID.guild);
  assert.equal(data.text.headline, 'Where players level up together');
  assert.match(data.text.rulesAr, /احترم الجميع/);
  assert.deepEqual(data.pages, { streamers: true, events: true, leaderboard: true, staff: true, rules: true });
});

test('logins started on the community website return there, others return to the dashboard', async () => {
  const site = await call('GET', '/auth/callback?code=abc&state=site-abcdefghijklmnop');
  assert.match(site.headers.get('location'), /^https:\/\/site\.example\/#token=[\w-]+&state=site-abcdefghijklmnop$/);
  const dash = await call('GET', '/auth/callback?code=abc&state=abcdefghijklmnop');
  assert.ok(dash.headers.get('location').startsWith(`${DASH}/#token=`));
  const denied = await call('GET', '/auth/callback?error=access_denied&state=site-abcdefghijklmnop');
  assert.equal(denied.headers.get('location'), `${SITE}/#login_error=denied`);
});

test('site data shows streamers with live status, news, events, scrims, the leaderboard and staff', async () => {
  await db.run(
    `INSERT INTO stream_alerts(guild_id, platform, account, platform_id, display_name, avatar_url, channel_id, ping, image, live)
     VALUES ($1, 'twitch', 'x', 'livelyone', 'LivelyOne', 'https://cdn.example/a.png', $2, 'none', 'avatar', TRUE),
            ($1, 'tiktok', 'y', 'quietone', 'quietone', NULL, $2, 'none', 'avatar', FALSE),
            ($1, 'tiktok', 'y', 'quietone', 'quietone', NULL, $3, 'none', 'avatar', FALSE)`,
    [ID.guild, ID.general, ID.extra],
  );
  await db.run('INSERT INTO members(guild_id, user_id, username, xp) VALUES ($1, $2, $3, 5000), ($1, $4, $5, 900)', [ID.guild, ID.member, 'member', ID.other, 'other']);
  await updateSettings(ID.guild, (s) => { s.site.staffRoles = [ID.roleMod]; });
  assert.equal((await call('POST', `${G}/collections/posts`, { as: ID.owner, body: { row: { title: 'Season 2 is here', body: 'New scrims every Friday.', pinned: 'Pinned' } } })).status, 200);
  const soon = Date.now() + 2 * 864e5;
  assert.equal((await call('POST', `${G}/collections/events`, { as: ID.owner, body: { row: { title: 'ELEVATE Cup', game: 'Fortnite Trios', starts_at: soon, prize: '100 USD' } } })).status, 200);
  assert.equal((await call('POST', `${G}/collections/events`, { as: ID.owner, body: { row: { title: 'Bad', starts_at: 'tomorrow' } } })).status, 400);

  const data = (await call('GET', '/api/site')).json;
  assert.deepEqual(data.streamers.map((s) => [s.name, s.platform, s.live]), [['LivelyOne', 'Twitch', true], ['quietone', 'TikTok', false]], 'live first, one card per streamer');
  assert.equal(data.streamers[0].url, 'https://twitch.tv/livelyone');
  assert.equal(data.streamers[1].url, 'https://www.tiktok.com/@quietone/live');
  assert.deepEqual(data.posts.map((p) => [p.title, p.pinned]), [['Season 2 is here', true]]);
  assert.deepEqual(data.events.map((e) => [e.title, e.prize, e.at]), [['ELEVATE Cup', '100 USD', soon]]);
  assert.deepEqual(data.leaderboard.map((r) => [r.name, r.level]), [['member', 9], ['other', 3]]);
  assert.equal(data.staff[0].name, 'Mod');
  assert.deepEqual(data.staff[0].members.map((m) => m.name), ['mod']);
  await db.run('DELETE FROM stream_alerts WHERE guild_id = $1', [ID.guild]);
});

test('members apply to the streamer team once, staff are told in Discord and see it on the dashboard', async () => {
  await updateSettings(ID.guild, (s) => { s.site.applicationChannel = ID.logs; });
  const body = { platform: 'TikTok', link: 'https://www.tiktok.com/@member', message: 'I stream Fortnite every night.' };
  assert.equal((await call('POST', '/api/site/apply', { body })).status, 401, 'needs a login');
  const sent = await call('POST', '/api/site/apply', { as: ID.member, body });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const notice = world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith(`/channels/${ID.logs}/messages`));
  assert.match(JSON.stringify(notice.body.embeds), /New streamer application[\s\S]*TikTok[\s\S]*tiktok\.com\/@member/);
  assert.deepEqual(notice.body.allowed_mentions.parse, []);
  assert.match((await call('POST', '/api/site/apply', { as: ID.member, body })).json.error, /already applied/);
  assert.match((await call('POST', '/api/site/apply', { as: ID.other, body: { ...body, link: 'not a link' } })).json.error, /starts with https/);
  assert.match((await call('POST', '/api/site/apply', { as: ID.stranger, body })).json.error, /Join the Discord server first/);

  const list = await call('GET', `${G}/collections/applications`, { as: ID.owner });
  assert.deepEqual(list.json.rows.map((r) => [r.member, r.platform]), [['member', 'TikTok']]);
  assert.equal((await call('GET', `${G}/collections/applications`, { as: ID.member })).status, 403, 'members cannot read applications');
  await call('DELETE', `${G}/collections/applications/${list.json.rows[0].id}`, { as: ID.owner });
  assert.equal((await call('POST', '/api/site/apply', { as: ID.member, body })).status, 200, 'can apply again once marked done');

  await updateSettings(ID.guild, (s) => { s.site.applications = false; });
  assert.match((await call('POST', '/api/site/apply', { as: ID.other, body })).json.error, /closed/);
  await updateSettings(ID.guild, (s) => { s.site.applications = true; });
});

test('website text saves from the admin panel and shows on the site straight away', async () => {
  const saved = await call('PATCH', `${G}/settings/site`, { as: ID.owner, body: { values: { headline: 'Climb with us', inviteUrl: 'https://discord.gg/elevate', 'pages.staff': false } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const data = (await call('GET', '/api/site')).json;
  assert.equal(data.text.headline, 'Climb with us');
  assert.equal(data.links.invite, 'https://discord.gg/elevate');
  assert.equal(data.pages.staff, false);
  const bad = await call('PATCH', `${G}/settings/site`, { as: ID.owner, body: { values: { inviteUrl: 'https://evil.example/x' } } });
  assert.equal(bad.status, 400);
  assert.equal((await call('PATCH', `${G}/settings/site`, { as: ID.member, body: { values: { headline: 'hacked' } } })).status, 403);
});
