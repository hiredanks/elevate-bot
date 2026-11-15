import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { closeDatabase, db } from '../src/core/db.js';
import { getSettings } from '../src/core/settings.js';
import { modules } from '../src/modules/index.js';

let world;
let server;
let base;
const realFetch = globalThis.fetch;
const WEB = 'https://dash.example';
const SERVERS = [{ id: ID.guild, name: 'Test Server', icon: null }, { id: '123456789012345678', name: 'Elsewhere', icon: null }];
// null means the token exchange works; otherwise [status, body] is what Discord answers.
const discordLogin = { tokenError: null };

function fakeDiscord(url) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/oauth2/token')) {
    if (!discordLogin.tokenError) return json({ access_token: 'discord-token', expires_in: 604800 });
    const [status, body] = discordLogin.tokenError;
    return json(body, status);
  }
  if (url.endsWith('/users/@me')) return json({ id: ID.owner, username: 'owner', global_name: 'The Owner' });
  if (url.endsWith('/users/@me/guilds')) {
    return json([
      { id: ID.guild, name: 'Test Server', icon: null, owner: true, permissions: '8' },
      { id: '123456789012345678', name: 'Elsewhere', icon: 'abc', owner: false, permissions: '32' },
      { id: '123456789012345679', name: 'Just a member', icon: null, owner: false, permissions: '1024' },
    ]);
  }
  return json({}, 404);
}

