import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { closeDatabase, db } from '../src/core/db.js';
import { jobs } from '../src/core/jobs.js';
import { commandJson } from '../src/core/registry.js';
import { updateSettings } from '../src/core/settings.js';
import { modules } from '../src/modules/index.js';

const { fetch: httpFetch } = await import('undici').catch(() => ({ fetch: globalThis.fetch }));
let world;
let api;
let base;
let harnessFetch;
const schema = (name) => commandJson().find((c) => c.name === name);
const run = (name, opts = {}) => world.command(name, { schema: schema(name), ...opts });
const posted = (channelId) => world.discord.calls.filter((c) => c.method === 'POST' && c.route.endsWith(`/channels/${channelId}/messages`));
const channelWrites = () => world.discord.calls.filter((c) => ['POST', 'PATCH'].includes(c.method) && c.route.startsWith('/channels/'));
const roleCall = (method, userId, roleId) => world.discord.calls.find((c) => c.method === method && c.route.endsWith(`/members/${userId}/roles/${roleId}`));
const G = `/api/guilds/${ID.guild}`;

before(async () => {
  world = await createWorld();
  world.client.scrimRefreshDelay = 0;
  harnessFetch = globalThis.fetch;
  api = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { api.once('listening', resolve); });
  base = `http://127.0.0.1:${api.address().port}`;
});
beforeEach(() => {
  world.reset();
  world.discord.calls.length = 0;
  globalThis.fetch = harnessFetch;
});
after(async () => { api.close(); await closeDatabase(); });

async function web(method, path, as, body) {
  const token = await createSession({ userId: as, username: 'x', guilds: [] });
  const res = await httpFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

/* ---------- Epic Games linking ---------- */

test('without Epic login keys, members link by typing their Epic name', async () => {
  Object.assign(config, { epicClientId: null, epicClientSecret: null });
  const open = await world.button('epic:link', { as: ID.member });
  assert.match(open.text, /"custom_id":"epic:name"/, 'shows the name box');
  assert.match((await world.modal('epic:name', { name: 'ab' }, { as: ID.member })).text, /3 to 16/);
  assert.match((await world.modal('epic:name', { name: 'ProMember' }, { as: ID.member })).text, /Linked to \*\*ProMember\*\*/);
  assert.match((await world.modal('epic:name', { name: 'promember' }, { as: ID.admin })).text, /Another member already linked/);
  assert.match((await world.modal('epic:name', { name: 'Admin Ace' }, { as: ID.admin })).text, /Linked to/);
  const link = await db.one('SELECT * FROM epic_links WHERE user_id = $1', [ID.member]);
  assert.equal(link.verified, false);
  assert.match((await run('epic', { sub: 'whois', options: { member: ID.member } })).text, /ProMember.*typed by them/);
});

function mockEpic(profile) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/epic/oauth/v2/token') {
      const code = new URLSearchParams(init.body).get('code');
      return code === 'good' ? json({ access_token: 'epic-access', account_id: profile.id, expires_in: 7200 }) : json({ errorCode: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/epic/id/v2/accounts') return json([{ accountId: profile.id, displayName: profile.name }]);
    return harnessFetch(input, init);
  };
  return seen;
}

async function epicLogin(as) {
  const res = await world.button('epic:link', { as });
  const authorize = res.text.match(/https:\/\/www\.epicgames\.com\/id\/authorize\?[^"]+/)?.[0];
  assert.ok(authorize, res.text);
  return new URL(authorize.replace(/\\u0026/g, '&'));
}

const callback = async (query) => {
  const res = await httpFetch(`${base}/epic/callback?${new URLSearchParams(query)}`);
  return { status: res.status, html: await res.text(), headers: res.headers };
};

test('with Epic login keys, members log in with Epic and the link is proven', async () => {
  Object.assign(config, { epicClientId: 'epic-client', epicClientSecret: 'epic-secret' });
  await updateSettings(ID.guild, (s) => { s.epic.linkedRole = ID.roleVip; });
  try {
    const seen = mockEpic({ id: 'epicaccount0001', name: 'Epic<Pro>' });
    const authorize = await epicLogin(ID.other);
    assert.equal(authorize.searchParams.get('client_id'), 'epic-client');
    assert.equal(authorize.searchParams.get('scope'), 'basic_profile');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://bot.example/epic/callback');
    const state = authorize.searchParams.get('state');

    const done = await callback({ code: 'good', state });
    assert.equal(done.status, 200);
    assert.match(done.html, /Linked to Epic&lt;Pro&gt;/, 'name shown, and escaped');
    assert.match(done.headers.get('content-security-policy'), /default-src 'none'/);
    const token = seen.find((s) => s.url.pathname === '/epic/oauth/v2/token');
    assert.equal(token.init.headers.authorization, `Basic ${Buffer.from('epic-client:epic-secret').toString('base64')}`);
    assert.equal(new URLSearchParams(token.init.body).get('redirect_uri'), 'https://bot.example/epic/callback');
    const link = await db.one('SELECT * FROM epic_links WHERE user_id = $1', [ID.other]);
    assert.deepEqual([link.epic_id, link.epic_name, link.verified], ['epicaccount0001', 'Epic<Pro>', true]);
    assert.ok(roleCall('PUT', ID.other, ID.roleVip), 'linked role given');

    assert.match((await callback({ code: 'good', state })).html, /expired/, 'a login link works once');
    assert.match((await callback({ code: 'good', state: 'x' })).html, /not valid/);
    const cancelled = await epicLogin(ID.mod);
    assert.match((await callback({ error: 'access_denied', state: cancelled.searchParams.get('state') })).html, /Nothing was linked/);
    const stolen = await epicLogin(ID.mod);
    const second = await callback({ code: 'good', state: stolen.searchParams.get('state') });
    assert.equal(second.status, 409);
    assert.match(second.html, /already linked to another Discord account/);
    const failed = await epicLogin(ID.mod);
    assert.equal((await callback({ code: 'bad', state: failed.searchParams.get('state') })).status, 502);
    assert.equal(await db.one('SELECT 1 AS y FROM epic_links WHERE user_id = $1', [ID.mod]), null);
  } finally {
    Object.assign(config, { epicClientId: null, epicClientSecret: null });
    await updateSettings(ID.guild, (s) => { s.epic.linkedRole = null; });
  }
});

test('the website lists linked accounts and can unlink them, but cannot add any', async () => {
  const list = await web('GET', `${G}/collections/epiclinks`, ID.owner);
  const byName = Object.fromEntries(list.json.rows.map((r) => [r.epic_name, r.how]));
  assert.deepEqual(byName, { ProMember: 'Typed', 'Admin Ace': 'Typed', 'Epic<Pro>': 'Epic login' });
  assert.equal((await web('POST', `${G}/collections/epiclinks`, ID.owner, { row: {} })).status, 405);
  const after = await web('DELETE', `${G}/collections/epiclinks/${ID.other}`, ID.owner);
  assert.equal(after.json.rows.length, 2);
  assert.equal(await db.one('SELECT 1 AS y FROM epic_links WHERE user_id = $1', [ID.other]), null);
});

/* ---------- Scrims ---------- */

const SCRIM = { title: 'Friday Scrims', mode: 'Trios', build: 'Zero Build', region: 'Europe', channel_id: ID.general, key_code: 'ELEV8KEY', starts_in: '15m', max_players: 2 };

test('the website posts a scrim with the chosen mode and keeps the key out of the channel', async () => {
  assert.match((await web('POST', `${G}/collections/scrims`, ID.owner, { row: { ...SCRIM, key_code: 'bad key!' } })).json.error, /Custom key/);
  assert.match((await web('POST', `${G}/collections/scrims`, ID.owner, { row: { ...SCRIM, starts_in: 'soon' } })).json.error, /Start time/);
  const res = await web('POST', `${G}/collections/scrims`, ID.owner, { row: SCRIM });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const [row] = res.json.rows;
  assert.deepEqual([row.title, row.mode, row.build, row.region, row.players, row.status], ['Friday Scrims', 'Trios', 'Zero Build', 'Europe', '0/2', 'Scheduled']);
  assert.equal(row.key_code, undefined, 'the key is never sent back to the website');
  assert.ok(Math.abs(Number(row.starts_at) - (Date.now() + 15 * 60_000)) < 10_000);
  const post = posted(ID.general).at(-1).body;
  const fields = Object.fromEntries(post.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Mode, 'Trios · Zero Build');
  assert.equal(fields.Region, 'Europe');
  assert.match(fields.Players, /0\/2 registered · 2 spots left/);
  assert.deepEqual(post.components[0].components.map((b) => [b.label, Boolean(b.disabled)]), [['Register', false], ['Leave', false], ['Get key', true], ['Link Epic account', false]]);
  assert.doesNotMatch(JSON.stringify(world.discord.calls), /ELEV8KEY/);
  await web('DELETE', `${G}/collections/scrims/${row.id}`, ID.owner);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.includes('/messages/')), 'post deleted');
  assert.equal((await web('GET', `${G}/collections/scrims`, ID.owner)).json.rows.length, 0);
});

test('players register, get the key privately when it starts, and lose the player role at the end', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.scrim, { requireEpic: true, playerRole: ID.roleVip }); });
  const created = await web('POST', `${G}/collections/scrims`, ID.owner, { row: SCRIM });
  const id = created.json.rows[0].id;

  const unlinked = await world.button(`scrim:join:${id}`, { as: ID.other });
  assert.match(unlinked.text, /Link your Epic Games account first/);
  assert.match(unlinked.text, /epic:link/);
  assert.match((await world.button(`scrim:join:${id}`, { as: ID.member })).text, /registered as \*\*ProMember\*\*/);
  assert.ok(roleCall('PUT', ID.member, ID.roleVip), 'player role given');
  assert.match((await world.button(`scrim:key:${id}`, { as: ID.member })).text, /The scrim starts <t:\d+:R>/);
  await world.button(`scrim:join:${id}`, { as: ID.admin });
  await world.modal('epic:name', { name: 'LateGuy' }, { as: ID.other });
  assert.match((await world.button(`scrim:join:${id}`, { as: ID.other })).text, /full/);

  const job = await db.one("SELECT * FROM jobs WHERE type = 'scrim:start' AND job_key = $1", [String(id)]);
  await jobs.tick(world.client, Number(job.run_at) + 1);
  const start = posted(ID.general).at(-1).body;
  assert.match(start.content, /<@&400000000000000005> 🟢 \*\*Friday Scrims\*\*: game 1 is starting!/);
  assert.deepEqual(start.allowed_mentions.roles, [ID.roleVip]);
  assert.match(start.embeds[0].description, /Zero Build Trios/);

  const key = await world.button(`scrim:key:${id}`, { as: ID.member });
  assert.match(key.text, /ELEV8KEY/);
  assert.match(key.text, /"flags":64/, 'private reply');
  assert.match((await world.button(`scrim:key:${id}`, { as: ID.other })).text, /Only registered players/);
  assert.doesNotMatch((await world.button(`scrim:key:${id}`, { as: ID.other })).text, /ELEV8KEY/);
  assert.match((await world.button(`scrim:key:${id}`, { as: ID.owner })).text, /ELEV8KEY/, 'staff can check the key');
  assert.match((await run('scrim', { sub: 'players', options: { id } })).text, /ProMember 🔑[\s\S]*Admin Ace/);

  assert.match((await run('scrim', { sub: 'next', options: { id, key: 'GAME2KEY' } })).text, /Game 2/);
  assert.match(posted(ID.general).at(-1).body.content, /game 2 is starting/);
  assert.match((await world.button(`scrim:key:${id}`, { as: ID.admin })).text, /GAME2KEY/);

  assert.match((await run('scrim', { sub: 'end', options: { id } })).text, /ended/);
  assert.ok(roleCall('DELETE', ID.member, ID.roleVip) && roleCall('DELETE', ID.admin, ID.roleVip), 'player roles removed');
  const ended = world.discord.calls.filter((c) => c.method === 'PATCH' && c.route.includes('/messages/')).at(-1).body;
  assert.equal(ended.embeds[0].fields.find((f) => f.name === 'Status').value, 'Ended');
  assert.ok(ended.components[0].components.every((b) => b.disabled), 'buttons switched off');
  assert.match((await world.button(`scrim:join:${id}`, { as: ID.other })).text, /over/);
  for (const write of channelWrites()) assert.doesNotMatch(JSON.stringify(write.body), /ELEV8KEY|GAME2KEY/, 'keys never posted in a channel');
  await updateSettings(ID.guild, (s) => { s.scrim.playerRole = null; });
});