before(async () => {
  world = await createWorld();
  // The website admin list defaults to the real owner's account; these tests act as the test server's owner.
  config.siteAdmins = [ID.owner];
  // Local calls go to the real API under test; only Discord itself is simulated.
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://discord.com/') ? fakeDiscord(String(url)) : realFetch(url, init));
  server = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { server.once('listening', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await closeDatabase(); });

const tokens = new Map();
async function tokenFor(userId) {
  if (!tokens.has(userId)) tokens.set(userId, await createSession({ userId, username: 'tester', guilds: SERVERS }));
  return tokens.get(userId);
}

async function api(method, path, { as = ID.owner, body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token ?? await tokenFor(as)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
const G = `/api/guilds/${ID.guild}`;

test('health and the invite link are public, everything else needs a login', async () => {
  assert.equal((await (await fetch(`${base}/health`)).json()).status, 'ok');
  assert.match((await (await fetch(`${base}/api/public`)).json()).inviteUrl, /permissions=8/);
  assert.equal((await api('GET', '/api/schema', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await fetch(`${base}${G}`)).status, 401);
});

test('login sends people to Discord with their state and the bot\'s own callback', async () => {
  const res = await fetch(`${base}/auth/login?state=abcdefghijklmnop`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location'));
  assert.equal(target.hostname, 'discord.com');
  assert.equal(target.searchParams.get('state'), 'abcdefghijklmnop');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://bot.example/auth/callback');
  assert.equal((await fetch(`${base}/auth/login?state=short`, { redirect: 'manual' })).status, 400);
});

test('the callback creates a working session and returns to the website only', async () => {
  const res = await fetch(`${base}/auth/callback?code=abc&state=abcdefghijklmnop`, { redirect: 'manual' });
  const location = res.headers.get('location');
  assert.ok(location.startsWith(`${WEB}/#token=`), location);
  const params = new URLSearchParams(new URL(location).hash.slice(1));
  assert.equal(params.get('state'), 'abcdefghijklmnop');
  const me = await api('GET', '/api/me', { token: params.get('token') });
  assert.equal(me.json.user.username, 'The Owner');
  assert.deepEqual(me.json.managed.map((g) => g.id), [ID.guild]);
  assert.deepEqual(me.json.others.map((g) => g.name), ['Elsewhere'], 'servers without Manage Server are dropped');
});

test('a failed Discord login returns to the website with the reason and no token', async () => {
  const callback = async (query) => (await fetch(`${base}/auth/callback?${query}`, { redirect: 'manual' })).headers.get('location');
  const cases = [
    [[401, { error: 'invalid_client' }], 'secret'],
    [[400, { error: 'invalid_grant', error_description: 'Invalid "redirect_uri" in request.' }], 'redirect'],
    [[400, { error: 'invalid_grant', error_description: 'Invalid "code" in request.' }], 'expired'],
    [[429, { message: 'You are being rate limited.' }], 'busy'],
    [[400, { error: 'something_new' }], 'other'],
  ];
  for (const [answer, reason] of cases) {
    discordLogin.tokenError = answer;
    assert.equal(await callback('code=abc&state=abcdefghijklmnop'), `${WEB}/#login_error=${reason}`, reason);
  }
  discordLogin.tokenError = null;
  assert.equal(await callback('error=access_denied&state=abcdefghijklmnop'), `${WEB}/#login_error=denied`);
  assert.equal(await callback('state=abcdefghijklmnop'), `${WEB}/#login_error=other`);
});

test('only the website\'s address gets browser access', async () => {
  const allowed = await fetch(`${base}/api/public`, { headers: { origin: WEB } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), WEB);
  const other = await fetch(`${base}/api/public`, { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}${G}`, { method: 'OPTIONS', headers: { origin: WEB } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
});

test('sessions end at logout and at expiry, and only a hash is stored', async () => {
  const token = await createSession({ userId: ID.owner, username: 'x', guilds: [] });
  assert.equal((await api('GET', '/api/me', { token })).status, 200);
  assert.equal((await db.all('SELECT 1 FROM web_sessions WHERE token_hash = $1', [token])).length, 0);
  assert.equal((await api('POST', '/auth/logout', { token })).status, 200);
  assert.equal((await api('GET', '/api/me', { token })).status, 401);
  const expired = await createSession({ userId: ID.owner, username: 'x', guilds: [] }, -1000);
  assert.equal((await api('GET', '/api/me', { token: expired })).status, 401);
});

test('only members with Manage Server can open a server', async () => {
  assert.equal((await api('GET', G, { as: ID.member })).status, 403);
  assert.equal((await api('GET', G, { as: ID.stranger })).status, 403);
  const ok = await api('GET', G, { as: ID.admin });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.guild.name, 'Test Server');
  assert.equal(ok.json.canSecurity, false);
});

test('the server list contains only servers the user can manage right now', async () => {
  const admin = await api('GET', '/api/me', { as: ID.admin });
  assert.deepEqual(admin.json.managed.map((g) => g.id), [ID.guild]);
  const member = await api('GET', '/api/me', { as: ID.member });
  assert.deepEqual(member.json.managed, []);
});

test('every form field exists in that module\'s settings', async () => {
  const { json } = await api('GET', '/api/schema');
  assert.ok(json.forms.length >= 12);
  for (const form of json.forms) {
    const { status, json: data } = await api('GET', `${G}/settings/${form.module}`);
    assert.equal(status, 200, form.module);
    for (const field of form.fields) assert.notEqual(data.values[field.key], undefined, `${form.module}.${field.key}`);
  }
});

test('settings save, reach the running bot immediately, and survive validation', async () => {
  const saved = await api('PATCH', `${G}/settings/welcome`, { body: { values: { enabled: true, channel: ID.general, message: 'Hello {user}' } } });
  assert.equal(saved.status, 200);
  assert.equal(getSettings(ID.guild).welcome.channel, ID.general);
  const row = await db.one('SELECT data FROM guild_settings WHERE guild_id = $1', [ID.guild]);
  assert.equal(row.data.welcome.message, 'Hello {user}');
});

test('bad values are rejected with a clear message', async () => {
  const cases = [
    ['welcome', { channel: '111111111111111111' }, /does not exist/],
    ['welcome', { channel: ID.voice }, /wrong type/],
    ['leveling', { xpMin: 99999 }, /between/],
    ['leveling', { xpMin: 1.5 }, /whole number/],
    ['automod', { 'filters.invites.action': 'explode' }, /choices/],
    ['starboard', { emoji: 'not emoji' }, /emoji/],
    ['custom', { prefix: '' }, /empty/],
    ['welcome', { autorolesHumans: [ID.roleAdmin] }, /admin-level/],
    ['leveling', { rewards: [{ level: 5, roleId: ID.roleAdmin }] }, /admin-level/],
  ];
  for (const [mod, values, pattern] of cases) {
    const res = await api('PATCH', `${G}/settings/${mod}`, { body: { values } });
    assert.equal(res.status, 400, JSON.stringify(values));
    assert.match(res.json.error, pattern);
  }
});

test('a request cannot write internal fields that are not on the form', async () => {
  await api('PATCH', `${G}/settings/antiraid`, { body: { values: { lockState: { x: 'allow' }, previousLevel: 3, enabled: false } } });
  assert.deepEqual(getSettings(ID.guild).antiraid.lockState, {});
  assert.equal(getSettings(ID.guild).antiraid.previousLevel, null);
  await api('PATCH', `${G}/settings/antinuke`, { body: { values: { trusted: [ID.admin] } } });
  assert.deepEqual(getSettings(ID.guild).antinuke.trusted, []);
});

test('anti-nuke settings are owner-only, even for an administrator', async () => {
  assert.equal((await api('GET', `${G}/settings/antinuke`, { as: ID.admin })).status, 403);
  assert.equal((await api('PATCH', `${G}/settings/antinuke`, { as: ID.admin, body: { values: { enabled: false } } })).status, 403);
  assert.equal((await api('PATCH', `${G}/settings/antinuke`, { body: { values: { enabled: true } } })).status, 200);
  assert.equal(getSettings(ID.guild).antinuke.enabled, true);
  await api('PATCH', `${G}/settings/antinuke`, { body: { values: { enabled: false } } });
});

test('an old role choice does not block saving other fields', async () => {
  await db.run('SELECT 1');
  getSettings(ID.guild).welcome.autorolesHumans = [ID.roleAdmin];
  const res = await api('PATCH', `${G}/settings/welcome`, { body: { values: { autorolesHumans: [ID.roleAdmin], cardTitle: 'Hi' } } });
  assert.equal(res.status, 200);
  getSettings(ID.guild).welcome.autorolesHumans = [];
});

test('collections create, list and delete', async () => {
  const add = await api('POST', `${G}/collections/autoresponders`, { body: { row: { trigger_text: 'ping', match_type: 'exact', response: 'pong' } } });
  assert.equal(add.status, 200);
  const row = add.json.rows.find((r) => r.trigger_text === 'ping');
  assert.ok(row);
  assert.equal((await api('POST', `${G}/collections/autoresponders`, { body: { row: { trigger_text: 'x' } } })).status, 400);
  const gone = await api('DELETE', `${G}/collections/autoresponders/${row.id}`);
  assert.ok(!gone.json.rows.some((r) => r.id === row.id));
});

test('a giveaway can be started and cancelled from the dashboard', async () => {
  const add = await api('POST', `${G}/collections/giveaways`, { body: { row: { prize: 'Web prize', channel_id: ID.general, winners: 2, duration: '1d' } } });
  assert.equal(add.status, 200);
  const row = add.json.rows.find((r) => r.prize === 'Web prize');
  assert.equal((await api('POST', `${G}/collections/giveaways`, { body: { row: { prize: 'x', channel_id: ID.general, winners: 1, duration: 'soon' } } })).status, 400);
  await api('DELETE', `${G}/collections/giveaways/${row.id}`);
  assert.equal(await db.one('SELECT 1 AS y FROM giveaways WHERE id = $1', [row.id]), null);
});

test('actions post panels and report missing setup', async () => {
  const missing = await api('POST', `${G}/actions/tickets/post`);
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /panel channel/);
  await api('PATCH', `${G}/settings/tickets`, { body: { values: { panelChannel: ID.general } } });
  assert.equal((await api('POST', `${G}/actions/tickets/post`)).status, 200);
});

test('cases and the leaderboard are served', async () => {
  assert.ok(Array.isArray((await api('GET', `${G}/cases`)).json.rows));
  assert.equal((await api('GET', `${G}/leaderboard?type=credits`)).json.type, 'credits');
  assert.equal((await api('GET', `${G}/leaderboard?type=drop-table`)).json.type, 'xp');
});

test('unknown routes and malformed bodies fail cleanly', async () => {
  assert.equal((await api('GET', '/api/nope')).status, 404);
  const res = await fetch(`${base}${G}/settings/welcome`, { method: 'PATCH', headers: { authorization: `Bearer ${await tokenFor(ID.owner)}` }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal(world.logger.errorCount, 0);
});