test('/scrim create can start right away, late players get the key on register, and only hosts can create', async () => {
  await updateSettings(ID.guild, (s) => { s.scrim.requireEpic = false; });
  const res = await run('scrim', { sub: 'create', options: { mode: 'Solo', build: 'Build', region: 'NA East', key: 'NOWKEY1', starts_in: 'now', channel: ID.extra } });
  assert.match(res.text, /posted in <#300000000000000005> and started/);
  assert.match(posted(ID.extra).at(-1).body.content, /Solo Scrim\*\*: game 1 is starting/);
  const id = Number(res.text.match(/Scrim \*\*#(\d+)\*\*/)[1]);
  assert.match((await world.button(`scrim:join:${id}`, { as: ID.mod })).text, /You are registered\. Here is the key[\s\S]*NOWKEY1/);
  assert.match((await run('scrim', { sub: 'create', options: { mode: 'Solo', build: 'Build', region: 'Asia', key: 'ab' } })).text, /3 to 32/);
  assert.match((await run('scrim', { sub: 'create', options: { mode: 'Solo', build: 'Build', region: 'Asia', key: 'GOODKEY' }, as: ID.member })).text, /do not have permission/);
  assert.match((await run('scrim', { sub: 'list' })).text, new RegExp(`#${id}.*live, game 1`));

  const stopped = await web('DELETE', `${G}/collections/scrims/${id}`, ID.owner);
  assert.equal(stopped.json.rows.length, 0);
  assert.equal((await db.one('SELECT status FROM scrims WHERE id = $1', [id])).status, 'ended', 'stopping a live scrim ends it and keeps the post');
  await updateSettings(ID.guild, (s) => { s.scrim.requireEpic = true; });
});
